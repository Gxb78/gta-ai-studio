from __future__ import annotations

import re
import unicodedata
from datetime import UTC, datetime
from typing import Any

from .ids import uuid7


NARRATIVE_VERSION = "narrative-map-rules-v1"
CONTENT_PLAN_VERSION = "content-planner-rules-v1"


CONTENT_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("vehicle_customization", ("customisation", "customiser", "tuning", "atelier", "los santos customs", "modification")),
    ("mission_guide", ("guide mission", "soluce", "walkthrough", "comment finir", "comment reussir")),
    ("mission_showcase", ("mission", "braquage", "objectif", "recompense")),
    ("myth_test", ("mythe", "rumeur", "vrai ou faux", "myth")),
    ("comparison", ("comparaison", "comparer", "versus", " vs ", "meilleur entre")),
    ("tip", ("astuce", "conseil", "tuto", "comment faire", "tip")),
    ("secret", ("secret", "cache", "easter egg")),
    ("challenge", ("defi", "challenge", "sans mourir", "chrono")),
    ("weapon_showcase", ("arme", "fusil", "pistolet", "explosif")),
    ("location_showcase", ("lieu", "endroit", "localisation", "map", "carte")),
    ("activity_showcase", ("activite", "course", "golf", "tennis")),
    ("news_explainer", ("nouveaute", "mise a jour", "update", "actualite")),
    ("vehicle_showcase", ("vehicule", "voiture", "moto", "avion", "acceleration", "conduite")),
)


CONCEPTS: dict[str, dict[str, Any]] = {
    "vehicle_presentation": {"intent": "présentation du véhicule", "terms": ("vehicle", "vehicule", "voiture", "moto", "garage"), "purpose": "context"},
    "exterior": {"intent": "vue extérieure", "terms": ("exterieur", "carrosserie", "vehicle", "vehicule"), "purpose": "explanation"},
    "interior": {"intent": "vue intérieure", "terms": ("interieur", "cockpit", "habitacle", "first_person"), "purpose": "explanation"},
    "workshop_entry": {"intent": "entrée dans l’atelier", "terms": ("workshop", "atelier", "los santos customs", "menu.workshop", "menu_candidate"), "purpose": "context"},
    "original_appearance": {"intent": "apparence d’origine", "terms": ("origine", "avant", "stock", "vehicle"), "purpose": "context"},
    "paint": {"intent": "choix de la peinture", "terms": ("peinture", "couleur", "respray", "paint", "colour"), "purpose": "explanation"},
    "wheels": {"intent": "choix des roues et jantes", "terms": ("roues", "jantes", "wheel", "wheels", "rims"), "purpose": "explanation"},
    "spoiler": {"intent": "choix de l’aileron", "terms": ("aileron", "spoiler"), "purpose": "explanation"},
    "bumpers": {"intent": "choix des pare-chocs", "terms": ("pare-chocs", "pare choc", "bumper", "bumpers"), "purpose": "explanation"},
    "engine": {"intent": "amélioration du moteur", "terms": ("moteur", "engine", "performance"), "purpose": "explanation"},
    "brakes": {"intent": "amélioration des freins", "terms": ("freins", "brakes", "brake"), "purpose": "explanation"},
    "suspension": {"intent": "réglage de la suspension", "terms": ("suspension",), "purpose": "explanation"},
    "armor": {"intent": "amélioration du blindage", "terms": ("blindage", "armor", "armour"), "purpose": "explanation"},
    "workshop_exit": {"intent": "sortie de l’atelier", "terms": ("sortie", "exit", "gameplay_candidate"), "purpose": "transition"},
    "driving": {"intent": "séquence de conduite", "terms": ("conduite", "driving", "gameplay_candidate", "high_motion"), "purpose": "proof"},
    "collision": {"intent": "collision ou dégâts visibles", "terms": ("collision", "accident", "damage", "degats"), "purpose": "proof"},
    "final_result": {"intent": "résultat final visible", "terms": ("resultat", "final", "apres", "gameplay_candidate", "vehicle"), "purpose": "conclusion"},
    "stats": {"intent": "statistiques visibles", "terms": ("statistiques", "stats", "speed", "acceleration", "braking", "handling"), "purpose": "proof"},
    "mission_launch": {"intent": "lancement de la mission", "terms": ("mission", "launch", "start", "briefing"), "purpose": "context"},
    "mission_objective": {"intent": "objectif de mission visible", "terms": ("objectif", "objective", "mission objective", "mission"), "purpose": "explanation"},
    "route": {"intent": "trajet vers l’objectif", "terms": ("route", "trajet", "waypoint", "map", "gameplay_candidate"), "purpose": "transition"},
    "combat": {"intent": "séquence de combat", "terms": ("combat", "gunfight", "tir", "weapon", "wanted"), "purpose": "proof"},
    "mission_result": {"intent": "résultat de la mission", "terms": ("mission success", "mission passed", "mission failed", "reussite", "echec", "resultat"), "purpose": "conclusion"},
    "reward": {"intent": "récompense visible", "terms": ("recompense", "reward", "rp", "cash", "visible_currency_amount"), "purpose": "proof"},
    "problem": {"intent": "problème à résoudre", "terms": ("probleme", "echec", "difficulte"), "purpose": "context"},
    "location": {"intent": "lieu ou menu nécessaire", "terms": ("lieu", "location", "map", "menu", "menu_candidate"), "purpose": "context"},
    "ordered_steps": {"intent": "étapes dans l’ordre", "terms": ("etape", "step", "menu", "action", "objective"), "purpose": "explanation"},
    "proof": {"intent": "preuve visuelle du résultat", "terms": ("resultat", "proof", "reussite", "success", "gameplay_candidate"), "purpose": "proof"},
    "question": {"intent": "question de départ", "terms": ("question", "comparaison", "mythe"), "purpose": "hook", "generic": True},
    "options": {"intent": "options comparées", "terms": ("versus", "comparaison", "option", "vehicle", "weapon"), "purpose": "comparison"},
    "criteria": {"intent": "critères de comparaison", "terms": ("critere", "stats", "performance", "speed"), "purpose": "comparison"},
    "verdict": {"intent": "verdict nuancé", "terms": ("verdict", "resultat", "conclusion"), "purpose": "conclusion"},
    "test_method": {"intent": "méthode de vérification", "terms": ("test", "methode", "verification"), "purpose": "explanation"},
    "test_result": {"intent": "résultat du test", "terms": ("resultat", "vrai", "faux", "success", "failed"), "purpose": "proof"},
    "overview": {"intent": "présentation des meilleurs moments disponibles", "terms": (), "purpose": "context", "generic": True},
}


CONTENT_STRUCTURES: dict[str, tuple[tuple[str, bool], ...]] = {
    "vehicle_showcase": (("vehicle_presentation", True), ("exterior", True), ("interior", False), ("stats", False), ("driving", True), ("collision", False), ("final_result", True)),
    "vehicle_customization": (("original_appearance", True), ("workshop_entry", True), ("paint", False), ("wheels", False), ("spoiler", False), ("bumpers", False), ("engine", False), ("brakes", False), ("suspension", False), ("armor", False), ("workshop_exit", False), ("final_result", True), ("driving", False)),
    "mission_showcase": (("mission_launch", True), ("mission_objective", True), ("route", False), ("combat", False), ("mission_result", True), ("reward", False)),
    "mission_guide": (("mission_launch", True), ("mission_objective", True), ("ordered_steps", True), ("combat", False), ("mission_result", True), ("reward", False)),
    "tip": (("problem", True), ("location", True), ("ordered_steps", True), ("proof", True)),
    "comparison": (("question", True), ("options", True), ("criteria", True), ("verdict", True)),
    "myth_test": (("question", True), ("test_method", True), ("test_result", True), ("verdict", True)),
    "other": (("overview", True), ("final_result", False)),
}


EXPLICIT_FEATURES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("paint", ("peinture", "couleur", "respray")),
    ("wheels", ("jantes", "roues", "wheels")),
    ("spoiler", ("aileron", "spoiler")),
    ("bumpers", ("pare-chocs", "pare choc", "bumper")),
    ("engine", ("moteur", "engine")),
    ("brakes", ("freins", "brakes")),
    ("suspension", ("suspension",)),
    ("armor", ("blindage", "armor")),
    ("interior", ("interieur", "cockpit", "habitacle")),
    ("stats", ("statistiques", "stats", "vitesse maximale", "acceleration", "maniabilite")),
    ("collision", ("collision", "accident", "degats")),
    ("reward", ("recompense", "reward", "gain")),
    ("combat", ("combat", "fusillade")),
    ("final_result", ("resultat final", "avant apres", "avant/apres")),
)


FACT_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("prix demandé", ("prix", "cout", "coûte")),
    ("vitesse maximale demandée", ("vitesse maximale", "vitesse max", "top speed")),
    ("statistiques demandées", ("statistiques", "stats", "acceleration", "freinage", "maniabilite")),
    ("récompense demandée", ("recompense", "gain", "payout")),
    ("classement demandé", ("meilleur", "classement", "plus rapide")),
)


def normalize_text(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value.casefold())
    ascii_value = "".join(character for character in folded if not unicodedata.combining(character))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9._/-]+", " ", ascii_value)).strip()


def understand_brief(raw_instruction: str) -> dict[str, Any]:
    normalized = normalize_text(raw_instruction)
    content_type = "other"
    for candidate, keywords in CONTENT_RULES:
        if any(keyword in f" {normalized} " for keyword in keywords):
            content_type = candidate
            break

    explicit_concepts = [concept for concept, keywords in EXPLICIT_FEATURES if _contains_positive_request(normalized, keywords)]
    must_include = [CONCEPTS[concept]["intent"] for concept in explicit_concepts]
    structure = CONTENT_STRUCTURES.get(content_type, CONTENT_STRUCTURES["other"])
    should_include = [CONCEPTS[concept]["intent"] for concept, _ in structure if concept not in explicit_concepts]
    requested_facts = [label for label, keywords in FACT_RULES if any(keyword in normalized for keyword in keywords)]
    comparisons = [raw_instruction.strip()] if content_type == "comparison" else []
    ambiguities = ["Le brief exprime une intention éditoriale et ne prouve pas le contenu du rush."]
    if content_type == "other":
        ambiguities.append("Type de contenu non déterminé avec certitude : structure générique appliquée.")
    if requested_facts:
        ambiguities.append("Les faits demandés restent à vérifier par la Phase 5 avant toute affirmation.")
    confidence = 0.92 if content_type != "other" else 0.58
    subject = raw_instruction.strip().split(".", 1)[0][:160]
    return {
        "content_type": content_type,
        "subject": subject,
        "narrative_order": [CONCEPTS[concept]["purpose"] for concept, _ in structure],
        "must_include": must_include,
        "must_include_concepts": explicit_concepts,
        "should_include": should_include,
        "expected_events": [concept for concept, _ in structure],
        "expected_visual_proofs": [CONCEPTS[concept]["intent"] for concept, required in structure if required],
        "requested_facts": requested_facts,
        "requested_comparisons": comparisons,
        "confidence": confidence,
        "ambiguities": ambiguities,
    }


def build_narrative_map(
    *,
    project_id: str,
    brief_id: str,
    structured_brief: dict[str, Any],
    segments: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    content_type = str(structured_brief.get("content_type", "other"))
    structure = list(CONTENT_STRUCTURES.get(content_type, CONTENT_STRUCTURES["other"]))
    explicit_concepts = [str(value) for value in structured_brief.get("must_include_concepts", [])]
    known = {concept for concept, _ in structure}
    for concept in explicit_concepts:
        if concept not in known and concept in CONCEPTS:
            structure.append((concept, True))
        else:
            structure = [(item, True if item == concept else required) for item, required in structure]

    beats: list[dict[str, Any]] = []
    for order, (concept, required) in enumerate(structure):
        descriptor = CONCEPTS[concept]
        candidates = _rank_candidates(concept, descriptor, segments)
        status = _beat_status(candidates)
        beats.append({
            "id": uuid7(),
            "order": order,
            "concept": concept,
            "intent": descriptor["intent"],
            "purpose": descriptor["purpose"],
            "required": required,
            "explicitly_requested": concept in explicit_concepts,
            "status": status,
            "candidate_segments": candidates,
            "decision_reason": _decision_reason(status, candidates),
        })

    required = [beat for beat in beats if beat["required"]]
    required_coverage = _coverage(required)
    overall_coverage = _coverage(beats)
    narrative_map = {
        "id": uuid7(),
        "project_id": project_id,
        "brief_id": brief_id,
        "version": 1,
        "algorithm_version": NARRATIVE_VERSION,
        "content_type": content_type,
        "beats": beats,
        "required_coverage": required_coverage,
        "overall_coverage": overall_coverage,
        "missing_required_count": sum(beat["required"] and beat["status"] in {"missing", "contradicted", "unusable"} for beat in beats),
        "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "fact_boundary": "La carte associe des intentions à des observations candidates; elle ne vérifie aucun fait GTA.",
    }
    coverage_report = _build_coverage_report(narrative_map, structured_brief, segments)
    return narrative_map, coverage_report


def build_content_plans(
    structured_brief: dict[str, Any],
    narrative_map: dict[str, Any],
    coverage_report: dict[str, Any],
    output_duration_ms: int,
) -> list[dict[str, Any]]:
    preferred = {
        "dynamic": "very_dynamic",
        "cinematic": "storytelling",
        "tutorial": "direct",
    }.get(str(structured_brief["production"]["editorial_style"]), "direct")
    variants = (
        ("direct", "Clair, linéaire et immédiatement compréhensible", 0.78),
        ("storytelling", "Progression avec contexte, tension et révélation", 0.72),
        ("very_dynamic", "Accroche rapide et alternance de plans courts", 0.82),
    )
    available = [
        beat for beat in narrative_map["beats"]
        if beat["status"] in {"found", "partially_found", "ambiguous"} and beat["candidate_segments"]
    ]
    plans: list[dict[str, Any]] = []
    for variant, description, pacing_fit in variants:
        ordered = _order_beats(available, variant)
        beat_items = [{
            "beat_id": beat["id"],
            "concept": beat["concept"],
            "intent": beat["intent"],
            "purpose": beat["purpose"],
            "status": beat["status"],
            "segment_ids": [candidate["segment_id"] for candidate in beat["candidate_segments"][:2]],
        } for beat in ordered]
        style_affinity = 1.0 if variant == preferred else 0.66
        coverage = float(coverage_report["required_coverage"])
        evidence_density = min(1.0, len(beat_items) / max(1, len(narrative_map["beats"])))
        duration_fit = min(1.0, output_duration_ms / max(3_000, len(beat_items) * 2_200)) if beat_items else 0.2
        score = round(0.46 * coverage + 0.22 * style_affinity + 0.16 * pacing_fit + 0.10 * evidence_density + 0.06 * duration_fit, 5)
        plans.append({
            "id": uuid7(),
            "schema_version": "1.0",
            "algorithm_version": CONTENT_PLAN_VERSION,
            "variant": variant,
            "description": description,
            "selected": False,
            "score": score,
            "output_duration_ms": output_duration_ms,
            "beats": beat_items,
            "missing_strategy": coverage_report["editing_decision"],
            "selection_signals": {
                "rush_coverage": coverage,
                "editorial_style_affinity": style_affinity,
                "pacing_fit": pacing_fit,
                "evidence_density": round(evidence_density, 5),
                "duration_fit": round(duration_fit, 5),
                "performance_history": "unavailable_until_learning_phase",
                "creator_preferences": "unavailable_until_learning_phase",
            },
        })
    selected = max(plans, key=lambda plan: (float(plan["score"]), plan["variant"] == preferred))
    selected["selected"] = True
    selected["selection_reason"] = (
        f"Meilleur compromis mesuré pour le style {structured_brief['production']['editorial_style']}, "
        f"avec {round(float(coverage_report['required_coverage']) * 100)} % de couverture obligatoire."
    )
    for plan in plans:
        if not plan["selected"]:
            plan["selection_reason"] = "Variante conservée pour comparaison, mais score global inférieur."
    return sorted(plans, key=lambda plan: (-float(plan["score"]), str(plan["variant"])))


def selected_segment_ids(plan: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for beat in plan.get("beats", []):
        for segment_id in beat.get("segment_ids", []):
            if segment_id not in result:
                result.append(str(segment_id))
    return result


def _contains_positive_request(normalized: str, keywords: tuple[str, ...]) -> bool:
    for keyword in keywords:
        position = normalized.find(keyword)
        if position < 0:
            continue
        prefix = normalized[max(0, position - 12):position]
        if not any(negation in prefix.split()[-2:] for negation in ("sans", "eviter", "exclure", "pas")):
            return True
    return False


def _rank_candidates(concept: str, descriptor: dict[str, Any], segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    terms = tuple(normalize_text(term) for term in descriptor.get("terms", ()))
    candidates: list[dict[str, Any]] = []
    for segment in segments:
        phase3 = dict(segment.get("attributes", {}).get("phase3", {}))
        evidence_parts = [
            str(segment.get("scene_type", "")),
            str(segment.get("summary", "")),
            *[str(value) for value in phase3.get("screen_labels", [])],
            *[str(value) for value in phase3.get("detected_texts", [])],
            *[str(value) for value in phase3.get("event_types", [])],
            *[str(value) for value in phase3.get("guided_intent_matches", [])],
        ]
        evidence = normalize_text(" ".join(evidence_parts))
        exact = [term for term in terms if term and term in evidence]
        term_tokens = {token for term in terms for token in term.split() if len(token) >= 4}
        evidence_tokens = set(evidence.split())
        overlap = sorted(term_tokens & evidence_tokens)
        semantic = min(1.0, 0.72 * (len(exact) / max(1, min(2, len(terms)))) + 0.28 * (len(overlap) / max(1, min(3, len(term_tokens)))))
        relevance = float(segment.get("relevance_score", 0))
        quality = float(segment.get("visual_quality_score", 0))
        if descriptor.get("generic"):
            score = 0.58 * relevance + 0.34 * quality + 0.08 * float(segment.get("novelty_score", 0))
            basis = ["pertinence visuelle générique"]
        elif semantic > 0:
            score = 0.67 * semantic + 0.18 * relevance + 0.15 * quality
            basis = ([f"signal observé : {', '.join(exact[:3])}"] if exact else []) + ([f"termes concordants : {', '.join(overlap[:4])}"] if overlap else [])
        else:
            score = min(0.24, 0.12 * relevance + 0.08 * quality)
            basis = []
        if score < 0.28:
            continue
        if not basis:
            basis = ["correspondance sémantique faible"]
        candidates.append({
            "segment_id": str(segment["id"]),
            "start_ms": int(segment["start_ms"]),
            "end_ms": int(segment["end_ms"]),
            "score": round(min(1.0, score), 5),
            "visual_quality_score": round(quality, 5),
            "rationale": "; ".join(basis),
        })
    return sorted(candidates, key=lambda item: (-float(item["score"]), int(item["start_ms"])))[:3]


def _beat_status(candidates: list[dict[str, Any]]) -> str:
    if not candidates:
        return "missing"
    top = candidates[0]
    if float(top["visual_quality_score"]) < 0.18:
        return "unusable"
    score = float(top["score"])
    if score >= 0.62:
        return "found"
    if score >= 0.44:
        return "partially_found"
    return "ambiguous"


def _decision_reason(status: str, candidates: list[dict[str, Any]]) -> str:
    messages = {
        "found": "Signal sémantique suffisamment fort dans le rush.",
        "partially_found": "Signal utile mais incomplet; narration prudente recommandée.",
        "ambiguous": "Candidat faible à confirmer visuellement avant publication.",
        "missing": "Aucun signal sémantique observé pour cette intention.",
        "contradicted": "Les observations disponibles indiquent une issue opposée.",
        "unusable": "Le signal existe mais la qualité visuelle est insuffisante.",
    }
    if candidates and status != "missing":
        return f"{messages[status]} Meilleur score : {round(float(candidates[0]['score']) * 100)} %."
    return messages[status]


def _coverage(beats: list[dict[str, Any]]) -> float:
    if not beats:
        return 1.0
    weights = {"found": 1.0, "partially_found": 0.55, "ambiguous": 0.25, "missing": 0.0, "contradicted": 0.0, "unusable": 0.0}
    return round(sum(weights[str(beat["status"])] for beat in beats) / len(beats), 5)


def _build_coverage_report(narrative_map: dict[str, Any], structured_brief: dict[str, Any], segments: list[dict[str, Any]]) -> dict[str, Any]:
    beats = list(narrative_map["beats"])
    missing = [beat for beat in beats if beat["status"] in {"missing", "contradicted", "unusable"}]
    ambiguous = [beat for beat in beats if beat["status"] in {"ambiguous", "partially_found"}]
    low_quality = [{
        "segment_id": str(segment["id"]),
        "start_ms": int(segment["start_ms"]),
        "end_ms": int(segment["end_ms"]),
        "visual_quality_score": float(segment.get("visual_quality_score", 0)),
    } for segment in segments if float(segment.get("visual_quality_score", 0)) < 0.35]
    recommendations = [_capture_recommendation(beat, str(narrative_map["content_type"])) for beat in missing if beat["required"]]
    required_coverage = float(narrative_map["required_coverage"])
    if required_coverage >= 0.8:
        decision = "ready_with_prudent_narration"
    elif required_coverage >= 0.4:
        decision = "continue_adapted_with_warning"
    else:
        decision = "continue_partial_and_request_footage"
    requested_facts = [{
        "request": value,
        "status": "requires_phase5_verification",
        "allowed_in_script": False,
    } for value in structured_brief.get("requested_facts", [])]
    return {
        "id": uuid7(),
        "schema_version": "1.0",
        "narrative_map_id": narrative_map["id"],
        "project_id": narrative_map["project_id"],
        "brief_id": narrative_map["brief_id"],
        "required_coverage": required_coverage,
        "overall_coverage": float(narrative_map["overall_coverage"]),
        "mandatory_total": sum(bool(beat["required"]) for beat in beats),
        "mandatory_found": sum(beat["required"] and beat["status"] == "found" for beat in beats),
        "missing_items": [_beat_summary(beat) for beat in missing],
        "ambiguous_items": [_beat_summary(beat) for beat in ambiguous],
        "low_quality_sequences": low_quality,
        "requested_facts": requested_facts,
        "complementary_footage": recommendations,
        "editing_decision": decision,
        "allowed_fallbacks": ["remove_missing_part", "adapt_narration", "use_alternate_candidate", "partial_version_with_warning", "request_precise_footage"],
        "unavailable_fallbacks": ["user_library_not_implemented", "generated_evidence_forbidden"],
        "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }


def _beat_summary(beat: dict[str, Any]) -> dict[str, Any]:
    return {
        "beat_id": beat["id"],
        "intent": beat["intent"],
        "required": beat["required"],
        "status": beat["status"],
        "reason": beat["decision_reason"],
    }


def _capture_recommendation(beat: dict[str, Any], content_type: str) -> dict[str, Any]:
    concept = str(beat["concept"])
    requests = {
        "driving": "Enregistre 30 secondes de conduite en ligne droite, compteur visible et sans changement de caméra.",
        "final_result": "Enregistre 12 secondes du résultat final, véhicule immobile puis rotation lente de la caméra.",
        "workshop_entry": "Enregistre l’entrée complète dans l’atelier jusqu’à l’apparition lisible du menu.",
        "mission_result": "Enregistre l’écran de fin de mission et laisse le résultat visible au moins 5 secondes.",
        "reward": "Enregistre l’écran de récompense sans le fermer, montant entièrement visible pendant 5 secondes.",
        "proof": "Enregistre l’action et son résultat dans un plan continu afin que la preuve visuelle soit reproductible.",
        "ordered_steps": "Enregistre chaque étape dans l’ordre, avec le menu ou l’action visible avant de passer à la suivante.",
    }
    default = f"Enregistre 10 à 20 secondes montrant clairement « {beat['intent']} », sans coupe et avec le HUD utile visible."
    return {
        "beat_id": beat["id"],
        "intent": beat["intent"],
        "priority": "required",
        "request": requests.get(concept, default),
        "content_type": content_type,
        "proof_goal": "Obtenir un signal visuel explicite et réutilisable dans la Narrative Map.",
    }


def _order_beats(beats: list[dict[str, Any]], variant: str) -> list[dict[str, Any]]:
    if variant == "storytelling":
        purpose_order = {"hook": 0, "context": 1, "transition": 2, "explanation": 3, "comparison": 3, "proof": 4, "conclusion": 5}
        return sorted(beats, key=lambda beat: (purpose_order.get(str(beat["purpose"]), 3), int(beat["order"])))
    if variant == "very_dynamic":
        return sorted(beats, key=lambda beat: (0 if beat["purpose"] in {"proof", "conclusion"} else 1, -float(beat["candidate_segments"][0]["score"]), int(beat["order"])))
    return sorted(beats, key=lambda beat: int(beat["order"]))
