from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .errors import StudioError
from .ids import uuid7


ADAPTER_VERSION = "gta5-rules-v1"


class Gta5Adapter:
    def __init__(self, manifest_path: Path, taxonomy_path: Path) -> None:
        self.manifest_path = manifest_path
        self.taxonomy_path = taxonomy_path
        self.descriptor = self._load_json(manifest_path)
        self.taxonomy = self._load_json(taxonomy_path)
        if self.descriptor.get("contract_version") != "1.0" or not self.descriptor.get("enabled"):
            raise StudioError("GTA5_ADAPTER_INCOMPATIBLE", "The GTA V adapter is disabled or incompatible.", status_code=503)

    def diagnostics(self) -> dict[str, str | bool]:
        return {
            "gta5_adapter_available": True,
            "gta5_adapter_version": str(self.descriptor["version"]),
            "gta5_adapter_capabilities": str(len(self.descriptor.get("capabilities", []))),
        }

    def normalize_text(self, value: str, locale: str = "fr-FR") -> str:
        del locale
        normalized = unicodedata.normalize("NFKD", value.casefold())
        ascii_text = "".join(character for character in normalized if not unicodedata.combining(character))
        return re.sub(r"[^a-z0-9$€%]+", " ", ascii_text).strip()

    def analyze(
        self,
        *,
        brief: str,
        frames: list[dict[str, Any]],
        texts_by_frame: dict[str, list[dict[str, Any]]],
        segments: list[dict[str, Any]],
    ) -> dict[str, Any]:
        frame_results: list[dict[str, Any]] = []
        entities: list[dict[str, Any]] = []
        events: list[dict[str, Any]] = []
        previous_label: str | None = None
        previous_menu: str | None = None

        for frame in frames:
            frame_texts = texts_by_frame.get(str(frame["id"]), [])
            combined = " ".join(self.normalize_text(str(item["text"])) for item in frame_texts)
            classification = self._classify_frame(frame, combined)
            frame_result = {
                "frame_id": frame["id"],
                "segment_id": frame["segment_id"],
                "timestamp_ms": frame["timestamp_ms"],
                **classification,
            }
            frame_results.append(frame_result)
            entities.extend(self._extract_entities(frame, frame_texts))
            current_label = str(classification["screen_label"])
            current_menu = str(classification["menu_id"]) if classification.get("menu_id") else None
            if current_label == "black_screen" and previous_label != "black_screen":
                events.append(self._event(frame, "black_screen_started", float(classification["confidence"]), {"basis": classification["basis"]}))
            if previous_label == "black_screen" and current_label != "black_screen":
                events.append(self._event(frame, "black_screen_ended", 0.78, {"next_screen": current_label}))
            if current_menu and previous_menu != current_menu:
                events.append(self._event(frame, f"{current_menu}_menu_entered", float(classification["confidence"]), {"basis": classification["basis"]}))
            if previous_menu and not current_menu:
                events.append(self._event(frame, f"{previous_menu}_menu_exited", 0.72, {"next_screen": current_label}))
            if float(frame["metrics"].get("motion", 0)) >= 0.12:
                events.append(self._event(frame, "high_motion", min(0.92, 0.55 + float(frame["metrics"]["motion"])), {"motion": frame["metrics"]["motion"]}))
            for rule in self.taxonomy["event_rules"]:
                matches = [keyword for keyword in rule["keywords"] if self.normalize_text(keyword) in combined]
                if matches:
                    events.append(self._event(frame, str(rule["event_type"]), min(0.97, 0.7 + 0.05 * len(matches)), {"matched_text_rules": matches, "label": rule["label"]}))
            previous_label = current_label
            previous_menu = current_menu

        segment_updates, search = self._summarize_segments(brief, segments, frames, frame_results, texts_by_frame, events)
        return {
            "schema_version": "1.0",
            "adapter": {
                "id": self.descriptor["id"],
                "version": self.descriptor["version"],
                "detector_version": ADAPTER_VERSION,
                "capabilities": self.descriptor["capabilities"],
                "limitations": self.descriptor.get("limitations", []),
            },
            "frame_results": frame_results,
            "segment_updates": segment_updates,
            "entities": entities,
            "events": _deduplicate_events(events),
            "guided_search": search,
            "summary": {
                "frame_count": len(frames),
                "text_count": sum(len(value) for value in texts_by_frame.values()),
                "entity_count": len(entities),
                "event_count": len(_deduplicate_events(events)),
                "screen_distribution": dict(Counter(str(item["screen_label"]) for item in frame_results)),
                "menu_distribution": dict(Counter(str(item["menu_id"]) for item in frame_results if item.get("menu_id"))),
            },
        }

    def _classify_frame(self, frame: dict[str, Any], normalized_text: str) -> dict[str, Any]:
        metrics = frame["metrics"]
        brightness = float(metrics.get("brightness", 0))
        darkness = float(metrics.get("darkness_ratio", 0))
        motion = float(metrics.get("motion", 0))
        if darkness >= 0.92 and brightness <= 0.08:
            return {"screen_label": "black_screen", "confidence": 0.97, "menu_id": None, "basis": ["darkness_ratio"]}
        best_menu: tuple[str, str, list[str]] | None = None
        for rule in self.taxonomy["menu_rules"]:
            matches = [keyword for keyword in rule["keywords"] if self.normalize_text(keyword) in normalized_text]
            if matches and (best_menu is None or len(matches) > len(best_menu[2])):
                best_menu = (str(rule["id"]), str(rule["label"]), matches)
        if best_menu:
            confidence = min(0.96, 0.62 + 0.07 * len(best_menu[2]))
            return {
                "screen_label": "menu_candidate",
                "confidence": round(confidence, 4),
                "menu_id": best_menu[0],
                "basis": ["ocr_rule", *best_menu[2]],
                "label": best_menu[1],
            }
        if darkness >= 0.68 and motion <= 0.025:
            return {"screen_label": "loading_candidate", "confidence": 0.64, "menu_id": None, "basis": ["dark_frame", "low_motion"]}
        if motion <= 0.012:
            return {"screen_label": "static_candidate", "confidence": 0.56, "menu_id": None, "basis": ["low_motion"]}
        if motion >= 0.12:
            return {"screen_label": "gameplay_candidate", "confidence": 0.62, "menu_id": None, "basis": ["high_motion"]}
        return {"screen_label": "unclassified_visual", "confidence": 0.35, "menu_id": None, "basis": ["no_strong_signal"]}

    def _extract_entities(self, frame: dict[str, Any], frame_texts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        entities: list[dict[str, Any]] = []
        for text in frame_texts:
            value = str(text["text"])
            confidence = float(text["confidence"])
            for match in re.finditer(r"(?:[$€]\s?\d[\d\s,.]*|\d[\d\s,.]*\s?[$€])", value):
                label = match.group(0).strip()
                entities.append({
                    "id": uuid7(),
                    "segment_id": frame["segment_id"],
                    "frame_id": frame["id"],
                    "entity_type": "visible_currency_amount",
                    "canonical_id": None,
                    "label": label,
                    "confidence": round(min(0.98, confidence), 5),
                    "start_ms": frame["timestamp_ms"],
                    "end_ms": int(frame["timestamp_ms"]) + 1,
                    "region": text.get("region"),
                    "detector_version": ADAPTER_VERSION,
                    "attributes": {"source": "ocr", "fact_status": "observed_text_only"},
                })
        return entities

    def _event(self, frame: dict[str, Any], event_type: str, confidence: float, attributes: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": uuid7(),
            "segment_id": frame["segment_id"],
            "frame_id": frame["id"],
            "event_type": event_type,
            "start_ms": frame["timestamp_ms"],
            "end_ms": int(frame["timestamp_ms"]) + 1,
            "confidence": round(max(0.0, min(1.0, confidence)), 5),
            "detector_version": ADAPTER_VERSION,
            "attributes": {**attributes, "fact_status": "inferred_candidate"},
        }

    def _summarize_segments(
        self,
        brief: str,
        segments: list[dict[str, Any]],
        frames: list[dict[str, Any]],
        frame_results: list[dict[str, Any]],
        texts_by_frame: dict[str, list[dict[str, Any]]],
        events: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        brief_terms = self._search_terms(brief)
        expected_labels: set[str] = set()
        matched_intents: list[str] = []
        normalized_brief = self.normalize_text(brief)
        for rule in self.taxonomy["guided_intents"]:
            if any(self.normalize_text(keyword) in normalized_brief for keyword in rule["brief_keywords"]):
                matched_intents.append(str(rule["intent"]))
                expected_labels.update(str(value) for value in rule["detection_labels"])

        frames_by_segment: dict[str, list[dict[str, Any]]] = defaultdict(list)
        results_by_frame = {str(item["frame_id"]): item for item in frame_results}
        for frame in frames:
            frames_by_segment[str(frame["segment_id"])].append(frame)
        events_by_segment: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for event in events:
            events_by_segment[str(event["segment_id"])].append(event)

        updates: list[dict[str, Any]] = []
        hits: list[dict[str, Any]] = []
        for segment in segments:
            segment_id = str(segment["id"])
            segment_frames = frames_by_segment.get(segment_id, [])
            frame_classes = [results_by_frame[str(frame["id"])] for frame in segment_frames if str(frame["id"]) in results_by_frame]
            texts = [
                item
                for frame in segment_frames
                for item in texts_by_frame.get(str(frame["id"]), [])
            ]
            segment_events = events_by_segment.get(segment_id, [])
            observed_terms = set(self._search_terms(" ".join(str(item["text"]) for item in texts)))
            labels = {
                str(item["screen_label"]) for item in frame_classes
            } | {
                f"menu.{item['menu_id']}" for item in frame_classes if item.get("menu_id")
            } | {
                str(item["event_type"]) for item in segment_events
            }
            overlap = sorted(brief_terms & observed_terms)
            expected_matches = sorted(expected_labels & labels)
            qualities = [float(frame["metrics"]["visual_quality"]) for frame in segment_frames]
            motions = [float(frame["metrics"]["motion"]) for frame in segment_frames]
            visual_quality = sum(qualities) / len(qualities) if qualities else float(segment["visual_quality_score"])
            motion_score = sum(motions) / len(motions) if motions else float(segment["motion_score"])
            text_score = len(overlap) / max(1, len(brief_terms))
            intent_score = min(1.0, len(expected_matches) / max(1, len(expected_labels))) if expected_labels else 0.0
            relevance = min(1.0, 0.12 + 0.22 * visual_quality + 0.43 * text_score + 0.33 * intent_score)
            dominant = Counter(str(item["screen_label"]) for item in frame_classes).most_common(1)
            dominant_label = dominant[0][0] if dominant else "unclassified_visual"
            menus = [str(item["menu_id"]) for item in frame_classes if item.get("menu_id")]
            if menus:
                scene_type = f"menu_{Counter(menus).most_common(1)[0][0]}_candidate"
            elif dominant_label == "black_screen":
                scene_type = "black_screen"
            elif dominant_label == "loading_candidate":
                scene_type = "loading_candidate"
            elif dominant_label == "gameplay_candidate":
                scene_type = "gameplay_candidate"
            else:
                scene_type = dominant_label
            top_texts = [str(item["text"]) for item in sorted(texts, key=lambda item: float(item["confidence"]), reverse=True)[:3]]
            summary_parts = [scene_type.replace("_", " ")]
            if top_texts:
                summary_parts.append("OCR : " + " · ".join(top_texts))
            summary = "; ".join(summary_parts)
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
                        "screen_labels": sorted(labels),
                        "detected_texts": top_texts,
                        "event_types": sorted({str(item["event_type"]) for item in segment_events}),
                        "brief_term_matches": overlap,
                        "guided_intent_matches": expected_matches,
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
                "matched_detections": expected_matches,
                "summary": summary,
            })
        hits.sort(key=lambda item: (-float(item["score"]), int(item["start_ms"])))
        return updates, {
            "brief": brief,
            "terms": sorted(brief_terms),
            "matched_intents": matched_intents,
            "expected_detection_labels": sorted(expected_labels),
            "hits": hits[:12],
            "notice": "Les correspondances classent des observations et candidats; elles ne constituent pas des faits GTA vérifiés.",
        }

    def _search_terms(self, value: str) -> set[str]:
        stop_words = {self.normalize_text(word) for word in self.taxonomy["stop_words"]}
        return {
            token
            for token in self.normalize_text(value).split()
            if len(token) >= 3 and token not in stop_words
        }

    @staticmethod
    def _load_json(path: Path) -> dict[str, Any]:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise StudioError("GTA5_ADAPTER_RESOURCE_INVALID", f"Invalid GTA V adapter resource: {path.name}", status_code=503) from error


def _deduplicate_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[tuple[str, str, int], dict[str, Any]] = {}
    for event in events:
        key = (str(event["segment_id"]), str(event["event_type"]), int(event["start_ms"]))
        existing = unique.get(key)
        if existing is None or float(event["confidence"]) > float(existing["confidence"]):
            unique[key] = event
    return sorted(unique.values(), key=lambda item: (int(item["start_ms"]), str(item["event_type"])))
