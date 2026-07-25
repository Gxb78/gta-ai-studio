import type { ArtifactRef, BoundingBox, GameId, IsoDateTime, Locale, Sha256, TimeRange, Uuid } from "./common.js";

export type MediaKind = "video" | "audio" | "image" | "subtitle" | "document";
export type MediaStatus = "registered" | "verified" | "invalid" | "deleted";
export type DerivativeKind = "proxy" | "audio_extract" | "frame" | "waveform" | "render" | "thumbnail" | "report";

export interface MediaAsset {
  readonly id: Uuid;
  readonly project_id: Uuid;
  readonly kind: MediaKind;
  readonly status: MediaStatus;
  readonly original_uri: string;
  readonly sha256: Sha256;
  readonly size_bytes: number;
  readonly duration_ms: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps_numerator: number | null;
  readonly fps_denominator: number | null;
  readonly video_codec: string | null;
  readonly audio_codec: string | null;
  readonly game: GameId;
  readonly captured_at: IsoDateTime | null;
  readonly created_at: IsoDateTime;
}

export interface MediaDerivative {
  readonly id: Uuid;
  readonly source_media_id: Uuid;
  readonly kind: DerivativeKind;
  readonly algorithm_version: string;
  readonly input_fingerprint: Sha256;
  readonly artifact: ArtifactRef;
}

export interface DetectedText {
  readonly text: string;
  readonly normalized_text: string;
  readonly locale: Locale | null;
  readonly confidence: number;
  readonly range: TimeRange;
  readonly region: BoundingBox | null;
}

export interface VideoSegment {
  readonly id: Uuid;
  readonly project_id: Uuid;
  readonly media_id: Uuid;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly scene_type: string;
  readonly detected_actions: readonly string[];
  readonly detected_objects: readonly string[];
  readonly detected_texts: readonly string[];
  readonly detected_entities: readonly string[];
  readonly motion_score: number;
  readonly visual_quality_score: number;
  readonly relevance_score: number;
  readonly novelty_score: number;
  readonly has_dialogue: boolean;
  readonly has_music: boolean;
  readonly has_potential_copyright_music: boolean;
  readonly transcript: string | null;
  readonly summary: string;
  readonly confidence: number;
}

