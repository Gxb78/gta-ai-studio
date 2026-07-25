from __future__ import annotations

import json
import math
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from gta_ai_contracts.editing import AdvancedEditPlan

from .errors import StudioError
from .ids import uuid7


ADVANCED_EDIT_VERSION = "advanced-edit-v1"
OVERLAY_RENDER_VERSION = "overlay-ass-v1"
EDIT_STYLES = {"dynamic", "cinematic", "tutorial"}


def load_edit_template(template_root: Path, editorial_style: str) -> dict[str, Any]:
    if editorial_style not in EDIT_STYLES:
        raise StudioError("EDIT_TEMPLATE_STYLE_INVALID", "Unsupported advanced edit style.", status_code=500)
    path = template_root / "overlays" / f"{editorial_style}.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise StudioError("EDIT_TEMPLATE_INVALID", f"Invalid overlay template for {editorial_style}.", status_code=503) from error
    if value.get("schema_version") != "1.0" or value.get("editorial_style") != editorial_style:
        raise StudioError("EDIT_TEMPLATE_MISMATCH", "Overlay template identity does not match the requested style.", status_code=503)
    for key in ("motion", "density", "audio_mix", "safe_area"):
        if not isinstance(value.get(key), dict):
            raise StudioError("EDIT_TEMPLATE_INVALID", f"Overlay template is missing {key}.", status_code=503)
    motion = value["motion"]
    density = value["density"]
    audio = value["audio_mix"]
    if not 1.0 <= float(motion["max_speed"]) <= 1.5:
        raise StudioError("EDIT_TEMPLATE_INVALID", "Template max speed is outside the safe range.", status_code=503)
    if not all(1.0 <= float(motion[key]) <= 1.2 for key in ("zoom_menu", "zoom_proof")):
        raise StudioError("EDIT_TEMPLATE_INVALID", "Template zoom is outside the safe range.", status_code=503)
    if not 0.2 <= float(motion["dynamic_reframe_threshold"]) <= 0.8:
        raise StudioError("EDIT_TEMPLATE_INVALID", "Template reframe threshold is outside the safe range.", status_code=503)
    if not 1 <= int(density["max_overlays"]) <= 10 or int(density["min_gap_ms"]) < 300:
        raise StudioError("EDIT_TEMPLATE_INVALID", "Template overlay density is unsafe.", status_code=503)
    if not -18 <= float(audio["target_lufs"]) <= -12 or not -2.5 <= float(audio["true_peak_db"]) <= -0.5:
        raise StudioError("EDIT_TEMPLATE_INVALID", "Template audio target is outside the safe range.", status_code=503)
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", str(value.get("accent_color", ""))):
        raise StudioError("EDIT_TEMPLATE_INVALID", "Template accent color is invalid.", status_code=503)
    return value


def estimate_visual_attention(image_path: Path) -> dict[str, Any]:
    try:
        import cv2
        import numpy as np
    except ImportError as error:
        raise StudioError("EDIT_TRACKING_RUNTIME_MISSING", "OpenCV tracking runtime is unavailable.", status_code=503) from error
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        return {"focus_x": 0.5, "focus_y": 0.5, "confidence": 0.0, "method": "center_fallback"}
    image = cv2.resize(image, (192, 108), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype("float32") / 255.0
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV).astype("float32")
    gradient_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradient = cv2.magnitude(gradient_x, gradient_y)
    gradient /= max(1e-6, float(gradient.max()))
    saturation = hsv[:, :, 1] / 255.0
    yy, xx = np.mgrid[0:108, 0:192]
    center_prior = 0.38 + 0.62 * np.exp(-(((xx / 191 - 0.5) ** 2) / 0.20 + ((yy / 107 - 0.5) ** 2) / 0.34))
    attention = (0.72 * gradient + 0.28 * saturation) * center_prior
    threshold = float(np.percentile(attention, 68))
    weights = np.maximum(attention - threshold, 0)
    total = float(weights.sum())
    if total <= 1e-5:
        return {"focus_x": 0.5, "focus_y": 0.5, "confidence": 0.0, "method": "center_fallback"}
    focus_x = float((weights * xx).sum() / total / 191)
    focus_y = float((weights * yy).sum() / total / 107)
    contrast = float(attention.std() / max(1e-5, attention.mean()))
    confidence = max(0.15, min(0.78, 0.22 + 0.22 * contrast))
    return {
        "focus_x": round(_clamp(focus_x, 0.08, 0.92), 5),
        "focus_y": round(_clamp(focus_y, 0.12, 0.88), 5),
        "confidence": round(confidence, 5),
        "method": "visual_attention",
    }


def build_advanced_edit_plan(
    *,
    project_id: str,
    brief_id: str,
    structured_brief: dict[str, Any],
    clips: list[dict[str, Any]],
    script: dict[str, Any],
    content_plan: dict[str, Any],
    narrative_map: dict[str, Any],
    verification_report: dict[str, Any],
    analysis: dict[str, Any],
    frame_paths: dict[str, Path],
    template: dict[str, Any],
    source_duration_ms: int,
) -> dict[str, Any]:
    plan_id = uuid7()
    relevant_evidence_ids = {
        str(evidence["source_id"])
        for claim in verification_report.get("claims", [])
        if claim.get("allowed_in_script")
        for evidence in claim.get("evidence", [])
    }
    observations_by_frame = _observations_by_frame(analysis, relevant_evidence_ids)
    points: list[dict[str, Any]] = []
    for frame in sorted(analysis.get("frames", []), key=lambda item: int(item["timestamp_ms"])):
        frame_id = str(frame["id"])
        visual = estimate_visual_attention(frame_paths[frame_id]) if frame_id in frame_paths else {
            "focus_x": 0.5,
            "focus_y": 0.5,
            "confidence": 0.0,
            "method": "center_fallback",
        }
        regions = observations_by_frame.get(frame_id, [])
        combined = _combine_attention(visual, regions)
        points.append({
            "id": uuid7(),
            "segment_id": frame.get("segment_id"),
            "frame_id": frame_id,
            "timestamp_ms": int(frame["timestamp_ms"]),
            **combined,
        })
    points = _smooth_track(points)

    beats = list(content_plan.get("beats", []))
    beats_by_segment: dict[str, list[dict[str, Any]]] = {}
    for beat in beats:
        for segment_id in beat.get("segment_ids", []):
            beats_by_segment.setdefault(str(segment_id), []).append(beat)
    motion_by_segment = _segment_motion(analysis)
    motion = template["motion"]
    composition = str(structured_brief.get("production", {}).get("composition", "smart_blur"))
    advanced_clips: list[dict[str, Any]] = []
    for index, source_clip in enumerate(clips):
        clip = dict(source_clip)
        supporting_ids = [str(value) for value in clip.get("supporting_segment_ids", [])]
        matching_beats = [beat for segment_id in supporting_ids for beat in beats_by_segment.get(segment_id, [])]
        clip_points = [
            point for point in points
            if int(clip["start_ms"]) <= int(point["timestamp_ms"]) <= int(clip["end_ms"])
            or str(point.get("segment_id")) in supporting_ids
        ]
        focus = _clip_focus(clip_points)
        threshold = float(motion["dynamic_reframe_threshold"])
        if focus["confidence"] >= threshold:
            reframe_mode = "dynamic_crop"
        elif composition == "center_crop":
            reframe_mode = "fixed_crop"
        else:
            reframe_mode = "blur_background"
        purposes = {str(beat.get("purpose", "")) for beat in matching_beats}
        concepts = {str(beat.get("concept", "")) for beat in matching_beats}
        menu_signal = any(
            str(frame.get("detections", {}).get("menu_id") or "") not in {"", "None", "null"}
            for frame in analysis.get("frames", [])
            if int(clip["start_ms"]) <= int(frame["timestamp_ms"]) <= int(clip["end_ms"])
        )
        zoom = 1.0
        zoom_reason = "none"
        if "proof" in purposes or concepts & {"stats", "reward", "final_result", "mission_result", "test_result"}:
            zoom = float(motion["zoom_proof"])
            zoom_reason = "proof_focus"
        elif menu_signal or concepts & {"paint", "wheels", "engine", "brakes", "ordered_steps"}:
            zoom = float(motion["zoom_menu"])
            zoom_reason = "menu_readability"
        average_motion = _mean([motion_by_segment.get(segment_id, 0.5) for segment_id in supporting_ids], default=0.5)
        requested_speed = 1.0
        speed_reason = "none"
        if ("transition" in purposes or menu_signal) and average_motion < 0.16:
            requested_speed = min(float(motion["max_speed"]), 1.1 + max(0.0, 0.16 - average_motion) * 1.5)
            speed_reason = "compress_low_motion_wait"
        output_duration = int(clip["duration_ms"])
        start_ms, end_ms, speed = _fit_speed_range(
            int(clip["start_ms"]),
            int(clip["end_ms"]),
            output_duration,
            requested_speed,
            source_duration_ms,
        )
        advanced_clips.append({
            **clip,
            "index": index,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "source_duration_ms": end_ms - start_ms,
            "duration_ms": output_duration,
            "speed": round(speed, 5),
            "speed_reason": speed_reason if speed > 1.01 else "none",
            "reframe_mode": reframe_mode,
            "focus_start_x": 0.5 if reframe_mode == "fixed_crop" else focus["start_x"],
            "focus_end_x": 0.5 if reframe_mode == "fixed_crop" else focus["end_x"],
            "focus_y": 0.5 if reframe_mode == "fixed_crop" else focus["focus_y"],
            "tracking_confidence": focus["confidence"],
            "tracking_method": focus["method"],
            "zoom": zoom,
            "zoom_reason": zoom_reason,
            "concepts": sorted(concepts),
            "purposes": sorted(purposes),
        })

    comparison = _build_before_after(narrative_map, advanced_clips, source_duration_ms)
    if comparison:
        target = advanced_clips[int(comparison["target_clip_index"])]
        target["comparison"] = comparison
        target["speed"] = 1.0
        target["source_duration_ms"] = int(target["duration_ms"])
        target["start_ms"] = min(
            max(0, source_duration_ms - int(target["duration_ms"])),
            int(target["start_ms"]),
        )
        target["end_ms"] = int(target["start_ms"]) + int(target["duration_ms"])
        target["reframe_mode"] = "split_screen"
        target["zoom"] = 1.0

    transitions = _build_transitions(advanced_clips, int(motion["transition_ms"]))
    for transition in transitions:
        advanced_clips[int(transition["from_index"])]["fade_out_ms"] = transition["duration_ms"]
        advanced_clips[int(transition["to_index"])]["fade_in_ms"] = transition["duration_ms"]
    overlays = _build_overlay_cues(
        advanced_clips,
        script,
        structured_brief,
        comparison,
        template,
        {str(value) for value in verification_report.get("gate", {}).get("admitted_claim_ids", [])},
    )
    tracking_confidence = _mean([float(point["confidence"]) for point in points], default=0.0)
    dynamic_count = sum(clip["reframe_mode"] == "dynamic_crop" for clip in advanced_clips)
    fallback_count = sum(clip["reframe_mode"] in {"blur_background", "fixed_crop"} for clip in advanced_clips)
    summary = {
        "clip_count": len(advanced_clips),
        "track_point_count": len(points),
        "tracking_confidence": round(tracking_confidence, 5),
        "dynamic_reframe_count": dynamic_count,
        "fallback_reframe_count": fallback_count,
        "zoom_effect_count": sum(float(clip["zoom"]) > 1.001 for clip in advanced_clips),
        "speed_effect_count": sum(float(clip["speed"]) > 1.01 for clip in advanced_clips),
        "comparison_count": 1 if comparison else 0,
        "overlay_count": len(overlays),
        "transition_count": len(transitions),
    }
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    payload = {
        "id": plan_id,
        "schema_version": "1.0",
        "algorithm_version": ADVANCED_EDIT_VERSION,
        "project_id": project_id,
        "brief_id": brief_id,
        "status": "READY_WITH_FALLBACKS" if fallback_count else "READY",
        "template": {
            "id": template["id"],
            "version": template["version"],
            "editorial_style": template["editorial_style"],
            "font_family": template["font_family"],
            "accent_color": template["accent_color"],
            "secondary_color": template["secondary_color"],
        },
        "safe_area": template["safe_area"],
        "clips": advanced_clips,
        "subject_track": points,
        "overlays": overlays,
        "transitions": transitions,
        "audio_mix": {
            **template["audio_mix"],
            "source_audio_level": float(structured_brief.get("production", {}).get("source_audio_level", 0.16)),
            "strategy": "voice_priority_sidechain_with_loudness_target",
        },
        "summary": summary,
        "safety": {
            "overlay_claim_rule": "Only claim IDs already admitted by the Phase 5 gate may support factual overlays.",
            "admitted_claim_ids": list(verification_report.get("gate", {}).get("admitted_claim_ids", [])),
            "decorative_effect_limit": int(template["density"]["max_overlays"]),
            "source_only": True,
        },
        "created_at": now,
    }
    return AdvancedEditPlan.model_validate(payload).model_dump(mode="json")


def write_overlay_ass(plan: dict[str, Any], destination: Path) -> None:
    template = plan["template"]
    accent = _ass_color(str(template["accent_color"]))
    secondary = _ass_color(str(template["secondary_color"]))
    font = str(template["font_family"]).replace(",", " ")
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Title,{font},82,{accent},{accent},&H00101010,&H90060A0D,-1,0,0,0,100,100,1,0,3,4,1,8,90,90,170,1
Style: Step,{font},48,{secondary},{secondary},&H00101010,&HA0060A0D,-1,0,0,0,100,100,0,0,3,3,1,7,75,75,240,1
Style: Proof,{font},42,{accent},{accent},&H00101010,&HA0060A0D,-1,0,0,0,100,100,0,0,3,3,1,9,75,75,250,1
Style: Compare,{font},58,{accent},{accent},&H00101010,&HB0060A0D,-1,0,0,0,100,100,1,0,3,4,1,8,60,60,180,1
Style: Result,{font},54,{secondary},{secondary},&H00101010,&HA0060A0D,-1,0,0,0,100,100,0,0,3,3,1,8,80,80,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events: list[str] = []
    for cue in plan.get("overlays", []):
        if not bool(cue.get("enabled", True)):
            continue
        cue_type = str(cue["cue_type"])
        start = _ass_time(int(cue["start_ms"]))
        end = _ass_time(int(cue["end_ms"]))
        text = _ass_text(str(cue["text"]))
        if cue_type == "before_after":
            secondary_text = _ass_text(str(cue.get("secondary_text") or "APRÈS"))
            events.append(f"Dialogue: 2,{start},{end},Compare,,0,0,0,,{{\\pos(270,220)\\fad(100,100)}}{text}")
            events.append(f"Dialogue: 2,{start},{end},Compare,,0,0,0,,{{\\pos(810,220)\\fad(100,100)}}{secondary_text}")
            continue
        style = {"title": "Title", "step": "Step", "proof": "Proof", "result": "Result", "conclusion": "Result"}.get(cue_type, "Step")
        events.append(f"Dialogue: 2,{start},{end},{style},,0,0,0,,{{\\fad(100,120)}}{text}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        temporary.write_text(header + "\n".join(events) + "\n", encoding="utf-8-sig")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def _observations_by_frame(analysis: dict[str, Any], relevant_ids: set[str]) -> dict[str, list[dict[str, Any]]]:
    output: dict[str, list[dict[str, Any]]] = {}
    for source_type, items in (("ocr_text", analysis.get("texts", [])), ("detected_entity", analysis.get("entities", []))):
        for item in items:
            region = item.get("region")
            frame_id = item.get("frame_id")
            if not frame_id or not isinstance(region, dict):
                continue
            weight = float(item.get("confidence", 0.5)) * (1.65 if str(item.get("id")) in relevant_ids else 1.0)
            output.setdefault(str(frame_id), []).append({
                "focus_x": _clamp(float(region.get("x", 0)) + float(region.get("width", 0)) / 2, 0, 1),
                "focus_y": _clamp(float(region.get("y", 0)) + float(region.get("height", 0)) / 2, 0, 1),
                "weight": weight,
                "source_type": source_type,
            })
    return output


def _combine_attention(visual: dict[str, Any], regions: list[dict[str, Any]]) -> dict[str, Any]:
    if not regions:
        return dict(visual)
    region_weight = sum(float(region["weight"]) for region in regions)
    region_x = sum(float(region["focus_x"]) * float(region["weight"]) for region in regions) / region_weight
    region_y = sum(float(region["focus_y"]) * float(region["weight"]) for region in regions) / region_weight
    visual_weight = max(0.15, float(visual["confidence"]) * 0.75)
    total = region_weight + visual_weight
    return {
        "focus_x": round(_clamp((region_x * region_weight + float(visual["focus_x"]) * visual_weight) / total, 0.06, 0.94), 5),
        "focus_y": round(_clamp((region_y * region_weight + float(visual["focus_y"]) * visual_weight) / total, 0.08, 0.92), 5),
        "confidence": round(_clamp(0.45 + 0.25 * min(1.0, region_weight) + 0.2 * float(visual["confidence"]), 0, 0.94), 5),
        "method": "combined" if float(visual["confidence"]) > 0 else "evidence_region",
        "source_type": "+".join(sorted({str(region["source_type"]) for region in regions})),
    }


def _smooth_track(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not points:
        return []
    output: list[dict[str, Any]] = []
    previous_x = float(points[0]["focus_x"])
    previous_y = float(points[0]["focus_y"])
    for point in points:
        raw_x = float(point["focus_x"])
        raw_y = float(point["focus_y"])
        next_x = _clamp(previous_x * 0.62 + raw_x * 0.38, previous_x - 0.14, previous_x + 0.14)
        next_y = _clamp(previous_y * 0.68 + raw_y * 0.32, previous_y - 0.1, previous_y + 0.1)
        value = {**point, "focus_x": round(next_x, 5), "focus_y": round(next_y, 5)}
        if "source_type" not in value:
            value["source_type"] = "image" if value["method"] == "visual_attention" else "fallback"
        output.append(value)
        previous_x, previous_y = next_x, next_y
    return output


def _clip_focus(points: list[dict[str, Any]]) -> dict[str, Any]:
    if not points:
        return {"start_x": 0.5, "end_x": 0.5, "focus_y": 0.5, "confidence": 0.0, "method": "center_fallback"}
    ordered = sorted(points, key=lambda point: int(point["timestamp_ms"]))
    confidence = _mean([float(point["confidence"]) for point in ordered], default=0.0)
    methods = {str(point["method"]) for point in ordered}
    return {
        "start_x": round(float(ordered[0]["focus_x"]), 5),
        "end_x": round(float(ordered[-1]["focus_x"]), 5),
        "focus_y": round(_mean([float(point["focus_y"]) for point in ordered], default=0.5), 5),
        "confidence": round(confidence, 5),
        "method": "combined" if len(methods) > 1 or "combined" in methods else next(iter(methods)),
    }


def _segment_motion(analysis: dict[str, Any]) -> dict[str, float]:
    grouped: dict[str, list[float]] = {}
    for frame in analysis.get("frames", []):
        grouped.setdefault(str(frame.get("segment_id")), []).append(float(frame.get("metrics", {}).get("motion", 0)))
    return {key: _mean(values, default=0.0) for key, values in grouped.items()}


def _fit_speed_range(start: int, end: int, output_duration: int, requested_speed: float, source_duration: int) -> tuple[int, int, float]:
    desired = max(end - start, round(output_duration * requested_speed))
    desired = min(desired, source_duration)
    center = (start + end) // 2
    next_start = max(0, min(source_duration - desired, center - desired // 2))
    next_end = min(source_duration, next_start + desired)
    actual_speed = (next_end - next_start) / max(1, output_duration)
    if actual_speed < 1.01:
        return start, end, 1.0
    return next_start, next_end, min(requested_speed, actual_speed)


def _build_before_after(narrative_map: dict[str, Any], clips: list[dict[str, Any]], source_duration_ms: int) -> dict[str, Any] | None:
    beats = {str(beat.get("concept")): beat for beat in narrative_map.get("beats", [])}
    before = beats.get("original_appearance")
    after = beats.get("final_result")
    if not before or not after or before.get("status") not in {"found", "partially_found"} or after.get("status") not in {"found", "partially_found"}:
        return None
    if not before.get("candidate_segments") or not after.get("candidate_segments"):
        return None
    eligible = [clip for clip in clips if int(clip["duration_ms"]) >= 1200]
    if not eligible:
        return None
    target = eligible[-1]
    before_candidate = before["candidate_segments"][0]
    after_candidate = after["candidate_segments"][0]
    duration = int(target["duration_ms"])
    return {
        "target_clip_index": int(target["index"]),
        "before_start_ms": max(0, min(source_duration_ms - duration, int(before_candidate["start_ms"]))),
        "after_start_ms": max(0, min(source_duration_ms - duration, int(after_candidate["start_ms"]))),
        "duration_ms": duration,
        "before_segment_id": before_candidate["segment_id"],
        "after_segment_id": after_candidate["segment_id"],
        "layout": "vertical_split",
        "reason": "Original and final states both have candidate segments in the rush.",
    }


def _build_transitions(clips: list[dict[str, Any]], duration_ms: int) -> list[dict[str, Any]]:
    transitions: list[dict[str, Any]] = []
    for index in range(1, len(clips)):
        previous = clips[index - 1]
        current = clips[index]
        if previous.get("purposes") == current.get("purposes") or len(transitions) >= 2:
            continue
        transitions.append({
            "id": uuid7(),
            "from_index": index - 1,
            "to_index": index,
            "type": "dip_to_black",
            "duration_ms": min(duration_ms, int(previous["duration_ms"]) // 4, int(current["duration_ms"]) // 4),
            "reason": "Narrative purpose boundary",
        })
    return [transition for transition in transitions if int(transition["duration_ms"]) >= 60]


def _build_overlay_cues(
    clips: list[dict[str, Any]],
    script: dict[str, Any],
    structured_brief: dict[str, Any],
    comparison: dict[str, Any] | None,
    template: dict[str, Any],
    admitted_claim_ids: set[str],
) -> list[dict[str, Any]]:
    duration_total = sum(int(clip["duration_ms"]) for clip in clips)
    if duration_total <= 0:
        return []
    density = template["density"]
    max_overlays = int(density["max_overlays"])
    content_label = {
        "vehicle_customization": "CUSTOMISATION",
        "vehicle_showcase": "PRÉSENTATION",
        "mission_showcase": "MISSION",
        "mission_guide": "GUIDE MISSION",
        "tip": "ASTUCE",
        "comparison": "COMPARAISON",
        "myth_test": "TEST DU MYTHE",
    }.get(str(structured_brief.get("content_type")), "GTA EN IMAGES")
    cues: list[dict[str, Any]] = [_overlay(
        "title", 0, min(duration_total, int(density["title_duration_ms"])), content_label, "title",
    )]
    positions: list[tuple[int, dict[str, Any]]] = []
    cursor = 0
    for clip in clips:
        positions.append((cursor, clip))
        cursor += int(clip["duration_ms"])
    claim_ids_by_segment: dict[str, set[str]] = {}
    for block in script.get("blocks", []):
        for segment_id in block.get("supporting_segment_ids", []):
            claim_ids_by_segment.setdefault(str(segment_id), set()).update(str(value) for value in block.get("supporting_claim_ids", []))
    last_end = int(cues[0]["end_ms"])
    for index, (position, clip) in enumerate(positions[1:], start=2):
        if len(cues) >= max_overlays:
            break
        if position - last_end < int(density["min_gap_ms"]):
            continue
        claim_ids = sorted({
            claim_id
            for segment_id in clip.get("supporting_segment_ids", [])
            for claim_id in claim_ids_by_segment.get(str(segment_id), set())
            if claim_id in admitted_claim_ids
        })
        if claim_ids:
            duration = int(density["proof_duration_ms"])
            cue = _overlay("proof", position, min(duration_total, position + duration), "PREUVE À L’ÉCRAN", "proof", claim_ids)
        else:
            duration = int(density["step_duration_ms"])
            cue = _overlay("step", position, min(duration_total, position + duration), f"PLAN {index:02}", "step")
        if int(cue["end_ms"]) > int(cue["start_ms"]):
            cues.append(cue)
            last_end = int(cue["end_ms"])
    if comparison and len(cues) < max_overlays:
        position = positions[int(comparison["target_clip_index"])][0]
        end = min(duration_total, position + int(comparison["duration_ms"]))
        cues.append(_overlay("before_after", position, end, "AVANT", "before_after", secondary_text="APRÈS"))
    if len(cues) < max_overlays and duration_total >= 1800:
        start = max(0, duration_total - 1400)
        if start - last_end >= int(density["min_gap_ms"]):
            cues.append(_overlay("conclusion", start, duration_total, "RÉSULTAT", "conclusion"))
    return sorted(cues, key=lambda cue: (int(cue["start_ms"]), str(cue["cue_type"])))[:max_overlays]


def _overlay(
    cue_type: str,
    start_ms: int,
    end_ms: int,
    text: str,
    template_key: str,
    supporting_claim_ids: list[str] | None = None,
    *,
    secondary_text: str | None = None,
) -> dict[str, Any]:
    return {
        "id": uuid7(),
        "cue_type": cue_type,
        "start_ms": start_ms,
        "end_ms": max(start_ms + 1, end_ms),
        "text": text,
        "secondary_text": secondary_text,
        "template_key": template_key,
        "supporting_claim_ids": supporting_claim_ids or [],
        "parameters": {"safe_area": True, "animation": "short_fade"},
    }


def _ass_color(hex_color: str) -> str:
    red, green, blue = hex_color[1:3], hex_color[3:5], hex_color[5:7]
    return f"&H00{blue}{green}{red}".upper()


def _ass_text(value: str) -> str:
    return value.replace("{", "(").replace("}", ")").replace("\n", " ").upper()


def _ass_time(milliseconds: int) -> str:
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours}:{minutes:02}:{seconds:02}.{millis // 10:02}"


def _mean(values: list[float], *, default: float) -> float:
    return sum(values) / len(values) if values else default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))
