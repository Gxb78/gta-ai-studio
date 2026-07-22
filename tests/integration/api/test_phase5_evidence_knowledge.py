from __future__ import annotations

from pathlib import Path

from gta_studio_api.config import REPO_ROOT, Settings
from gta_studio_api.evidence_engine import build_verification_report, load_knowledge_pack
from gta_studio_api.production import build_script, structure_brief
from gta_studio_api.service import StudioService


PROJECT_ID = "00000000-0000-4000-8000-000000000001"
BRIEF_ID = "00000000-0000-4000-8000-000000000002"
SEGMENT_ID = "00000000-0000-4000-8000-000000000003"


def _brief(requested_fact: str) -> dict[str, object]:
    value = structure_brief(
        "Présente ce rush puis donne le prix.",
        game_id="gta5",
        target_duration_seconds=30,
        editorial_style="dynamic",
        voice_id="local-voice",
        voice_rate=1,
        caption_style="impact",
        composition="smart_blur",
        source_audio_level=0.16,
        include_hook=False,
        include_cta=False,
    )
    value["requested_facts"] = [requested_fact]
    return value


def _report(*, entities: list[dict[str, object]] | None = None, history: dict[str, dict[str, object]] | None = None) -> dict[str, object]:
    return build_verification_report(
        project_id=PROJECT_ID,
        brief_id=BRIEF_ID,
        game_id="gta5",
        structured_brief=_brief("prix demandé"),
        narrative_map={"beats": []},
        selected_plan={"beats": []},
        analysis={"frames": [], "texts": [], "entities": entities or [], "events": []},
        knowledge_items=[],
        history_counts=history or {},
    )


def test_knowledge_packs_are_strictly_isolated_by_game() -> None:
    gta5 = load_knowledge_pack(REPO_ROOT / "game-adapters", "gta5")
    gta6 = load_knowledge_pack(REPO_ROOT / "game-adapters", "gta6")

    assert gta5["namespace"] == "gta5"
    assert len(gta5["items"]) == 5
    assert all(item["game_id"] == "gta5" and item["namespace"] == "gta5" for item in gta5["items"])
    assert gta6["namespace"] == "gta6"
    assert gta6["items"] == []


def test_requested_price_without_observation_is_unknown_and_blocked() -> None:
    report = _report()
    claim = report["claims"][0]

    assert report["status"] == "PASSED_WITH_EXCLUSIONS"
    assert claim["status"] == "unknown"
    assert claim["allowed_in_script"] is False
    assert claim["evidence"] == []
    assert report["summary"]["requested_fact_coverage"] == 0


def test_visible_amount_is_sourced_and_scripted_without_extrapolation() -> None:
    entities = [{
        "id": "00000000-0000-4000-8000-000000000004",
        "segment_id": SEGMENT_ID,
        "entity_type": "visible_currency_amount",
        "label": "1 250 $",
        "start_ms": 1_000,
        "end_ms": 1_500,
        "confidence": 0.91,
    }]
    report = _report(entities=entities)
    claim = report["claims"][0]

    assert report["status"] == "PASSED"
    assert claim["status"] == "observed_once"
    assert claim["allowed_in_script"] is True
    assert claim["evidence"][0]["evidence_type"] == "detected_entity"
    assert claim["evidence"][0]["metadata"]["segment_id"] == SEGMENT_ID
    assert "1 250 $" in claim["safe_narration"]

    script = build_script(
        _brief("prix demandé"),
        30_000,
        content_plan={"beats": []},
        coverage_report={"complementary_footage": []},
        verification_report=report,
    )
    assert "1 250 $" in script["full_text"]
    assert script["safety"]["sourced_claim_ids"] == [claim["id"]]
    assert any(claim["id"] in block["supporting_claim_ids"] for block in script["blocks"])


def test_prior_project_observation_promotes_claim_to_reproduced() -> None:
    entities = [{
        "id": "00000000-0000-4000-8000-000000000004",
        "segment_id": SEGMENT_ID,
        "entity_type": "visible_currency_amount",
        "label": "1 250 $",
        "start_ms": 1_000,
        "end_ms": 1_500,
        "confidence": 0.72,
    }]
    first = _report(entities=entities)
    claim_key = first["claims"][0]["claim_key"]
    prior_claim_id = "00000000-0000-4000-8000-000000000009"
    repeated = _report(entities=entities, history={claim_key: {"observation_count": 1, "claim_ids": [prior_claim_id]}})

    assert repeated["claims"][0]["status"] == "reproduced"
    assert repeated["claims"][0]["confidence"] >= 0.82
    repeated_proof = next(item for item in repeated["claims"][0]["evidence"] if item["evidence_type"] == "repeated_test")
    assert repeated_proof["source_id"] == prior_claim_id


def test_phase5_migration_and_pack_sync_are_idempotent(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    settings = Settings(
        environment="test",
        data_dir=data_dir,
        database_path=data_dir / "studio.db",
        migration_dir=REPO_ROOT / "packages" / "database" / "migrations",
    )
    service = StudioService(settings)
    service.initialize()
    service.initialize()

    with service.database.connect() as connection:
        versions = {int(row[0]) for row in connection.execute("SELECT version FROM schema_migrations")}
        gta5_count = int(connection.execute("SELECT COUNT(*) FROM knowledge_items WHERE namespace = 'gta5'").fetchone()[0])
        gta6_count = int(connection.execute("SELECT COUNT(*) FROM knowledge_items WHERE namespace = 'gta6'").fetchone()[0])
        revision_count = int(connection.execute("SELECT COUNT(*) FROM knowledge_revisions").fetchone()[0])
        assert list(connection.execute("PRAGMA foreign_key_check")) == []

    assert 6 in versions
    assert gta5_count == 5
    assert gta6_count == 0
    assert revision_count == 5
