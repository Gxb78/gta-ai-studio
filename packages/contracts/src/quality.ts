import type { JsonValue, Uuid } from "./common.js";

export type QualityDimension = "technical" | "editorial" | "factual" | "audio" | "subtitle" | "visual" | "platform";
export type QualityCheckStatus = "pass" | "warn" | "fail" | "skipped";
export type QualitySeverity = "info" | "warning" | "blocker";

export interface QualityCheckResult {
  readonly id: Uuid;
  readonly render_job_id: Uuid;
  readonly check_id: string;
  readonly check_version: string;
  readonly dimension: QualityDimension;
  readonly status: QualityCheckStatus;
  readonly severity: QualitySeverity;
  readonly message: string;
  readonly measured_value: JsonValue;
  readonly threshold: JsonValue;
  readonly evidence_artifact_ids: readonly Uuid[];
  readonly correction_action: string | null;
}

export interface QualityScore {
  readonly editorial_adherence: number;
  readonly factual_reliability: number;
  readonly visual_quality: number;
  readonly pacing: number;
  readonly audio_quality: number;
  readonly subtitle_quality: number;
  readonly platform_compliance: number;
  readonly overall: number;
}

export interface QualityGateDecision {
  readonly passed: boolean;
  readonly blocker_check_ids: readonly string[];
  readonly warning_check_ids: readonly string[];
  readonly score: QualityScore;
}

