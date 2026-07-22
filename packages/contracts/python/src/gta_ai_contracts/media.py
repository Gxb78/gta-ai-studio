from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from .common import ArtifactRef, GameId, NonNegativeInt, PositiveInt, Sha256, StudioModel, UnitScore


class MediaAsset(StudioModel):
    id: UUID
    project_id: UUID
    kind: Literal["video", "audio", "image", "subtitle", "document"]
    status: Literal["registered", "verified", "invalid", "deleted"]
    original_uri: str
    sha256: Sha256
    size_bytes: NonNegativeInt
    duration_ms: NonNegativeInt | None = None
    width: PositiveInt | None = None
    height: PositiveInt | None = None
    fps_numerator: PositiveInt | None = None
    fps_denominator: PositiveInt | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    game: GameId = "unknown"
    captured_at: datetime | None = None
    created_at: datetime

    @model_validator(mode="after")
    def validate_fps_pair(self) -> "MediaAsset":
        if (self.fps_numerator is None) != (self.fps_denominator is None):
            raise ValueError("fps numerator and denominator must be provided together")
        return self


class MediaDerivative(StudioModel):
    id: UUID
    source_media_id: UUID
    kind: Literal["proxy", "audio_extract", "frame", "waveform", "render", "thumbnail", "report"]
    algorithm_version: str
    input_fingerprint: Sha256
    artifact: ArtifactRef


class VideoSegment(StudioModel):
    id: UUID
    project_id: UUID
    media_id: UUID
    start_ms: NonNegativeInt
    end_ms: PositiveInt
    scene_type: str
    detected_actions: list[str] = Field(default_factory=list)
    detected_objects: list[str] = Field(default_factory=list)
    detected_texts: list[str] = Field(default_factory=list)
    detected_entities: list[str] = Field(default_factory=list)
    motion_score: UnitScore
    visual_quality_score: UnitScore
    relevance_score: UnitScore
    novelty_score: UnitScore
    has_dialogue: bool = False
    has_music: bool = False
    has_potential_copyright_music: bool = False
    transcript: str | None = None
    summary: str
    confidence: UnitScore

    @model_validator(mode="after")
    def validate_range(self) -> "VideoSegment":
        if self.end_ms <= self.start_ms:
            raise ValueError("segment end must be greater than start")
        return self
