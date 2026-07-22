from __future__ import annotations

import os
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

from .errors import JobCancelled, StudioError
from .ids import uuid7


ProgressCallback = Callable[[float], None]
CancelCallback = Callable[[], bool]


class VisionTools:
    def __init__(self, *, frame_interval_seconds: float, max_frames: int, max_width: int, ocr_min_confidence: float) -> None:
        self.frame_interval_seconds = frame_interval_seconds
        self.max_frames = max_frames
        self.max_width = max_width
        self.ocr_min_confidence = ocr_min_confidence
        self._ocr_engine: Any | None = None

    def diagnostics(self) -> dict[str, str | bool]:
        try:
            import cv2
            import onnxruntime
            import rapidocr

            model_dir = Path(rapidocr.__file__).resolve().parent / "models"
            models = sorted(model_dir.glob("*.onnx"))
            return {
                "vision_available": True,
                "opencv": str(cv2.__version__),
                "onnxruntime": str(onnxruntime.__version__),
                "rapidocr": str(getattr(rapidocr, "__version__", "available")),
                "ocr_models": str(len(models)),
            }
        except (ImportError, OSError) as error:
            return {
                "vision_available": False,
                "opencv": "unavailable",
                "onnxruntime": "unavailable",
                "rapidocr": type(error).__name__,
                "ocr_models": "0",
            }

    def verify_inference_runtime(self) -> dict[str, str | bool]:
        """Load every OCR stage and execute one tiny offline inference."""
        try:
            import cv2
            import numpy as np

            image = np.full((128, 512, 3), 245, dtype=np.uint8)
            cv2.putText(image, "OCR", (30, 90), cv2.FONT_HERSHEY_SIMPLEX, 2.4, (10, 10, 10), 5, cv2.LINE_AA)
            result = self._get_ocr_engine()(image)
            return {
                "ocr_inference_ready": result is not None,
                "ocr_backend": "onnxruntime-cpu",
            }
        except Exception as error:
            raise StudioError(
                "OCR_SMOKE_TEST_FAILED",
                "The packaged OCR runtime could not execute a local inference.",
                status_code=503,
                details={"type": type(error).__name__},
            ) from error
    def sample_timestamps(self, duration_ms: int, segments: list[dict[str, Any]]) -> list[int]:
        if duration_ms <= 0:
            return []
        adaptive_interval_ms = max(
            round(self.frame_interval_seconds * 1000),
            max(1, duration_ms // max(1, self.max_frames)),
        )
        timestamps = set(range(0, duration_ms, adaptive_interval_ms))
        for segment in segments:
            start = int(segment["start_ms"])
            end = int(segment["end_ms"])
            timestamps.add(min(duration_ms - 1, start + max(0, end - start) // 2))
        timestamps.add(max(0, duration_ms - 1))
        ordered = sorted(value for value in timestamps if 0 <= value < duration_ms)
        if len(ordered) <= self.max_frames:
            return ordered
        if self.max_frames == 1:
            return [ordered[len(ordered) // 2]]
        indexes = {
            round(index * (len(ordered) - 1) / (self.max_frames - 1))
            for index in range(self.max_frames)
        }
        return [ordered[index] for index in sorted(indexes)]

    def extract_frames(
        self,
        source: Path,
        destination_dir: Path,
        duration_ms: int,
        segments: list[dict[str, Any]],
        progress: ProgressCallback,
        cancelled: CancelCallback,
    ) -> list[dict[str, Any]]:
        try:
            import cv2
            import numpy as np
        except ImportError as error:
            raise StudioError("VISION_RUNTIME_MISSING", "OpenCV and NumPy are unavailable.", status_code=503) from error

        timestamps = self.sample_timestamps(duration_ms, segments)
        destination_dir.mkdir(parents=True, exist_ok=True)
        capture = cv2.VideoCapture(str(source))
        if not capture.isOpened():
            raise StudioError("VISION_VIDEO_OPEN_FAILED", "OpenCV could not open the analysis proxy.")
        frames: list[dict[str, Any]] = []
        previous_gray: Any | None = None
        try:
            for index, timestamp_ms in enumerate(timestamps):
                if cancelled():
                    raise JobCancelled()
                capture.set(cv2.CAP_PROP_POS_MSEC, float(timestamp_ms))
                ok, image = capture.read()
                if not ok or image is None:
                    continue
                source_height, source_width = image.shape[:2]
                if source_width > self.max_width:
                    ratio = self.max_width / source_width
                    image = cv2.resize(
                        image,
                        (self.max_width, max(2, round(source_height * ratio))),
                        interpolation=cv2.INTER_AREA,
                    )
                height, width = image.shape[:2]
                gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
                comparison = cv2.resize(gray, (320, 180), interpolation=cv2.INTER_AREA)
                brightness = float(np.mean(gray) / 255.0)
                darkness_ratio = float(np.mean(gray < 18))
                sharpness_raw = float(cv2.Laplacian(gray, cv2.CV_64F).var())
                sharpness = min(1.0, sharpness_raw / 650.0)
                edges = cv2.Canny(gray, 70, 150)
                edge_density = float(np.mean(edges > 0))
                saturation = float(np.mean(cv2.cvtColor(image, cv2.COLOR_BGR2HSV)[:, :, 1]) / 255.0)
                motion = 0.0 if previous_gray is None else float(np.mean(cv2.absdiff(comparison, previous_gray)) / 255.0)
                previous_gray = comparison
                visual_quality = max(0.0, min(1.0, 0.55 * sharpness + 0.25 * (1 - darkness_ratio) + 0.2 * min(1.0, edge_density * 6)))
                frame_id = uuid7()
                destination = destination_dir / f"frame-{index + 1:04d}-{timestamp_ms:010d}.jpg"
                temporary = destination.with_suffix(".partial.jpg")
                try:
                    if not cv2.imwrite(str(temporary), image, [int(cv2.IMWRITE_JPEG_QUALITY), 90]):
                        raise StudioError("VISION_FRAME_WRITE_FAILED", "OpenCV could not write an extracted frame.")
                    os.replace(temporary, destination)
                finally:
                    temporary.unlink(missing_ok=True)
                segment_id = _segment_for_timestamp(segments, timestamp_ms)
                frames.append({
                    "id": frame_id,
                    "segment_id": segment_id,
                    "timestamp_ms": timestamp_ms,
                    "path": destination,
                    "width": width,
                    "height": height,
                    "metrics": {
                        "brightness": round(brightness, 5),
                        "darkness_ratio": round(darkness_ratio, 5),
                        "sharpness": round(sharpness, 5),
                        "sharpness_raw": round(sharpness_raw, 3),
                        "edge_density": round(edge_density, 5),
                        "saturation": round(saturation, 5),
                        "motion": round(motion, 5),
                        "visual_quality": round(visual_quality, 5),
                    },
                })
                progress((index + 1) / max(1, len(timestamps)))
        finally:
            capture.release()
        if not frames:
            raise StudioError("VISION_NO_FRAMES", "No representative frame could be extracted.")
        return frames

    def recognize_text(self, image_path: Path) -> list[dict[str, Any]]:
        try:
            import cv2
            import numpy as np
        except ImportError as error:
            raise StudioError("OCR_RUNTIME_MISSING", "The local OCR image runtime is unavailable.", status_code=503) from error
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise StudioError("OCR_IMAGE_READ_FAILED", "The extracted frame could not be read.")
        detections = self._run_ocr(image, "native")
        if not any(float(item["confidence"]) >= 0.62 for item in detections):
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8)).apply(gray)
            enhanced = cv2.cvtColor(clahe, cv2.COLOR_GRAY2BGR)
            scale = min(2.0, max(1.0, 1500 / max(1, enhanced.shape[1])))
            if scale > 1:
                enhanced = cv2.resize(enhanced, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            detections.extend(self._run_ocr(enhanced, "clahe"))
        unique: dict[str, dict[str, Any]] = {}
        for detection in detections:
            key = re.sub(r"\W+", "", str(detection["text"]).casefold())
            if len(key) < 2:
                continue
            existing = unique.get(key)
            if existing is None or float(detection["confidence"]) > float(existing["confidence"]):
                unique[key] = detection
        return sorted(unique.values(), key=lambda item: (-float(item["confidence"]), str(item["text"])))

    def _run_ocr(self, image: Any, pass_name: str) -> list[dict[str, Any]]:
        engine = self._get_ocr_engine()
        try:
            result = engine(image)
        except Exception as error:
            raise StudioError(
                "OCR_INFERENCE_FAILED",
                "RapidOCR could not analyze an extracted frame.",
                retryable=True,
                details={"type": type(error).__name__},
            ) from error
        boxes = getattr(result, "boxes", None)
        texts = getattr(result, "txts", None)
        scores = getattr(result, "scores", None)
        if boxes is None:
            return []
        if texts is None:
            texts = ()
        if scores is None:
            scores = ()
        height, width = image.shape[:2]
        output: list[dict[str, Any]] = []
        for box, text, score in zip(boxes, texts, scores, strict=False):
            confidence = float(score)
            clean = re.sub(r"\s+", " ", str(text)).strip()
            if confidence < self.ocr_min_confidence or len(clean) < 2:
                continue
            points = list(box)
            xs = [float(point[0]) for point in points]
            ys = [float(point[1]) for point in points]
            x1, x2 = max(0.0, min(xs)), min(float(width), max(xs))
            y1, y2 = max(0.0, min(ys)), min(float(height), max(ys))
            output.append({
                "text": clean,
                "confidence": round(confidence, 5),
                "region": {
                    "x": round(x1 / width, 6),
                    "y": round(y1 / height, 6),
                    "width": round(max(0.0, x2 - x1) / width, 6),
                    "height": round(max(0.0, y2 - y1) / height, 6),
                },
                "pass": pass_name,
            })
        return output

    def _get_ocr_engine(self) -> Any:
        if self._ocr_engine is not None:
            return self._ocr_engine
        try:
            from rapidocr import RapidOCR

            self._ocr_engine = RapidOCR()
        except Exception as error:
            raise StudioError(
                "OCR_ENGINE_INITIALIZATION_FAILED",
                "RapidOCR or its local PP-OCR models are unavailable.",
                status_code=503,
                details={"type": type(error).__name__},
            ) from error
        return self._ocr_engine


def _segment_for_timestamp(segments: list[dict[str, Any]], timestamp_ms: int) -> str:
    for segment in segments:
        if int(segment["start_ms"]) <= timestamp_ms < int(segment["end_ms"]):
            return str(segment["id"])
    return str(segments[-1]["id"])


def normalize_observed_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value.casefold())
    ascii_text = "".join(character for character in normalized if not unicodedata.combining(character))
    return re.sub(r"[^a-z0-9$€%]+", " ", ascii_text).strip()


def build_generic_visual_report(
    *,
    brief: str,
    frames: list[dict[str, Any]],
    texts_by_frame: dict[str, list[dict[str, Any]]],
    segments: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build a game-agnostic report without assigning GTA-specific meaning."""
    frame_results: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    previous_label: str | None = None
    for frame in frames:
        metrics = dict(frame["metrics"])
        darkness = float(metrics.get("darkness_ratio", 0))
        brightness = float(metrics.get("brightness", 0))
        motion = float(metrics.get("motion", 0))
        if darkness >= 0.92 and brightness <= 0.08:
            label, confidence, basis = "black_screen", 0.97, ["darkness_ratio"]
        elif motion <= 0.012:
            label, confidence, basis = "static_candidate", 0.56, ["low_motion"]
        elif motion >= 0.12:
            label, confidence, basis = "high_motion_visual", 0.62, ["high_motion"]
        else:
            label, confidence, basis = "unclassified_visual", 0.35, ["no_strong_signal"]
        frame_results.append({
            "frame_id": frame["id"],
            "segment_id": frame["segment_id"],
            "timestamp_ms": frame["timestamp_ms"],
            "screen_label": label,
            "confidence": confidence,
            "menu_id": None,
            "basis": basis,
        })
        if label == "black_screen" and previous_label != label:
            events.append(_generic_event(frame, "black_screen_started", confidence, {"basis": basis}))
        if previous_label == "black_screen" and label != "black_screen":
            events.append(_generic_event(frame, "black_screen_ended", 0.78, {"next_screen": label}))
        if motion >= 0.12:
            events.append(_generic_event(frame, "high_motion", min(0.92, 0.55 + motion), {"motion": motion}))
        previous_label = label

    brief_terms = {token for token in normalize_observed_text(brief).split() if len(token) >= 3}
    frames_by_segment: dict[str, list[dict[str, Any]]] = defaultdict(list)
    results_by_frame = {str(item["frame_id"]): item for item in frame_results}
    for frame in frames:
        frames_by_segment[str(frame["segment_id"])].append(frame)
    updates: list[dict[str, Any]] = []
    hits: list[dict[str, Any]] = []
    for segment in segments:
        segment_id = str(segment["id"])
        segment_frames = frames_by_segment.get(segment_id, [])
        frame_classes = [results_by_frame[str(frame["id"])] for frame in segment_frames]
        texts = [item for frame in segment_frames for item in texts_by_frame.get(str(frame["id"]), [])]
        observed_terms = {
            token
            for item in texts
            for token in normalize_observed_text(str(item["text"])).split()
            if len(token) >= 3
        }
        overlap = sorted(brief_terms & observed_terms)
        qualities = [float(frame["metrics"].get("visual_quality", 0.5)) for frame in segment_frames]
        motions = [float(frame["metrics"].get("motion", 0)) for frame in segment_frames]
        visual_quality = sum(qualities) / len(qualities) if qualities else float(segment["visual_quality_score"])
        motion_score = sum(motions) / len(motions) if motions else float(segment["motion_score"])
        relevance = min(1.0, 0.18 + 0.32 * visual_quality + 0.5 * len(overlap) / max(1, len(brief_terms)))
        dominant = Counter(str(item["screen_label"]) for item in frame_classes).most_common(1)
        scene_type = dominant[0][0] if dominant else "unclassified_visual"
        top_texts = [str(item["text"]) for item in sorted(texts, key=lambda item: float(item["confidence"]), reverse=True)[:3]]
        summary = scene_type.replace("_", " ")
        if top_texts:
            summary += "; OCR : " + " · ".join(top_texts)
        update = {
            "id": segment_id,
            "scene_type": scene_type,
            "summary": summary,
            "motion_score": round(motion_score, 5),
            "visual_quality_score": round(visual_quality, 5),
            "relevance_score": round(relevance, 5),
            "novelty_score": float(segment["novelty_score"]),
            "confidence": round(max([float(item["confidence"]) for item in frame_classes] or [0.35]), 5),
            "attributes": {
                **dict(segment.get("attributes", {})),
                "phase3": {
                    "screen_labels": sorted({str(item["screen_label"]) for item in frame_classes}),
                    "detected_texts": top_texts,
                    "brief_term_matches": overlap,
                    "fact_status": "observations_and_inferred_candidates",
                },
            },
        }
        updates.append(update)
        hits.append({
            "segment_id": segment_id,
            "start_ms": segment["start_ms"],
            "end_ms": segment["end_ms"],
            "score": round(relevance, 5),
            "matched_terms": overlap,
            "matched_detections": [],
            "summary": summary,
        })
    hits.sort(key=lambda item: (-float(item["score"]), int(item["start_ms"])))
    return {
        "schema_version": "1.0",
        "adapter": {
            "id": "studio.game-adapter.generic",
            "version": "1.0.0",
            "detector_version": "generic-visual-v1",
            "capabilities": ["screen_classification", "text_normalization", "guided_search"],
            "limitations": [
                "Aucune taxonomie propre au jeu n'est appliquée.",
                "Les classifications visuelles sont des candidats et non des faits vérifiés.",
            ],
        },
        "frame_results": frame_results,
        "segment_updates": updates,
        "entities": [],
        "events": events,
        "guided_search": {
            "brief": brief,
            "terms": sorted(brief_terms),
            "matched_intents": [],
            "expected_detection_labels": [],
            "hits": hits[:12],
            "notice": "Classement fondé sur les textes observés et des métriques visuelles génériques.",
        },
        "summary": {
            "frame_count": len(frames),
            "text_count": sum(len(value) for value in texts_by_frame.values()),
            "entity_count": 0,
            "event_count": len(events),
            "screen_distribution": dict(Counter(str(item["screen_label"]) for item in frame_results)),
            "menu_distribution": {},
        },
    }


def _generic_event(frame: dict[str, Any], event_type: str, confidence: float, attributes: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": uuid7(),
        "segment_id": frame["segment_id"],
        "frame_id": frame["id"],
        "event_type": event_type,
        "start_ms": frame["timestamp_ms"],
        "end_ms": int(frame["timestamp_ms"]) + 1,
        "confidence": round(max(0.0, min(1.0, confidence)), 5),
        "detector_version": "generic-visual-v1",
        "attributes": {**attributes, "fact_status": "inferred_candidate"},
    }
