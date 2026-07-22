import type { IsoDateTime, JsonObject, Sha256, Uuid } from "./common.js";

export const JOB_STATUSES = [
  "QUEUED",
  "BLOCKED",
  "LEASED",
  "RUNNING",
  "RETRY_WAIT",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: JsonObject;
}

export interface JobRun {
  readonly id: Uuid;
  readonly project_id: Uuid;
  readonly kind: string;
  readonly status: JobStatus;
  readonly priority: number;
  readonly idempotency_key: string;
  readonly input_fingerprint: Sha256;
  readonly algorithm_version: string;
  readonly parameters: JsonObject;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly progress: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: IsoDateTime | null;
  readonly next_retry_at: IsoDateTime | null;
  readonly cancel_requested_at: IsoDateTime | null;
  readonly error: JobError | null;
  readonly result_artifact_id: Uuid | null;
  readonly created_at: IsoDateTime;
  readonly updated_at: IsoDateTime;
}

