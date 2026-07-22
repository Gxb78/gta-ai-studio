import type { GameId, Locale, Uuid } from "./common.js";

export const CONTENT_TYPES = [
  "vehicle_showcase",
  "vehicle_customization",
  "mission_showcase",
  "mission_guide",
  "tip",
  "secret",
  "myth_test",
  "comparison",
  "challenge",
  "weapon_showcase",
  "location_showcase",
  "activity_showcase",
  "news_explainer",
  "other",
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];
export type TargetPlatform = "tiktok" | "youtube_shorts" | "youtube_longform";
export type AspectRatio = "9:16" | "16:9" | "1:1";
export type Tone = "informative" | "enthusiastic" | "cinematic" | "humorous" | "serious" | "neutral";
export type Pacing = "slow" | "balanced" | "dynamic" | "very_dynamic";
export type SpoilerLevel = "none" | "light" | "full";
export type VoiceMode = "synthetic_voice" | "text_only";
export type PublishMode = "local_export" | "approval_required" | "automatic";

export interface EditorialBrief {
  readonly id: Uuid;
  readonly project_id: Uuid;
  readonly schema_version: "1.0";
  readonly raw_instruction: string;
  readonly language: Locale;
  readonly game: GameId;
  readonly content_type: ContentType;
  readonly subject: string | null;
  readonly objective: string;
  readonly target_platforms: readonly TargetPlatform[];
  readonly target_duration_seconds: number | null;
  readonly target_aspect_ratio: AspectRatio;
  readonly narrative_order: readonly string[];
  readonly must_include: readonly string[];
  readonly should_include: readonly string[];
  readonly must_avoid: readonly string[];
  readonly expected_events: readonly string[];
  readonly expected_visual_proofs: readonly string[];
  readonly requested_facts: readonly string[];
  readonly requested_comparisons: readonly string[];
  readonly tone: Tone;
  readonly pacing: Pacing;
  readonly spoiler_level: SpoilerLevel;
  readonly voice_mode: VoiceMode;
  readonly publish_mode: PublishMode;
  readonly confidence: number;
  readonly ambiguities: readonly string[];
}

