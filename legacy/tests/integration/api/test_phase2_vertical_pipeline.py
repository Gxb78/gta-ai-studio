from __future__ import annotations

import time
from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

from gta_studio_api.config import REPO_ROOT, Settings
from gta_studio_api.main import create_app


FIXTURE = REPO_ROOT / "tests" / "fixtures" / "demo-gameplay.mp4"


def test_brief_to_vertical_render_pipeline(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    with TestClient(create_app(settings)) as client:
        imported = client.post(
            "/api/v1/projects/import",
            json={"source_path": str(FIXTURE), "title": "Vertical slice", "game_id": "gta5", "copy_mode": "managed"},
        )
        assert imported.status_code == 202, imported.text
        project_id = imported.json()["id"]
        wait_for_stage(client, project_id, "PROXIED")

        voices = client.get("/api/v1/voices")
        assert voices.status_code == 200
        assert voices.json()
        selected_voice = voices.json()[0]["id"]

        started = client.post(
            f"/api/v1/projects/{project_id}/produce",
            json={
                "brief": "montrer cette courte démonstration locale",
                "target_duration_seconds": 3,
                "editorial_style": "dynamic",
                "voice_id": selected_voice,
                "voice_rate": 2,
                "caption_style": "minimal",
                "composition": "smart_blur",
                "source_audio_level": 0.08,
                "include_hook": False,
                "include_cta": False,
            },
        )
        assert started.status_code == 202, started.text
        project = wait_for_stage(client, project_id, "READY_TO_PUBLISH", timeout=120)

        assert project["run_status"] == "COMPLETED"
        assert project["production"]["script"]["full_text"].startswith("On teste :")
        assert project["production"]["render"]["artifact_metadata"]["width"] == 360
        assert project["production"]["render"]["artifact_metadata"]["height"] == 640
        assert project["production"]["render_url"]
        assert len(project["production"]["segments"]) >= 1
        assert all(check["status"] == "pass" for check in project["production"]["quality_checks"])
        assert project["analysis"]["run"]["status"] == "SUCCEEDED"
        assert project["analysis"]["summary"]["frame_count"] >= 1
        assert project["analysis"]["adapter"]["id"] == "studio.game-adapter.gta5"
        assert project["production"]["narrative"]["map"]["beats"]
        assert len(project["production"]["narrative"]["plans"]) == 3
        assert project["production"]["narrative"]["selected_plan"]["selected"] is True
        assert project["production"]["narrative"]["coverage"]["editing_decision"]
        assert {"BUILD_NARRATIVE_MAP", "PLAN_CONTENT", "VERIFY_FACTS", "PLAN_ADVANCED_EDIT", "GENERATE_CREATIVE_PACKAGE"} <= {job["kind"] for job in project["jobs"]}
        assert project["production"]["evidence"]["run"]["status"] in {"PASSED", "PASSED_WITH_EXCLUSIONS"}
        assert project["production"]["evidence"]["knowledge_snapshot"]["namespace"] == "gta5"
        assert project["production"]["evidence"]["cross_game_item_count"] == 0
        assert project["production"]["evidence"]["claims"]
        assert all(
            claim["evidence"] or not claim["allowed_in_script"]
            for claim in project["production"]["evidence"]["claims"]
        )
        assert all(
            set(block["supporting_claim_ids"]) <= set(project["production"]["evidence"]["gate"]["admitted_claim_ids"])
            for block in project["production"]["script"]["blocks"]
        )
        advanced_edit = project["production"]["advanced_edit"]
        assert advanced_edit["status"] in {"READY", "READY_WITH_FALLBACKS"}
        assert advanced_edit["summary"]["track_point_count"] >= 1
        assert advanced_edit["summary"]["overlay_count"] >= 1
        assert advanced_edit["audio_mix"]["strategy"] == "voice_priority_sidechain_with_loudness_target"
        assert {"advanced_edit_plan", "overlay_ass"} <= set(project["production"]["artifacts"])
        timeline_tracks = project["production"]["edit"]["timeline"]["tracks"]
        assert any(track["kind"] == "overlay" for track in timeline_tracks)
        assert any(
            effect["type"] == "subject_reframe"
            for track in timeline_tracks if track["kind"] == "video"
            for clip in track["clips"]
            for effect in clip["effects"]
        )
        admitted_overlay_claims = set(project["production"]["evidence"]["gate"]["admitted_claim_ids"])
        assert all(set(cue["supporting_claim_ids"]) <= admitted_overlay_claims for cue in advanced_edit["overlays"])
        creative = project["production"]["creative_package"]
        assert creative["status"] in {"READY", "READY_WITH_WARNINGS"}
        assert len(creative["thumbnails"]) == 3
        assert len(creative["metadata"]["variants"]) == 18
        assert set(creative["metadata"]["selected_by_platform"]) == {"youtube_shorts", "tiktok", "instagram_reels"}
        assert all(0 <= item["score"] <= 1 for item in creative["thumbnails"])
        assert all(0 <= item["score"] <= 1 for item in creative["metadata"]["variants"])
        thumbnail = client.get(creative["thumbnails"][0]["url"])
        assert thumbnail.status_code == 200
        assert thumbnail.headers["content-type"].startswith("image/jpeg")
        decoded_thumbnail = cv2.imdecode(np.frombuffer(thumbnail.content, dtype=np.uint8), cv2.IMREAD_COLOR)
        assert decoded_thumbnail.shape[:2] == (720, 1280)
        creative_export = client.get(creative["download_url"])
        assert creative_export.status_code == 200
        assert creative_export.json()["id"] == creative["id"]
        first_frame = project["analysis"]["frames"][0]
        frame_response = client.get(first_frame["url"])
        assert frame_response.status_code == 200
        assert frame_response.headers["content-type"].startswith("image/jpeg")

        rendered = client.get(project["production"]["render_url"])
        assert rendered.status_code == 200
        assert rendered.headers["content-type"].startswith("video/mp4")
        assert len(rendered.content) > 10_000

        subtitles = client.get(project["production"]["subtitles_url"])
        assert subtitles.status_code == 200
        assert "On teste" in subtitles.content.decode("utf-8")

        editor = project["production"]["timeline_editor"]
        assert editor["revision"] == 1
        edited_clips = project["production"]["advanced_edit"]["clips"]
        edited_clips[0]["focus_start_x"] = 0.31
        edited_clips[0]["focus_end_x"] = 0.67
        edited_overlays = project["production"]["advanced_edit"]["overlays"]
        edited_overlays[0]["text"] = "TEXTE MANUEL"
        edited_overlays[0]["manual_override"] = True
        edited_overlays[0]["enabled"] = True
        saved = client.post(
            f"/api/v1/projects/{project_id}/timeline/revisions",
            json={
                "base_edit_project_id": editor["edit_project_id"],
                "expected_revision": editor["revision"],
                "clips": edited_clips,
                "overlays": edited_overlays,
                "note": "Ajustement manuel du focus",
            },
        )
        assert saved.status_code == 201, saved.text
        edited_project = saved.json()
        assert edited_project["production"]["edit"]["revision"] == 2
        assert edited_project["production"]["timeline_editor"]["parent_edit_project_id"] == editor["edit_project_id"]
        assert edited_project["production"]["advanced_edit"]["clips"][0]["focus_start_x"] == 0.31
        assert edited_project["production"]["advanced_edit"]["overlays"][0]["supporting_claim_ids"] == []

        # Utiliser le nouveau format ClipPreviewRequest
        first_clip = edited_project["production"]["advanced_edit"]["clips"][0]
        clip_id = first_clip["id"]
        timeline_revision = edited_project["production"]["edit"]["revision"]

        from gta_studio_api.ids import uuid7
        preview_started = client.post(
            f"/api/v1/projects/{project_id}/timeline/preview",
            json={
                "client_request_id": str(uuid7()),
                "edit_project_id": edited_project["production"]["edit"]["id"],
                "clip_id": clip_id,
                "timeline_revision": timeline_revision,
                "clip_revision": 0,
                "render_profile": "draft",
                "preview_window": None,
            },
        )
        assert preview_started.status_code == 202, preview_started.text
        preview_response_data = preview_started.json()
        assert preview_response_data["status"] in ["pending", "ready"]
        assert preview_response_data["clip_id"] == clip_id

        # Attendre la completion du job
        preview_project = wait_for_clip_preview(client, project_id, timeout=60)

        # Vérifier que l'artefact est disponible
        if preview_response_data.get("artifact_url"):
            artifact_response = client.get(preview_response_data["artifact_url"])
            assert artifact_response.status_code == 200
            assert artifact_response.headers["content-type"].startswith("video/mp4")
            assert len(artifact_response.content) > 2_000

        first_render = project["production"]["render"]
        variant = client.post(
            f"/api/v1/projects/{project_id}/produce",
            json={
                "brief": "créer une variante plus posée de cette démonstration",
                "target_duration_seconds": 3,
                "editorial_style": "cinematic",
                "voice_id": selected_voice,
                "voice_rate": 0,
                "caption_style": "impact",
                "composition": "center_crop",
                "source_audio_level": 0.12,
                "include_hook": False,
                "include_cta": False,
            },
        )
        assert variant.status_code == 202, variant.text
        assert variant.json()["production"]["brief"]["revision"] == 2
        remixed = wait_for_revision_complete(client, project_id, revision=2, timeout=120)
        assert remixed["production"]["render"]["artifact_id"] != first_render["artifact_id"]
        assert remixed["production"]["render"]["artifact_uri"] != first_render["artifact_uri"]
        assert remixed["production"]["render"]["render_plan"]["composition"] == "center_crop"
        assert "créer" in remixed["production"]["script"]["full_text"]
        assert "?" not in remixed["production"]["script"]["full_text"]


def make_settings(tmp_path: Path) -> Settings:
    data_dir = tmp_path / "data"
    return Settings(
        environment="test",
        data_dir=data_dir,
        database_path=data_dir / "studio.db",
        migration_dir=REPO_ROOT / "packages" / "database" / "migrations",
        worker_poll_interval_seconds=0.05,
        worker_lease_seconds=30,
        proxy_max_width=640,
        proxy_preset="ultrafast",
        render_width=360,
        render_height=640,
        render_crf=28,
        render_preset="ultrafast",
    )


def wait_for_stage(client: TestClient, project_id: str, target: str, timeout: float = 60) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    last: dict[str, object] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/projects/{project_id}")
        assert response.status_code == 200
        last = response.json()
        if last["pipeline_stage"] == target:
            return last
        if last["run_status"] in {"FAILED_FINAL", "CANCELLED"}:
            raise AssertionError(last)
        time.sleep(0.15)
    raise AssertionError(f"Project did not reach {target}: {last}")


def wait_for_revision_complete(client: TestClient, project_id: str, revision: int, timeout: float = 60) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    last: dict[str, object] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/projects/{project_id}")
        assert response.status_code == 200
        last = response.json()
        brief = last.get("production", {}).get("brief")
        if brief and brief["revision"] == revision and last["run_status"] == "COMPLETED":
            return last
        if last["run_status"] in {"FAILED_FINAL", "CANCELLED"}:
            raise AssertionError(last)
        time.sleep(0.15)
    raise AssertionError(f"Project revision {revision} did not complete: {last}")


def wait_for_clip_preview(client: TestClient, project_id: str, timeout: float = 60) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    last: dict[str, object] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/projects/{project_id}")
        assert response.status_code == 200
        last = response.json()
        editor = last.get("production", {}).get("timeline_editor")
        if editor and editor.get("previews") and last["run_status"] == "COMPLETED":
            return last
        failed_preview = next((job for job in last.get("jobs", []) if job["kind"] == "RENDER_CLIP_PREVIEW" and job["status"] == "FAILED"), None)
        if failed_preview:
            raise AssertionError(failed_preview)
        time.sleep(0.15)
    raise AssertionError(f"Clip preview did not complete: {last}")
