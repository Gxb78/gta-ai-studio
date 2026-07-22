from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field

from .common import JsonValue, NonNegativeInt, PositiveInt, StudioModel, UnitScore


class SubjectTrackPoint(StudioModel):
    id: UUID
    segment_id: UUID | None = None
    frame_id: UUID | None = None
    timestamp_ms: NonNegativeInt
    focus_x: UnitScore
    focus_y: UnitScore
    confidence: UnitScore
    method: Literal["evidence_region", "visual_attention", "combined", "center_fallback"]
    source_type: str


class AdvancedEditClip(StudioModel):
    index: NonNegativeInt
    start_ms: NonNegativeInt
    end_ms: PositiveInt
    source_duration_ms: PositiveInt
    duration_ms: PositiveInt
    supporting_segment_ids: list[UUID]
    selection_score: UnitScore | None = None
    speed: float = Field(ge=1, le=2)
    speed_reason: str
    reframe_mode: Literal["dynamic_crop", "fixed_crop", "blur_background", "split_screen"]
    focus_start_x: UnitScore
    focus_end_x: UnitScore
    focus_y: UnitScore
    tracking_confidence: UnitScore
    tracking_method: Literal["evidence_region", "visual_attention", "combined", "center_fallback"]
    zoom: float = Field(ge=1, le=1.2)
    zoom_reason: str
    comparison: dict[str, JsonValue] | None = None
    concepts: list[str] = Field(default_factory=list)
    purposes: list[str] = Field(default_factory=list)
    fade_in_ms: NonNegativeInt | None = None
    fade_out_ms: NonNegativeInt | None = None


class OverlayCue(StudioModel):
    id: UUID
    cue_type: Literal["title", "step", "proof", "before_after", "result", "conclusion"]
    start_ms: NonNegativeInt
    end_ms: PositiveInt
    text: str
    secondary_text: str | None = None
    template_key: str
    supporting_claim_ids: list[UUID] = Field(default_factory=list)
    parameters: dict[str, JsonValue] = Field(default_factory=dict)


class AdvancedEditPlan(StudioModel):
    schema_version: Literal["1.0"] = "1.0"
    id: UUID
    algorithm_version: str
    project_id: UUID
    brief_id: UUID
    status: Literal["READY", "READY_WITH_FALLBACKS", "FAILED"]
    template: dict[str, JsonValue]
    safe_area: dict[str, JsonValue]
    clips: list[AdvancedEditClip]
    subject_track: list[SubjectTrackPoint]
    overlays: list[OverlayCue]
    transitions: list[dict[str, JsonValue]]
    audio_mix: dict[str, JsonValue]
    summary: dict[str, JsonValue]
    safety: dict[str, JsonValue]
    created_at: datetime
