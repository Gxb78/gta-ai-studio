from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from .common import JsonValue, NonNegativeInt, PositiveInt, Rational, StudioModel, UnitScore


class TimelineSource(StudioModel):
    media_id: UUID
    uri: str
    source_in: NonNegativeInt
    source_duration: PositiveInt


class TimelineEffect(StudioModel):
    type: str
    version: str
    parameters: dict[str, JsonValue] = Field(default_factory=dict)


class TimelineClip(StudioModel):
    id: UUID
    track_id: UUID
    start: NonNegativeInt
    duration: PositiveInt
    source: TimelineSource | None = None
    text: str | None = None
    speed: Rational = Rational(numerator=1, denominator=1)
    opacity: UnitScore = 1
    volume: float = Field(default=1, ge=0, le=4)
    blend_mode: Literal["normal", "multiply", "screen", "overlay"] = "normal"
    effects: list[TimelineEffect] = Field(default_factory=list)
    supporting_segment_ids: list[UUID] = Field(default_factory=list)
    supporting_claim_ids: list[UUID] = Field(default_factory=list)


class TimelineTrack(StudioModel):
    id: UUID
    kind: Literal["video", "audio", "text", "overlay"]
    name: str
    order: NonNegativeInt
    exclusive: bool = True
    muted: bool = False
    clips: list[TimelineClip] = Field(default_factory=list)


class TimelineTransition(StudioModel):
    id: UUID
    from_clip_id: UUID
    to_clip_id: UUID
    type: Literal["cut", "crossfade", "dip_to_black", "audio_crossfade"]
    duration: NonNegativeInt


class TimelineMarker(StudioModel):
    id: UUID
    position: NonNegativeInt
    kind: Literal["beat", "proof", "chapter", "warning"]
    label: str
    reference_id: UUID | None = None


class SafeArea(StudioModel):
    top: UnitScore
    right: UnitScore
    bottom: UnitScore
    left: UnitScore

    @model_validator(mode="after")
    def validate_visible_area(self) -> "SafeArea":
        if self.top + self.bottom >= 1 or self.left + self.right >= 1:
            raise ValueError("safe area must leave a visible rectangle")
        return self


class TimelineProject(StudioModel):
    schema_version: Literal["1.0"] = "1.0"
    id: UUID
    project_id: UUID
    width: PositiveInt
    height: PositiveInt
    fps: Rational
    timebase: Rational
    duration: PositiveInt
    safe_area: SafeArea
    tracks: list[TimelineTrack]
    transitions: list[TimelineTransition] = Field(default_factory=list)
    markers: list[TimelineMarker] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_references_and_ranges(self) -> "TimelineProject":
        track_ids: set[UUID] = set()
        clip_ids: set[UUID] = set()
        for track in self.tracks:
            if track.id in track_ids:
                raise ValueError("timeline track ids must be unique")
            track_ids.add(track.id)
            ordered = sorted(track.clips, key=lambda clip: clip.start)
            for index, clip in enumerate(ordered):
                if clip.id in clip_ids:
                    raise ValueError("timeline clip ids must be unique")
                clip_ids.add(clip.id)
                if clip.track_id != track.id:
                    raise ValueError("clip track_id must match containing track")
                if clip.start + clip.duration > self.duration:
                    raise ValueError("clip exceeds timeline duration")
                if track.kind == "text" and not (clip.text and clip.text.strip()):
                    raise ValueError("text tracks require non-empty text")
                if track.exclusive and index > 0:
                    previous = ordered[index - 1]
                    if clip.start < previous.start + previous.duration:
                        pair_has_transition = any(
                            {transition.from_clip_id, transition.to_clip_id} == {previous.id, clip.id}
                            for transition in self.transitions
                        )
                        if not pair_has_transition:
                            raise ValueError("exclusive track clips overlap without transition")
        if any(transition.from_clip_id not in clip_ids or transition.to_clip_id not in clip_ids for transition in self.transitions):
            raise ValueError("transition references unknown clip")
        return self

