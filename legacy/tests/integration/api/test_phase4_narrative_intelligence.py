from __future__ import annotations

from gta_studio_api.narrative_intelligence import build_content_plans, build_narrative_map
from gta_studio_api.production import build_script, structure_brief


def _brief(instruction: str, style: str = "dynamic") -> dict[str, object]:
    return structure_brief(
        instruction,
        game_id="gta5",
        target_duration_seconds=30,
        editorial_style=style,
        voice_id="local-voice",
        voice_rate=1,
        caption_style="impact",
        composition="smart_blur",
        source_audio_level=0.16,
        include_hook=False,
        include_cta=False,
    )


def _segment(*, segment_id: str, summary: str, labels: list[str], quality: float = 0.85) -> dict[str, object]:
    return {
        "id": segment_id,
        "media_id": "00000000-0000-4000-8000-000000000003",
        "start_ms": 0,
        "end_ms": 5_000,
        "scene_type": "menu_workshop_candidate",
        "summary": summary,
        "motion_score": 0.2,
        "visual_quality_score": quality,
        "relevance_score": 0.86,
        "novelty_score": 0.7,
        "confidence": 0.88,
        "attributes": {
            "phase3": {
                "screen_labels": labels,
                "detected_texts": [summary],
                "event_types": [],
                "guided_intent_matches": labels,
            },
        },
    }


def test_advanced_brief_detects_customization_requirements_and_fact_gates() -> None:
    brief = _brief("Montre la customisation avec les jantes rouges, puis donne le prix et la vitesse maximale.")

    assert brief["content_type"] == "vehicle_customization"
    assert "wheels" in brief["must_include_concepts"]
    assert "prix demandé" in brief["requested_facts"]
    assert "vitesse maximale demandée" in brief["requested_facts"]
    assert float(brief["confidence"]) > 0.8


def test_narrative_map_requires_semantic_evidence_and_requests_missing_footage() -> None:
    brief = _brief("Montre la customisation avec les jantes rouges et le résultat final.")
    segments = [_segment(
        segment_id="00000000-0000-4000-8000-000000000010",
        summary="OCR: LOS SANTOS CUSTOMS ENGINE BRAKES",
        labels=["menu.workshop", "workshop"],
    )]

    narrative_map, coverage = build_narrative_map(
        project_id="00000000-0000-4000-8000-000000000001",
        brief_id="00000000-0000-4000-8000-000000000002",
        structured_brief=brief,
        segments=segments,
    )

    workshop = next(beat for beat in narrative_map["beats"] if beat["concept"] == "workshop_entry")
    wheels = next(beat for beat in narrative_map["beats"] if beat["concept"] == "wheels")
    assert workshop["status"] == "found"
    assert wheels["status"] == "missing"
    assert wheels["candidate_segments"] == []
    recommendation = next(item for item in coverage["complementary_footage"] if item["beat_id"] == wheels["id"])
    assert "jantes" in recommendation["request"]
    assert coverage["editing_decision"] == "continue_partial_and_request_footage"


def test_content_planner_scores_three_variants_and_safe_script_omits_missing_detail() -> None:
    brief = _brief("Montre la customisation avec les jantes rouges et son prix.")
    segments = [_segment(
        segment_id="00000000-0000-4000-8000-000000000010",
        summary="OCR: LOS SANTOS CUSTOMS ENGINE",
        labels=["menu.workshop", "workshop"],
    )]
    narrative_map, coverage = build_narrative_map(
        project_id="00000000-0000-4000-8000-000000000001",
        brief_id="00000000-0000-4000-8000-000000000002",
        structured_brief=brief,
        segments=segments,
    )
    plans = build_content_plans(brief, narrative_map, coverage, 30_000)

    assert {plan["variant"] for plan in plans} == {"direct", "storytelling", "very_dynamic"}
    assert sum(bool(plan["selected"]) for plan in plans) == 1
    selected = next(plan for plan in plans if plan["selected"])
    assert selected["variant"] == "very_dynamic"
    assert selected["selection_signals"]["performance_history"] == "unavailable_until_learning_phase"

    script = build_script(brief, 30_000, content_plan=selected, coverage_report=coverage)
    assert "jantes rouges" not in script["full_text"].casefold()
    assert "prix" not in script["full_text"].casefold()
    assert script["safety"]["added_factual_claims"] == 0
    assert script["safety"]["omitted_missing_intents"] >= 1
