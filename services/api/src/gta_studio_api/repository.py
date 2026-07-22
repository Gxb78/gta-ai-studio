from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from .database import Database
from .errors import StudioError
from .ids import uuid7
from .media import ProbeResult


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


class Repository:
    def __init__(self, database: Database) -> None:
        self.database = database

    def create_project(self, title: str, game_id: str, target_stage: str = "PROXIED") -> str:
        project_id = uuid7()
        timestamp = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO projects(
                    id, title, game_id, pipeline_stage, run_status, target_stage,
                    data_policy, created_at, updated_at
                ) VALUES (?, ?, ?, 'CREATED', 'ACTIVE', ?, 'local_only', ?, ?)
                """,
                (project_id, title, game_id, target_stage, timestamp, timestamp),
            )
            self._audit(connection, project_id, None, "project.created", {"target_stage": target_stage})
        return project_id

    def update_stage(
        self,
        project_id: str,
        expected: str,
        target: str,
        *,
        run_status: str = "ACTIVE",
        event: str,
    ) -> None:
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT pipeline_stage, row_version FROM projects WHERE id = ? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()
            if row is None:
                raise StudioError("DOMAIN_PROJECT_NOT_FOUND", "Project not found.", status_code=404)
            if row["pipeline_stage"] == target:
                connection.execute(
                    "UPDATE projects SET run_status = ?, updated_at = ? WHERE id = ?",
                    (run_status, utc_now(), project_id),
                )
                return
            if row["pipeline_stage"] != expected:
                raise StudioError(
                    "DOMAIN_INVALID_STAGE_TRANSITION",
                    f"Expected {expected}, found {row['pipeline_stage']}.",
                    status_code=409,
                )
            result = connection.execute(
                """
                UPDATE projects
                SET pipeline_stage = ?, run_status = ?, updated_at = ?, row_version = row_version + 1
                WHERE id = ? AND row_version = ?
                """,
                (target, run_status, utc_now(), project_id, row["row_version"]),
            )
            if result.rowcount != 1:
                raise StudioError("STORAGE_CONCURRENT_UPDATE", "Project was modified concurrently.", status_code=409, retryable=True)
            self._audit(connection, project_id, None, event, {"from": expected, "to": target, "run_status": run_status})

    def set_project_status(self, project_id: str, status: str, code: str | None = None, message: str | None = None) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE projects SET run_status = ?, failure_code = ?, failure_message = ?,
                    updated_at = ?, row_version = row_version + 1
                WHERE id = ?
                """,
                (status, code, message, utc_now(), project_id),
            )
            self._audit(connection, project_id, None, "project.status_changed", {"status": status, "failure_code": code})

    def register_media(self, project_id: str, uri: str, sha256: str, size_bytes: int, probe: ProbeResult) -> str:
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT id FROM media_assets WHERE project_id = ? AND sha256 = ?",
                (project_id, sha256),
            ).fetchone()
            if existing:
                return str(existing["id"])
            media_id = uuid7()
            connection.execute(
                """
                INSERT INTO media_assets(
                    id, project_id, kind, status, original_uri, sha256, size_bytes,
                    duration_ms, width, height, fps_numerator, fps_denominator,
                    video_codec, audio_codec, game_id, metadata_json, created_at
                )
                SELECT ?, ?, 'video', 'verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, game_id, ?, ?
                FROM projects WHERE id = ?
                """,
                (
                    media_id,
                    project_id,
                    uri,
                    sha256,
                    size_bytes,
                    probe.duration_ms,
                    probe.width,
                    probe.height,
                    probe.fps_numerator,
                    probe.fps_denominator,
                    probe.video_codec,
                    probe.audio_codec,
                    canonical_json({"format_name": probe.format_name}),
                    utc_now(),
                    project_id,
                ),
            )
            self._audit(connection, project_id, None, "media.ingested", {"media_id": media_id, "sha256": sha256})
            return media_id

    def get_primary_media(self, project_id: str) -> dict[str, Any]:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM media_assets WHERE project_id = ? AND kind = 'video' AND status = 'verified' ORDER BY created_at LIMIT 1",
                (project_id,),
            ).fetchone()
        if row is None:
            raise StudioError("MEDIA_PROJECT_SOURCE_MISSING", "Project source media is missing.", status_code=409)
        return dict(row)

    def register_artifact(
        self,
        project_id: str | None,
        kind: str,
        uri: str,
        sha256: str,
        size_bytes: int,
        media_type: str,
        algorithm_version: str,
        input_fingerprint: str,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT id FROM artifacts WHERE uri = ? OR (kind = ? AND algorithm_version = ? AND input_fingerprint = ? AND deleted_at IS NULL) LIMIT 1",
                (uri, kind, algorithm_version, input_fingerprint),
            ).fetchone()
            if existing:
                return str(existing["id"])
            artifact_id = uuid7()
            connection.execute(
                """
                INSERT INTO artifacts(
                    id, project_id, kind, uri, sha256, size_bytes, media_type,
                    algorithm_version, input_fingerprint, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    artifact_id,
                    project_id,
                    kind,
                    uri,
                    sha256,
                    size_bytes,
                    media_type,
                    algorithm_version,
                    input_fingerprint,
                    canonical_json(metadata or {}),
                    utc_now(),
                ),
            )
            return artifact_id

    def find_artifact(self, kind: str, algorithm_version: str, input_fingerprint: str) -> dict[str, Any] | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM artifacts
                WHERE kind = ? AND algorithm_version = ? AND input_fingerprint = ? AND deleted_at IS NULL
                ORDER BY created_at DESC LIMIT 1
                """,
                (kind, algorithm_version, input_fingerprint),
            ).fetchone()
        return dict(row) if row else None

    def link_derivative(self, media_id: str, artifact_id: str, kind: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO media_derivatives(id, source_media_id, artifact_id, kind, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (uuid7(), media_id, artifact_id, kind, utc_now()),
            )

    def enqueue_job(
        self,
        project_id: str,
        kind: str,
        parameters: dict[str, Any],
        input_fingerprint: str,
        algorithm_version: str,
        *,
        dependencies: list[str] | None = None,
        idempotency_suffix: str = "",
    ) -> str:
        idempotency_key = f"{kind}:{algorithm_version}:{fingerprint(parameters)}:{input_fingerprint}{idempotency_suffix}"
        dependencies = dependencies or []
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT id FROM job_runs WHERE project_id = ? AND idempotency_key = ?",
                (project_id, idempotency_key),
            ).fetchone()
            if existing:
                return str(existing["id"])
            job_id = uuid7()
            timestamp = utc_now()
            status = "BLOCKED" if dependencies else "QUEUED"
            connection.execute(
                """
                INSERT INTO job_runs(
                    id, project_id, kind, status, priority, idempotency_key,
                    input_fingerprint, algorithm_version, parameters_json,
                    attempt, max_attempts, progress, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 3, 0, ?, ?)
                """,
                (
                    job_id,
                    project_id,
                    kind,
                    status,
                    idempotency_key,
                    input_fingerprint,
                    algorithm_version,
                    canonical_json(parameters),
                    timestamp,
                    timestamp,
                ),
            )
            for dependency in dependencies:
                connection.execute(
                    "INSERT INTO job_dependencies(job_id, depends_on_job_id, required) VALUES (?, ?, 1)",
                    (job_id, dependency),
                )
            self._audit(connection, project_id, job_id, "job.queued", {"kind": kind, "status": status})
            return job_id

    def claim_job(self, worker_id: str, lease_seconds: int) -> dict[str, Any] | None:
        now = datetime.now(UTC)
        now_text = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        expires = (now + timedelta(seconds=lease_seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE job_runs SET status = 'CANCELLED', completed_at = ?, updated_at = ? WHERE status IN ('QUEUED', 'BLOCKED', 'RETRY_WAIT') AND cancel_requested_at IS NOT NULL",
                (now_text, now_text),
            )
            connection.execute(
                "UPDATE job_runs SET status = 'QUEUED', next_retry_at = NULL, updated_at = ? WHERE status = 'RETRY_WAIT' AND next_retry_at <= ?",
                (now_text, now_text),
            )
            connection.execute(
                """
                UPDATE job_runs AS candidate SET status = 'QUEUED', updated_at = ?
                WHERE candidate.status = 'BLOCKED'
                  AND NOT EXISTS (
                    SELECT 1 FROM job_dependencies dependency
                    JOIN job_runs parent ON parent.id = dependency.depends_on_job_id
                    WHERE dependency.job_id = candidate.id AND dependency.required = 1 AND parent.status <> 'SUCCEEDED'
                  )
                """,
                (now_text,),
            )
            row = connection.execute(
                """
                SELECT * FROM job_runs AS candidate
                WHERE candidate.status = 'QUEUED' AND candidate.cancel_requested_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM job_dependencies dependency
                    JOIN job_runs parent ON parent.id = dependency.depends_on_job_id
                    WHERE dependency.job_id = candidate.id AND dependency.required = 1 AND parent.status <> 'SUCCEEDED'
                  )
                ORDER BY candidate.priority DESC, candidate.created_at
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            job_id = str(row["id"])
            result = connection.execute(
                """
                UPDATE job_runs
                SET status = 'LEASED', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
                    attempt = attempt + 1, started_at = COALESCE(started_at, ?), updated_at = ?, row_version = row_version + 1
                WHERE id = ? AND status = 'QUEUED' AND row_version = ?
                """,
                (worker_id, expires, now_text, now_text, now_text, job_id, row["row_version"]),
            )
            if result.rowcount != 1:
                return None
            connection.execute(
                "UPDATE job_runs SET status = 'RUNNING', updated_at = ?, row_version = row_version + 1 WHERE id = ? AND status = 'LEASED' AND lease_owner = ?",
                (now_text, job_id, worker_id),
            )
            connection.execute(
                "UPDATE projects SET run_status = 'ACTIVE', failure_code = NULL, failure_message = NULL, updated_at = ? WHERE id = ?",
                (now_text, row["project_id"]),
            )
            claimed = connection.execute("SELECT * FROM job_runs WHERE id = ?", (job_id,)).fetchone()
            self._audit(connection, str(row["project_id"]), job_id, "job.started", {"worker_id": worker_id})
        return self._job_dict(claimed)

    def update_job_progress(self, job_id: str, worker_id: str, progress: float, lease_seconds: int) -> None:
        now = datetime.now(UTC)
        expires = (now + timedelta(seconds=lease_seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE job_runs SET progress = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
                WHERE id = ? AND status = 'RUNNING' AND lease_owner = ?
                """,
                (max(0.0, min(1.0, progress)), utc_now(), expires, utc_now(), job_id, worker_id),
            )

    def is_cancel_requested(self, job_id: str) -> bool:
        with self.database.connect() as connection:
            row = connection.execute("SELECT cancel_requested_at FROM job_runs WHERE id = ?", (job_id,)).fetchone()
        return row is None or row["cancel_requested_at"] is not None

    def complete_job(self, job_id: str, worker_id: str, artifact_id: str) -> None:
        with self.database.transaction() as connection:
            row = connection.execute("SELECT project_id FROM job_runs WHERE id = ?", (job_id,)).fetchone()
            result = connection.execute(
                """
                UPDATE job_runs SET status = 'SUCCEEDED', progress = 1, result_artifact_id = ?,
                    lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?, row_version = row_version + 1
                WHERE id = ? AND status = 'RUNNING' AND lease_owner = ?
                """,
                (artifact_id, utc_now(), utc_now(), job_id, worker_id),
            )
            if result.rowcount != 1:
                raise StudioError("JOB_LEASE_LOST", "Worker lost the job lease before completion.", status_code=409, retryable=True)
            self._audit(connection, str(row["project_id"]), job_id, "job.completed", {"artifact_id": artifact_id})

    def complete_proxy_job(self, job_id: str, worker_id: str, artifact_id: str, project_id: str) -> None:
        """Publish proxy job success and project readiness in one transaction."""
        with self.database.transaction() as connection:
            timestamp = utc_now()
            result = connection.execute(
                """
                UPDATE job_runs SET status = 'SUCCEEDED', progress = 1, result_artifact_id = ?,
                    lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?, row_version = row_version + 1
                WHERE id = ? AND project_id = ? AND status = 'RUNNING' AND lease_owner = ?
                """,
                (artifact_id, timestamp, timestamp, job_id, project_id, worker_id),
            )
            if result.rowcount != 1:
                raise StudioError("JOB_LEASE_LOST", "Worker lost the proxy job lease before completion.", status_code=409, retryable=True)
            project = connection.execute(
                "SELECT pipeline_stage, row_version FROM projects WHERE id = ? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()
            if project is None:
                raise StudioError("DOMAIN_PROJECT_NOT_FOUND", "Project not found.", status_code=404)
            if project["pipeline_stage"] == "INGESTED":
                connection.execute(
                    """
                    UPDATE projects SET pipeline_stage = 'PROXIED', run_status = 'COMPLETED',
                        updated_at = ?, row_version = row_version + 1
                    WHERE id = ? AND row_version = ?
                    """,
                    (timestamp, project_id, project["row_version"]),
                )
                self._audit(
                    connection,
                    project_id,
                    job_id,
                    "project.proxy_completed",
                    {"from": "INGESTED", "to": "PROXIED", "run_status": "COMPLETED"},
                )
            elif project["pipeline_stage"] == "PROXIED":
                connection.execute(
                    "UPDATE projects SET run_status = 'COMPLETED', updated_at = ?, row_version = row_version + 1 WHERE id = ?",
                    (timestamp, project_id),
                )
            else:
                raise StudioError(
                    "DOMAIN_INVALID_STAGE_TRANSITION",
                    f"Expected INGESTED or PROXIED, found {project['pipeline_stage']}.",
                    status_code=409,
                )
            self._audit(connection, project_id, job_id, "job.completed", {"artifact_id": artifact_id})

    def fail_job(self, job_id: str, worker_id: str, error: StudioError) -> str:
        with self.database.transaction() as connection:
            row = connection.execute("SELECT project_id, attempt, max_attempts FROM job_runs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                return "FAILED"
            retry = error.retryable and int(row["attempt"]) < int(row["max_attempts"])
            status = "RETRY_WAIT" if retry else ("CANCELLED" if error.code == "JOB_CANCELLED" else "FAILED")
            retry_at = None
            if retry:
                delay = min(300, 2 ** max(0, int(row["attempt"]) - 1))
                retry_at = (datetime.now(UTC) + timedelta(seconds=delay)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            connection.execute(
                """
                UPDATE job_runs SET status = ?, next_retry_at = ?, error_code = ?, error_message = ?,
                    error_details_json = ?, lease_owner = NULL, lease_expires_at = NULL,
                    completed_at = CASE WHEN ? IN ('FAILED', 'CANCELLED') THEN ? ELSE NULL END,
                    updated_at = ?, row_version = row_version + 1
                WHERE id = ? AND lease_owner = ?
                """,
                (
                    status,
                    retry_at,
                    error.code,
                    error.message,
                    canonical_json(error.details),
                    status,
                    utc_now(),
                    utc_now(),
                    job_id,
                    worker_id,
                ),
            )
            project_status = "FAILED_RETRYABLE" if retry else ("CANCELLED" if status == "CANCELLED" else "FAILED_FINAL")
            connection.execute(
                "UPDATE projects SET run_status = ?, failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?",
                (project_status, error.code, error.message, utc_now(), row["project_id"]),
            )
            self._audit(connection, str(row["project_id"]), job_id, "job.failed", {"code": error.code, "retryable": retry})
            return status

    def recover_abandoned_jobs(self) -> int:
        with self.database.transaction() as connection:
            rows = list(connection.execute("SELECT id, project_id FROM job_runs WHERE status IN ('LEASED', 'RUNNING')"))
            connection.execute(
                """
                UPDATE job_runs SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL,
                    heartbeat_at = NULL, updated_at = ?, row_version = row_version + 1
                WHERE status IN ('LEASED', 'RUNNING')
                """,
                (utc_now(),),
            )
            for row in rows:
                self._audit(connection, str(row["project_id"]), str(row["id"]), "job.recovered", {})
            return len(rows)

    def request_job_cancellation(self, job_id: str) -> None:
        with self.database.transaction() as connection:
            row = connection.execute("SELECT project_id FROM job_runs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise StudioError("JOB_NOT_FOUND", "Job not found.", status_code=404)
            connection.execute(
                "UPDATE job_runs SET cancel_requested_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')",
                (utc_now(), utc_now(), job_id),
            )
            self._audit(connection, str(row["project_id"]), job_id, "job.cancel_requested", {})

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM job_runs WHERE id = ?",
                (job_id,),
            ).fetchone()

        return self._job_dict(row) if row else None

    def retry_latest_failed_job(self, project_id: str) -> str:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM job_runs WHERE project_id = ? AND status = 'FAILED' ORDER BY completed_at DESC LIMIT 1",
                (project_id,),
            ).fetchone()
        if row is None:
            raise StudioError("JOB_NO_FAILED_JOB", "No failed job is available for retry.", status_code=409)
        job = self._job_dict(row)
        new_id = self.enqueue_job(
            project_id,
            str(job["kind"]),
            dict(job["parameters"]),
            str(job["input_fingerprint"]),
            str(job["algorithm_version"]),
            idempotency_suffix=f":manual:{uuid7()}",
        )
        self.set_project_status(project_id, "ACTIVE")
        return new_id

    def begin_production(self, project_id: str, structured_brief: dict[str, Any]) -> str:
        timestamp = utc_now()
        with self.database.transaction() as connection:
            project = connection.execute(
                "SELECT pipeline_stage, run_status FROM projects WHERE id = ? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()
            if project is None:
                raise StudioError("DOMAIN_PROJECT_NOT_FOUND", "Project not found.", status_code=404)
            if project["pipeline_stage"] not in {"PROXIED", "FINAL_RENDERED", "READY_TO_PUBLISH"}:
                raise StudioError(
                    "PRODUCTION_PROJECT_NOT_READY",
                    "Production requires a completed proxy, render, or creative package.",
                    status_code=409,
                )
            running = connection.execute(
                "SELECT 1 FROM job_runs WHERE project_id = ? AND status IN ('QUEUED','BLOCKED','LEASED','RUNNING','RETRY_WAIT') LIMIT 1",
                (project_id,),
            ).fetchone()
            if running:
                raise StudioError("PRODUCTION_ALREADY_RUNNING", "This project already has active work.", status_code=409)
            connection.execute("UPDATE editorial_briefs SET is_current = 0 WHERE project_id = ?", (project_id,))
            revision = int(connection.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 FROM editorial_briefs WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0])
            brief_id = uuid7()
            connection.execute(
                """
                INSERT INTO editorial_briefs(
                    id, project_id, schema_version, revision, raw_instruction,
                    structured_json, confidence, is_current, created_at
                ) VALUES (?, ?, '1.0', ?, ?, ?, ?, 1, ?)
                """,
                (
                    brief_id,
                    project_id,
                    revision,
                    structured_brief["raw_instruction"],
                    canonical_json(structured_brief),
                    float(structured_brief["confidence"]),
                    timestamp,
                ),
            )
            connection.execute(
                """
                UPDATE projects SET target_stage = 'READY_TO_PUBLISH', run_status = 'ACTIVE',
                    failure_code = NULL, failure_message = NULL, updated_at = ?, row_version = row_version + 1
                WHERE id = ?
                """,
                (timestamp, project_id),
            )
            self._audit(connection, project_id, None, "production.started", {"brief_id": brief_id, "revision": revision})
        return brief_id

    def prepare_creative_package(self, project_id: str) -> dict[str, str]:
        timestamp = utc_now()
        with self.database.transaction() as connection:
            project = connection.execute(
                "SELECT pipeline_stage FROM projects WHERE id = ? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()
            if project is None:
                raise StudioError("DOMAIN_PROJECT_NOT_FOUND", "Project not found.", status_code=404)
            if project["pipeline_stage"] not in {"FINAL_RENDERED", "READY_TO_PUBLISH"}:
                raise StudioError("CREATIVE_RENDER_REQUIRED", "A final render is required before building the creative package.", status_code=409)
            running = connection.execute(
                "SELECT 1 FROM job_runs WHERE project_id = ? AND status IN ('QUEUED','BLOCKED','LEASED','RUNNING','RETRY_WAIT') LIMIT 1",
                (project_id,),
            ).fetchone()
            if running:
                raise StudioError("PRODUCTION_ALREADY_RUNNING", "This project already has active work.", status_code=409)
            brief = connection.execute(
                "SELECT id FROM editorial_briefs WHERE project_id = ? AND is_current = 1",
                (project_id,),
            ).fetchone()
            render = connection.execute(
                "SELECT id, artifact_id FROM render_jobs WHERE project_id = ? AND status = 'SUCCEEDED' ORDER BY completed_at DESC LIMIT 1",
                (project_id,),
            ).fetchone()
            if brief is None or render is None or not render["artifact_id"]:
                raise StudioError("CREATIVE_INPUTS_MISSING", "The current brief or final render is missing.", status_code=409)
            connection.execute(
                """
                UPDATE projects SET target_stage = 'READY_TO_PUBLISH', run_status = 'ACTIVE',
                    failure_code = NULL, failure_message = NULL, updated_at = ?, row_version = row_version + 1
                WHERE id = ?
                """,
                (timestamp, project_id),
            )
            self._audit(connection, project_id, None, "creative.started", {"brief_id": brief["id"], "render_job_id": render["id"]})
            return {
                "brief_id": str(brief["id"]),
                "render_job_id": str(render["id"]),
                "render_artifact_id": str(render["artifact_id"]),
            }

    def create_analysis_run(
        self,
        project_id: str,
        brief_id: str,
        *,
        adapter_id: str,
        adapter_version: str,
        vision_version: str,
        ocr_version: str,
    ) -> str:
        analysis_run_id = uuid7()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO analysis_runs(
                    id, project_id, brief_id, adapter_id, adapter_version,
                    vision_version, ocr_version, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?)
                """,
                (analysis_run_id, project_id, brief_id, adapter_id, adapter_version, vision_version, ocr_version, utc_now()),
            )
            self._audit(connection, project_id, None, "analysis.started", {"analysis_run_id": analysis_run_id, "brief_id": brief_id})
        return analysis_run_id

    def save_analysis_frames(self, analysis_run_id: str, project_id: str, media_id: str, frames: list[dict[str, Any]]) -> None:
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM analysis_frames WHERE analysis_run_id = ?", (analysis_run_id,))
            for frame in frames:
                connection.execute(
                    """
                    INSERT INTO analysis_frames(
                        id, analysis_run_id, project_id, media_id, segment_id, artifact_id,
                        timestamp_ms, width, height, metrics_json, detections_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
                    """,
                    (
                        frame["id"], analysis_run_id, project_id, media_id, frame["segment_id"], frame["artifact_id"],
                        frame["timestamp_ms"], frame["width"], frame["height"], canonical_json(frame["metrics"]), utc_now(),
                    ),
                )
            self._audit(connection, project_id, None, "analysis.frames_extracted", {"analysis_run_id": analysis_run_id, "frame_count": len(frames)})

    def replace_ocr_detections(self, analysis_run_id: str, project_id: str, detections: list[dict[str, Any]]) -> None:
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM detected_texts WHERE analysis_run_id = ?", (analysis_run_id,))
            for detection in detections:
                connection.execute(
                    """
                    INSERT INTO detected_texts(
                        id, segment_id, start_ms, end_ms, text, normalized_text,
                        locale, confidence, region_json, detector_version,
                        analysis_run_id, frame_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        detection["id"], detection["segment_id"], detection["start_ms"], detection["end_ms"],
                        detection["text"], detection["normalized_text"], detection.get("locale"),
                        detection["confidence"], canonical_json(detection["region"]) if detection.get("region") else None,
                        detection["detector_version"], analysis_run_id, detection["frame_id"],
                    ),
                )
            self._audit(connection, project_id, None, "analysis.ocr_completed", {"analysis_run_id": analysis_run_id, "text_count": len(detections)})

    def complete_visual_analysis(
        self,
        analysis_run_id: str,
        project_id: str,
        report_artifact_id: str,
        report: dict[str, Any],
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM detected_entities WHERE analysis_run_id = ?", (analysis_run_id,))
            connection.execute("DELETE FROM detected_events WHERE analysis_run_id = ?", (analysis_run_id,))
            for entity in report["entities"]:
                connection.execute(
                    """
                    INSERT INTO detected_entities(
                        id, segment_id, entity_type, canonical_id, label, confidence,
                        start_ms, end_ms, region_json, detector_version, attributes_json,
                        analysis_run_id, frame_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entity["id"], entity["segment_id"], entity["entity_type"], entity.get("canonical_id"),
                        entity["label"], entity["confidence"], entity.get("start_ms"), entity.get("end_ms"),
                        canonical_json(entity["region"]) if entity.get("region") else None,
                        entity["detector_version"], canonical_json(entity.get("attributes", {})),
                        analysis_run_id, entity.get("frame_id"),
                    ),
                )
            for event in report["events"]:
                connection.execute(
                    """
                    INSERT INTO detected_events(
                        id, segment_id, event_type, start_ms, end_ms, confidence,
                        detector_version, attributes_json, analysis_run_id, frame_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event["id"], event["segment_id"], event["event_type"], event["start_ms"], event["end_ms"],
                        event["confidence"], event["detector_version"], canonical_json(event.get("attributes", {})),
                        analysis_run_id, event.get("frame_id"),
                    ),
                )
            for frame_result in report["frame_results"]:
                connection.execute(
                    "UPDATE analysis_frames SET detections_json = ? WHERE id = ? AND analysis_run_id = ?",
                    (canonical_json(frame_result), frame_result["frame_id"], analysis_run_id),
                )
            for segment in report["segment_updates"]:
                connection.execute(
                    """
                    UPDATE segments SET scene_type = ?, summary = ?, motion_score = ?, visual_quality_score = ?,
                        relevance_score = ?, novelty_score = ?, confidence = ?, attributes_json = ?
                    WHERE id = ? AND project_id = ?
                    """,
                    (
                        segment["scene_type"], segment["summary"], segment["motion_score"], segment["visual_quality_score"],
                        segment["relevance_score"], segment["novelty_score"], segment["confidence"],
                        canonical_json(segment["attributes"]), segment["id"], project_id,
                    ),
                )
            persisted_summary = {
                "adapter": report["adapter"],
                "summary": report["summary"],
                "guided_search": report["guided_search"],
            }
            connection.execute(
                """
                UPDATE analysis_runs SET status = 'SUCCEEDED', report_artifact_id = ?, summary_json = ?, completed_at = ?
                WHERE id = ? AND project_id = ?
                """,
                (report_artifact_id, canonical_json(persisted_summary), utc_now(), analysis_run_id, project_id),
            )
            self._audit(connection, project_id, None, "analysis.completed", {"analysis_run_id": analysis_run_id, **report["summary"]})

    def fail_analysis_run(self, analysis_run_id: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE analysis_runs SET status = 'FAILED', completed_at = ? WHERE id = ?",
                (utc_now(), analysis_run_id),
            )

    def get_analysis_frame(self, project_id: str, frame_id: str) -> dict[str, Any]:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT f.id AS frame_id, f.project_id, a.*
                FROM analysis_frames f JOIN artifacts a ON a.id = f.artifact_id
                WHERE f.id = ? AND f.project_id = ? AND a.deleted_at IS NULL
                """,
                (frame_id, project_id),
            ).fetchone()
        if row is None:
            raise StudioError("ANALYSIS_FRAME_NOT_FOUND", "Analysis frame not found.", status_code=404)
        return self._artifact_dict(row)

    def replace_segments(self, project_id: str, segments: list[dict[str, Any]]) -> None:
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM segments WHERE project_id = ?", (project_id,))
            for segment in segments:
                connection.execute(
                    """
                    INSERT INTO segments(
                        id, project_id, media_id, start_ms, end_ms, scene_type, summary,
                        motion_score, visual_quality_score, relevance_score, novelty_score,
                        confidence, attributes_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        segment["id"], project_id, segment["media_id"], segment["start_ms"], segment["end_ms"],
                        segment["scene_type"], segment["summary"], segment["motion_score"],
                        segment["visual_quality_score"], segment["relevance_score"], segment["novelty_score"],
                        segment["confidence"], canonical_json(segment.get("attributes", {})), utc_now(),
                    ),
                )
            self._audit(connection, project_id, None, "production.scenes_segmented", {"segment_count": len(segments)})

    def sync_knowledge_pack(self, pack: dict[str, Any]) -> dict[str, int]:
        game_id = str(pack["game_id"])
        namespace = str(pack["namespace"])
        if namespace != game_id or game_id not in {"gta5", "gta6"}:
            raise StudioError("KNOWLEDGE_NAMESPACE_MISMATCH", "Knowledge namespace must equal the game id.", status_code=500)
        inserted = 0
        revised = 0
        unchanged = 0
        timestamp = utc_now()
        with self.database.transaction() as connection:
            for item in pack["items"]:
                value = {
                    "category": item.get("category"),
                    **dict(item["value"]),
                    "pack_version": item["pack_version"],
                }
                value_json = canonical_json(value)
                existing = connection.execute(
                    """
                    SELECT * FROM knowledge_items
                    WHERE namespace = ? AND canonical_key = ? AND game_version = ?
                    """,
                    (namespace, item["canonical_key"], item["game_version"]),
                ).fetchone()
                if existing is None:
                    knowledge_item_id = uuid7()
                    connection.execute(
                        """
                        INSERT INTO knowledge_items(
                            id, namespace, canonical_key, game_id, game_version, value_json,
                            source_uri, source_type, confidence, status, verified_at,
                            valid_from, valid_to, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            knowledge_item_id, namespace, item["canonical_key"], game_id,
                            item["game_version"], value_json, item.get("source_uri"), item["source_type"],
                            item["confidence"], item["status"], item.get("verified_at"),
                            item.get("valid_from"), item.get("valid_to"), timestamp, timestamp,
                        ),
                    )
                    revision = 1
                    change_reason = "initial_pack_import"
                    inserted += 1
                else:
                    knowledge_item_id = str(existing["id"])
                    same = (
                        str(existing["value_json"]) == value_json
                        and str(existing["status"]) == str(item["status"])
                        and float(existing["confidence"]) == float(item["confidence"])
                        and existing["source_uri"] == item.get("source_uri")
                        and str(existing["source_type"]) == str(item["source_type"])
                    )
                    if same:
                        unchanged += 1
                        continue
                    revision = int(connection.execute(
                        "SELECT COALESCE(MAX(revision), 0) + 1 FROM knowledge_revisions WHERE knowledge_item_id = ?",
                        (knowledge_item_id,),
                    ).fetchone()[0])
                    connection.execute(
                        """
                        UPDATE knowledge_items
                        SET value_json = ?, source_uri = ?, source_type = ?, confidence = ?, status = ?,
                            verified_at = ?, valid_from = ?, valid_to = ?, updated_at = ?
                        WHERE id = ? AND game_id = ?
                        """,
                        (
                            value_json, item.get("source_uri"), item["source_type"], item["confidence"],
                            item["status"], item.get("verified_at"), item.get("valid_from"), item.get("valid_to"),
                            timestamp, knowledge_item_id, game_id,
                        ),
                    )
                    change_reason = "pack_content_changed"
                    revised += 1
                connection.execute(
                    """
                    INSERT INTO knowledge_revisions(
                        id, knowledge_item_id, revision, value_json, source_uri, source_type,
                        confidence, status, verified_at, change_reason, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        uuid7(), knowledge_item_id, revision, value_json, item.get("source_uri"),
                        item["source_type"], item["confidence"], item["status"], item.get("verified_at"),
                        change_reason, timestamp,
                    ),
                )
            self._audit(connection, None, None, "knowledge.pack_synced", {
                "game_id": game_id,
                "namespace": namespace,
                "pack_version": pack["pack_version"],
                "inserted": inserted,
                "revised": revised,
                "unchanged": unchanged,
            })
        return {"inserted": inserted, "revised": revised, "unchanged": unchanged}

    def list_knowledge_items(self, game_id: str) -> list[dict[str, Any]]:
        with self.database.connect() as connection:
            rows = list(connection.execute(
                """
                SELECT ki.*,
                       COALESCE((SELECT MAX(revision) FROM knowledge_revisions kr WHERE kr.knowledge_item_id = ki.id), 1) AS revision,
                       (SELECT COUNT(*) FROM knowledge_revisions kr WHERE kr.knowledge_item_id = ki.id) AS revision_count,
                       (SELECT COUNT(*) FROM knowledge_usages ku WHERE ku.knowledge_item_id = ki.id) AS usage_count
                FROM knowledge_items ki
                WHERE ki.game_id = ? AND ki.namespace = ?
                ORDER BY ki.canonical_key
                """,
                (game_id, game_id),
            ))
        items: list[dict[str, Any]] = []
        for row in rows:
            value = dict(row)
            value["value"] = json.loads(value.pop("value_json"))
            items.append(value)
        return items

    def claim_history_counts(self, game_id: str, project_id: str) -> dict[str, dict[str, Any]]:
        with self.database.connect() as connection:
            rows = list(connection.execute(
                """
                SELECT claim_key, id, project_id
                FROM claims
                WHERE game_id = ? AND project_id <> ?
                  AND status IN ('observed_once', 'reproduced', 'verified')
                ORDER BY created_at DESC
                """,
                (game_id, project_id),
            ))
        history: dict[str, dict[str, Any]] = {}
        for row in rows:
            entry = history.setdefault(str(row["claim_key"]), {"project_ids": set(), "claim_ids": []})
            entry["project_ids"].add(str(row["project_id"]))
            entry["claim_ids"].append(str(row["id"]))
        return {
            key: {
                "observation_count": len(value["project_ids"]),
                "claim_ids": value["claim_ids"],
            }
            for key, value in history.items()
        }

    def create_verification_package(
        self,
        project_id: str,
        brief_id: str,
        game_id: str,
        report: dict[str, Any],
        report_artifact_id: str,
    ) -> str:
        timestamp = utc_now()
        verification_run_id = str(report["id"])
        with self.database.transaction() as connection:
            existing_run = connection.execute(
                "SELECT id FROM verification_runs WHERE project_id = ? AND brief_id = ?",
                (project_id, brief_id),
            ).fetchone()
            if existing_run is not None:
                return str(existing_run["id"])
            connection.execute(
                """
                INSERT INTO verification_runs(
                    id, project_id, brief_id, game_id, algorithm_version, status,
                    report_artifact_id, summary_json, created_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    verification_run_id, project_id, brief_id, game_id, report["algorithm_version"],
                    report["status"], report_artifact_id, canonical_json({
                        "summary": report["summary"],
                        "gate": report["gate"],
                        "knowledge_snapshot": report["knowledge_snapshot"],
                        "requested_facts": report["requested_facts"],
                    }), timestamp, timestamp,
                ),
            )
            for claim in report["claims"]:
                connection.execute(
                    """
                    INSERT INTO claims(
                        id, project_id, statement, status, confidence, game_version, observed_at, created_at,
                        game_id, claim_key, claim_type, normalized_statement, allowed_in_script,
                        certainty_language, verification_reason, verified_at, algorithm_version, verification_run_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        claim["id"], project_id, claim["statement"], claim["status"], claim["confidence"],
                        claim.get("game_version"), claim.get("observed_at"), timestamp, game_id, claim["claim_key"],
                        claim["claim_type"], claim["normalized_statement"], int(bool(claim["allowed_in_script"])),
                        claim["certainty_language"], claim["verification_reason"], claim.get("verified_at"),
                        claim["algorithm_version"], verification_run_id,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO claim_status_history(id, claim_id, status, confidence, reason, origin, occurred_at)
                    VALUES (?, ?, ?, ?, ?, 'evidence_engine', ?)
                    """,
                    (uuid7(), claim["id"], claim["status"], claim["confidence"], claim["verification_reason"], timestamp),
                )
                for evidence in claim["evidence"]:
                    connection.execute(
                        """
                        INSERT INTO evidence(
                            id, claim_id, evidence_type, source_id, start_ms, end_ms,
                            strength, metadata_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            evidence["id"], claim["id"], evidence["evidence_type"], evidence["source_id"],
                            evidence.get("start_ms"), evidence.get("end_ms"), evidence["strength"],
                            canonical_json(evidence.get("metadata", {})), timestamp,
                        ),
                    )
                    if evidence["evidence_type"] == "knowledge_item":
                        revision = int(evidence.get("metadata", {}).get("revision", 1))
                        connection.execute(
                            """
                            INSERT OR IGNORE INTO knowledge_usages(
                                id, knowledge_item_id, knowledge_revision, project_id, claim_id, usage_kind, created_at
                            ) VALUES (?, ?, ?, ?, ?, 'verification', ?)
                            """,
                            (uuid7(), evidence["source_id"], revision, project_id, claim["id"], timestamp),
                        )
            self._audit(connection, project_id, None, "evidence.verification_completed", {
                "verification_run_id": verification_run_id,
                "status": report["status"],
                **report["summary"],
            })
        return verification_run_id

    def create_narrative_package(
        self,
        project_id: str,
        brief_id: str,
        narrative_map: dict[str, Any],
        coverage_report: dict[str, Any],
    ) -> str:
        timestamp = utc_now()
        narrative_map_id = str(narrative_map["id"])
        with self.database.transaction() as connection:
            revision = int(connection.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 FROM narrative_maps WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0])
            connection.execute(
                """
                INSERT INTO narrative_maps(
                    id, project_id, brief_id, revision, required_coverage,
                    missing_required_count, created_at, algorithm_version,
                    overall_coverage, content_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    narrative_map_id, project_id, brief_id, revision,
                    narrative_map["required_coverage"], narrative_map["missing_required_count"],
                    timestamp, narrative_map["algorithm_version"], narrative_map["overall_coverage"],
                    narrative_map["content_type"],
                ),
            )
            for beat in narrative_map["beats"]:
                connection.execute(
                    """
                    INSERT INTO narrative_beats(
                        id, narrative_map_id, sort_order, intent, required, status,
                        candidates_json, concept, purpose, explicitly_requested, decision_reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        beat["id"], narrative_map_id, beat["order"], beat["intent"],
                        int(bool(beat["required"])), beat["status"], canonical_json(beat["candidate_segments"]),
                        beat.get("concept"), beat.get("purpose"), int(bool(beat.get("explicitly_requested"))),
                        beat.get("decision_reason"),
                    ),
                )
            connection.execute(
                """
                INSERT INTO coverage_reports(
                    id, project_id, brief_id, narrative_map_id, required_coverage,
                    overall_coverage, editing_decision, report_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    coverage_report["id"], project_id, brief_id, narrative_map_id,
                    coverage_report["required_coverage"], coverage_report["overall_coverage"],
                    coverage_report["editing_decision"], canonical_json(coverage_report), timestamp,
                ),
            )
            self._audit(connection, project_id, None, "narrative.map_created", {
                "narrative_map_id": narrative_map_id,
                "required_coverage": narrative_map["required_coverage"],
                "missing_required_count": narrative_map["missing_required_count"],
            })
        return narrative_map_id

    def create_content_plans(
        self,
        project_id: str,
        narrative_map_id: str,
        plans: list[dict[str, Any]],
    ) -> str:
        selected = next((plan for plan in plans if plan["selected"]), None)
        if selected is None:
            raise StudioError("CONTENT_PLAN_SELECTION_MISSING", "No selected content plan was provided.", status_code=500)
        with self.database.transaction() as connection:
            for plan in plans:
                connection.execute(
                    """
                    INSERT INTO content_plans(
                        id, project_id, narrative_map_id, variant, selected, plan_json, score, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        plan["id"], project_id, narrative_map_id, plan["variant"],
                        int(bool(plan["selected"])), canonical_json(plan), plan["score"], utc_now(),
                    ),
                )
            self._audit(connection, project_id, None, "narrative.plan_selected", {
                "narrative_map_id": narrative_map_id,
                "content_plan_id": selected["id"],
                "variant": selected["variant"],
                "score": selected["score"],
            })
        return str(selected["id"])

    def create_script_package(
        self,
        project_id: str,
        content_plan_id: str,
        script: dict[str, Any],
    ) -> str:
        timestamp = utc_now()
        with self.database.transaction() as connection:
            revision = int(connection.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 FROM scripts WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0])
            connection.execute("UPDATE scripts SET selected = 0 WHERE project_id = ?", (project_id,))
            script_id = uuid7()
            connection.execute(
                """
                INSERT INTO scripts(id, project_id, content_plan_id, revision, language, estimated_duration_ms, selected, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
                """,
                (script_id, project_id, content_plan_id, revision, script["language"], script["estimated_duration_ms"], timestamp),
            )
            for block in script["blocks"]:
                connection.execute(
                    """
                    INSERT INTO script_blocks(
                        id, script_id, sort_order, purpose, narration, on_screen_text,
                        supporting_segment_ids_json, supporting_claim_ids_json,
                        estimated_duration_ms, confidence
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        block["id"], script_id, block["sort_order"], block["purpose"], block["narration"],
                        block["on_screen_text"], canonical_json(block["supporting_segment_ids"]),
                        canonical_json(block["supporting_claim_ids"]), block["estimated_duration_ms"], block["confidence"],
                    ),
                )
            self._audit(connection, project_id, None, "production.script_created", {"script_id": script_id, "revision": revision})
        return script_id

    def create_voice_track(
        self,
        project_id: str,
        script_id: str,
        artifact_id: str,
        voice_id: str,
        duration_ms: int,
        alignment: list[dict[str, Any]],
    ) -> str:
        voice_track_id = uuid7()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO voice_tracks(
                    id, project_id, script_id, artifact_id, voice_id, locale,
                    duration_ms, alignment_json, created_at
                ) VALUES (?, ?, ?, ?, ?, 'fr-FR', ?, ?, ?)
                """,
                (voice_track_id, project_id, script_id, artifact_id, voice_id, duration_ms, canonical_json(alignment), utc_now()),
            )
            self._audit(connection, project_id, None, "production.voice_created", {"voice_track_id": voice_track_id, "voice_id": voice_id})
        return voice_track_id

    def create_advanced_edit_package(
        self,
        project_id: str,
        brief_id: str,
        plan_artifact_id: str,
        overlay_artifact_id: str,
        plan: dict[str, Any],
    ) -> str:
        plan_id = str(plan["id"])
        summary = dict(plan["summary"])
        template = dict(plan["template"])
        timestamp = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO advanced_edit_plans(
                    id, project_id, brief_id, plan_artifact_id, overlay_artifact_id,
                    template_id, template_version, algorithm_version, status,
                    tracking_confidence, dynamic_reframe_count, overlay_count,
                    zoom_effect_count, speed_effect_count, comparison_count,
                    plan_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    plan_id, project_id, brief_id, plan_artifact_id, overlay_artifact_id,
                    template["id"], template["version"], plan["algorithm_version"], plan["status"],
                    summary["tracking_confidence"], summary["dynamic_reframe_count"], summary["overlay_count"],
                    summary["zoom_effect_count"], summary["speed_effect_count"], summary["comparison_count"],
                    canonical_json(plan), timestamp,
                ),
            )
            for point in plan.get("subject_track", []):
                connection.execute(
                    """
                    INSERT INTO subject_track_points(
                        id, advanced_edit_plan_id, segment_id, frame_id, timestamp_ms,
                        focus_x, focus_y, confidence, method, source_type, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        point["id"], plan_id, point.get("segment_id"), point.get("frame_id"),
                        point["timestamp_ms"], point["focus_x"], point["focus_y"],
                        point["confidence"], point["method"], point["source_type"], timestamp,
                    ),
                )
            for cue in plan.get("overlays", []):
                connection.execute(
                    """
                    INSERT INTO overlay_cues(
                        id, advanced_edit_plan_id, cue_type, start_ms, end_ms, text,
                        secondary_text, template_key, supporting_claim_ids_json,
                        parameters_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        cue["id"], plan_id, cue["cue_type"], cue["start_ms"], cue["end_ms"],
                        cue["text"], cue.get("secondary_text"), cue["template_key"],
                        canonical_json(cue.get("supporting_claim_ids", [])),
                        canonical_json(cue.get("parameters", {})), timestamp,
                    ),
                )
            self._audit(
                connection,
                project_id,
                None,
                "production.advanced_edit_planned",
                {"advanced_edit_plan_id": plan_id, **summary},
            )
        return plan_id

    def create_edit_project(
        self,
        project_id: str,
        script_id: str,
        timeline: dict[str, Any],
        *,
        editor_revision: dict[str, Any] | None = None,
    ) -> str:
        timestamp = utc_now()
        with self.database.transaction() as connection:
            revision = int(connection.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 FROM edit_projects WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0])
            edit_project_id = str(timeline["id"])
            connection.execute(
                """
                INSERT INTO edit_projects(
                    id, project_id, script_id, schema_version, revision, width, height,
                    fps_numerator, fps_denominator, timebase_numerator, timebase_denominator,
                    duration, timeline_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    edit_project_id, project_id, script_id, timeline["schema_version"], revision,
                    timeline["width"], timeline["height"], timeline["fps"]["numerator"],
                    timeline["fps"]["denominator"], timeline["timebase"]["numerator"],
                    timeline["timebase"]["denominator"], timeline["duration"], canonical_json(timeline), timestamp,
                ),
            )
            for track in timeline["tracks"]:
                connection.execute(
                    """
                    INSERT INTO timeline_tracks(id, edit_project_id, kind, name, sort_order, exclusive, muted)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (track["id"], edit_project_id, track["kind"], track["name"], track["order"], int(track["exclusive"]), int(track["muted"])),
                )
                for clip in track["clips"]:
                    source = clip.get("source")
                    connection.execute(
                        """
                        INSERT INTO timeline_clips(
                            id, track_id, start_time, duration, source_media_id,
                            source_in, source_duration, clip_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            clip["id"], track["id"], clip["start"], clip["duration"],
                            source.get("media_id") if source else None,
                            source.get("source_in") if source else None,
                            source.get("source_duration") if source else None,
                            canonical_json(clip),
                        ),
                    )
            if editor_revision is not None:
                connection.execute(
                    """
                    INSERT INTO timeline_edit_revisions(
                        id, project_id, edit_project_id, parent_edit_project_id,
                        base_advanced_edit_plan_id, state_artifact_id, timeline_artifact_id,
                        overlay_artifact_id, editor_state_json, note, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        editor_revision["id"], project_id, edit_project_id,
                        editor_revision.get("parent_edit_project_id"),
                        editor_revision.get("base_advanced_edit_plan_id"),
                        editor_revision["state_artifact_id"], editor_revision["timeline_artifact_id"],
                        editor_revision["overlay_artifact_id"], canonical_json(editor_revision["state"]),
                        editor_revision.get("note", ""), timestamp,
                    ),
                )
            self._audit(connection, project_id, None, "production.timeline_created", {"edit_project_id": edit_project_id, "revision": revision})
            if editor_revision is not None:
                self._audit(
                    connection,
                    project_id,
                    None,
                    "timeline.revision_saved",
                    {"edit_project_id": edit_project_id, "revision": revision, "parent_edit_project_id": editor_revision.get("parent_edit_project_id")},
                )
        return edit_project_id

    def save_clip_preview(
        self,
        project_id: str,
        edit_project_id: str,
        clip_index: int,
        artifact_id: str,
        job_run_id: str,
    ) -> str:
        preview_id = uuid7()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO timeline_clip_previews(
                    id, project_id, edit_project_id, clip_index, artifact_id, job_run_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (preview_id, project_id, edit_project_id, clip_index, artifact_id, job_run_id, utc_now()),
            )
            self._audit(connection, project_id, job_run_id, "timeline.clip_preview_ready", {"edit_project_id": edit_project_id, "clip_index": clip_index, "artifact_id": artifact_id})
        return preview_id

    def get_clip_preview_artifact(self, project_id: str, edit_project_id: str, clip_index: int) -> dict[str, Any]:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT a.* FROM timeline_clip_previews p
                JOIN artifacts a ON a.id = p.artifact_id
                WHERE p.project_id = ? AND p.edit_project_id = ? AND p.clip_index = ? AND a.deleted_at IS NULL
                ORDER BY p.created_at DESC LIMIT 1
                """,
                (project_id, edit_project_id, clip_index),
            ).fetchone()
        if row is None:
            raise StudioError("TIMELINE_PREVIEW_NOT_READY", "The selected clip preview is not ready.", status_code=409)
        return self._artifact_dict(row)

    def create_render_job(self, project_id: str, edit_project_id: str, job_run_id: str, render_plan: dict[str, Any]) -> str:
        render_job_id = uuid7()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO render_jobs(
                    id, project_id, edit_project_id, job_run_id, render_kind,
                    status, render_plan_json, created_at
                ) VALUES (?, ?, ?, ?, 'final', 'RUNNING', ?, ?)
                """,
                (render_job_id, project_id, edit_project_id, job_run_id, canonical_json(render_plan), utc_now()),
            )
        return render_job_id

    def complete_render_job(self, project_id: str, render_job_id: str, artifact_id: str, ffmpeg_version: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE render_jobs SET artifact_id = ?, ffmpeg_version = ?, status = 'SUCCEEDED', completed_at = ?
                WHERE id = ?
                """,
                (artifact_id, ffmpeg_version, utc_now(), render_job_id),
            )
            self._audit(connection, project_id, None, "production.render_completed", {"render_job_id": render_job_id, "artifact_id": artifact_id})

    def create_quality_checks(self, render_job_id: str, checks: list[dict[str, str]]) -> None:
        with self.database.transaction() as connection:
            for check in checks:
                connection.execute(
                    """
                    INSERT INTO quality_checks(
                        id, render_job_id, check_id, check_version, dimension,
                        status, severity, message, measured_json, threshold_json,
                        evidence_artifact_ids_json, created_at
                    ) VALUES (?, ?, ?, '1.0', ?, ?, ?, ?, '{}', '{}', '[]', ?)
                    ON CONFLICT(render_job_id, check_id, check_version) DO UPDATE SET
                        dimension = excluded.dimension,
                        status = excluded.status,
                        severity = excluded.severity,
                        message = excluded.message,
                        created_at = excluded.created_at
                    """,
                    (
                        uuid7(), render_job_id, check["check_id"], check["dimension"],
                        check["status"], check["severity"], check["message"], utc_now(),
                    ),
                )

    def save_creative_package(
        self,
        project_id: str,
        brief_id: str,
        render_job_id: str,
        package_artifact_id: str,
        package: dict[str, Any],
    ) -> None:
        timestamp = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM creative_packages WHERE project_id = ? AND brief_id = ?",
                (project_id, brief_id),
            )
            connection.execute(
                """
                INSERT INTO creative_packages(
                    id, project_id, brief_id, render_job_id, package_artifact_id,
                    algorithm_version, status, selected_thumbnail_id,
                    selected_metadata_ids_json, package_json, created_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    package["id"], project_id, brief_id, render_job_id, package_artifact_id,
                    package["algorithm_version"], package["status"], package["selected_thumbnail_id"],
                    canonical_json(package["metadata"]["selected_by_platform"]), canonical_json(package), timestamp, timestamp,
                ),
            )
            for thumbnail in package["thumbnails"]:
                connection.execute(
                    """
                    INSERT INTO thumbnail_candidates(
                        id, project_id, artifact_id, source_segment_id, score, selected,
                        metadata_json, created_at, creative_package_id, source_frame_ids_json,
                        rank, template_key, headline, score_json, provenance_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        thumbnail["id"], project_id, thumbnail["artifact_id"], thumbnail.get("source_segment_id"),
                        thumbnail["score"], int(bool(thumbnail["selected"])),
                        canonical_json({"width": thumbnail["width"], "height": thumbnail["height"]}), timestamp,
                        package["id"], canonical_json(thumbnail["source_frame_ids"]), thumbnail["rank"],
                        thumbnail["template_key"], thumbnail["headline"], canonical_json(thumbnail["score_breakdown"]),
                        canonical_json(thumbnail["provenance"]),
                    ),
                )
            for metadata in package["metadata"]["variants"]:
                connection.execute(
                    """
                    INSERT INTO metadata_candidates(
                        id, project_id, platform, kind, content, score, selected, created_at,
                        creative_package_id, category, metadata_json, provenance_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        metadata["id"], project_id, metadata["platform"], metadata["kind"], metadata["title"],
                        metadata["score"], int(bool(metadata["selected"])), timestamp, package["id"], metadata["category"],
                        canonical_json({
                            "description": metadata["description"],
                            "short_description": metadata["short_description"],
                            "keywords": metadata["keywords"],
                            "hashtags": metadata["hashtags"],
                            "thumbnail_text": metadata["thumbnail_text"],
                            "pinned_comment": metadata["pinned_comment"],
                            "chapters": metadata["chapters"],
                            "score_breakdown": metadata["score_breakdown"],
                            "history_score": metadata["history_score"],
                        }),
                        canonical_json(metadata["provenance"]),
                    ),
                )
            self._audit(
                connection,
                project_id,
                None,
                "creative.completed",
                {
                    "creative_package_id": package["id"],
                    "thumbnail_count": len(package["thumbnails"]),
                    "metadata_variant_count": len(package["metadata"]["variants"]),
                },
            )

    def get_thumbnail_artifact(self, project_id: str, variant_id: str) -> dict[str, Any]:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT a.* FROM thumbnail_candidates tc
                JOIN artifacts a ON a.id = tc.artifact_id
                WHERE tc.id = ? AND tc.project_id = ? AND a.deleted_at IS NULL
                """,
                (variant_id, project_id),
            ).fetchone()
        if row is None:
            raise StudioError("CREATIVE_THUMBNAIL_NOT_FOUND", "Thumbnail variant not found.", status_code=404)
        return self._artifact_dict(row)

    def list_projects(self) -> list[dict[str, Any]]:
        with self.database.connect() as connection:
            rows = list(connection.execute(
                """
                SELECT p.*,
                    (SELECT COUNT(*) FROM job_runs j WHERE j.project_id = p.id) AS job_count,
                    (SELECT MAX(progress) FROM job_runs j WHERE j.project_id = p.id AND j.status = 'RUNNING') AS active_progress
                FROM projects p WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC
                """
            ))
        return [dict(row) for row in rows]

    def get_project(self, project_id: str) -> dict[str, Any]:
        with self.database.connect() as connection:
            project = connection.execute("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL", (project_id,)).fetchone()
            if project is None:
                raise StudioError("DOMAIN_PROJECT_NOT_FOUND", "Project not found.", status_code=404)
            media = [self._media_dict(row) for row in connection.execute("SELECT * FROM media_assets WHERE project_id = ? ORDER BY created_at", (project_id,))]
            jobs = [self._job_dict(row) for row in connection.execute("SELECT * FROM job_runs WHERE project_id = ? ORDER BY created_at", (project_id,))]
            proxy = connection.execute(
                """
                SELECT a.* FROM artifacts a
                JOIN media_derivatives d ON d.artifact_id = a.id
                JOIN media_assets m ON m.id = d.source_media_id
                WHERE m.project_id = ? AND d.kind = 'proxy' AND a.deleted_at IS NULL
                ORDER BY a.created_at DESC LIMIT 1
                """,
                (project_id,),
            ).fetchone()
            audits = [dict(row) for row in connection.execute(
                "SELECT event_type, payload_json, occurred_at FROM audit_events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 20",
                (project_id,),
            )]
            production = self._production_snapshot(connection, project_id)
            analysis = self._analysis_snapshot(connection, project_id)
        value = dict(project)
        value["media"] = media
        value["jobs"] = jobs
        value["proxy"] = self._artifact_dict(proxy) if proxy else None
        value["recent_events"] = [self._audit_dict(event) for event in audits]
        value["production"] = production
        value["analysis"] = analysis
        return value

    def _analysis_snapshot(self, connection: sqlite3.Connection, project_id: str) -> dict[str, Any]:
        run = connection.execute(
            """
            SELECT ar.* FROM analysis_runs ar
            JOIN editorial_briefs eb ON eb.id = ar.brief_id
            WHERE ar.project_id = ? AND eb.is_current = 1
            ORDER BY ar.created_at DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        if run is None:
            return {
                "run": None,
                "adapter": None,
                "summary": None,
                "guided_search": None,
                "frames": [],
                "texts": [],
                "entities": [],
                "events": [],
            }
        run_value = dict(run)
        summary_value = json.loads(run_value.pop("summary_json"))
        frames: list[dict[str, Any]] = []
        for row in connection.execute(
            """
            SELECT f.*, a.uri AS artifact_uri, a.sha256 AS artifact_sha256,
                   a.size_bytes AS artifact_size_bytes, a.media_type AS artifact_media_type
            FROM analysis_frames f JOIN artifacts a ON a.id = f.artifact_id
            WHERE f.analysis_run_id = ? AND a.deleted_at IS NULL
            ORDER BY f.timestamp_ms
            """,
            (run_value["id"],),
        ):
            frame = dict(row)
            frame["metrics"] = json.loads(frame.pop("metrics_json"))
            frame["detections"] = json.loads(frame.pop("detections_json"))
            frames.append(frame)
        texts: list[dict[str, Any]] = []
        for row in connection.execute(
            "SELECT * FROM detected_texts WHERE analysis_run_id = ? ORDER BY start_ms, confidence DESC",
            (run_value["id"],),
        ):
            value = dict(row)
            value["region"] = json.loads(value.pop("region_json")) if value.get("region_json") else None
            texts.append(value)
        entities: list[dict[str, Any]] = []
        for row in connection.execute(
            "SELECT * FROM detected_entities WHERE analysis_run_id = ? ORDER BY start_ms, confidence DESC",
            (run_value["id"],),
        ):
            value = dict(row)
            value["region"] = json.loads(value.pop("region_json")) if value.get("region_json") else None
            value["attributes"] = json.loads(value.pop("attributes_json"))
            entities.append(value)
        events: list[dict[str, Any]] = []
        for row in connection.execute(
            "SELECT * FROM detected_events WHERE analysis_run_id = ? ORDER BY start_ms, confidence DESC",
            (run_value["id"],),
        ):
            value = dict(row)
            value["attributes"] = json.loads(value.pop("attributes_json"))
            events.append(value)
        return {
            "run": run_value,
            "adapter": summary_value.get("adapter"),
            "summary": summary_value.get("summary"),
            "guided_search": summary_value.get("guided_search"),
            "frames": frames,
            "texts": texts,
            "entities": entities,
            "events": events,
        }

    def _production_snapshot(self, connection: sqlite3.Connection, project_id: str) -> dict[str, Any]:
        brief = connection.execute(
            "SELECT id, revision, raw_instruction, structured_json, confidence, created_at FROM editorial_briefs WHERE project_id = ? AND is_current = 1",
            (project_id,),
        ).fetchone()
        segments = list(connection.execute(
            "SELECT id, start_ms, end_ms, scene_type, summary, confidence FROM segments WHERE project_id = ? ORDER BY start_ms",
            (project_id,),
        ))
        narrative = self._narrative_snapshot(connection, project_id)
        evidence = self._evidence_snapshot(connection, project_id)
        advanced_edit = self._advanced_edit_snapshot(connection, project_id)
        creative_package = self._creative_package_snapshot(connection, project_id)
        script_row = connection.execute(
            "SELECT * FROM scripts WHERE project_id = ? AND selected = 1 ORDER BY revision DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        script: dict[str, Any] | None = None
        if script_row:
            blocks = []
            for row in connection.execute(
                """
                SELECT id, sort_order, purpose, narration, on_screen_text,
                       supporting_segment_ids_json, supporting_claim_ids_json,
                       estimated_duration_ms, confidence
                FROM script_blocks WHERE script_id = ? ORDER BY sort_order
                """,
                (script_row["id"],),
            ):
                block = dict(row)
                block["order"] = block.pop("sort_order")
                block["supporting_segment_ids"] = json.loads(block.pop("supporting_segment_ids_json"))
                block["supporting_claim_ids"] = json.loads(block.pop("supporting_claim_ids_json"))
                blocks.append(block)
            script = {**dict(script_row), "blocks": blocks, "full_text": " ".join(str(block["narration"]) for block in blocks)}
        voice = connection.execute(
            """
            SELECT vt.id, vt.script_id, vt.voice_id, vt.locale, vt.duration_ms, vt.alignment_json,
                   a.id AS artifact_id, a.uri AS artifact_uri, a.sha256 AS artifact_sha256, a.size_bytes AS artifact_size_bytes
            FROM voice_tracks vt JOIN artifacts a ON a.id = vt.artifact_id
            WHERE vt.project_id = ? ORDER BY vt.created_at DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        edit = connection.execute(
            "SELECT id, revision, duration, timeline_json, created_at FROM edit_projects WHERE project_id = ? ORDER BY revision DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        timeline_editor = None
        if edit:
            revision_row = connection.execute(
                """
                SELECT id, parent_edit_project_id, base_advanced_edit_plan_id, editor_state_json, note, created_at
                FROM timeline_edit_revisions WHERE edit_project_id = ?
                """,
                (edit["id"],),
            ).fetchone()
            previews = [dict(row) for row in connection.execute(
                """
                SELECT p.clip_index, p.artifact_id, a.sha256, p.created_at
                FROM timeline_clip_previews p JOIN artifacts a ON a.id = p.artifact_id
                WHERE p.edit_project_id = ? AND a.deleted_at IS NULL
                ORDER BY p.clip_index, p.created_at DESC
                """,
                (edit["id"],),
            )]
            latest_previews: dict[int, dict[str, Any]] = {}
            for preview in previews:
                latest_previews.setdefault(int(preview["clip_index"]), preview)
            if revision_row:
                revision_value = dict(revision_row)
                editor_state = json.loads(revision_value.pop("editor_state_json"))
                advanced_edit = editor_state
                timeline_editor = {
                    **revision_value,
                    "edit_project_id": edit["id"],
                    "revision": int(edit["revision"]),
                    "state": editor_state,
                    "previews": list(latest_previews.values()),
                }
            else:
                timeline_editor = {
                    "id": None,
                    "edit_project_id": edit["id"],
                    "revision": int(edit["revision"]),
                    "parent_edit_project_id": None,
                    "base_advanced_edit_plan_id": advanced_edit.get("id") if advanced_edit else None,
                    "state": advanced_edit,
                    "note": "",
                    "created_at": edit["created_at"],
                    "previews": list(latest_previews.values()),
                }
        render = connection.execute(
            """
            SELECT r.id, r.status, r.render_kind, r.ffmpeg_version, r.render_plan_json, r.created_at, r.completed_at,
                   a.id AS artifact_id, a.uri AS artifact_uri, a.sha256 AS artifact_sha256, a.size_bytes AS artifact_size_bytes,
                   a.metadata_json AS artifact_metadata_json
            FROM render_jobs r LEFT JOIN artifacts a ON a.id = r.artifact_id
            WHERE r.project_id = ? ORDER BY r.created_at DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        quality: list[dict[str, Any]] = []
        if render:
            quality = [dict(row) for row in connection.execute(
                "SELECT check_id, dimension, status, severity, message FROM quality_checks WHERE render_job_id = ? ORDER BY created_at",
                (render["id"],),
            )]
        production_artifacts: dict[str, dict[str, Any]] = {}
        for artifact_row in connection.execute(
            """
            SELECT * FROM artifacts
            WHERE project_id = ? AND kind IN (
                'scene_report','visual_analysis_report','narrative_map','coverage_report','content_plan',
                'evidence_report','script','voice','subtitles_srt','subtitles_ass','advanced_edit_plan',
                'overlay_ass','timeline','final_render','thumbnail_impact','thumbnail_clean','thumbnail_duo',
                'creative_package','timeline_edit_state','timeline_revision','clip_preview'
            )
              AND deleted_at IS NULL ORDER BY created_at
            """,
            (project_id,),
        ):
            production_artifacts[str(artifact_row["kind"])] = self._artifact_dict(artifact_row)
        brief_value = None
        if brief:
            brief_value = dict(brief)
            brief_value["structured"] = json.loads(brief_value.pop("structured_json"))
        voice_value = dict(voice) if voice else None
        if voice_value:
            voice_value["alignment"] = json.loads(voice_value.pop("alignment_json"))
        edit_value = dict(edit) if edit else None
        if edit_value:
            edit_value["timeline"] = json.loads(edit_value.pop("timeline_json"))
        render_value = dict(render) if render else None
        if render_value:
            render_value["render_plan"] = json.loads(render_value.pop("render_plan_json")) if render_value.get("render_plan_json") else None
            render_value["artifact_metadata"] = json.loads(render_value.pop("artifact_metadata_json")) if render_value.get("artifact_metadata_json") else None
        return {
            "brief": brief_value,
            "segments": [dict(row) for row in segments],
            "narrative": narrative,
            "evidence": evidence,
            "advanced_edit": advanced_edit,
            "timeline_editor": timeline_editor,
            "creative_package": creative_package,
            "script": script,
            "voice": voice_value,
            "edit": edit_value,
            "render": render_value,
            "quality_checks": quality,
            "artifacts": production_artifacts,
        }

    def _creative_package_snapshot(self, connection: sqlite3.Connection, project_id: str) -> dict[str, Any] | None:
        row = connection.execute(
            """
            SELECT cp.*, a.uri AS package_artifact_uri, a.sha256 AS package_artifact_sha256,
                   a.size_bytes AS package_artifact_size_bytes
            FROM creative_packages cp
            JOIN editorial_briefs eb ON eb.id = cp.brief_id
            JOIN artifacts a ON a.id = cp.package_artifact_id
            WHERE cp.project_id = ? AND eb.is_current = 1 AND a.deleted_at IS NULL
            ORDER BY cp.completed_at DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        if row is None:
            return None
        value = dict(row)
        package = json.loads(value.pop("package_json"))
        package["artifact_id"] = value["package_artifact_id"]
        package["artifact_uri"] = value["package_artifact_uri"]
        package["artifact_sha256"] = value["package_artifact_sha256"]
        package["artifact_size_bytes"] = value["package_artifact_size_bytes"]
        package["selected_thumbnail_id"] = value["selected_thumbnail_id"]
        package["metadata"]["selected_by_platform"] = json.loads(value["selected_metadata_ids_json"])
        package["created_at"] = value["created_at"]
        package["completed_at"] = value["completed_at"]
        return package

    def _advanced_edit_snapshot(self, connection: sqlite3.Connection, project_id: str) -> dict[str, Any] | None:
        row = connection.execute(
            """
            SELECT aep.*, pa.uri AS plan_artifact_uri, oa.uri AS overlay_artifact_uri
            FROM advanced_edit_plans aep
            JOIN editorial_briefs eb ON eb.id = aep.brief_id
            JOIN artifacts pa ON pa.id = aep.plan_artifact_id
            JOIN artifacts oa ON oa.id = aep.overlay_artifact_id
            WHERE aep.project_id = ? AND eb.is_current = 1
              AND pa.deleted_at IS NULL AND oa.deleted_at IS NULL
            ORDER BY aep.created_at DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        if row is None:
            return None
        value = dict(row)
        plan = json.loads(value.pop("plan_json"))
        return {
            "id": value["id"],
            "brief_id": value["brief_id"],
            "status": value["status"],
            "algorithm_version": value["algorithm_version"],
            "template_id": value["template_id"],
            "template_version": value["template_version"],
            "tracking_confidence": value["tracking_confidence"],
            "created_at": value["created_at"],
            "plan_artifact_id": value["plan_artifact_id"],
            "plan_artifact_uri": value["plan_artifact_uri"],
            "overlay_artifact_id": value["overlay_artifact_id"],
            "overlay_artifact_uri": value["overlay_artifact_uri"],
            "summary": plan.get("summary", {}),
            "clips": plan.get("clips", []),
            "subject_track": plan.get("subject_track", []),
            "overlays": plan.get("overlays", []),
            "transitions": plan.get("transitions", []),
            "audio_mix": plan.get("audio_mix", {}),
            "safe_area": plan.get("safe_area", {}),
            "safety": plan.get("safety", {}),
        }

    def _narrative_snapshot(self, connection: sqlite3.Connection, project_id: str) -> dict[str, Any] | None:
        map_row = connection.execute(
            "SELECT * FROM narrative_maps WHERE project_id = ? ORDER BY revision DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        if map_row is None:
            return None
        map_value = dict(map_row)
        beats: list[dict[str, Any]] = []
        for row in connection.execute(
            "SELECT * FROM narrative_beats WHERE narrative_map_id = ? ORDER BY sort_order",
            (map_value["id"],),
        ):
            beat = dict(row)
            beat["order"] = beat.pop("sort_order")
            beat["required"] = bool(beat["required"])
            beat["explicitly_requested"] = bool(beat["explicitly_requested"])
            beat["candidate_segments"] = json.loads(beat.pop("candidates_json"))
            beats.append(beat)
        map_value["version"] = map_value.pop("revision")
        map_value["beats"] = beats
        map_value["fact_boundary"] = "Intentions reliées à des observations candidates; aucun fait GTA n’est vérifié à cette étape."
        coverage_row = connection.execute(
            "SELECT report_json FROM coverage_reports WHERE narrative_map_id = ?",
            (map_value["id"],),
        ).fetchone()
        coverage = json.loads(str(coverage_row["report_json"])) if coverage_row else None
        plans: list[dict[str, Any]] = []
        for row in connection.execute(
            "SELECT plan_json FROM content_plans WHERE narrative_map_id = ? ORDER BY selected DESC, score DESC",
            (map_value["id"],),
        ):
            plans.append(json.loads(str(row["plan_json"])))
        selected_plan = next((plan for plan in plans if plan.get("selected")), None)
        return {
            "map": map_value,
            "coverage": coverage,
            "plans": plans,
            "selected_plan": selected_plan,
        }

    def _evidence_snapshot(self, connection: sqlite3.Connection, project_id: str) -> dict[str, Any] | None:
        run = connection.execute(
            """
            SELECT vr.* FROM verification_runs vr
            JOIN editorial_briefs eb ON eb.id = vr.brief_id
            WHERE vr.project_id = ? AND eb.is_current = 1
            ORDER BY vr.completed_at DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        if run is None:
            return None
        run_value = dict(run)
        summary = json.loads(run_value.pop("summary_json"))
        claims: list[dict[str, Any]] = []
        for row in connection.execute(
            "SELECT * FROM claims WHERE verification_run_id = ? ORDER BY created_at, claim_key",
            (run_value["id"],),
        ):
            claim = dict(row)
            claim["allowed_in_script"] = bool(claim["allowed_in_script"])
            claim["evidence"] = []
            for evidence_row in connection.execute(
                "SELECT * FROM evidence WHERE claim_id = ? ORDER BY created_at, id",
                (claim["id"],),
            ):
                evidence = dict(evidence_row)
                evidence["metadata"] = json.loads(evidence.pop("metadata_json"))
                claim["evidence"].append(evidence)
            claim["history"] = [dict(history) for history in connection.execute(
                """
                SELECT status, confidence, reason, origin, occurred_at
                FROM claim_status_history WHERE claim_id = ? ORDER BY occurred_at
                """,
                (claim["id"],),
            )]
            claims.append(claim)
        knowledge_items: list[dict[str, Any]] = []
        for row in connection.execute(
            """
            SELECT ki.*,
                   COALESCE((SELECT MAX(revision) FROM knowledge_revisions kr WHERE kr.knowledge_item_id = ki.id), 1) AS revision,
                   (SELECT COUNT(*) FROM knowledge_revisions kr WHERE kr.knowledge_item_id = ki.id) AS revision_count,
                   (SELECT COUNT(*) FROM knowledge_usages ku WHERE ku.knowledge_item_id = ki.id AND ku.project_id = ?) AS project_usage_count
            FROM knowledge_items ki
            WHERE ki.game_id = ? AND ki.namespace = ?
            ORDER BY ki.canonical_key
            """,
            (project_id, run_value["game_id"], run_value["game_id"]),
        ):
            item = dict(row)
            item["value"] = json.loads(item.pop("value_json"))
            knowledge_items.append(item)
        cross_game_count = int(connection.execute(
            """
            SELECT COUNT(*) FROM knowledge_items
            WHERE game_id <> ? AND id IN (
                SELECT knowledge_item_id FROM knowledge_usages WHERE project_id = ?
            )
            """,
            (run_value["game_id"], project_id),
        ).fetchone()[0])
        return {
            "run": run_value,
            "summary": summary.get("summary", {}),
            "gate": summary.get("gate", {}),
            "requested_facts": summary.get("requested_facts", []),
            "knowledge_snapshot": summary.get("knowledge_snapshot", {}),
            "claims": claims,
            "knowledge_items": knowledge_items,
            "cross_game_item_count": cross_game_count,
        }

    def get_artifact(self, artifact_id: str) -> dict[str, Any]:
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NULL", (artifact_id,)).fetchone()
        if row is None:
            raise StudioError("STORAGE_ARTIFACT_NOT_FOUND", "Artifact not found.", status_code=404)
        return self._artifact_dict(row)

    def create_preview_cache_entry(
        self, cache_key: str, render_profile: str, renderer_version: str, job_run_id: str,
    ) -> None:
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO preview_cache_entries
                   (cache_key, status, render_profile, renderer_version, job_run_id, created_at, last_accessed_at)
                   VALUES (?, 'pending', ?, ?, ?, ?, ?)
                   ON CONFLICT(cache_key) DO UPDATE SET
                       status = 'pending', job_run_id = excluded.job_run_id, last_accessed_at = excluded.last_accessed_at
                   WHERE status IN ('failed', 'corrupted')""",
                (cache_key, render_profile, renderer_version, job_run_id, now, now),
            )

    def find_preview_cache_entry(self, cache_key: str) -> dict[str, Any] | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM preview_cache_entries WHERE cache_key = ?", (cache_key,)
            ).fetchone()
        return dict(row) if row else None

    def complete_preview_cache(
        self, cache_key: str, artifact_uri: str, sha256: str, size_bytes: int,
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """UPDATE preview_cache_entries
                   SET status = 'ready', artifact_uri = ?, artifact_sha256 = ?, size_bytes = ?,
                       last_accessed_at = ?
                   WHERE cache_key = ?""",
                (artifact_uri, sha256, size_bytes, utc_now(), cache_key),
            )

    def fail_preview_cache(self, cache_key: str, error_message: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE preview_cache_entries SET status = 'failed', error_message = ? WHERE cache_key = ?",
                (error_message, cache_key),
            )

    def touch_preview_cache(self, cache_key: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE preview_cache_entries SET last_accessed_at = ?, hit_count = hit_count + 1 WHERE cache_key = ?",
                (utc_now(), cache_key),
            )

    def mark_preview_corrupted(self, cache_key: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE preview_cache_entries SET status = 'corrupted' WHERE cache_key = ?",
                (cache_key,),
            )

    def link_project_preview(self, project_id: str, cache_key: str, clip_id: str) -> None:
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO project_preview_cache_refs (project_id, cache_key, clip_id, created_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(project_id, cache_key, clip_id) DO NOTHING""",
                (project_id, cache_key, clip_id, now),
            )
            connection.execute(
                """UPDATE preview_cache_entries SET ref_count = (
                       SELECT COUNT(*) FROM project_preview_cache_refs WHERE cache_key = ?
                   ) WHERE cache_key = ?""",
                (cache_key, cache_key),
            )

    def evict_preview_cache_lru(self, max_bytes: int, max_entries: int) -> list[str]:
        """Remove LRU cache entries exceeding quota. Returns artifact URIs to delete."""
        with self.database.transaction() as connection:
            rows = list(connection.execute(
                """SELECT cache_key, artifact_uri, size_bytes FROM preview_cache_entries
                   WHERE status IN ('ready', 'corrupted', 'failed')
                   ORDER BY last_accessed_at ASC"""
            ))
            total_bytes_row = connection.execute(
                "SELECT SUM(size_bytes) as total FROM preview_cache_entries WHERE status = 'ready'"
            ).fetchone()
            total_bytes = int(total_bytes_row["total"]) if total_bytes_row and total_bytes_row["total"] else 0
            
            total_entries_row = connection.execute(
                "SELECT COUNT(*) as cnt FROM preview_cache_entries WHERE status = 'ready'"
            ).fetchone()
            total_entries = int(total_entries_row["cnt"]) if total_entries_row else 0
            
            uris_to_delete: list[str] = []
            keys_to_delete: list[str] = []
            for row in rows:
                if total_bytes <= max_bytes and total_entries <= max_entries:
                    break
                key = str(row["cache_key"])
                ref = connection.execute(
                    "SELECT ref_count FROM preview_cache_entries WHERE cache_key = ?", (key,)
                ).fetchone()
                if ref and int(ref["ref_count"]) > 0:
                    continue
                keys_to_delete.append(key)
                if row["artifact_uri"]:
                    uris_to_delete.append(str(row["artifact_uri"]))
                total_bytes -= int(row["size_bytes"])
                total_entries -= 1
            
            for key in keys_to_delete:
                connection.execute("DELETE FROM preview_cache_entries WHERE cache_key = ?", (key,))
            
            return uris_to_delete

    def get_preview_cache_stats(self) -> dict[str, Any]:
        """Récupère les statistiques globales du cache de preview."""
        with self.database.connect() as connection:
            # Stats globales
            stats_row = connection.execute(
                """SELECT
                    COUNT(*) as total_entries,
                    SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready_count,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
                    SUM(CASE WHEN status = 'rendering' THEN 1 ELSE 0 END) as rendering_count,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
                    SUM(CASE WHEN status = 'corrupted' THEN 1 ELSE 0 END) as corrupted_count,
                    SUM(size_bytes) as total_bytes,
                    SUM(hit_count) as total_hits,
                    AVG(ref_count) as avg_ref_count
                FROM preview_cache_entries"""
            ).fetchone()

            # Cache hit rate (basé sur hit_count vs entries)
            total_hits = int(stats_row["total_hits"]) if stats_row["total_hits"] else 0
            ready_count = int(stats_row["ready_count"]) if stats_row["ready_count"] else 0
            cache_hit_rate = (total_hits / (total_hits + ready_count)) if (total_hits + ready_count) > 0 else 0.0

            # Top 10 entries by hit_count
            top_entries = list(connection.execute(
                """SELECT cache_key, hit_count, ref_count, size_bytes, created_at, last_accessed_at
                   FROM preview_cache_entries
                   WHERE status = 'ready'
                   ORDER BY hit_count DESC
                   LIMIT 10"""
            ))

            return {
                "total_entries": int(stats_row["total_entries"]),
                "ready_count": ready_count,
                "pending_count": int(stats_row["pending_count"]) if stats_row["pending_count"] else 0,
                "rendering_count": int(stats_row["rendering_count"]) if stats_row["rendering_count"] else 0,
                "failed_count": int(stats_row["failed_count"]) if stats_row["failed_count"] else 0,
                "corrupted_count": int(stats_row["corrupted_count"]) if stats_row["corrupted_count"] else 0,
                "total_bytes": int(stats_row["total_bytes"]) if stats_row["total_bytes"] else 0,
                "total_hits": total_hits,
                "cache_hit_rate": round(cache_hit_rate, 3),
                "avg_ref_count": round(float(stats_row["avg_ref_count"]), 2) if stats_row["avg_ref_count"] else 0.0,
                "top_entries": [dict(row) for row in top_entries],
            }

    def get_preview_render_metrics(self) -> dict[str, Any]:
        """Récupère les métriques de performance du rendu de preview."""
        with self.database.connect() as connection:
            # Métriques sur les jobs RENDER_CLIP_PREVIEW
            metrics_row = connection.execute(
                """SELECT
                    COUNT(*) as total_jobs,
                    SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_count,
                    SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed_count,
                    SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) as running_count,
                    SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending_count,
                    AVG(CASE WHEN status = 'COMPLETED' AND duration_ms IS NOT NULL
                        THEN duration_ms ELSE NULL END) as avg_duration_ms,
                    MIN(CASE WHEN status = 'COMPLETED' AND duration_ms IS NOT NULL
                        THEN duration_ms ELSE NULL END) as min_duration_ms,
                    MAX(CASE WHEN status = 'COMPLETED' AND duration_ms IS NOT NULL
                        THEN duration_ms ELSE NULL END) as max_duration_ms
                FROM job_runs
                WHERE job_type = 'RENDER_CLIP_PREVIEW'
                AND created_at > datetime('now', '-7 days')"""
            ).fetchone()

            # Derniers échecs
            recent_failures = list(connection.execute(
                """SELECT id, error_code, error_message, created_at, completed_at
                   FROM job_runs
                   WHERE job_type = 'RENDER_CLIP_PREVIEW' AND status = 'FAILED'
                   ORDER BY created_at DESC
                   LIMIT 5"""
            ))

            return {
                "total_jobs_7d": int(metrics_row["total_jobs"]) if metrics_row["total_jobs"] else 0,
                "completed_count": int(metrics_row["completed_count"]) if metrics_row["completed_count"] else 0,
                "failed_count": int(metrics_row["failed_count"]) if metrics_row["failed_count"] else 0,
                "running_count": int(metrics_row["running_count"]) if metrics_row["running_count"] else 0,
                "pending_count": int(metrics_row["pending_count"]) if metrics_row["pending_count"] else 0,
                "avg_duration_ms": round(float(metrics_row["avg_duration_ms"]), 2) if metrics_row["avg_duration_ms"] else None,
                "min_duration_ms": int(metrics_row["min_duration_ms"]) if metrics_row["min_duration_ms"] else None,
                "max_duration_ms": int(metrics_row["max_duration_ms"]) if metrics_row["max_duration_ms"] else None,
                "recent_failures": [dict(row) for row in recent_failures],
            }

    def _audit(
        self,
        connection: sqlite3.Connection,
        project_id: str | None,
        job_id: str | None,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        connection.execute(
            """
            INSERT INTO audit_events(id, project_id, job_id, actor_type, actor_id, event_type, payload_json, occurred_at)
            VALUES (?, ?, ?, 'system', 'local-api', ?, ?, ?)
            """,
            (uuid7(), project_id, job_id, event_type, canonical_json(payload), utc_now()),
        )

    @staticmethod
    def _job_dict(row: sqlite3.Row | None) -> dict[str, Any]:
        if row is None:
            return {}
        value = dict(row)
        value["parameters"] = json.loads(value.pop("parameters_json"))
        value["error_details"] = json.loads(value.pop("error_details_json")) if value.get("error_details_json") else None
        return value

    @staticmethod
    def _media_dict(row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        value["metadata"] = json.loads(value.pop("metadata_json"))
        return value

    @staticmethod
    def _artifact_dict(row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        value["metadata"] = json.loads(value.pop("metadata_json"))
        return value

    @staticmethod
    def _audit_dict(value: dict[str, Any]) -> dict[str, Any]:
        payload = json.loads(str(value.pop("payload_json")))
        value["payload"] = payload
        return value
