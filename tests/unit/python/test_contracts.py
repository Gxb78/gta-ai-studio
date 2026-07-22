from __future__ import annotations

from uuid import uuid4

import pytest
from pydantic import ValidationError

from gta_ai_contracts.editorial import EditorialBrief
from gta_ai_contracts.narrative import NarrativeBeat


def test_editorial_brief_rejects_duplicate_platforms() -> None:
    with pytest.raises(ValidationError):
        EditorialBrief(
            id=uuid4(),
            project_id=uuid4(),
            raw_instruction="Présente la Zentorno.",
            game="gta5",
            content_type="vehicle_showcase",
            objective="Présenter le véhicule",
            target_platforms=["youtube_shorts", "youtube_shorts"],
            target_duration_seconds=55,
            target_aspect_ratio="9:16",
            tone="informative",
            pacing="dynamic",
            spoiler_level="none",
            voice_mode="synthetic_voice",
            publish_mode="local_export",
            confidence=0.9,
        )


def test_found_beat_requires_a_real_candidate() -> None:
    with pytest.raises(ValidationError):
        NarrativeBeat(
            id=uuid4(),
            order=0,
            intent="montrer le résultat final",
            required=True,
            status="found",
            candidate_segments=[],
        )

