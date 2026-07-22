import type { GameId, IsoDateTime, JsonObject, Uuid } from "./common.js";

export type NarrativeBeatStatus = "found" | "partially_found" | "ambiguous" | "missing" | "contradicted" | "unusable";
export type ClaimStatus = "hypothesis" | "observed_once" | "reproduced" | "verified" | "contradicted" | "outdated" | "unknown";
export type EvidenceSourceType = "segment" | "media_frame" | "ocr_text" | "detected_entity" | "detected_event" | "knowledge_item" | "official_documentation" | "repeated_test" | "user_library";

export interface SegmentCandidate {
  readonly segment_id: Uuid;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly score: number;
  readonly rationale: string;
}

export interface NarrativeBeat {
  readonly id: Uuid;
  readonly order: number;
  readonly intent: string;
  readonly required: boolean;
  readonly status: NarrativeBeatStatus;
  readonly candidate_segments: readonly SegmentCandidate[];
  readonly concept?: string;
  readonly purpose?: ScriptPurpose;
  readonly explicitly_requested?: boolean;
  readonly decision_reason?: string;
}

export interface NarrativeMap {
  readonly id: Uuid;
  readonly project_id: Uuid;
  readonly brief_id: Uuid;
  readonly version: number;
  readonly beats: readonly NarrativeBeat[];
  readonly required_coverage: number;
  readonly missing_required_count: number;
  readonly overall_coverage?: number;
  readonly content_type?: string;
  readonly algorithm_version?: string;
  readonly fact_boundary?: string;
  readonly created_at: IsoDateTime;
}

export interface MissingSequenceRecommendation {
  readonly beat_id: Uuid;
  readonly intent: string;
  readonly priority: "required" | "recommended";
  readonly request: string;
  readonly content_type: string;
  readonly proof_goal: string;
}

export interface RequestedFactGate {
  readonly request: string;
  readonly status: "requires_phase5_verification";
  readonly allowed_in_script: false;
}

export interface CoverageReport {
  readonly id: Uuid;
  readonly narrative_map_id: Uuid;
  readonly project_id: Uuid;
  readonly brief_id: Uuid;
  readonly required_coverage: number;
  readonly overall_coverage: number;
  readonly mandatory_total: number;
  readonly mandatory_found: number;
  readonly missing_items: readonly Record<string, unknown>[];
  readonly ambiguous_items: readonly Record<string, unknown>[];
  readonly low_quality_sequences: readonly Record<string, unknown>[];
  readonly requested_facts: readonly RequestedFactGate[];
  readonly complementary_footage: readonly MissingSequenceRecommendation[];
  readonly editing_decision: "ready_with_prudent_narration" | "continue_adapted_with_warning" | "continue_partial_and_request_footage";
  readonly created_at: IsoDateTime;
}

export type ContentPlanVariant = "direct" | "storytelling" | "very_dynamic";

export interface ContentPlan {
  readonly id: Uuid;
  readonly variant: ContentPlanVariant;
  readonly selected: boolean;
  readonly score: number;
  readonly description: string;
  readonly selection_reason: string;
  readonly beats: readonly Record<string, unknown>[];
  readonly selection_signals: Readonly<Record<string, number | string>>;
}

export interface Claim {
  readonly id: Uuid;
  readonly project_id: Uuid;
  readonly game_id: GameId;
  readonly claim_key: string;
  readonly claim_type: string;
  readonly statement: string;
  readonly normalized_statement: string;
  readonly status: ClaimStatus;
  readonly confidence: number;
  readonly game_version: string | null;
  readonly observed_at: IsoDateTime | null;
  readonly verified_at: IsoDateTime | null;
  readonly allowed_in_script: boolean;
  readonly certainty_language: string;
  readonly verification_reason: string;
  readonly safe_narration: string | null;
  readonly request: string | null;
  readonly algorithm_version: string;
  readonly evidence: readonly EvidenceRecord[];
}

export interface EvidenceRecord {
  readonly id: Uuid;
  readonly evidence_type: EvidenceSourceType;
  readonly source_id: Uuid;
  readonly start_ms: number | null;
  readonly end_ms: number | null;
  readonly strength: number;
  readonly metadata: JsonObject;
}

export interface RequestedFactResult {
  readonly claim_id: Uuid;
  readonly request: string;
  readonly status: ClaimStatus;
  readonly confidence: number;
  readonly allowed_in_script: boolean;
  readonly reason: string;
}

export interface VerificationReport {
  readonly id: Uuid;
  readonly schema_version: "1.0";
  readonly algorithm_version: string;
  readonly project_id: Uuid;
  readonly brief_id: Uuid;
  readonly game_id: GameId;
  readonly status: "PASSED" | "PASSED_WITH_EXCLUSIONS" | "FAILED";
  readonly claims: readonly Claim[];
  readonly summary: {
    readonly claim_count: number;
    readonly admitted_claim_count: number;
    readonly blocked_claim_count: number;
    readonly requested_fact_count: number;
    readonly requested_fact_coverage: number;
    readonly script_factual_safety: number;
    readonly status_distribution: Readonly<Record<ClaimStatus, number>>;
    readonly knowledge_items_available: number;
    readonly knowledge_items_used: number;
  };
  readonly requested_facts: readonly RequestedFactResult[];
  readonly knowledge_snapshot: {
    readonly namespace: GameId;
    readonly game_version: string;
    readonly item_count: number;
    readonly used_item_ids: readonly Uuid[];
    readonly cross_game_items: number;
    readonly notice: string;
  };
  readonly gate: {
    readonly status: "PASSED" | "PASSED_WITH_EXCLUSIONS" | "FAILED";
    readonly rule: string;
    readonly blocked_claim_ids: readonly Uuid[];
    readonly admitted_claim_ids: readonly Uuid[];
  };
  readonly created_at: IsoDateTime;
}

export interface KnowledgeItem {
  readonly id: Uuid;
  readonly namespace: "gta5" | "gta6";
  readonly canonical_key: string;
  readonly game_id: "gta5" | "gta6";
  readonly game_version: string;
  readonly value: JsonObject;
  readonly source_uri: string | null;
  readonly source_type: string;
  readonly confidence: number;
  readonly status: ClaimStatus;
  readonly verified_at: IsoDateTime | null;
  readonly revision: number;
}

export type ScriptPurpose = "hook" | "context" | "explanation" | "transition" | "proof" | "comparison" | "conclusion" | "call_to_action";

export interface ScriptBlock {
  readonly id: Uuid;
  readonly order: number;
  readonly purpose: ScriptPurpose;
  readonly narration: string;
  readonly on_screen_text: string | null;
  readonly supporting_segment_ids: readonly Uuid[];
  readonly supporting_claim_ids: readonly Uuid[];
  readonly estimated_duration_ms: number;
  readonly confidence: number;
}
