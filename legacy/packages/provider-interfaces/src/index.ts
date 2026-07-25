import type { ArtifactRef, DataPolicy, IsoDateTime, JsonObject, JsonValue, Locale, Uuid } from "../../contracts/src/common.js";

export type ProviderCapability = "llm" | "vision" | "ocr" | "transcription" | "tts" | "image" | "embedding" | "publishing" | "analytics";
export type ProviderHealth = "healthy" | "degraded" | "unavailable" | "disabled";

export interface ProviderDescriptor {
  readonly provider_id: string;
  readonly implementation_version: string;
  readonly model_id: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly local: boolean;
  readonly supported_locales: readonly Locale[];
  readonly limits: JsonObject;
}

export interface ProviderContext {
  readonly request_id: Uuid;
  readonly trace_id: Uuid;
  readonly project_id: Uuid;
  readonly job_id: Uuid;
  readonly deadline_at: IsoDateTime;
  readonly data_policy: DataPolicy;
  readonly idempotency_key: string;
}

export interface ProviderEstimate {
  readonly estimated_latency_ms: number | null;
  readonly estimated_cost_minor: number | null;
  readonly currency: string | null;
  readonly billable_units: JsonObject;
}

export interface ProviderUsage {
  readonly latency_ms: number;
  readonly cost_minor: number | null;
  readonly currency: string | null;
  readonly units: JsonObject;
}

export interface ProviderResult<T> {
  readonly value: T;
  readonly provider_id: string;
  readonly model_id: string;
  readonly usage: ProviderUsage;
  readonly raw_response_artifact: ArtifactRef | null;
}

export type ProviderErrorKind = "transient" | "rate_limit" | "invalid_request" | "unavailable" | "policy" | "cancelled" | "internal";

export interface ProviderFailure {
  readonly kind: ProviderErrorKind;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retry_after_ms: number | null;
}

export interface BaseProvider {
  readonly descriptor: ProviderDescriptor;
  health(): Promise<ProviderHealth>;
  estimate(input: JsonObject, context: ProviderContext): Promise<ProviderEstimate>;
}

export interface TextGenerationRequest {
  readonly system_instruction: string;
  readonly user_content: string;
  readonly response_schema: JsonObject | null;
  readonly temperature: number;
  readonly max_output_tokens: number;
}

export interface TextGenerationResponse {
  readonly text: string;
  readonly structured_output: JsonValue;
}

export interface LlmProvider extends BaseProvider {
  generate_text(request: TextGenerationRequest, context: ProviderContext): Promise<ProviderResult<TextGenerationResponse>>;
}

export interface VisionRequest {
  readonly images: readonly ArtifactRef[];
  readonly instruction: string;
  readonly response_schema: JsonObject;
}

export interface VisionProvider extends BaseProvider {
  analyze(request: VisionRequest, context: ProviderContext): Promise<ProviderResult<JsonObject>>;
}

export interface OcrProvider extends BaseProvider {
  recognize(image: ArtifactRef, locale: Locale, context: ProviderContext): Promise<ProviderResult<JsonObject>>;
}

export interface TranscriptionProvider extends BaseProvider {
  transcribe(audio: ArtifactRef, locale: Locale, context: ProviderContext): Promise<ProviderResult<JsonObject>>;
}

export interface TtsRequest {
  readonly text: string;
  readonly voice_id: string;
  readonly locale: Locale;
  readonly speaking_rate: number;
  readonly pronunciation_lexicon: Readonly<Record<string, string>>;
}

export interface TtsProvider extends BaseProvider {
  synthesize(request: TtsRequest, context: ProviderContext): Promise<ProviderResult<ArtifactRef>>;
}

export interface ImageProvider extends BaseProvider {
  create(input: JsonObject, context: ProviderContext): Promise<ProviderResult<ArtifactRef>>;
}

export interface EmbeddingProvider extends BaseProvider {
  embed(texts: readonly string[], context: ProviderContext): Promise<ProviderResult<readonly (readonly number[])[]>>;
}

export interface PublishingProvider extends BaseProvider {
  publish(input: JsonObject, context: ProviderContext): Promise<ProviderResult<JsonObject>>;
}

export interface AnalyticsProvider extends BaseProvider {
  collect(input: JsonObject, context: ProviderContext): Promise<ProviderResult<JsonObject>>;
}

