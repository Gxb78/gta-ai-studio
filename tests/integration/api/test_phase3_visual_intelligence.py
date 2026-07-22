from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from gta_studio_api.config import REPO_ROOT
from gta_studio_api.gta5_adapter import Gta5Adapter
from gta_studio_api.vision import VisionTools


def test_local_ocr_reads_a_synthetic_menu_observation(tmp_path: Path) -> None:
    image = np.full((720, 1280, 3), 242, dtype=np.uint8)
    cv2.putText(image, "ENGINE BRAKES RESPRAY", (80, 360), cv2.FONT_HERSHEY_SIMPLEX, 2.1, (10, 10, 10), 5, cv2.LINE_AA)
    path = tmp_path / "menu.jpg"
    assert cv2.imwrite(str(path), image)

    vision = VisionTools(frame_interval_seconds=3, max_frames=10, max_width=960, ocr_min_confidence=0.3)
    detections = vision.recognize_text(path)
    observed = " ".join(str(item["text"]).upper() for item in detections)
    assert "ENGINE" in observed
    assert all(0 <= float(item["confidence"]) <= 1 for item in detections)


def test_gta5_adapter_scores_workshop_candidates_without_inventing_vehicles() -> None:
    adapter = Gta5Adapter(
        REPO_ROOT / "game-adapters" / "gta5" / "adapter.manifest.json",
        REPO_ROOT / "game-adapters" / "gta5" / "taxonomy.json",
    )
    segment = {
        "id": "segment-1",
        "media_id": "media-1",
        "start_ms": 0,
        "end_ms": 3000,
        "scene_type": "opening",
        "summary": "",
        "motion_score": 0.3,
        "visual_quality_score": 0.8,
        "relevance_score": 0.5,
        "novelty_score": 0.5,
        "confidence": 0.5,
        "attributes": {},
    }
    frame = {
        "id": "frame-1",
        "segment_id": "segment-1",
        "timestamp_ms": 1000,
        "metrics": {
            "brightness": 0.5,
            "darkness_ratio": 0.01,
            "motion": 0.01,
            "visual_quality": 0.85,
        },
    }
    report = adapter.analyze(
        brief="montrer la customisation à l'atelier",
        frames=[frame],
        texts_by_frame={"frame-1": [{"text": "ENGINE BRAKES RESPRAY", "confidence": 0.94, "region": None}]},
        segments=[segment],
    )

    assert report["frame_results"][0]["menu_id"] == "workshop"
    assert report["guided_search"]["hits"][0]["score"] > 0.5
    assert report["events"][0]["attributes"]["fact_status"] == "inferred_candidate"
    assert not any(entity["entity_type"] == "vehicle" for entity in report["entities"])
