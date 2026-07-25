from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .errors import StudioError
from .ids import uuid7
from .narrative_intelligence import normalize_text


EVIDENCE_VERSION = "evidence-engine-v1"
KNOWLEDGE_PACK_VERSION = "knowledge-pack-v1"
CLAIM_STATUSES = {"hypothesis", "observed_once", "reproduced", "verified", "contradicted", "outdated", "unknown"}


def load_knowledge_pack(game_adapter_root: Path, game_id: str) -> dict[str, Any]:
    if game_id not in {"gta5", "gta6"}:
        return {
            "schema_version": "1.0",
            "game_id": "unknown",
            "namespace": "unknown",
            "pack_version": "0.0.0",
            "game_version": "unknown",
            "source_scope": "none",
            "notice": "No knowledge pack is loaded for an unknown game.",
            "items": [],
        }
    manifest_path = game_adapter_root / game_id / "knowledge" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        items_path = manifest_path.parent / str(manifest["items_file"])
        items = json.loads(items_path.read_text(encoding="utf-8"))
    except (OSError, KeyError, json.JSONDecodeError) as error:
        raise StudioError("KNOWLEDGE_PACK_INVALID", f"Invalid {game_id} knowledge pack.", status_code=503) from error
    if manifest.get("game_id") != game_id or manifest.get("namespace") != game_id:
        raise StudioError("KNOWLEDGE_NAMESPACE_MISMATCH", "Knowledge pack namespace does not match its game.", status_code=503)
    if not isinstance(items, list):
        raise StudioError("KNOWLEDGE_ITEMS_INVALID", "Knowledge pack items must be a list.", status_code=503)
    validated: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or str(item.get("status")) not in CLAIM_STATUSES:
            raise StudioError("KNOWLEDGE_ITEM_INVALID", "Knowledge pack contains an invalid item.", status_code=503)
        validated.append({
            **item,
            "namespace": game_id,
            "game_id": game_id,
            "game_version": str(manifest["game_version"]),
            "pack_version": str(manifest["pack_version"]),
        })
    return {**manifest, "items": validated}


def build_verification_report(
    *,
    project_id: str,
    brief_id: str,
    game_id: str,
    structured_brief: dict[str, Any],
    narrative_map: dict[str, Any],
    selected_plan: dict[str, Any],
    analysis: dict[str, Any],
    knowledge_items: list[dict[str, Any]],
    history_counts: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    frames = {str(frame["id"]): frame for frame in analysis.get("frames", [])}
    texts_by_segment: dict[str, list[dict[str, Any]]] = {}
    for item in analysis.get("texts", []):
        segment_id = str(item.get("segment_id") or frames.get(str(item.get("frame_id")), {}).get("segment_id", ""))
        if segment_id:
            texts_by_segment.setdefault(segment_id, []).append(item)
    entities_by_segment = _group_by_segment(analysis.get("entities", []), frames)
    events_by_segment = _group_by_segment(analysis.get("events", []), frames)
    claims: list[dict[str, Any]] = []

    beats_by_id = {str(beat["id"]): beat for beat in narrative_map.get("beats", [])}
    for planned in selected_plan.get("beats", []):
        beat = beats_by_id.get(str(planned.get("beat_id")))
        if not beat:
            continue
        claim = _claim_from_beat(
            project_id=project_id,
            game_id=game_id,
            beat=beat,
            texts_by_segment=texts_by_segment,
            events_by_segment=events_by_segment,
            knowledge_items=knowledge_items,
        )
        claims.append(_apply_reproduction_history(claim, history_counts))

    requested_fact_claims: list[dict[str, Any]] = []
    for request in structured_brief.get("requested_facts", []):
        claim = _claim_from_fact_request(
            project_id=project_id,
            game_id=game_id,
            request=str(request),
            content_type=str(structured_brief.get("content_type", "other")),
            texts_by_segment=texts_by_segment,
            entities_by_segment=entities_by_segment,
            events_by_segment=events_by_segment,
            knowledge_items=knowledge_items,
        )
        claim = _apply_reproduction_history(claim, history_counts)
        requested_fact_claims.append(claim)
        claims.append(claim)

    counts = Counter(str(claim["status"]) for claim in claims)
    admitted = [claim for claim in claims if claim["allowed_in_script"]]
    blocked_requested = [claim for claim in requested_fact_claims if not claim["allowed_in_script"]]
    gate_status = "PASSED_WITH_EXCLUSIONS" if blocked_requested else "PASSED"
    requested_admitted = sum(bool(claim["allowed_in_script"]) for claim in requested_fact_claims)
    requested_coverage = requested_admitted / len(requested_fact_claims) if requested_fact_claims else 1.0
    knowledge_used = sorted({
        str(evidence["source_id"])
        for claim in claims
        for evidence in claim["evidence"]
        if evidence["evidence_type"] == "knowledge_item"
    })
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    return {
        "id": uuid7(),
        "schema_version": "1.0",
        "algorithm_version": EVIDENCE_VERSION,
        "project_id": project_id,
        "brief_id": brief_id,
        "game_id": game_id,
        "status": gate_status,
        "claims": claims,
        "summary": {
            "claim_count": len(claims),
            "admitted_claim_count": len(admitted),
            "blocked_claim_count": sum(not claim["allowed_in_script"] for claim in claims),
            "requested_fact_count": len(requested_fact_claims),
            "requested_fact_coverage": round(requested_coverage, 5),
            "script_factual_safety": 1.0,
            "status_distribution": dict(counts),
            "knowledge_items_available": len(knowledge_items),
            "knowledge_items_used": len(knowledge_used),
        },
        "requested_facts": [{
            "claim_id": claim["id"],
            "request": claim["request"],
            "status": claim["status"],
            "confidence": claim["confidence"],
            "allowed_in_script": claim["allowed_in_script"],
            "reason": claim["verification_reason"],
        } for claim in requested_fact_claims],
        "knowledge_snapshot": {
            "namespace": game_id,
            "game_version": next((item.get("game_version") for item in knowledge_items), "unknown"),
            "item_count": len(knowledge_items),
            "used_item_ids": knowledge_used,
            "cross_game_items": sum(str(item.get("game_id")) != game_id for item in knowledge_items),
            "notice": "Only knowledge from the project game namespace is eligible.",
        },
        "gate": {
            "status": gate_status,
            "rule": "Unverified, contradicted, outdated and unknown claims are excluded from the script.",
            "blocked_claim_ids": [claim["id"] for claim in claims if not claim["allowed_in_script"]],
            "admitted_claim_ids": [claim["id"] for claim in admitted],
        },
        "created_at": now,
    }


def _claim_from_beat(
    *,
    project_id: str,
    game_id: str,
    beat: dict[str, Any],
    texts_by_segment: dict[str, list[dict[str, Any]]],
    events_by_segment: dict[str, list[dict[str, Any]]],
    knowledge_items: list[dict[str, Any]],
) -> dict[str, Any]:
    candidates = list(beat.get("candidate_segments", []))
    status = "observed_once" if beat.get("status") in {"found", "partially_found"} else "hypothesis"
    confidence = float(candidates[0]["score"]) if candidates else 0.2
    claim_key = f"visual.{beat.get('concept', 'unknown')}"
    evidence: list[dict[str, Any]] = []
    for candidate in candidates[:2]:
        segment_id = str(candidate["segment_id"])
        evidence.append(_evidence(
            "segment",
            segment_id,
            float(candidate["score"]),
            start_ms=int(candidate["start_ms"]),
            end_ms=int(candidate["end_ms"]),
            metadata={"rationale": candidate["rationale"], "beat_id": beat["id"]},
        ))
        for text in texts_by_segment.get(segment_id, [])[:2]:
            evidence.append(_evidence(
                "ocr_text",
                str(text["id"]),
                float(text["confidence"]),
                start_ms=int(text["start_ms"]),
                end_ms=max(int(text["start_ms"]) + 1, int(text.get("end_ms", int(text["start_ms"]) + 1))),
                metadata={"observed_text": text["text"], "fact_status": "observed_text"},
            ))
        for event in events_by_segment.get(segment_id, [])[:1]:
            evidence.append(_evidence(
                "detected_event",
                str(event["id"]),
                float(event["confidence"]),
                start_ms=int(event["start_ms"]),
                end_ms=int(event["end_ms"]),
                metadata={"event_type": event["event_type"], "fact_status": "inferred_candidate"},
            ))
    observed_text = normalize_text(" ".join(str(value.get("metadata", {}).get("observed_text", "")) for value in evidence))
    for item in knowledge_items:
        value = dict(item.get("value", {}))
        terms = [normalize_text(str(term)) for term in value.get("terms", [])]
        if value.get("concept") == beat.get("concept") and any(term and term in observed_text for term in terms):
            evidence.append(_evidence(
                "knowledge_item",
                str(item["id"]),
                float(item["confidence"]),
                metadata={"canonical_key": item["canonical_key"], "revision": item["revision"], "scope": "detector_terminology"},
            ))
    return _claim(
        project_id=project_id,
        game_id=game_id,
        claim_key=claim_key,
        claim_type="visual_observation",
        statement=f"Le rush contient une séquence candidate pour « {beat['intent']} ».",
        status=status,
        confidence=confidence,
        evidence=evidence,
        allowed_in_script=False,
        certainty_language="observed_in_test" if status == "observed_once" else "conditional",
        verification_reason="Association Narrative Map soutenue par les observations Phase 3.",
    )


def _claim_from_fact_request(
    *,
    project_id: str,
    game_id: str,
    request: str,
    content_type: str,
    texts_by_segment: dict[str, list[dict[str, Any]]],
    entities_by_segment: dict[str, list[dict[str, Any]]],
    events_by_segment: dict[str, list[dict[str, Any]]],
    knowledge_items: list[dict[str, Any]],
) -> dict[str, Any]:
    normalized_request = normalize_text(request)
    knowledge_match = _verified_knowledge_match(normalized_request, knowledge_items)
    if knowledge_match:
        statement = str(knowledge_match["value"].get("statement", request))
        return _claim(
            project_id=project_id,
            game_id=game_id,
            claim_key=str(knowledge_match["canonical_key"]),
            claim_type="knowledge_fact",
            statement=statement,
            status="verified",
            confidence=float(knowledge_match["confidence"]),
            evidence=[_evidence("knowledge_item", str(knowledge_match["id"]), float(knowledge_match["confidence"]), metadata={"revision": knowledge_match["revision"], "canonical_key": knowledge_match["canonical_key"]})],
            allowed_in_script=True,
            certainty_language="certain",
            verification_reason="Correspondance exacte avec un fait vérifié du namespace du jeu.",
            safe_narration=statement,
            request=request,
            game_version=str(knowledge_match["game_version"]),
        )

    if "prix" in normalized_request:
        observed = _best_currency_entity(entities_by_segment)
        if observed:
            return _observed_entity_claim(project_id, game_id, request, observed, "screen_amount")
    if "recompense" in normalized_request:
        observed = _reward_entity(entities_by_segment, events_by_segment, content_type)
        if observed:
            return _observed_entity_claim(project_id, game_id, request, observed, "screen_reward_amount")
    if "vitesse maximale" in normalized_request:
        observed_text = _best_text(texts_by_segment, ("km/h", "kmh", "mph"), require_digit=True)
        if observed_text:
            return _observed_text_claim(project_id, game_id, request, observed_text, "screen_top_speed")
    if "statistiques" in normalized_request:
        observed_text = _best_text(texts_by_segment, ("speed", "vitesse", "acceleration", "braking", "freinage", "handling", "maniabilite", "stats"))
        if observed_text:
            return _observed_text_claim(project_id, game_id, request, observed_text, "screen_stat_label")

    return _claim(
        project_id=project_id,
        game_id=game_id,
        claim_key=f"requested.{normalize_text(request).replace(' ', '_')}",
        claim_type="requested_fact",
        statement=f"La demande « {request} » ne possède pas de preuve suffisante dans ce projet.",
        status="unknown",
        confidence=0.0,
        evidence=[],
        allowed_in_script=False,
        certainty_language="excluded",
        verification_reason="Aucune observation qualifiante ni connaissance vérifiée correspondante.",
        request=request,
    )


def _observed_entity_claim(project_id: str, game_id: str, request: str, observed: dict[str, Any], claim_type: str) -> dict[str, Any]:
    label = str(observed["label"])
    start = int(observed["start_ms"])
    return _claim(
        project_id=project_id,
        game_id=game_id,
        claim_key=f"observed.amount.{normalize_text(label)}",
        claim_type=claim_type,
        statement=f"Le montant {label} est visible à l’écran dans ce rush.",
        status="observed_once",
        confidence=float(observed["confidence"]),
        evidence=[_evidence("detected_entity", str(observed["id"]), float(observed["confidence"]), start_ms=start, end_ms=max(start + 1, int(observed.get("end_ms", start + 1))), metadata={"entity_type": observed["entity_type"], "observed_label": label, "segment_id": observed.get("segment_id")})],
        allowed_in_script=True,
        certainty_language="game_indicates",
        verification_reason="Montant lu directement à l’écran; son rôle économique exact n’est pas extrapolé.",
        safe_narration=f"À l’écran, le jeu affiche {label}.",
        request=request,
    )


def _observed_text_claim(project_id: str, game_id: str, request: str, observed: dict[str, Any], claim_type: str) -> dict[str, Any]:
    text = str(observed["text"])
    start = int(observed["start_ms"])
    return _claim(
        project_id=project_id,
        game_id=game_id,
        claim_key=f"observed.text.{normalize_text(text)}",
        claim_type=claim_type,
        statement=f"Le texte « {text} » est visible à l’écran dans ce rush.",
        status="observed_once",
        confidence=float(observed["confidence"]),
        evidence=[_evidence("ocr_text", str(observed["id"]), float(observed["confidence"]), start_ms=start, end_ms=max(start + 1, int(observed.get("end_ms", start + 1))), metadata={"observed_text": text, "segment_id": observed.get("segment_id")})],
        allowed_in_script=True,
        certainty_language="game_indicates",
        verification_reason="Texte observé par OCR; aucune valeur absente n’est inférée.",
        safe_narration=f"À l’écran, on peut lire « {text} ».",
        request=request,
    )


def _claim(
    *,
    project_id: str,
    game_id: str,
    claim_key: str,
    claim_type: str,
    statement: str,
    status: str,
    confidence: float,
    evidence: list[dict[str, Any]],
    allowed_in_script: bool,
    certainty_language: str,
    verification_reason: str,
    safe_narration: str | None = None,
    request: str | None = None,
    game_version: str | None = None,
) -> dict[str, Any]:
    return {
        "id": uuid7(),
        "project_id": project_id,
        "game_id": game_id,
        "claim_key": claim_key,
        "claim_type": claim_type,
        "statement": statement,
        "normalized_statement": normalize_text(statement),
        "status": status,
        "confidence": round(max(0.0, min(1.0, confidence)), 5),
        "game_version": game_version,
        "observed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z") if evidence else None,
        "verified_at": datetime.now(UTC).isoformat().replace("+00:00", "Z") if status == "verified" else None,
        "allowed_in_script": allowed_in_script,
        "certainty_language": certainty_language,
        "verification_reason": verification_reason,
        "safe_narration": safe_narration,
        "request": request,
        "algorithm_version": EVIDENCE_VERSION,
        "evidence": evidence,
    }


def _evidence(
    evidence_type: str,
    source_id: str,
    strength: float,
    *,
    start_ms: int | None = None,
    end_ms: int | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": uuid7(),
        "evidence_type": evidence_type,
        "source_id": source_id,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "strength": round(max(0.0, min(1.0, strength)), 5),
        "metadata": metadata or {},
    }


def _apply_reproduction_history(claim: dict[str, Any], history_counts: dict[str, dict[str, Any]]) -> dict[str, Any]:
    history = history_counts.get(str(claim["claim_key"]), {})
    if claim["status"] != "observed_once" or int(history.get("observation_count", 0)) < 1:
        return claim
    prior_claim_ids = [str(value) for value in history.get("claim_ids", [])]
    repeated_evidence = [
        _evidence(
            "repeated_test",
            prior_claim_id,
            0.82,
            metadata={
                "claim_key": claim["claim_key"],
                "prior_observation_count": int(history["observation_count"]),
            },
        )
        for prior_claim_id in prior_claim_ids[:3]
    ]
    return {
        **claim,
        "status": "reproduced",
        "confidence": max(0.82, float(claim["confidence"])),
        "certainty_language": "observed_in_test",
        "verification_reason": f"{claim['verification_reason']} Observation cohérente dans au moins un projet antérieur.",
        "evidence": [*claim["evidence"], *repeated_evidence],
    }


def _group_by_segment(items: list[dict[str, Any]], frames: dict[str, dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        segment_id = str(item.get("segment_id") or frames.get(str(item.get("frame_id")), {}).get("segment_id", ""))
        if segment_id:
            result.setdefault(segment_id, []).append(item)
    return result


def _best_currency_entity(entities_by_segment: dict[str, list[dict[str, Any]]]) -> dict[str, Any] | None:
    candidates = [item for items in entities_by_segment.values() for item in items if item.get("entity_type") == "visible_currency_amount"]
    return max(candidates, key=lambda item: float(item["confidence"]), default=None)


def _reward_entity(
    entities_by_segment: dict[str, list[dict[str, Any]]],
    events_by_segment: dict[str, list[dict[str, Any]]],
    content_type: str,
) -> dict[str, Any] | None:
    if content_type not in {"mission_showcase", "mission_guide"}:
        return None
    for segment_id, events in events_by_segment.items():
        if any("mission_success" in str(event.get("event_type")) for event in events):
            values = [item for item in entities_by_segment.get(segment_id, []) if item.get("entity_type") == "visible_currency_amount"]
            if values:
                return max(values, key=lambda item: float(item["confidence"]))
    return None


def _best_text(
    texts_by_segment: dict[str, list[dict[str, Any]]],
    terms: tuple[str, ...],
    *,
    require_digit: bool = False,
) -> dict[str, Any] | None:
    candidates = []
    for items in texts_by_segment.values():
        for item in items:
            normalized = normalize_text(str(item.get("text", "")))
            if any(normalize_text(term) in normalized for term in terms) and (not require_digit or any(char.isdigit() for char in normalized)):
                candidates.append(item)
    return max(candidates, key=lambda item: float(item["confidence"]), default=None)


def _verified_knowledge_match(request: str, knowledge_items: list[dict[str, Any]]) -> dict[str, Any] | None:
    for item in knowledge_items:
        value = dict(item.get("value", {}))
        aliases = [normalize_text(str(alias)) for alias in value.get("request_aliases", [])]
        if item.get("status") == "verified" and value.get("statement") and request in aliases:
            return item
    return None
