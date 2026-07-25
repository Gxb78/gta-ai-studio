import assert from "node:assert/strict";
import test from "node:test";

import { canScheduleJobs, canTransitionStage, isTerminalStatus, targetReached } from "../../../packages/domain/src/pipeline.js";
import { buildIdempotencyKey, canTransitionJob, computeRetryDelayMs } from "../../../packages/job-engine/src/index.js";

test("pipeline permits the canonical forward path and bounded QC loop", () => {
  assert.equal(canTransitionStage("CREATED", "SOURCE_SELECTED"), true);
  assert.equal(canTransitionStage("SOURCE_SELECTED", "INGESTED"), true);
  assert.equal(canTransitionStage("QC_ANALYZED", "FINAL_RENDERED"), true);
  assert.equal(canTransitionStage("CORRECTED", "DRAFT_RENDERED"), true);
  assert.equal(canTransitionStage("PROXIED", "CREATED"), false);
});

test("run status is independent from the durable pipeline stage", () => {
  assert.equal(canScheduleJobs("ACTIVE"), true);
  assert.equal(canScheduleJobs("WAITING_FOR_USER"), false);
  assert.equal(isTerminalStatus("FAILED_FINAL"), true);
  assert.equal(isTerminalStatus("FAILED_RETRYABLE"), false);
  assert.equal(targetReached("PROXIED", "INGESTED"), true);
});

test("job state machine rejects terminal-state reuse", () => {
  assert.equal(canTransitionJob("QUEUED", "LEASED"), true);
  assert.equal(canTransitionJob("RUNNING", "RETRY_WAIT"), true);
  assert.equal(canTransitionJob("SUCCEEDED", "RUNNING"), false);
});

test("idempotency key is stable for differently ordered parameter keys", () => {
  const left = buildIdempotencyKey({
    job_kind: "proxy",
    algorithm_version: "1.0.0",
    parameters: { preset: "preview", width: 720 },
    ordered_input_hashes: ["a", "b"],
  });
  const right = buildIdempotencyKey({
    job_kind: "proxy",
    algorithm_version: "1.0.0",
    parameters: { width: 720, preset: "preview" },
    ordered_input_hashes: ["a", "b"],
  });
  assert.equal(left, right);
  assert.equal(computeRetryDelayMs(1), 1_000);
  assert.equal(computeRetryDelayMs(3), 4_000);
});
