from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from gta_studio_api.creative_intelligence import build_creative_package, render_thumbnail_variants
from gta_studio_api.ids import uuid7


def test_creative_package_scores_observed_frames_and_excludes_unverified_subject(tmp_path: Path) -> None:
    project_id, brief_id = uuid7(), uuid7()
    segment_ids = [uuid7(), uuid7(), uuid7()]
    frame_ids = [uuid7(), uuid7(), uuid7()]
    frame_paths: dict[str, Path] = {}
    frames = []
    for index, frame_id in enumerate(frame_ids):
        image = np.zeros((360, 640, 3), dtype=np.uint8)
        image[:] = (20 + index * 8, 35 + index * 12, 48 + index * 18)
        cv2.rectangle(image, (260 - index * 35, 70), (570, 310), (35, 180, 245), -1)
        path = tmp_path / f"frame-{index}.jpg"
        assert cv2.imwrite(str(path), image)
        frame_paths[frame_id] = path
        frames.append({
            "id": frame_id,
            "segment_id": segment_ids[index],
            "timestamp_ms": index * 3_000,
            "metrics": {
                "brightness": 0.45 + index * 0.03,
                "sharpness": 0.65 + index * 0.08,
                "edge_density": 0.14,
                "saturation": 0.58,
                "motion": 0.08,
                "visual_quality": 0.72 + index * 0.06,
            },
            "detections": {"screen_label": "gameplay", "menu_id": None},
        })

    package = build_creative_package(
        project_id=project_id,
        brief_id=brief_id,
        game_id="gta5",
        structured_brief={"subject": "Je présente la Zentorno.", "content_type": "vehicle_showcase"},
        analysis={"frames": frames, "texts": [], "entities": [], "events": []},
        narrative={
            "map": {"overall_coverage": 0.75, "beats": [{"concept": "final_result", "status": "found"}]},
            "coverage": {"overall_coverage": 0.75},
            "selected_plan": {"beats": [{"segment_ids": segment_ids, "concept": "overview"}]},
        },
        evidence={"gate": {"admitted_claim_ids": []}, "claims": []},
        script={"blocks": [{"purpose": "context"}, {"purpose": "conclusion"}]},
        output_duration_ms=30_000,
    )

    assert package["safety"]["factual_anchor"] == "GTA"
    assert package["safety"]["unverified_subject_excluded"] is True
    assert all("Zentorno" not in item["title"] for item in package["metadata"]["variants"])
    assert len(package["thumbnails"]) == 3
    assert len(package["metadata"]["variants"]) == 18
    assert {item["category"] for item in package["metadata"]["variants"]} == {"direct", "curiosity", "question", "comparison", "result", "advice"}
    assert package["image_selection"]["candidates"][0]["score"] >= package["image_selection"]["candidates"][-1]["score"]

    outputs = render_thumbnail_variants(package["thumbnails"], frame_paths, tmp_path / "thumbnails", "gta5")
    assert len(outputs) == 3
    for output in outputs.values():
        rendered = cv2.imread(str(output))
        assert rendered is not None
        assert rendered.shape[:2] == (720, 1280)
