from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from gta_studio_api.config import REPO_ROOT, Settings
from gta_studio_api.main import create_app
from gta_studio_api.service import StudioService


FIXTURE = REPO_ROOT / "tests" / "fixtures" / "demo-gameplay.mp4"


def test_import_to_verified_proxy_pipeline(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        health = client.get("/api/v1/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"

        response = client.post(
            "/api/v1/projects/import",
            json={
                "source_path": str(FIXTURE),
                "title": "Démo Phase 1",
                "game_id": "gta5",
                "copy_mode": "managed",
            },
        )
        assert response.status_code == 202, response.text
        project_id = response.json()["id"]
        project = wait_for_project(client, project_id)

        assert project["pipeline_stage"] == "PROXIED"
        assert project["run_status"] == "COMPLETED"
        assert len(project["media"]) == 1
        assert project["media"][0]["duration_ms"] > 0
        assert project["media"][0]["width"] == 1280
        assert [job["status"] for job in project["jobs"]] == ["SUCCEEDED", "SUCCEEDED"]
        assert project["proxy"] is not None

        proxy = client.get(project["proxy_url"])
        assert proxy.status_code == 200
        assert proxy.headers["content-type"].startswith("video/mp4")
        assert len(proxy.content) > 1_000


def test_duplicate_source_reuses_content_addressed_proxy(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        artifact_ids: list[str] = []
        for title in ("Première importation", "Seconde importation"):
            response = client.post(
                "/api/v1/projects/import",
                json={"source_path": str(FIXTURE), "title": title, "game_id": "gta5", "copy_mode": "managed"},
            )
            assert response.status_code == 202
            project = wait_for_project(client, response.json()["id"])
            artifact_ids.append(project["proxy"]["id"])
        assert artifact_ids[0] == artifact_ids[1]


def test_startup_recovers_an_abandoned_running_job(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    first = StudioService(settings)
    first.initialize()
    project_id = first.repository.create_project("Crash recovery", "gta5", "PROXIED")
    first.repository.update_stage(project_id, "CREATED", "SOURCE_SELECTED", event="project.source_selected")
    job_id = first.repository.enqueue_job(
        project_id,
        "INGEST_SOURCE",
        {"resolved_source_path": str(FIXTURE)},
        "a" * 64,
        "ingest-v1",
    )
    claimed = first.repository.claim_job("dead-worker", 300)
    assert claimed is not None and claimed["id"] == job_id and claimed["status"] == "RUNNING"

    restarted = StudioService(settings)
    restarted.initialize()
    recovered = restarted.repository.get_project(project_id)
    assert recovered["jobs"][0]["status"] == "QUEUED"
    assert any(event["event_type"] == "job.recovered" for event in recovered["recent_events"])


def make_settings(tmp_path: Path) -> Settings:
    data_dir = tmp_path / "data"
    return Settings(
        environment="test",
        data_dir=data_dir,
        database_path=data_dir / "studio.db",
        migration_dir=REPO_ROOT / "packages" / "database" / "migrations",
        worker_poll_interval_seconds=0.05,
        worker_lease_seconds=5,
        proxy_max_width=640,
    )


def wait_for_project(client: TestClient, project_id: str, timeout: float = 30) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    last: dict[str, object] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/projects/{project_id}")
        assert response.status_code == 200
        last = response.json()
        if last["run_status"] == "COMPLETED":
            return last
        if last["run_status"] in {"FAILED_FINAL", "CANCELLED"}:
            raise AssertionError(last)
        time.sleep(0.1)
    raise AssertionError(f"Project did not complete before timeout: {last}")
