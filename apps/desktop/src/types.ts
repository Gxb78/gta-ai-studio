export type PipelineStage =
  | "CREATED" | "SOURCE_SELECTED" | "INGESTED" | "PROXIED"
  | "ANALYZED" | "SEGMENTED" | "NARRATIVE_MAPPED" | "COVERAGE_CHECKED"
  | "CONTENT_PLANNED" | "FACTS_VERIFIED" | "SCRIPTED" | "VOICED"
  | "TIMELINE_BUILT" | "DRAFT_RENDERED" | "QC_ANALYZED" | "CORRECTED" | "FINAL_RENDERED" | "READY_TO_PUBLISH";
export type RunStatus = "ACTIVE" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "CANCELLED" | "COMPLETED" | string;
export type JobStatus = "QUEUED" | "BLOCKED" | "LEASED" | "RUNNING" | "RETRY_WAIT" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface Health {
  status: "ok" | "degraded";
  version: string;
  database: "ok";
  worker: "running" | "stopped";
  tools: Record<string, string | boolean>;
}

export interface HardwareDiagnostics {
  requested_mode: "auto" | "cpu" | "nvidia";
  active_mode: "cpu" | "nvidia";
  video_encoder: "libx264" | "h264_nvenc";
  gpu_name: string;
  nvidia: null | { name: string; driver: string; memory_mb: string };
  ffmpeg_hardware_encoders: string[];
  nvenc_ready: boolean;
  opencv_cuda: boolean;
  opencv_cuda_devices: number;
  onnx_providers: string[];
  onnx_gpu: boolean;
  fallback: string;
  diagnostics: string[];
}

export interface AudioWaveform {
  track: string;
  sample_rate: number;
  duration_ms: number;
  peaks: number[];
  rms: number[];
}

export interface MediaAsset {
  id: string;
  sha256: string;
  size_bytes: number;
  duration_ms: number;
  width: number;
  height: number;
  fps_numerator: number;
  fps_denominator: number;
  video_codec: string;
  audio_codec: string | null;
  game_id: "gta5" | "gta6" | "unknown";
}

export interface JobRun {
  id: string;
  kind: "INGEST_SOURCE" | "GENERATE_PROXY" | "ANALYZE_SCENES" | "EXTRACT_KEYFRAMES" | "OCR_FRAMES" | "ANALYZE_GAMEPLAY" | "BUILD_NARRATIVE_MAP" | "PLAN_CONTENT" | "VERIFY_FACTS" | "GENERATE_SCRIPT" | "SYNTHESIZE_VOICE" | "PLAN_ADVANCED_EDIT" | "BUILD_TIMELINE" | "RENDER_VERTICAL" | "GENERATE_CREATIVE_PACKAGE" | "RENDER_CLIP_PREVIEW";
  status: JobStatus;
  progress: number;
  attempt: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
}

export interface Artifact {
  id: string;
  uri: string;
  sha256: string;
  size_bytes: number;
  metadata: Record<string, unknown>;
}

export interface ProjectSummary {
  id: string;
  title: string;
  game_id: "gta5" | "gta6" | "unknown";
  pipeline_stage: PipelineStage;
  run_status: RunStatus;
  created_at: string;
  updated_at: string;
  active_progress?: number | null;
}

export interface Project extends ProjectSummary {
  target_stage: string;
  failure_code: string | null;
  failure_message: string | null;
  media: MediaAsset[];
  jobs: JobRun[];
  proxy: Artifact | null;
  proxy_url: string | null;
  production: ProductionState;
  analysis: AnalysisState;
  recent_events: Array<{ event_type: string; occurred_at: string; payload: Record<string, unknown> }>;
}

export interface AnalysisState {
  run: null | {
    id: string;
    status: "RUNNING" | "SUCCEEDED" | "FAILED";
    adapter_id: string;
    adapter_version: string;
    vision_version: string;
    ocr_version: string;
  };
  adapter: null | {
    id: string;
    version: string;
    detector_version: string;
    capabilities: string[];
    limitations: string[];
  };
  summary: null | {
    frame_count: number;
    text_count: number;
    entity_count: number;
    event_count: number;
    screen_distribution: Record<string, number>;
    menu_distribution: Record<string, number>;
  };
  guided_search: null | {
    brief: string;
    terms: string[];
    matched_intents: string[];
    hits: Array<{
      segment_id: string;
      start_ms: number;
      end_ms: number;
      score: number;
      matched_terms: string[];
      matched_detections: string[];
      summary: string;
    }>;
    notice: string;
  };
  frames: AnalysisFrame[];
  texts: Array<{
    id: string;
    frame_id: string;
    start_ms: number;
    text: string;
    normalized_text: string;
    confidence: number;
  }>;
  entities: Array<{
    id: string;
    frame_id: string | null;
    start_ms: number;
    entity_type: string;
    label: string;
    confidence: number;
    attributes: Record<string, unknown>;
  }>;
  events: Array<{
    id: string;
    frame_id: string | null;
    start_ms: number;
    event_type: string;
    confidence: number;
    attributes: Record<string, unknown>;
  }>;
}

export interface AnalysisFrame {
  id: string;
  timestamp_ms: number;
  width: number;
  height: number;
  url: string;
  metrics: Record<string, number>;
  detections: {
    screen_label?: string;
    menu_id?: string | null;
    confidence?: number;
    basis?: string[];
  };
}

export interface Voice {
  id: string;
  name: string;
  culture: string;
  gender: string;
}

export interface ProductionRequest {
  brief: string;
  target_duration_seconds: number;
  editorial_style: "dynamic" | "cinematic" | "tutorial";
  voice_id: string | null;
  voice_rate: number;
  caption_style: "impact" | "minimal";
  composition: "smart_blur" | "center_crop";
  source_audio_level: number;
  include_hook: boolean;
  include_cta: boolean;
}

export interface ProductionState {
  brief: null | {
    id: string;
    raw_instruction: string;
    revision: number;
    structured: Record<string, unknown> & { production?: Record<string, unknown> };
  };
  segments: Array<{ id: string; start_ms: number; end_ms: number; scene_type: string; summary: string; confidence: number }>;
  narrative: NarrativeState | null;
  evidence: EvidenceState | null;
  advanced_edit: AdvancedEditingState | null;
  timeline_editor: TimelineEditorState | null;
  creative_package: CreativePackage | null;
  script: null | {
    id: string;
    full_text: string;
    estimated_duration_ms: number;
    blocks: Array<{ id: string; order: number; purpose: string; narration: string; on_screen_text: string; supporting_segment_ids: string[]; supporting_claim_ids: string[]; estimated_duration_ms: number }>;
  };
  voice: null | { id: string; voice_id: string; duration_ms: number; artifact_id: string };
  edit: null | { id: string; revision: number; duration: number; timeline: Record<string, unknown> & { tracks?: unknown[] } };
  render: null | {
    id: string;
    status: string;
    artifact_id: string | null;
    artifact_size_bytes: number | null;
    artifact_metadata: null | Record<string, unknown>;
    render_plan: null | Record<string, unknown>;
  };
  quality_checks: Array<{ check_id: string; dimension: string; status: "pass" | "warn" | "fail"; severity: string; message: string }>;
  artifacts: Record<string, Artifact>;
  render_url: string | null;
  voice_url: string | null;
  subtitles_url: string | null;
}

export interface CreativeThumbnail {
  id: string;
  rank: number;
  template_key: "impact" | "clean" | "duo";
  headline: string;
  source_frame_ids: string[];
  score: number;
  score_breakdown: Record<string, number>;
  selected: boolean;
  width: number;
  height: number;
  artifact_id: string;
  url: string;
}

export interface CreativeMetadataVariant {
  id: string;
  platform: "youtube_shorts" | "tiktok" | "instagram_reels";
  platform_label: string;
  category: "direct" | "curiosity" | "question" | "comparison" | "result" | "advice";
  title: string;
  description: string;
  short_description: string;
  keywords: string[];
  hashtags: string[];
  thumbnail_text: string;
  pinned_comment: string;
  score: number;
  score_breakdown: Record<string, number>;
  history_score: number | null;
  selected: boolean;
}

export interface CreativePackage {
  id: string;
  status: "READY" | "READY_WITH_WARNINGS" | "FAILED";
  algorithm_version: string;
  generated_at: string;
  selected_thumbnail_id: string;
  image_selection: {
    criteria: string[];
    candidates: Array<{ frame_id: string; segment_id: string | null; timestamp_ms: number; score: number; score_breakdown: Record<string, number> }>;
  };
  thumbnails: CreativeThumbnail[];
  metadata: {
    variants: CreativeMetadataVariant[];
    selected_by_platform: Record<string, string>;
    history_signal: { status: "unavailable"; reason: string };
  };
  safety: {
    source_policy: string;
    factual_anchor: string;
    anchor_sources: string[];
    unverified_subject_excluded: boolean;
    clickbait_policy: string;
  };
  summary: { candidate_frame_count: number; thumbnail_count: number; metadata_variant_count: number; platform_count: number };
  artifact_id: string;
  artifact_sha256: string;
  artifact_size_bytes: number;
  download_url: string;
}

export interface AdvancedEditingClip {
  id: string;
  index: number;
  start_ms: number;
  end_ms: number;
  source_duration_ms: number;
  duration_ms: number;
  reframe_mode: "dynamic_crop" | "fixed_crop" | "blur_background" | "split_screen";
  tracking_confidence: number;
  speed: number;
  speed_reason: string;
  zoom: number;
  zoom_reason: string;
  focus_start_x: number;
  focus_end_x: number;
  focus_y: number;
  tracking_method: string;
  concepts: string[];
  purposes: string[];
  supporting_segment_ids: string[];
  supporting_claim_ids: string[];
  selection_score?: number | null;
  fade_in_ms?: number;
  fade_out_ms?: number;
  comparison?: Record<string, unknown>;
}

export interface EditableOverlay {
  id: string;
  cue_type: "title" | "step" | "proof" | "before_after" | "result" | "conclusion";
  start_ms: number;
  end_ms: number;
  text: string;
  secondary_text: string | null;
  template_key: string;
  supporting_claim_ids: string[];
  parameters: Record<string, unknown>;
  enabled?: boolean;
  manual_override?: boolean;
}

export interface AdvancedEditingState {
  id: string;
  status: "READY" | "READY_WITH_FALLBACKS" | "FAILED";
  algorithm_version: string;
  template_id: string;
  template_version: string;
  tracking_confidence: number;
  summary: {
    clip_count: number;
    track_point_count: number;
    dynamic_reframe_count: number;
    fallback_reframe_count: number;
    overlay_count: number;
    zoom_effect_count: number;
    speed_effect_count: number;
    comparison_count: number;
    transition_count: number;
  };
  clips: AdvancedEditingClip[];
  subject_track: Array<{ id: string; timestamp_ms: number; focus_x: number; focus_y: number; confidence: number; method: string }>;
  overlays: EditableOverlay[];
  transitions: Array<{ id: string; type: string; duration_ms: number }>;
  audio_mix: { target_lufs: number; true_peak_db: number; source_audio_level: number; strategy: string };
  safe_area: Record<string, number>;
  safety: Record<string, unknown>;
}

export interface TimelineEditorState {
  id: string | null;
  edit_project_id: string;
  revision: number;
  parent_edit_project_id: string | null;
  base_advanced_edit_plan_id: string | null;
  state: AdvancedEditingState | null;
  note: string;
  created_at: string;
  previews: Array<{ clip_index: number; artifact_id: string; sha256: string; created_at: string }>;
}

export interface TimelineRevisionRequest {
  base_edit_project_id: string;
  expected_revision: number;
  clips: AdvancedEditingClip[];
  overlays: EditableOverlay[];
  note: string;
}

export type NarrativeBeatStatus = "found" | "partially_found" | "ambiguous" | "missing" | "contradicted" | "unusable";

export interface NarrativeCandidate {
  segment_id: string;
  start_ms: number;
  end_ms: number;
  score: number;
  visual_quality_score: number;
  rationale: string;
}

export interface NarrativeBeat {
  id: string;
  order: number;
  concept: string;
  intent: string;
  purpose: string;
  required: boolean;
  explicitly_requested: boolean;
  status: NarrativeBeatStatus;
  decision_reason: string;
  candidate_segments: NarrativeCandidate[];
}

export interface CoverageItem {
  beat_id: string;
  intent: string;
  required: boolean;
  status: NarrativeBeatStatus;
  reason: string;
}

export interface FootageRecommendation {
  beat_id: string;
  intent: string;
  priority: string;
  request: string;
  content_type: string;
  proof_goal: string;
}

export interface ContentPlan {
  id: string;
  variant: "direct" | "storytelling" | "very_dynamic";
  selected: boolean;
  score: number;
  description: string;
  selection_reason: string;
  beats: Array<{ beat_id: string; concept: string; intent: string; purpose: string; status: NarrativeBeatStatus; segment_ids: string[] }>;
  selection_signals: Record<string, number | string>;
}

export interface NarrativeState {
  map: {
    id: string;
    version: number;
    algorithm_version: string;
    content_type: string;
    required_coverage: number;
    overall_coverage: number;
    missing_required_count: number;
    fact_boundary: string;
    beats: NarrativeBeat[];
  };
  coverage: {
    required_coverage: number;
    overall_coverage: number;
    mandatory_total: number;
    mandatory_found: number;
    missing_items: CoverageItem[];
    ambiguous_items: CoverageItem[];
    low_quality_sequences: Array<{ segment_id: string; start_ms: number; end_ms: number; visual_quality_score: number }>;
    requested_facts: Array<{ request: string; status: "requires_phase5_verification"; allowed_in_script: false }>;
    complementary_footage: FootageRecommendation[];
    editing_decision: "ready_with_prudent_narration" | "continue_adapted_with_warning" | "continue_partial_and_request_footage";
  } | null;
  plans: ContentPlan[];
  selected_plan: ContentPlan | null;
}

export type ClaimStatus = "hypothesis" | "observed_once" | "reproduced" | "verified" | "contradicted" | "outdated" | "unknown";

export interface ClaimEvidence {
  id: string;
  evidence_type: "segment" | "media_frame" | "ocr_text" | "detected_entity" | "detected_event" | "knowledge_item" | "official_documentation" | "repeated_test" | "user_library";
  source_id: string;
  start_ms: number | null;
  end_ms: number | null;
  strength: number;
  metadata: Record<string, unknown>;
}

export interface EvidenceClaim {
  id: string;
  claim_key: string;
  claim_type: string;
  statement: string;
  status: ClaimStatus;
  confidence: number;
  allowed_in_script: boolean;
  certainty_language: string;
  verification_reason: string;
  safe_narration: string | null;
  request: string | null;
  evidence: ClaimEvidence[];
  history: Array<{ status: ClaimStatus; confidence: number; reason: string; origin: string; occurred_at: string }>;
}

export interface EvidenceState {
  run: {
    id: string;
    game_id: "gta5" | "gta6" | "unknown";
    algorithm_version: string;
    status: "PASSED" | "PASSED_WITH_EXCLUSIONS" | "FAILED";
    completed_at: string;
  };
  summary: {
    claim_count: number;
    admitted_claim_count: number;
    blocked_claim_count: number;
    requested_fact_count: number;
    requested_fact_coverage: number;
    script_factual_safety: number;
    status_distribution: Record<string, number>;
    knowledge_items_available: number;
    knowledge_items_used: number;
  };
  gate: {
    status: "PASSED" | "PASSED_WITH_EXCLUSIONS" | "FAILED";
    rule: string;
    blocked_claim_ids: string[];
    admitted_claim_ids: string[];
  };
  requested_facts: Array<{ claim_id: string; request: string; status: ClaimStatus; confidence: number; allowed_in_script: boolean; reason: string }>;
  knowledge_snapshot: { namespace: string; game_version: string; item_count: number; used_item_ids: string[]; cross_game_items: number; notice: string };
  claims: EvidenceClaim[];
  knowledge_items: Array<{
    id: string;
    canonical_key: string;
    namespace: string;
    game_id: string;
    game_version: string;
    source_type: string;
    source_uri: string | null;
    confidence: number;
    status: ClaimStatus;
    revision: number;
    revision_count: number;
    project_usage_count: number;
    value: Record<string, unknown>;
  }>;
  cross_game_item_count: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

export type PreviewRenderProfile = "draft" | "fidelity";
export type PreviewViewMode = "cropped" | "before_after";
export type PreviewStatus =
  | "interactive" | "dirty" | "debouncing" | "queued"
  | "rendering" | "ready" | "stale" | "failed";

export interface PreviewWindow {
  playheadMs: number;
  startMs: number;
  durationMs: number;
}

export interface PreviewResponse {
  client_request_id: string;
  job_run_id: string | null;
  cache_key: string;
  cache_hit: boolean;
  status: "ready" | "pending" | "rendering" | "failed";
  artifact_url: string | null;
  clip_id: string;
  clip_revision: number;
  timeline_revision: number;
  render_profile: PreviewRenderProfile;
}
