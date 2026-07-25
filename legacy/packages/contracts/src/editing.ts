import type { IsoDateTime, JsonObject, Uuid } from "./common.js";

export type ReframeMode = "dynamic_crop" | "fixed_crop" | "blur_background" | "split_screen";
export type TrackingMethod = "evidence_region" | "visual_attention" | "combined" | "center_fallback";
export type OverlayCueType = "title" | "step" | "proof" | "before_after" | "result" | "conclusion";

export interface SubjectTrackPoint {
  readonly id: Uuid;
  readonly segment_id: Uuid | null;
  readonly frame_id: Uuid | null;
  readonly timestamp_ms: number;
  readonly focus_x: number;
  readonly focus_y: number;
  readonly confidence: number;
  readonly method: TrackingMethod;
  readonly source_type: string;
}

export interface AdvancedEditClip {
  readonly index: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly source_duration_ms: number;
  readonly duration_ms: number;
  readonly supporting_segment_ids: readonly Uuid[];
  readonly selection_score?: number;
  readonly speed: number;
  readonly speed_reason: string;
  readonly reframe_mode: ReframeMode;
  readonly focus_start_x: number;
  readonly focus_end_x: number;
  readonly focus_y: number;
  readonly tracking_confidence: number;
  readonly tracking_method: TrackingMethod;
  readonly zoom: number;
  readonly zoom_reason: string;
  readonly comparison?: JsonObject;
  readonly concepts: readonly string[];
  readonly purposes: readonly string[];
  readonly fade_in_ms?: number;
  readonly fade_out_ms?: number;
}

export interface OverlayCue {
  readonly id: Uuid;
  readonly cue_type: OverlayCueType;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  readonly secondary_text: string | null;
  readonly template_key: string;
  readonly supporting_claim_ids: readonly Uuid[];
  readonly parameters: JsonObject;
}

export interface AdvancedEditPlan {
  readonly id: Uuid;
  readonly schema_version: "1.0";
  readonly algorithm_version: string;
  readonly project_id: Uuid;
  readonly brief_id: Uuid;
  readonly status: "READY" | "READY_WITH_FALLBACKS" | "FAILED";
  readonly template: JsonObject;
  readonly safe_area: JsonObject;
  readonly clips: readonly AdvancedEditClip[];
  readonly subject_track: readonly SubjectTrackPoint[];
  readonly overlays: readonly OverlayCue[];
  readonly transitions: readonly JsonObject[];
  readonly audio_mix: JsonObject;
  readonly summary: JsonObject;
  readonly safety: JsonObject;
  readonly created_at: IsoDateTime;
}
