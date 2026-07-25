export const CONTRACT_SCHEMA_VERSION = "1.0" as const;

export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;
export type Uuid = string;
export type IsoDateTime = string;
export type Sha256 = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type GameId = "gta5" | "gta6" | "unknown";
export type Locale = string;

export type DataPolicy = "local_only" | "metadata_only" | "media_allowed";

export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

export interface TimeRange {
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ArtifactRef {
  readonly id: Uuid;
  readonly kind: string;
  readonly uri: string;
  readonly sha256: Sha256;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly created_at: IsoDateTime;
}

export interface ProvenanceRef {
  readonly source_type: "media" | "segment" | "claim" | "knowledge" | "model_run" | "user" | "media_frame" | "ocr_text" | "detected_entity" | "detected_event" | "knowledge_item" | "official_documentation" | "repeated_test" | "user_library";
  readonly source_id: Uuid;
  readonly range?: TimeRange;
}

export interface ContractEnvelope<T> {
  readonly schema_version: ContractSchemaVersion;
  readonly payload: T;
}
