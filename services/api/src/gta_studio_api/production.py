from __future__ import annotations

import math
import re
from fractions import Fraction
from pathlib import Path
from typing import Any

from gta_ai_contracts.common import Rational
from gta_ai_contracts.timeline import (
    SafeArea,
    TimelineClip,
    TimelineEffect,
    TimelineMarker,
    TimelineProject,
    TimelineSource,
    TimelineTrack,
    TimelineTransition,
)

from .ids import uuid7
from .narrative_intelligence import selected_segment_ids, understand_brief


STYLE_SETTINGS: dict[str, dict[str, str]] = {
    "dynamic": {"tone": "enthusiastic", "pacing": "very_dynamic", "prefix": "On teste :", "hook": "Voici le défi."},
    "cinematic": {"tone": "cinematic", "pacing": "balanced", "prefix": "Mission :", "hook": "Tout commence ici."},
    "tutorial": {"tone": "informative", "pacing": "balanced", "prefix": "Objectif du guide :", "hook": "On va droit au but."},
}


def normalize_brief(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def structure_brief(
    raw_instruction: str,
    *,
    game_id: str,
    target_duration_seconds: int,
    editorial_style: str,
    voice_id: str | None,
    voice_rate: int,
    caption_style: str,
    composition: str,
    source_audio_level: float,
    include_hook: bool,
    include_cta: bool,
) -> dict[str, Any]:
    normalized = normalize_brief(raw_instruction)
    style = STYLE_SETTINGS[editorial_style]
    understanding = understand_brief(normalized)
    return {
        "schema_version": "1.0",
        "raw_instruction": normalized,
        "language": "fr-FR",
        "game": game_id,
        "content_type": understanding["content_type"],
        "subject": understanding["subject"],
        "objective": normalized,
        "target_platforms": ["tiktok", "youtube_shorts"],
        "target_duration_seconds": target_duration_seconds,
        "target_aspect_ratio": "9:16",
        "narrative_order": understanding["narrative_order"],
        "must_include": understanding["must_include"],
        "must_include_concepts": understanding["must_include_concepts"],
        "should_include": understanding["should_include"],
        "must_avoid": ["affirmation non vérifiée", "information absente du rush"],
        "expected_events": understanding["expected_events"],
        "expected_visual_proofs": understanding["expected_visual_proofs"],
        "requested_facts": understanding["requested_facts"],
        "requested_comparisons": understanding["requested_comparisons"],
        "tone": style["tone"],
        "pacing": style["pacing"],
        "spoiler_level": "none",
        "voice_mode": "synthetic_voice",
        "publish_mode": "local_export",
        "confidence": understanding["confidence"],
        "ambiguities": understanding["ambiguities"],
        "production": {
            "editorial_style": editorial_style,
            "voice_id": voice_id,
            "voice_rate": voice_rate,
            "caption_style": caption_style,
            "composition": composition,
            "source_audio_level": source_audio_level,
            "include_hook": include_hook,
            "include_cta": include_cta,
        },
    }


def build_script(
    structured_brief: dict[str, Any],
    output_duration_ms: int,
    *,
    content_plan: dict[str, Any] | None = None,
    coverage_report: dict[str, Any] | None = None,
    verification_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    production = dict(structured_brief["production"])
    style = STYLE_SETTINGS[str(production["editorial_style"])]
    voice_rate = int(production["voice_rate"])
    available_words = max(4, math.floor(output_duration_ms / 1000 * 2.25 * (1 + voice_rate * 0.08) * 0.82))
    missing_required = bool(coverage_report and coverage_report.get("complementary_footage"))
    objective = (
        "voici uniquement les séquences réellement disponibles dans le rush"
        if missing_required
        else normalize_brief(str(structured_brief["objective"])).strip(" .!?")
    )
    objective_words = objective.split()
    prefix_words = style["prefix"].split()
    hook_words = style["hook"].split() if production["include_hook"] else []
    cta_words = "À toi de jouer.".split() if production["include_cta"] else []
    minimum_objective_words = min(len(objective_words), max(2, available_words - len(prefix_words)))
    optional_budget = available_words - len(prefix_words) - minimum_objective_words
    use_hook = bool(hook_words and optional_budget >= len(hook_words))
    if use_hook:
        optional_budget -= len(hook_words)
    use_cta = bool(cta_words and optional_budget >= len(cta_words))
    reserved = len(prefix_words) + (len(hook_words) if use_hook else 0) + (len(cta_words) if use_cta else 0)
    objective_budget = max(1, available_words - reserved)
    objective_text = f"{style['prefix']} {' '.join(objective_words[:objective_budget])}.".replace("..", ".")

    planned_beats = list(content_plan.get("beats", [])) if content_plan else []
    verified_claims = list(verification_report.get("claims", [])) if verification_report else []
    claims_by_segment: dict[str, list[str]] = {}
    for claim in verified_claims:
        if not claim.get("allowed_in_script"):
            continue
        for evidence in claim.get("evidence", []):
            segment_id = evidence.get("metadata", {}).get("segment_id")
            if evidence.get("evidence_type") == "segment":
                segment_id = evidence.get("source_id")
            if segment_id:
                claims_by_segment.setdefault(str(segment_id), []).append(str(claim["id"]))

    raw_blocks: list[tuple[str, str, list[str], list[str]]] = []
    if use_hook:
        raw_blocks.append(("hook", style["hook"], [], []))
    first_support = [str(value) for value in (planned_beats[0].get("segment_ids", []) if planned_beats else [])]
    first_claims = sorted({claim_id for segment_id in first_support for claim_id in claims_by_segment.get(segment_id, [])})
    raw_blocks.append(("context", objective_text, first_support, first_claims))
    narration_labels = {
        "workshop_entry": "On entre dans l’atelier.",
        "paint": "Place au choix de la peinture.",
        "wheels": "On passe aux roues et aux jantes.",
        "spoiler": "Voici le choix de l’aileron.",
        "engine": "On regarde maintenant l’amélioration moteur.",
        "brakes": "Puis viennent les freins.",
        "mission_objective": "Voici l’objectif affiché à l’écran.",
        "ordered_steps": "On enchaîne les étapes visibles dans l’ordre.",
        "combat": "La séquence d’action commence ici.",
        "driving": "Place maintenant à la conduite.",
        "proof": "Le résultat apparaît directement à l’écran.",
        "final_result": "Et voici le résultat final visible.",
        "mission_result": "Voici l’issue montrée par le rush.",
        "overview": "Voici les moments les plus pertinents du rush.",
    }
    remaining_budget = max(0, available_words - sum(len(text.split()) for _, text, _, _ in raw_blocks) - (len(cta_words) if use_cta else 0))
    for beat in planned_beats:
        narration = narration_labels.get(str(beat.get("concept", "")))
        if not narration or len(narration.split()) > remaining_budget:
            continue
        purpose = str(beat.get("purpose", "explanation"))
        if purpose not in {"hook", "context", "explanation", "transition", "proof", "comparison", "conclusion", "call_to_action"}:
            purpose = "explanation"
        support = [str(value) for value in beat.get("segment_ids", [])]
        claim_ids = sorted({claim_id for segment_id in support for claim_id in claims_by_segment.get(segment_id, [])})
        raw_blocks.append((purpose, narration, support, claim_ids))
        remaining_budget -= len(narration.split())
    factual_claim_ids: list[str] = []
    for claim in verified_claims:
        narration = claim.get("safe_narration")
        if not claim.get("allowed_in_script") or not narration or len(str(narration).split()) > remaining_budget:
            continue
        support = sorted({
            str(evidence.get("metadata", {}).get("segment_id"))
            for evidence in claim.get("evidence", [])
            if evidence.get("metadata", {}).get("segment_id")
        })
        raw_blocks.append(("proof", str(narration), support, [str(claim["id"])]))
        factual_claim_ids.append(str(claim["id"]))
        remaining_budget -= len(str(narration).split())
    if use_cta:
        raw_blocks.append(("call_to_action", "À toi de jouer.", [], []))

    weights = [max(1, len(text.split())) for _, text, _, _ in raw_blocks]
    total_weight = sum(weights)
    blocks: list[dict[str, Any]] = []
    for index, ((purpose, narration, support, claim_ids), weight) in enumerate(zip(raw_blocks, weights, strict=True)):
        blocks.append({
            "id": uuid7(),
            "sort_order": index,
            "purpose": purpose,
            "narration": narration,
            "on_screen_text": narration,
            "supporting_segment_ids": support,
            "supporting_claim_ids": claim_ids,
            "estimated_duration_ms": max(450, round(output_duration_ms * weight / total_weight)),
            "confidence": 1.0 if purpose != "context" else 0.9,
        })
    return {
        "schema_version": "1.0",
        "language": "fr-FR",
        "estimated_duration_ms": sum(block["estimated_duration_ms"] for block in blocks),
        "full_text": " ".join(block["narration"] for block in blocks),
        "blocks": blocks,
        "safety": {
            "strategy": "evidence_gated_editorial_plan" if verification_report else ("coverage_gated_editorial_plan" if content_plan else "brief_as_intention"),
            "added_factual_claims": len(factual_claim_ids),
            "sourced_claim_ids": factual_claim_ids,
            "blocked_claims": int(verification_report.get("summary", {}).get("blocked_claim_count", 0)) if verification_report else 0,
            "factual_gate": verification_report.get("status") if verification_report else "not_run",
            "omitted_missing_intents": len(coverage_report.get("complementary_footage", [])) if coverage_report else 0,
            "notice": "Le script ne décrit que les intentions reliées à des segments candidats et n’affirme aucun fait GTA non vérifié.",
        },
    }


def build_scene_segments(boundaries_ms: list[int], duration_ms: int, media_id: str) -> list[dict[str, Any]]:
    clean = sorted({0, *[value for value in boundaries_ms if 700 <= value <= duration_ms - 700], duration_ms})
    merged = [clean[0]]
    for boundary in clean[1:]:
        if boundary != duration_ms and boundary - merged[-1] < 700:
            continue
        merged.append(boundary)
    if merged[-1] != duration_ms:
        merged.append(duration_ms)
    segments: list[dict[str, Any]] = []
    for index, (start_ms, end_ms) in enumerate(zip(merged, merged[1:])):
        segments.append({
            "id": uuid7(),
            "media_id": media_id,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "scene_type": "opening" if index == 0 else "detected_cut",
            "summary": f"Plan {index + 1} détecté automatiquement",
            "motion_score": 0.5,
            "visual_quality_score": 0.75,
            "relevance_score": 0.5,
            "novelty_score": 0.65 if index else 0.5,
            "confidence": 0.75,
            "attributes": {"detector": "ffmpeg-scene", "ordinal": index + 1},
        })
    return segments


def select_edit_clips(segments: list[dict[str, Any]], source_duration_ms: int, target_duration_ms: int, pacing: str) -> list[dict[str, Any]]:
    output_duration_ms = min(source_duration_ms, target_duration_ms)
    if output_duration_ms >= source_duration_ms:
        return [{
            "start_ms": 0,
            "end_ms": source_duration_ms,
            "duration_ms": source_duration_ms,
            "supporting_segment_ids": [segment["id"] for segment in segments],
        }]

    max_clips = {"slow": 3, "balanced": 5, "dynamic": 7, "very_dynamic": 9}.get(pacing, 5)
    clip_count = max(1, min(max_clips, len(segments), output_duration_ms // 1200 or 1))
    base_duration = output_duration_ms // clip_count
    remainder = output_duration_ms % clip_count
    clips: list[dict[str, Any]] = []
    previous_end = 0
    for index in range(clip_count):
        duration = base_duration + (1 if index < remainder else 0)
        if clip_count == 1:
            start = 0
        else:
            ideal = round(index * (source_duration_ms - duration) / (clip_count - 1))
            start = max(previous_end, ideal)
        end = min(source_duration_ms, start + duration)
        start = max(previous_end, end - duration)
        overlaps = [
            segment["id"] for segment in segments
            if int(segment["start_ms"]) < end and int(segment["end_ms"]) > start
        ]
        clips.append({"start_ms": start, "end_ms": end, "duration_ms": end - start, "supporting_segment_ids": overlaps})
        previous_end = end
    return clips


def select_semantic_clips(segments: list[dict[str, Any]], source_duration_ms: int, target_duration_ms: int, pacing: str) -> list[dict[str, Any]]:
    output_duration_ms = min(source_duration_ms, target_duration_ms)
    if output_duration_ms >= source_duration_ms or not segments:
        return select_edit_clips(segments, source_duration_ms, target_duration_ms, pacing)
    max_clips = {"slow": 3, "balanced": 5, "dynamic": 7, "very_dynamic": 9}.get(pacing, 5)
    clip_count = max(1, min(max_clips, len(segments), output_duration_ms // 1200 or 1))
    base_duration = output_duration_ms // clip_count
    remainder = output_duration_ms % clip_count
    ranked = sorted(
        segments,
        key=lambda segment: (
            -(0.74 * float(segment["relevance_score"]) + 0.26 * float(segment["visual_quality_score"])),
            int(segment["start_ms"]),
        ),
    )
    selected: list[dict[str, Any]] = []
    for segment in ranked:
        if len(selected) >= clip_count:
            break
        desired = base_duration + (1 if len(selected) < remainder else 0)
        center = (int(segment["start_ms"]) + int(segment["end_ms"])) // 2
        start = max(0, min(source_duration_ms - desired, center - desired // 2))
        end = start + desired
        if any(start < int(existing["end_ms"]) and end > int(existing["start_ms"]) for existing in selected):
            continue
        overlaps = [
            candidate["id"] for candidate in segments
            if int(candidate["start_ms"]) < end and int(candidate["end_ms"]) > start
        ]
        selected.append({
            "start_ms": start,
            "end_ms": end,
            "duration_ms": desired,
            "supporting_segment_ids": overlaps,
            "selection_score": round(0.74 * float(segment["relevance_score"]) + 0.26 * float(segment["visual_quality_score"]), 5),
        })
    if len(selected) != clip_count or sum(int(clip["duration_ms"]) for clip in selected) != output_duration_ms:
        return select_edit_clips(segments, source_duration_ms, target_duration_ms, pacing)
    return sorted(selected, key=lambda clip: int(clip["start_ms"]))


def select_planned_clips(
    segments: list[dict[str, Any]],
    content_plan: dict[str, Any],
    source_duration_ms: int,
    target_duration_ms: int,
    pacing: str,
) -> list[dict[str, Any]]:
    planned_ids = set(selected_segment_ids(content_plan))
    if not planned_ids:
        return select_semantic_clips(segments, source_duration_ms, target_duration_ms, pacing)
    prioritized = [{
        **segment,
        "relevance_score": max(
            float(segment.get("relevance_score", 0)),
            1.0 if str(segment["id"]) in planned_ids else 0.0,
        ),
    } for segment in segments]
    return select_semantic_clips(prioritized, source_duration_ms, target_duration_ms, pacing)


def build_captions(script: dict[str, Any], voice_duration_ms: int, output_duration_ms: int) -> list[dict[str, Any]]:
    words: list[str] = []
    for block in script["blocks"]:
        words.extend(str(block["narration"]).split())
    if not words:
        return []
    groups = [words[index:index + 6] for index in range(0, len(words), 6)]
    usable_duration = min(voice_duration_ms, output_duration_ms)
    total_words = len(words)
    cursor = 0
    captions: list[dict[str, Any]] = []
    for index, group in enumerate(groups):
        start = round(usable_duration * cursor / total_words)
        cursor += len(group)
        end = round(usable_duration * cursor / total_words)
        captions.append({
            "id": uuid7(),
            "index": index + 1,
            "start_ms": start,
            "end_ms": max(start + 300, min(output_duration_ms, end)),
            "text": " ".join(group),
        })
    captions[-1]["end_ms"] = min(output_duration_ms, max(captions[-1]["end_ms"], usable_duration))
    return captions


def write_subtitles(captions: list[dict[str, Any]], srt_path: Path, ass_path: Path, style: str) -> None:
    srt_lines: list[str] = []
    for caption in captions:
        srt_lines.extend([
            str(caption["index"]),
            f"{_srt_time(int(caption['start_ms']))} --> {_srt_time(int(caption['end_ms']))}",
            str(caption["text"]),
            "",
        ])
    _write_text_atomic(srt_path, "\n".join(srt_lines), encoding="utf-8")

    if style == "impact":
        font_size, primary, outline, bold = 76, "&H00FFFFFF", "&H00101010", -1
    else:
        font_size, primary, outline, bold = 58, "&H00FFFFFF", "&H00101010", 0
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: GTA,Segoe UI,{font_size},{primary},&H000000FF,{outline},&H70000000,{bold},0,0,0,100,100,0,0,1,5,2,2,80,80,290,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for caption in captions:
        text = str(caption["text"]).replace("{", "(").replace("}", ")")
        if style == "impact":
            text = text.upper()
        events.append(f"Dialogue: 0,{_ass_time(int(caption['start_ms']))},{_ass_time(int(caption['end_ms']))},GTA,,0,0,0,,{text}")
    _write_text_atomic(ass_path, header + "\n".join(events) + "\n", encoding="utf-8-sig")


def build_timeline(
    *,
    project_id: str,
    media_id: str,
    media_uri: str,
    voice_artifact_id: str,
    clips: list[dict[str, Any]],
    captions: list[dict[str, Any]],
    composition: str,
    output_duration_ms: int,
    width: int = 1080,
    height: int = 1920,
    advanced_edit_plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    timeline_id = uuid7()
    video_track_id = uuid7()
    ambient_track_id = uuid7()
    voice_track_id = uuid7()
    text_track_id = uuid7()
    overlay_track_id = uuid7()
    position = 0
    video_clips: list[TimelineClip] = []
    ambient_clips: list[TimelineClip] = []
    markers: list[TimelineMarker] = []
    clip_ids: list[str] = []
    for index, clip in enumerate(clips):
        clip_id = uuid7()
        clip_ids.append(clip_id)
        duration = int(clip["duration_ms"])
        source_duration = int(clip.get("source_duration_ms", duration))
        speed_fraction = Fraction(str(clip.get("speed", 1.0))).limit_denominator(1000)
        effects = [TimelineEffect(
            type="subject_reframe",
            version="1.0",
            parameters={
                "mode": str(clip.get("reframe_mode", composition)),
                "focus_start_x": float(clip.get("focus_start_x", 0.5)),
                "focus_end_x": float(clip.get("focus_end_x", 0.5)),
                "focus_y": float(clip.get("focus_y", 0.5)),
                "confidence": float(clip.get("tracking_confidence", 0.0)),
                "method": str(clip.get("tracking_method", "center_fallback")),
            },
        )]
        if float(clip.get("zoom", 1.0)) > 1.001:
            effects.append(TimelineEffect(
                type="zoom",
                version="1.0",
                parameters={"factor": float(clip["zoom"]), "reason": str(clip.get("zoom_reason", "attention"))},
            ))
        if float(clip.get("speed", 1.0)) > 1.01:
            effects.append(TimelineEffect(
                type="speed",
                version="1.0",
                parameters={"factor": float(clip["speed"]), "reason": str(clip.get("speed_reason", "rhythm"))},
            ))
        if clip.get("comparison"):
            effects.append(TimelineEffect(
                type="comparison_split",
                version="1.0",
                parameters=dict(clip["comparison"]),
            ))
        video_clips.append(TimelineClip(
            id=clip_id,
            track_id=video_track_id,
            start=position,
            duration=duration,
            source=TimelineSource(
                media_id=media_id,
                uri=media_uri,
                source_in=int(clip["start_ms"]),
                source_duration=source_duration,
            ),
            speed=Rational(numerator=speed_fraction.numerator, denominator=speed_fraction.denominator),
            effects=effects,
            supporting_segment_ids=list(clip["supporting_segment_ids"]),
        ))
        ambient_clips.append(TimelineClip(
            id=uuid7(),
            track_id=ambient_track_id,
            start=position,
            duration=duration,
            source=TimelineSource(
                media_id=media_id,
                uri=media_uri,
                source_in=int(clip["start_ms"]),
                source_duration=source_duration,
            ),
            speed=Rational(numerator=speed_fraction.numerator, denominator=speed_fraction.denominator),
            effects=[TimelineEffect(
                type="volume",
                version="1.0",
                parameters={"level": float((advanced_edit_plan or {}).get("audio_mix", {}).get("source_audio_level", 0.16))},
            )],
            supporting_segment_ids=list(clip["supporting_segment_ids"]),
        ))
        markers.append(TimelineMarker(id=uuid7(), position=position, kind="beat", label=f"Plan {index + 1}"))
        position += duration
    text_clips = [
        TimelineClip(
            id=uuid7(),
            track_id=text_track_id,
            start=int(caption["start_ms"]),
            duration=int(caption["end_ms"]) - int(caption["start_ms"]),
            text=str(caption["text"]),
        )
        for caption in captions
    ]
    overlay_clips = [
        TimelineClip(
            id=uuid7(),
            track_id=overlay_track_id,
            start=int(cue["start_ms"]),
            duration=int(cue["end_ms"]) - int(cue["start_ms"]),
            text=str(cue["text"]),
            effects=[TimelineEffect(
                type="overlay_template",
                version="1.0",
                parameters={
                    "cue_type": str(cue["cue_type"]),
                    "cue_id": str(cue["id"]),
                    "template_key": str(cue["template_key"]),
                    "secondary_text": str(cue.get("secondary_text") or ""),
                    "safe_area": True,
                },
            )],
            supporting_claim_ids=list(cue.get("supporting_claim_ids", [])),
        )
        for cue in (advanced_edit_plan or {}).get("overlays", [])
        if bool(cue.get("enabled", True))
    ]
    transitions = [
        TimelineTransition(
            id=str(transition["id"]),
            from_clip_id=clip_ids[int(transition["from_index"])],
            to_clip_id=clip_ids[int(transition["to_index"])],
            type=str(transition["type"]),
            duration=int(transition["duration_ms"]),
        )
        for transition in (advanced_edit_plan or {}).get("transitions", [])
    ]
    safe = (advanced_edit_plan or {}).get("safe_area", {})
    timeline = TimelineProject(
        id=timeline_id,
        project_id=project_id,
        width=width,
        height=height,
        fps=Rational(numerator=30, denominator=1),
        timebase=Rational(numerator=1, denominator=1000),
        duration=output_duration_ms,
        safe_area=SafeArea(
            top=float(safe.get("top", 0.08)),
            right=float(safe.get("right", 0.06)),
            bottom=float(safe.get("bottom", 0.16)),
            left=float(safe.get("left", 0.06)),
        ),
        tracks=[
            TimelineTrack(id=video_track_id, kind="video", name="Montage source", order=0, clips=video_clips),
            TimelineTrack(
                id=ambient_track_id,
                kind="audio",
                name="Ambiance source",
                order=1,
                clips=ambient_clips,
            ),
            TimelineTrack(
                id=voice_track_id,
                kind="audio",
                name="Voix locale",
                order=2,
                clips=[TimelineClip(
                    id=uuid7(),
                    track_id=voice_track_id,
                    start=0,
                    duration=output_duration_ms,
                    effects=[TimelineEffect(type="artifact_source", version="1.0", parameters={"artifact_id": voice_artifact_id})],
                )],
            ),
            TimelineTrack(id=text_track_id, kind="text", name="Sous-titres", order=3, clips=text_clips),
            TimelineTrack(id=overlay_track_id, kind="overlay", name="Graphismes Phase 6", order=4, exclusive=False, clips=overlay_clips),
        ],
        transitions=transitions,
        markers=markers,
    )
    return timeline.model_dump(mode="json")


def _srt_time(milliseconds: int) -> str:
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def _write_text_atomic(path: Path, content: str, *, encoding: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid7()}.tmp")
    try:
        temporary.write_text(content, encoding=encoding)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _ass_time(milliseconds: int) -> str:
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours}:{minutes:02}:{seconds:02}.{millis // 10:02}"
