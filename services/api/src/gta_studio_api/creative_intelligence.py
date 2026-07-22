from __future__ import annotations

import math
import os
import re
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .errors import StudioError
from .ids import uuid7


CREATIVE_PACKAGE_VERSION = "creative-package-v1"
THUMBNAIL_VERSION = "opencv-thumbnail-v1"

PLATFORM_RULES: dict[str, dict[str, Any]] = {
    "youtube_shorts": {"label": "YouTube Shorts", "title_max": 100, "hashtags": ["#Shorts", "#GTA", "#Gameplay"]},
    "tiktok": {"label": "TikTok", "title_max": 80, "hashtags": ["#GTA", "#Gaming", "#PourToi"]},
    "instagram_reels": {"label": "Instagram Reels", "title_max": 80, "hashtags": ["#GTA", "#ReelsGaming", "#Gameplay"]},
}

CONTENT_LABELS = {
    "vehicle_showcase": "Présentation GTA",
    "vehicle_customization": "Customisation GTA",
    "mission_showcase": "Mission GTA",
    "mission_guide": "Guide de mission GTA",
    "tip": "Astuce GTA",
    "comparison": "Comparaison GTA",
    "myth_test": "Test GTA",
    "other": "Rush GTA",
}


def build_creative_package(
    *,
    project_id: str,
    brief_id: str,
    game_id: str,
    structured_brief: dict[str, Any],
    analysis: dict[str, Any],
    narrative: dict[str, Any] | None,
    evidence: dict[str, Any] | None,
    script: dict[str, Any] | None,
    output_duration_ms: int,
) -> dict[str, Any]:
    frames = list(analysis.get("frames", []))
    if not frames:
        raise StudioError("CREATIVE_NO_SOURCE_FRAMES", "No observed frame is available for thumbnail generation.", status_code=409)

    package_id = uuid7()
    candidates = rank_thumbnail_frames(frames, analysis, narrative)
    factual_context = _factual_context(structured_brief, analysis, narrative, evidence)
    thumbnails = _thumbnail_variants(package_id, candidates, factual_context, game_id)
    metadata_variants = _metadata_variants(
        package_id=package_id,
        structured_brief=structured_brief,
        factual_context=factual_context,
        evidence=evidence,
        script=script,
        duration_seconds=max(1, round(output_duration_ms / 1000)),
        game_id=game_id,
        frame_ids=[str(candidate["frame_id"]) for candidate in candidates[:3]],
    )
    selected_metadata = {
        platform: max(
            (item for item in metadata_variants if item["platform"] == platform),
            key=lambda item: float(item["score"]),
        )["id"]
        for platform in PLATFORM_RULES
    }
    return {
        "schema_version": "1.0",
        "id": package_id,
        "project_id": project_id,
        "brief_id": brief_id,
        "algorithm_version": CREATIVE_PACKAGE_VERSION,
        "status": "READY" if factual_context["confidence"] >= 0.5 else "READY_WITH_WARNINGS",
        "generated_at": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "image_selection": {
            "criteria": ["sharpness", "readability", "subject_visibility", "contrast", "framing", "novelty", "strong_element", "interface_absence", "narrative_relevance"],
            "candidates": candidates,
        },
        "thumbnails": thumbnails,
        "metadata": {
            "variants": metadata_variants,
            "selected_by_platform": selected_metadata,
            "history_signal": {"status": "unavailable", "reason": "Analytics begin in Phase 9; no account history was invented."},
        },
        "selected_thumbnail_id": max(thumbnails, key=lambda item: float(item["score"]))["id"],
        "safety": {
            "source_policy": "Only observed project frames are used; no generated or competitor visual is introduced.",
            "factual_anchor": factual_context["anchor"],
            "anchor_sources": factual_context["anchor_sources"],
            "unverified_subject_excluded": factual_context["unverified_subject_excluded"],
            "clickbait_policy": "Every proposal is scored for precision and deceptive-clickbait risk.",
        },
        "summary": {
            "candidate_frame_count": len(candidates),
            "thumbnail_count": len(thumbnails),
            "metadata_variant_count": len(metadata_variants),
            "platform_count": len(PLATFORM_RULES),
        },
    }


def rank_thumbnail_frames(
    frames: list[dict[str, Any]],
    analysis: dict[str, Any],
    narrative: dict[str, Any] | None,
    *,
    limit: int = 8,
) -> list[dict[str, Any]]:
    entity_by_frame: dict[str, float] = {}
    for entity in analysis.get("entities", []):
        frame_id = entity.get("frame_id")
        if frame_id:
            entity_by_frame[str(frame_id)] = max(entity_by_frame.get(str(frame_id), 0.0), float(entity.get("confidence", 0)))
    text_area_by_frame: dict[str, float] = {}
    for text in analysis.get("texts", []):
        frame_id = text.get("frame_id")
        region = text.get("region") or {}
        if frame_id:
            area = float(region.get("width", 0)) * float(region.get("height", 0))
            text_area_by_frame[str(frame_id)] = min(1.0, text_area_by_frame.get(str(frame_id), 0.0) + area)

    selected_segments = {
        str(segment_id)
        for beat in ((narrative or {}).get("selected_plan") or {}).get("beats", [])
        for segment_id in beat.get("segment_ids", [])
    }
    scored: list[dict[str, Any]] = []
    for frame in frames:
        metrics = dict(frame.get("metrics", {}))
        detections = dict(frame.get("detections", {}))
        frame_id = str(frame["id"])
        brightness = float(metrics.get("brightness", 0.5))
        sharpness = _clamp(float(metrics.get("sharpness", 0.0)))
        contrast = _clamp(float(metrics.get("edge_density", 0.0)) * 6.0)
        brightness_balance = _clamp(1.0 - abs(brightness - 0.52) / 0.52)
        subject_visibility = max(
            entity_by_frame.get(frame_id, 0.0),
            0.72 if detections.get("screen_label") in {"gameplay", "vehicle_customization", "mission"} else 0.46,
        )
        menu_penalty = 0.45 if detections.get("menu_id") else 0.0
        screen_penalty = 0.6 if detections.get("screen_label") in {"black", "loading", "pause_menu"} else 0.0
        interface_absence = _clamp(1.0 - menu_penalty - screen_penalty - text_area_by_frame.get(frame_id, 0.0) * 0.5)
        framing = 0.76 if subject_visibility >= 0.7 else 0.62
        strong_element = _clamp(0.45 * float(metrics.get("saturation", 0.0)) + 0.35 * contrast + 0.2 * min(1.0, float(metrics.get("motion", 0.0)) * 4))
        relevance = 1.0 if str(frame.get("segment_id")) in selected_segments else 0.58
        visual_quality = _clamp(float(metrics.get("visual_quality", 0.0)))
        breakdown = {
            "sharpness": sharpness,
            "readability": round(0.55 * brightness_balance + 0.45 * contrast, 5),
            "subject_visibility": round(subject_visibility, 5),
            "contrast": round(contrast, 5),
            "framing": framing,
            "strong_element": round(strong_element, 5),
            "interface_absence": round(interface_absence, 5),
            "narrative_relevance": relevance,
            "visual_quality": visual_quality,
        }
        base_score = (
            0.17 * breakdown["sharpness"]
            + 0.13 * breakdown["readability"]
            + 0.14 * breakdown["subject_visibility"]
            + 0.08 * breakdown["contrast"]
            + 0.08 * breakdown["framing"]
            + 0.08 * breakdown["strong_element"]
            + 0.13 * breakdown["interface_absence"]
            + 0.12 * breakdown["narrative_relevance"]
            + 0.07 * breakdown["visual_quality"]
        )
        scored.append({
            "frame_id": frame_id,
            "segment_id": frame.get("segment_id"),
            "timestamp_ms": int(frame.get("timestamp_ms", 0)),
            "score": round(_clamp(base_score), 5),
            "score_breakdown": breakdown,
        })

    scored.sort(key=lambda item: (-float(item["score"]), int(item["timestamp_ms"])))
    chosen: list[dict[str, Any]] = []
    for item in scored:
        if len(chosen) >= limit:
            break
        nearest = min((abs(int(item["timestamp_ms"]) - int(existing["timestamp_ms"])) for existing in chosen), default=10_000)
        novelty = _clamp(nearest / 4_000)
        if chosen and novelty < 0.18 and len(scored) > limit:
            continue
        item["score_breakdown"]["novelty"] = round(novelty, 5)
        item["score"] = round(_clamp(float(item["score"]) * 0.9 + novelty * 0.1), 5)
        chosen.append(item)
    chosen.sort(key=lambda item: (-float(item["score"]), int(item["timestamp_ms"])))
    return chosen or scored[:1]


def render_thumbnail_variants(
    variants: list[dict[str, Any]],
    frame_paths: dict[str, Path],
    destination_dir: Path,
    game_id: str,
) -> dict[str, Path]:
    try:
        import cv2
        import numpy as np
    except ImportError as error:
        raise StudioError("THUMBNAIL_RUNTIME_MISSING", "OpenCV and NumPy are unavailable.", status_code=503) from error

    destination_dir.mkdir(parents=True, exist_ok=True)
    output: dict[str, Path] = {}
    badge = {"gta5": "GTA V", "gta6": "GTA VI"}.get(game_id, "GTA")
    for variant in variants:
        source_ids = [str(value) for value in variant["source_frame_ids"]]
        images = []
        for frame_id in source_ids:
            path = frame_paths.get(frame_id)
            image = cv2.imread(str(path)) if path else None
            if image is not None:
                images.append(image)
        if not images:
            raise StudioError("THUMBNAIL_SOURCE_MISSING", "A selected thumbnail source frame is missing.", status_code=500)
        canvas = _compose_thumbnail(images, str(variant["template_key"]), np, cv2)
        _decorate_thumbnail(canvas, str(variant["headline"]), badge, str(variant["template_key"]), np, cv2)
        destination = destination_dir / f"thumbnail-{int(variant['rank']):02d}-{variant['template_key']}.jpg"
        temporary = destination.with_suffix(".partial.jpg")
        try:
            if not cv2.imwrite(str(temporary), canvas, [int(cv2.IMWRITE_JPEG_QUALITY), 94]):
                raise StudioError("THUMBNAIL_WRITE_FAILED", "OpenCV could not write a thumbnail.", status_code=500)
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        output[str(variant["id"])] = destination
    return output


def _thumbnail_variants(package_id: str, candidates: list[dict[str, Any]], context: dict[str, Any], game_id: str) -> list[dict[str, Any]]:
    primary = candidates[0]
    secondary = candidates[1] if len(candidates) > 1 else primary
    headlines = _thumbnail_headlines(context)
    definitions = [
        ("impact", [primary], headlines[0], 0.96, 0.92),
        ("clean", [secondary], headlines[1], 0.91, 0.97),
        ("duo", [primary, secondary], headlines[2], 0.9, 0.95),
    ]
    variants: list[dict[str, Any]] = []
    for rank, (template, sources, headline, readability, fidelity) in enumerate(definitions, start=1):
        source_score = sum(float(item["score"]) for item in sources) / len(sources)
        composition = {"impact": 0.95, "clean": 0.9, "duo": 0.93}[template]
        clickbait_safety = 0.98 if context["anchor"] == "GTA" else 0.94
        breakdown = {
            "source_image": round(source_score, 5),
            "mobile_readability": readability,
            "composition": composition,
            "visual_fidelity": fidelity,
            "clickbait_safety": clickbait_safety,
        }
        score = sum(breakdown.values()) / len(breakdown)
        variants.append({
            "id": uuid7(),
            "creative_package_id": package_id,
            "rank": rank,
            "template_key": template,
            "headline": headline,
            "source_frame_ids": [str(item["frame_id"]) for item in sources],
            "source_segment_id": sources[0].get("segment_id"),
            "score": round(score, 5),
            "score_breakdown": breakdown,
            "selected": False,
            "width": 1280,
            "height": 720,
            "provenance": {"policy": "observed_frames_only", "game_id": game_id},
        })
    selected = max(variants, key=lambda item: float(item["score"]))
    selected["selected"] = True
    return variants


def _metadata_variants(
    *,
    package_id: str,
    structured_brief: dict[str, Any],
    factual_context: dict[str, Any],
    evidence: dict[str, Any] | None,
    script: dict[str, Any] | None,
    duration_seconds: int,
    game_id: str,
    frame_ids: list[str],
) -> list[dict[str, Any]]:
    theme = factual_context["theme"]
    comparison_ready = factual_context["comparison_ready"]
    result_ready = factual_context["result_ready"]
    categories = [
        ("direct", f"{theme} en {duration_seconds} secondes", 0.96, 0.84),
        ("curiosity", "Ce que montre vraiment ce rush GTA", 0.9, 0.9),
        ("question", "Quel moment de ce rush GTA retiendras-tu ?", 0.94, 0.86),
        ("comparison", "Avant / après : deux moments vraiment visibles" if comparison_ready else "Deux moments du même rush GTA", 0.95, 0.83),
        ("result", "Le résultat final visible dans le rush" if result_ready else "Le montage final de ce rush GTA", 0.97, 0.82),
        ("advice", "Voir l’essentiel de ce rush GTA", 0.96, 0.8),
    ]
    game_hashtag = {"gta5": "#GTAV", "gta6": "#GTAVI"}.get(game_id, "#GTA")
    claim_ids = [str(value) for value in (evidence or {}).get("gate", {}).get("admitted_claim_ids", [])]
    block_count = len((script or {}).get("blocks", []))
    variants: list[dict[str, Any]] = []
    for platform, rules in PLATFORM_RULES.items():
        hashtags = list(dict.fromkeys([game_hashtag, *rules["hashtags"]]))
        description = (
            f"Montage vertical local de {duration_seconds} secondes construit à partir de {block_count} bloc(s) éditorial(aux) "
            "et uniquement des séquences retenues dans ce rush. Voix synthétique, sous-titres et cadrage sont générés par GTA AI Studio."
        )
        short_description = f"{theme} · montage vertical issu uniquement de ce rush."
        for category, title, precision, originality in categories:
            title = title[: int(rules["title_max"])]
            relevance = 0.94 if factual_context["confidence"] >= 0.5 else 0.78
            length_score = _clamp(1 - max(0, len(title) - 64) / 50)
            coherence = 0.97 if "rush" in title.casefold() or factual_context["anchor_verified"] else 0.88
            clickbait_safety = precision
            breakdown = {
                "precision": precision,
                "relevance": relevance,
                "length": round(length_score, 5),
                "originality": originality,
                "video_coherence": coherence,
                "clickbait_safety": clickbait_safety,
            }
            score = sum(breakdown.values()) / len(breakdown)
            variants.append({
                "id": uuid7(),
                "creative_package_id": package_id,
                "platform": platform,
                "platform_label": rules["label"],
                "kind": "publication_set",
                "category": category,
                "title": title,
                "description": description,
                "short_description": short_description,
                "keywords": ["GTA", game_id.upper(), "gameplay", "vidéo verticale", category],
                "hashtags": hashtags,
                "thumbnail_text": _ascii_headline(title, 24),
                "pinned_comment": "Quel passage du rush retiens-tu ?",
                "chapters": [],
                "score": round(score, 5),
                "score_breakdown": breakdown,
                "history_score": None,
                "selected": False,
                "provenance": {
                    "source_frame_ids": frame_ids,
                    "supporting_claim_ids": claim_ids,
                    "factual_anchor": factual_context["anchor"],
                    "history_signal": "unavailable",
                },
            })
        winner = max((item for item in variants if item["platform"] == platform), key=lambda item: float(item["score"]))
        winner["selected"] = True
    return variants


def _factual_context(
    structured_brief: dict[str, Any],
    analysis: dict[str, Any],
    narrative: dict[str, Any] | None,
    evidence: dict[str, Any] | None,
) -> dict[str, Any]:
    subject = str(structured_brief.get("subject", ""))
    normalized_subject = _normalize(subject)
    observed_texts = [
        item for item in analysis.get("texts", [])
        if float(item.get("confidence", 0)) >= 0.72 and len(str(item.get("text", "")).strip()) >= 3
    ]
    anchor = "GTA"
    anchor_sources: list[str] = []
    for text in observed_texts:
        candidate = str(text.get("text", "")).strip()
        normalized_candidate = _normalize(candidate)
        tokens = [token for token in normalized_candidate.split() if len(token) >= 4]
        if tokens and any(token in normalized_subject for token in tokens) and len(candidate) <= 32:
            anchor = candidate.title()
            anchor_sources.append(str(text["id"]))
            break
    if anchor == "GTA":
        for claim in (evidence or {}).get("claims", []):
            narration = str(claim.get("safe_narration") or "").strip()
            if claim.get("allowed_in_script") and 3 <= len(narration) <= 32:
                anchor = narration.rstrip(".?!")
                anchor_sources.append(str(claim["id"]))
                break

    map_value = (narrative or {}).get("map") or {}
    coverage = (narrative or {}).get("coverage") or {}
    beats = list(map_value.get("beats", []))
    found_concepts = {
        str(beat.get("concept")) for beat in beats if beat.get("status") in {"found", "partially_found"}
    }
    coverage_score = float(coverage.get("overall_coverage", map_value.get("overall_coverage", 0.0)) or 0.0)
    content_type = str(structured_brief.get("content_type", "other"))
    theme = anchor if anchor != "GTA" else (CONTENT_LABELS.get(content_type, "Rush GTA") if coverage_score >= 0.45 else "Rush GTA")
    confidence = max(0.35, min(1.0, coverage_score if coverage_score else 0.45))
    if anchor_sources:
        confidence = max(confidence, 0.78)
    return {
        "anchor": anchor,
        "theme": theme,
        "confidence": confidence,
        "anchor_verified": bool(anchor_sources),
        "anchor_sources": anchor_sources,
        "unverified_subject_excluded": anchor == "GTA" and bool(subject),
        "comparison_ready": bool({"original_appearance", "options"} & found_concepts and {"final_result", "verdict"} & found_concepts),
        "result_ready": bool({"final_result", "mission_result", "test_result", "proof"} & found_concepts),
    }


def _thumbnail_headlines(context: dict[str, Any]) -> list[str]:
    anchor = str(context["anchor"])
    if context["anchor_verified"]:
        return [_ascii_headline(anchor, 22), "VISIBLE DANS LE RUSH", "DEUX PLANS REELS"]
    if context["comparison_ready"]:
        return ["AVANT / APRES", "RESULTAT VISIBLE", "DEUX MOMENTS REELS"]
    return ["LE MOMENT FORT", "GTA SANS DETOUR", "DEUX PLANS DU RUSH"]


def _compose_thumbnail(images: list[Any], template: str, np: Any, cv2: Any) -> Any:
    if template == "duo" and len(images) >= 2:
        left = _cover(images[0], 640, 720, cv2)
        right = _cover(images[1], 640, 720, cv2)
        canvas = np.concatenate([left, right], axis=1)
        cv2.line(canvas, (640, 0), (640, 720), (66, 245, 214), 8, cv2.LINE_AA)
    else:
        canvas = _cover(images[0], 1280, 720, cv2)
    lab = cv2.cvtColor(canvas, cv2.COLOR_BGR2LAB)
    luminance, a_channel, b_channel = cv2.split(lab)
    luminance = cv2.createCLAHE(clipLimit=1.7, tileGridSize=(8, 8)).apply(luminance)
    return cv2.cvtColor(cv2.merge((luminance, a_channel, b_channel)), cv2.COLOR_LAB2BGR)


def _decorate_thumbnail(canvas: Any, headline: str, badge: str, template: str, np: Any, cv2: Any) -> None:
    height, width = canvas.shape[:2]
    if template == "clean":
        overlay = canvas.copy()
        cv2.rectangle(overlay, (0, height - 230), (width, height), (8, 13, 22), -1)
        cv2.addWeighted(overlay, 0.72, canvas, 0.28, 0, canvas)
        origin_x, origin_y, max_width = 70, height - 125, width - 140
    else:
        gradient = np.zeros_like(canvas)
        for x in range(width):
            alpha = max(0.0, 0.82 * (1 - x / (width * 0.72)))
            gradient[:, x] = (7, 11, 18)
            canvas[:, x] = cv2.addWeighted(canvas[:, x], 1 - alpha, gradient[:, x], alpha, 0)
        origin_x, origin_y, max_width = 70, 350, 700
    cv2.rectangle(canvas, (48, 40), (210, 102), (26, 236, 202), -1)
    cv2.putText(canvas, badge, (70, 84), cv2.FONT_HERSHEY_DUPLEX, 1.1, (8, 18, 28), 2, cv2.LINE_AA)
    _put_wrapped_text(canvas, _ascii_headline(headline, 30), origin_x, origin_y, max_width, cv2)
    cv2.rectangle(canvas, (0, height - 14), (width, height), (26, 236, 202), -1)


def _put_wrapped_text(image: Any, value: str, x: int, y: int, max_width: int, cv2: Any) -> None:
    words = value.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        width = cv2.getTextSize(candidate, cv2.FONT_HERSHEY_DUPLEX, 2.05, 5)[0][0]
        if current and width > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    for index, line in enumerate(lines[:3]):
        baseline = y + index * 92
        cv2.putText(image, line, (x + 5, baseline + 5), cv2.FONT_HERSHEY_DUPLEX, 2.05, (3, 5, 10), 8, cv2.LINE_AA)
        cv2.putText(image, line, (x, baseline), cv2.FONT_HERSHEY_DUPLEX, 2.05, (248, 250, 252), 5, cv2.LINE_AA)


def _cover(image: Any, width: int, height: int, cv2: Any) -> Any:
    source_height, source_width = image.shape[:2]
    scale = max(width / source_width, height / source_height)
    resized = cv2.resize(image, (max(width, round(source_width * scale)), max(height, round(source_height * scale))), interpolation=cv2.INTER_LANCZOS4)
    y = max(0, (resized.shape[0] - height) // 2)
    x = max(0, (resized.shape[1] - width) // 2)
    return resized[y:y + height, x:x + width].copy()


def _ascii_headline(value: str, limit: int) -> str:
    folded = unicodedata.normalize("NFKD", value)
    ascii_value = "".join(character for character in folded if not unicodedata.combining(character))
    ascii_value = re.sub(r"[^A-Za-z0-9 /!?'-]+", " ", ascii_value).upper()
    return re.sub(r"\s+", " ", ascii_value).strip()[:limit].rstrip()


def _normalize(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value.casefold())
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", "".join(character for character in folded if not unicodedata.combining(character)))).strip()


def _clamp(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, value))
