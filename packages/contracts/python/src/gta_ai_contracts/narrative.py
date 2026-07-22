from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from .common import GameId, JsonValue, NonNegativeInt, PositiveInt, StudioModel, UnitScore


class SegmentCandidate(StudioModel):
    segment_id: UUID
    start_ms: NonNegativeInt
    end_ms: PositiveInt
    score: UnitScore
    rationale: str

    @model_validator(mode="after")
    def validate_range(self) -> "SegmentCandidate":
        if self.end_ms <= self.start_ms:
            raise ValueError("candidate end must be greater than start")
        return self


class NarrativeBeat(StudioModel):
    id: UUID
    order: NonNegativeInt
    intent: str
    required: bool
    status: Literal["found", "partially_found", "ambiguous", "missing", "contradicted", "unusable"]
    candidate_segments: list[SegmentCandidate] = Field(default_factory=list)
    concept: str | None = None
    purpose: Literal["hook", "context", "explanation", "transition", "proof", "comparison", "conclusion", "call_to_action"] | None = None
    explicitly_requested: bool = False
    decision_reason: str | None = None

    @model_validator(mode="after")
    def validate_candidates(self) -> "NarrativeBeat":
        if self.status == "found" and not self.candidate_segments:
            raise ValueError("found beats require at least one candidate")
        if self.status == "missing" and self.candidate_segments:
            raise ValueError("missing beats cannot contain candidates")
        return self


class NarrativeMap(StudioModel):
    id: UUID
    project_id: UUID
    brief_id: UUID
    version: PositiveInt
    beats: list[NarrativeBeat]
    required_coverage: UnitScore
    missing_required_count: NonNegativeInt
    overall_coverage: UnitScore | None = None
    content_type: str | None = None
    algorithm_version: str | None = None
    fact_boundary: str | None = None
    created_at: datetime


class MissingSequenceRecommendation(StudioModel):
    beat_id: UUID
    intent: str
    priority: Literal["required", "recommended"]
    request: str
    content_type: str
    proof_goal: str


class RequestedFactGate(StudioModel):
    request: str
    status: Literal["requires_phase5_verification"]
    allowed_in_script: Literal[False]


class CoverageReport(StudioModel):
    id: UUID
    narrative_map_id: UUID
    project_id: UUID
    brief_id: UUID
    required_coverage: UnitScore
    overall_coverage: UnitScore
    mandatory_total: NonNegativeInt
    mandatory_found: NonNegativeInt
    missing_items: list[dict[str, object]] = Field(default_factory=list)
    ambiguous_items: list[dict[str, object]] = Field(default_factory=list)
    low_quality_sequences: list[dict[str, object]] = Field(default_factory=list)
    requested_facts: list[RequestedFactGate] = Field(default_factory=list)
    complementary_footage: list[MissingSequenceRecommendation] = Field(default_factory=list)
    editing_decision: Literal["ready_with_prudent_narration", "continue_adapted_with_warning", "continue_partial_and_request_footage"]
    created_at: datetime


class ContentPlan(StudioModel):
    id: UUID
    variant: Literal["direct", "storytelling", "very_dynamic"]
    selected: bool
    score: UnitScore
    description: str
    selection_reason: str
    beats: list[dict[str, object]] = Field(default_factory=list)
    selection_signals: dict[str, float | str] = Field(default_factory=dict)


class EvidenceRef(StudioModel):
    id: UUID
    evidence_type: Literal[
        "segment", "media_frame", "ocr_text", "detected_entity", "detected_event",
        "knowledge_item", "official_documentation", "repeated_test", "user_library",
    ]
    source_id: UUID
    start_ms: NonNegativeInt | None = None
    end_ms: PositiveInt | None = None
    strength: UnitScore
    metadata: dict[str, JsonValue] = Field(default_factory=dict)


class Claim(StudioModel):
    id: UUID
    project_id: UUID
    game_id: GameId
    claim_key: str
    claim_type: str
    statement: str
    normalized_statement: str
    status: Literal["hypothesis", "observed_once", "reproduced", "verified", "contradicted", "outdated", "unknown"]
    confidence: UnitScore
    game_version: str | None = None
    observed_at: datetime | None = None
    verified_at: datetime | None = None
    allowed_in_script: bool
    certainty_language: str
    verification_reason: str
    safe_narration: str | None = None
    request: str | None = None
    algorithm_version: str
    evidence: list[EvidenceRef] = Field(default_factory=list)


class RequestedFactResult(StudioModel):
    claim_id: UUID
    request: str
    status: Literal["hypothesis", "observed_once", "reproduced", "verified", "contradicted", "outdated", "unknown"]
    confidence: UnitScore
    allowed_in_script: bool
    reason: str


class VerificationSummary(StudioModel):
    claim_count: NonNegativeInt
    admitted_claim_count: NonNegativeInt
    blocked_claim_count: NonNegativeInt
    requested_fact_count: NonNegativeInt
    requested_fact_coverage: UnitScore
    script_factual_safety: UnitScore
    status_distribution: dict[str, NonNegativeInt]
    knowledge_items_available: NonNegativeInt
    knowledge_items_used: NonNegativeInt


class KnowledgeSnapshot(StudioModel):
    namespace: GameId
    game_version: str
    item_count: NonNegativeInt
    used_item_ids: list[UUID] = Field(default_factory=list)
    cross_game_items: NonNegativeInt
    notice: str


class FactGate(StudioModel):
    status: Literal["PASSED", "PASSED_WITH_EXCLUSIONS", "FAILED"]
    rule: str
    blocked_claim_ids: list[UUID] = Field(default_factory=list)
    admitted_claim_ids: list[UUID] = Field(default_factory=list)


class VerificationReport(StudioModel):
    id: UUID
    schema_version: Literal["1.0"]
    algorithm_version: str
    project_id: UUID
    brief_id: UUID
    game_id: GameId
    status: Literal["PASSED", "PASSED_WITH_EXCLUSIONS", "FAILED"]
    claims: list[Claim] = Field(default_factory=list)
    summary: VerificationSummary
    requested_facts: list[RequestedFactResult] = Field(default_factory=list)
    knowledge_snapshot: KnowledgeSnapshot
    gate: FactGate
    created_at: datetime


class KnowledgeItem(StudioModel):
    id: UUID
    namespace: Literal["gta5", "gta6"]
    canonical_key: str
    game_id: Literal["gta5", "gta6"]
    game_version: str
    value: dict[str, JsonValue]
    source_uri: str | None = None
    source_type: str
    confidence: UnitScore
    status: Literal["hypothesis", "observed_once", "reproduced", "verified", "contradicted", "outdated", "unknown"]
    verified_at: datetime | None = None
    revision: PositiveInt


class ScriptBlock(StudioModel):
    id: UUID
    order: NonNegativeInt
    purpose: Literal["hook", "context", "explanation", "transition", "proof", "comparison", "conclusion", "call_to_action"]
    narration: str
    on_screen_text: str | None = None
    supporting_segment_ids: list[UUID] = Field(default_factory=list)
    supporting_claim_ids: list[UUID] = Field(default_factory=list)
    estimated_duration_ms: PositiveInt
    confidence: UnitScore
