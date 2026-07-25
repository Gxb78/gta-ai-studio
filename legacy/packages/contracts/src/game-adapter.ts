import type { ArtifactRef, BoundingBox, GameId, JsonObject, Locale, TimeRange, Uuid } from "./common.js";
import type { ContentType } from "./editorial.js";

export type AdapterCapability = "game_detection" | "screen_classification" | "hud" | "menus" | "entities" | "events" | "text_normalization" | "guided_search" | "knowledge" | "pronunciation" | "narrative_templates";

export interface GameAdapterDescriptor {
  readonly id: string;
  readonly game_id: Exclude<GameId, "unknown">;
  readonly version: string;
  readonly contract_version: "1.0";
  readonly display_name: string;
  readonly supported_game_versions: readonly string[];
  readonly supported_locales: readonly Locale[];
  readonly capabilities: readonly AdapterCapability[];
  readonly knowledge_namespace: string;
}

export interface FrameRef {
  readonly artifact: ArtifactRef;
  readonly timestamp_ms: number;
  readonly width: number;
  readonly height: number;
}

export interface SegmentRef {
  readonly segment_id: Uuid;
  readonly media_id: Uuid;
  readonly range: TimeRange;
  readonly representative_frames: readonly FrameRef[];
}

export interface Detection {
  readonly label: string;
  readonly confidence: number;
  readonly region: BoundingBox | null;
  readonly range: TimeRange | null;
  readonly detector_version: string;
  readonly attributes: JsonObject;
}

export interface EntityDetection extends Detection {
  readonly entity_type: string;
  readonly canonical_id: string | null;
}

export interface GameEvent extends Detection {
  readonly event_type: string;
  readonly entity_ids: readonly string[];
}

export interface NarrativeTemplate {
  readonly id: string;
  readonly version: string;
  readonly content_type: ContentType;
  readonly required_beats: readonly string[];
  readonly optional_beats: readonly string[];
}

export interface GameEntity {
  readonly canonical_id: string;
  readonly entity_type: string;
  readonly display_name: string;
  readonly aliases: readonly string[];
  readonly confidence: number;
}

export interface GameAdapter {
  readonly descriptor: GameAdapterDescriptor;
  detect_game(frame: FrameRef): Promise<Detection>;
  detect_hud(frame: FrameRef): Promise<readonly Detection[]>;
  detect_menus(frame: FrameRef): Promise<readonly Detection[]>;
  detect_entities(frame: FrameRef): Promise<readonly EntityDetection[]>;
  detect_events(segment: SegmentRef): Promise<readonly GameEvent[]>;
  normalize_text(text: string, locale: Locale): string;
  resolve_entity(text: string, context: JsonObject): Promise<GameEntity | null>;
  get_content_templates(content_type: ContentType): readonly NarrativeTemplate[];
  get_expected_events(content_type: ContentType): readonly string[];
  get_knowledge_namespace(): string;
  get_pronunciation_lexicon(locale: Locale): Readonly<Record<string, string>>;
}
