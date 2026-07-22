from __future__ import annotations

from typing import Literal, Protocol
from uuid import UUID

from pydantic import Field

from .common import ArtifactRef, BoundingBox, JsonValue, StudioModel, TimeRange, UnitScore


class GameAdapterDescriptor(StudioModel):
    id: str
    game_id: Literal["gta5", "gta6"]
    version: str
    contract_version: Literal["1.0"] = "1.0"
    display_name: str
    supported_game_versions: list[str] = Field(default_factory=list)
    supported_locales: list[str] = Field(default_factory=list)
    capabilities: list[str] = Field(default_factory=list)
    knowledge_namespace: str


class Detection(StudioModel):
    label: str
    confidence: UnitScore
    region: BoundingBox | None = None
    range: TimeRange | None = None
    detector_version: str
    attributes: dict[str, JsonValue] = Field(default_factory=dict)


class FrameRef(StudioModel):
    artifact: ArtifactRef
    timestamp_ms: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class SegmentRef(StudioModel):
    segment_id: UUID
    media_id: UUID
    range: TimeRange
    representative_frames: list[FrameRef] = Field(default_factory=list)


class EntityDetection(Detection):
    entity_type: str
    canonical_id: str | None = None


class GameEvent(Detection):
    event_type: str
    entity_ids: list[str] = Field(default_factory=list)


class NarrativeTemplate(StudioModel):
    id: str
    version: str
    content_type: str
    required_beats: list[str] = Field(default_factory=list)
    optional_beats: list[str] = Field(default_factory=list)


class GameEntity(StudioModel):
    canonical_id: str
    entity_type: str
    display_name: str
    aliases: list[str] = Field(default_factory=list)
    confidence: UnitScore


class GameAdapter(Protocol):
    descriptor: GameAdapterDescriptor

    async def detect_game(self, frame: FrameRef) -> Detection: ...
    async def detect_hud(self, frame: FrameRef) -> list[Detection]: ...
    async def detect_menus(self, frame: FrameRef) -> list[Detection]: ...
    async def detect_entities(self, frame: FrameRef) -> list[EntityDetection]: ...
    async def detect_events(self, segment: SegmentRef) -> list[GameEvent]: ...
    def normalize_text(self, text: str, locale: str) -> str: ...
    async def resolve_entity(self, text: str, context: dict[str, JsonValue]) -> GameEntity | None: ...
    def get_content_templates(self, content_type: str) -> list[NarrativeTemplate]: ...
    def get_expected_events(self, content_type: str) -> list[str]: ...
    def get_knowledge_namespace(self) -> str: ...
    def get_pronunciation_lexicon(self, locale: str) -> dict[str, str]: ...
