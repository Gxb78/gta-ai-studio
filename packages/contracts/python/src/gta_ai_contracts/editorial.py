from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StringConstraints, field_validator

from .common import GameId, StudioModel, UnitScore

ContentType = Literal[
    "vehicle_showcase",
    "vehicle_customization",
    "mission_showcase",
    "mission_guide",
    "tip",
    "secret",
    "myth_test",
    "comparison",
    "challenge",
    "weapon_showcase",
    "location_showcase",
    "activity_showcase",
    "news_explainer",
    "other",
]
TargetPlatform = Literal["tiktok", "youtube_shorts", "youtube_longform"]


class EditorialBrief(StudioModel):
    id: UUID
    project_id: UUID
    schema_version: Literal["1.0"] = "1.0"
    raw_instruction: Annotated[str, StringConstraints(min_length=1)]
    language: Annotated[str, StringConstraints(min_length=2)] = "fr-FR"
    game: GameId = "unknown"
    content_type: ContentType
    subject: str | None = None
    objective: Annotated[str, StringConstraints(min_length=1)]
    target_platforms: list[TargetPlatform]
    target_duration_seconds: Annotated[int, Field(gt=0, le=7_200)] | None = None
    target_aspect_ratio: Literal["9:16", "16:9", "1:1"]
    narrative_order: list[str] = Field(default_factory=list)
    must_include: list[str] = Field(default_factory=list)
    should_include: list[str] = Field(default_factory=list)
    must_avoid: list[str] = Field(default_factory=list)
    expected_events: list[str] = Field(default_factory=list)
    expected_visual_proofs: list[str] = Field(default_factory=list)
    requested_facts: list[str] = Field(default_factory=list)
    requested_comparisons: list[str] = Field(default_factory=list)
    tone: Literal["informative", "enthusiastic", "cinematic", "humorous", "serious", "neutral"]
    pacing: Literal["slow", "balanced", "dynamic", "very_dynamic"]
    spoiler_level: Literal["none", "light", "full"]
    voice_mode: Literal["synthetic_voice", "text_only"]
    publish_mode: Literal["local_export", "approval_required", "automatic"]
    confidence: UnitScore
    ambiguities: list[str] = Field(default_factory=list)

    @field_validator("target_platforms")
    @classmethod
    def unique_platforms(cls, value: list[TargetPlatform]) -> list[TargetPlatform]:
        if not value:
            raise ValueError("at least one target platform is required")
        if len(set(value)) != len(value):
            raise ValueError("target platforms must be unique")
        return value

