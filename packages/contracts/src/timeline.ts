import type { JsonObject, Rational, Uuid } from "./common.js";

export type TimelineTrackKind = "video" | "audio" | "text" | "overlay";
export type BlendMode = "normal" | "multiply" | "screen" | "overlay";

export interface TimelineSource {
  readonly media_id: Uuid;
  readonly uri: string;
  readonly source_in: number;
  readonly source_duration: number;
}

export interface TimelineEffect {
  readonly type: string;
  readonly version: string;
  readonly parameters: JsonObject;
}

export interface TimelineClip {
  readonly id: Uuid;
  readonly track_id: Uuid;
  readonly start: number;
  readonly duration: number;
  readonly source: TimelineSource | null;
  readonly text: string | null;
  readonly speed: Rational;
  readonly opacity: number;
  readonly volume: number;
  readonly blend_mode: BlendMode;
  readonly effects: readonly TimelineEffect[];
  readonly supporting_segment_ids: readonly Uuid[];
  readonly supporting_claim_ids: readonly Uuid[];
}

export interface TimelineTrack {
  readonly id: Uuid;
  readonly kind: TimelineTrackKind;
  readonly name: string;
  readonly order: number;
  readonly exclusive: boolean;
  readonly muted: boolean;
  readonly clips: readonly TimelineClip[];
}

export interface TimelineTransition {
  readonly id: Uuid;
  readonly from_clip_id: Uuid;
  readonly to_clip_id: Uuid;
  readonly type: "cut" | "crossfade" | "dip_to_black" | "audio_crossfade";
  readonly duration: number;
}

export interface TimelineMarker {
  readonly id: Uuid;
  readonly position: number;
  readonly kind: "beat" | "proof" | "chapter" | "warning";
  readonly label: string;
  readonly reference_id: Uuid | null;
}

export interface SafeArea {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface TimelineProject {
  readonly schema_version: "1.0";
  readonly id: Uuid;
  readonly project_id: Uuid;
  readonly width: number;
  readonly height: number;
  readonly fps: Rational;
  readonly timebase: Rational;
  readonly duration: number;
  readonly safe_area: SafeArea;
  readonly tracks: readonly TimelineTrack[];
  readonly transitions: readonly TimelineTransition[];
  readonly markers: readonly TimelineMarker[];
}

