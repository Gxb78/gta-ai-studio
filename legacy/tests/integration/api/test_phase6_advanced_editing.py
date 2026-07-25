from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from gta_studio_api.config import REPO_ROOT
from gta_studio_api.editing_intelligence import build_advanced_edit_plan, load_edit_template, write_overlay_ass
from gta_studio_api.ids import uuid7
from gta_studio_api.media import MediaTools
from gta_studio_api.render import VerticalRenderer


def test_advanced_edit_plan_tracks_subject_and_builds_before_after(tmp_path: Path) -> None:
    project_id, brief_id = uuid7(), uuid7()
    first_segment, second_segment = uuid7(), uuid7()
    first_frame, second_frame = uuid7(), uuid7()
    observed_text_id = uuid7()
    image_path = tmp_path / "attention.jpg"
    image = np.zeros((360, 640, 3), dtype=np.uint8)
    cv2.rectangle(image, (430, 80), (610, 300), (20, 220, 255), -1)
    assert cv2.imwrite(str(image_path), image)
    template = load_edit_template(REPO_ROOT / "templates", "dynamic")
    plan = build_advanced_edit_plan(
        project_id=project_id,
        brief_id=brief_id,
        structured_brief={
            "content_type": "vehicle_customization",
            "production": {"composition": "center_crop", "source_audio_level": 0.12},
        },
        clips=[
            {"start_ms": 0, "end_ms": 1500, "duration_ms": 1500, "supporting_segment_ids": [first_segment]},
            {"start_ms": 2200, "end_ms": 3700, "duration_ms": 1500, "supporting_segment_ids": [second_segment]},
        ],
        script={"blocks": [{
            "supporting_segment_ids": [second_segment],
            "supporting_claim_ids": [uuid7()],
        }]},
        content_plan={"beats": [
                {"segment_ids": [first_segment], "purpose": "proof", "concept": "stats"},
            {"segment_ids": [second_segment], "purpose": "proof", "concept": "final_result"},
        ]},
        narrative_map={"beats": [
            {"concept": "original_appearance", "status": "found", "candidate_segments": [{"segment_id": first_segment, "start_ms": 0}]},
            {"concept": "final_result", "status": "found", "candidate_segments": [{"segment_id": second_segment, "start_ms": 2200}]},
        ]},
        verification_report={
            "claims": [{"allowed_in_script": True, "evidence": [{"source_id": observed_text_id}]}],
            "gate": {"admitted_claim_ids": []},
        },
        analysis={
            "frames": [
                {"id": first_frame, "segment_id": first_segment, "timestamp_ms": 500, "metrics": {"motion": 0.08}, "detections": {}},
                {"id": second_frame, "segment_id": second_segment, "timestamp_ms": 2500, "metrics": {"motion": 0.05}, "detections": {"menu_id": "vehicle_mod"}},
            ],
            "texts": [{"id": observed_text_id, "frame_id": second_frame, "confidence": 0.9, "region": {"x": 0.7, "y": 0.2, "width": 0.2, "height": 0.3}}],
            "entities": [],
        },
        frame_paths={first_frame: image_path, second_frame: image_path},
        template=template,
        source_duration_ms=5000,
    )

    assert len(plan["subject_track"]) == 2
    assert plan["summary"]["dynamic_reframe_count"] >= 1
    assert plan["summary"]["comparison_count"] == 1
    assert plan["summary"]["zoom_effect_count"] >= 1
    assert plan["clips"][-1]["reframe_mode"] == "split_screen"
    assert any(cue["cue_type"] == "before_after" for cue in plan["overlays"])
    overlay_path = tmp_path / "overlays.ass"
    write_overlay_ass(plan, overlay_path)
    overlay_text = overlay_path.read_text(encoding="utf-8-sig")
    assert "Style: Compare" in overlay_text
    assert "AVANT" in overlay_text


def test_renderer_command_contains_phase6_filters(tmp_path: Path) -> None:
    media = MediaTools("ffmpeg", "ffprobe", 1280, 28, "veryfast")
    renderer = VerticalRenderer(media, 360, 640, 24, "ultrafast")
    command = renderer.build_command(
        tmp_path / "source.mp4",
        tmp_path / "voice.wav",
        tmp_path / "captions.ass",
        tmp_path / "output.mp4",
        [{
            "start_ms": 0,
            "duration_ms": 2000,
            "source_duration_ms": 2400,
            "speed": 1.2,
            "reframe_mode": "dynamic_crop",
            "focus_start_x": 0.25,
            "focus_end_x": 0.75,
            "focus_y": 0.5,
            "zoom": 1.1,
        }],
        composition="center_crop",
        source_has_audio=True,
        source_audio_level=0.1,
        duration_ms=2000,
        overlays=tmp_path / "overlays.ass",
        audio_mix={"target_lufs": -14, "true_peak_db": -1, "ducking_ratio": 9},
    )
    filters = command[command.index("-filter_complex") + 1]
    assert "crop=360:640" in filters
    assert "atempo=1.20000" in filters
    assert filters.count("ass=filename=") == 2
    assert "sidechaincompress" in filters
    assert "loudnorm=I=-14.0:TP=-1.0" in filters


def test_clip_preview_command_uses_selected_manual_focus(tmp_path: Path) -> None:
    media = MediaTools("ffmpeg", "ffprobe", 1280, 28, "veryfast", "cpu")
    renderer = VerticalRenderer(media, 360, 640, 24, "ultrafast")
    command = renderer.build_clip_preview_command(
        tmp_path / "source.mp4",
        tmp_path / "preview.mp4",
        {
            "start_ms": 800,
            "duration_ms": 1500,
            "source_duration_ms": 1800,
            "speed": 1.2,
            "reframe_mode": "dynamic_crop",
            "focus_start_x": 0.22,
            "focus_end_x": 0.78,
            "focus_y": 0.44,
            "zoom": 1.08,
        },
        composition="smart_blur",
        source_has_audio=True,
    )
    filters = command[command.index("-filter_complex") + 1]
    assert "crop=540:960" in filters
    assert "0.220000" in filters and "0.560000" in filters
    assert "atempo=1.20000" in filters
    assert "libx264" in command
