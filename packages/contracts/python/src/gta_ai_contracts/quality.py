from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import Field

from .common import JsonValue, StudioModel, UnitScore


class QualityCheckResult(StudioModel):
    id: UUID
    render_job_id: UUID
    check_id: str
    check_version: str
    dimension: Literal["technical", "editorial", "factual", "audio", "subtitle", "visual", "platform"]
    status: Literal["pass", "warn", "fail", "skipped"]
    severity: Literal["info", "warning", "blocker"]
    message: str
    measured_value: JsonValue
    threshold: JsonValue
    evidence_artifact_ids: list[UUID] = Field(default_factory=list)
    correction_action: str | None = None


class QualityScore(StudioModel):
    editorial_adherence: UnitScore
    factual_reliability: UnitScore
    visual_quality: UnitScore
    pacing: UnitScore
    audio_quality: UnitScore
    subtitle_quality: UnitScore
    platform_compliance: UnitScore
    overall: UnitScore


class QualityGateDecision(StudioModel):
    passed: bool
    blocker_check_ids: list[str] = Field(default_factory=list)
    warning_check_ids: list[str] = Field(default_factory=list)
    score: QualityScore

