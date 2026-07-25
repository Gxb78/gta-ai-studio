import type { JobStatus } from "../../contracts/src/jobs.js";
import type { JsonObject } from "../../contracts/src/common.js";
import { canonicalJson, sha256Text } from "../../shared-utils/src/index.js";

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  QUEUED: ["BLOCKED", "LEASED", "CANCELLED"],
  BLOCKED: ["QUEUED", "CANCELLED"],
  LEASED: ["RUNNING", "QUEUED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "RETRY_WAIT", "FAILED", "CANCELLED"],
  RETRY_WAIT: ["QUEUED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new Error(`JOB_INVALID_STATUS_TRANSITION: ${from} -> ${to}`);
  }
}

export interface IdempotencyKeyInput {
  readonly job_kind: string;
  readonly algorithm_version: string;
  readonly parameters: JsonObject;
  readonly ordered_input_hashes: readonly string[];
}

export function buildIdempotencyKey(input: IdempotencyKeyInput): string {
  const parametersHash = sha256Text(canonicalJson(input.parameters));
  const inputHash = sha256Text(input.ordered_input_hashes.join(":"));
  return `${input.job_kind}:${input.algorithm_version}:${parametersHash}:${inputHash}`;
}

export function computeRetryDelayMs(attempt: number, baseMs = 1_000, capMs = 300_000, jitter = 0): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("JOB_INVALID_ATTEMPT");
  }
  if (baseMs <= 0 || capMs < baseMs || jitter < 0 || jitter > 1) {
    throw new Error("JOB_INVALID_RETRY_POLICY");
  }
  const deterministic = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(deterministic * (1 + jitter));
}

