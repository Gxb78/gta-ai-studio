import assert from "node:assert/strict";
import test from "node:test";

import type { QualityCheckResult, QualityScore, TimelineProject } from "../../../packages/contracts/src/index.js";
import { evaluateQualityGate } from "../../../packages/quality-engine/src/index.js";
import { validateTimeline } from "../../../packages/timeline-engine/src/index.js";

const uuid = (suffix: string): string => `0190f8d0-0000-7000-8000-${suffix.padStart(12, "0")}`;

function validTimeline(): TimelineProject {
  const trackId = uuid("1");
  return {
    schema_version: "1.0",
    id: uuid("2"),
    project_id: uuid("3"),
    width: 1080,
    height: 1920,
    fps: { numerator: 30, denominator: 1 },
    timebase: { numerator: 1, denominator: 1_000 },
    duration: 5_000,
    safe_area: { top: 0.08, right: 0.12, bottom: 0.18, left: 0.08 },
    tracks: [{
      id: trackId,
      kind: "video",
      name: "Main",
      order: 0,
      exclusive: true,
      muted: false,
      clips: [{
        id: uuid("4"),
        track_id: trackId,
        start: 0,
        duration: 5_000,
        source: { media_id: uuid("5"), uri: "project://source/gameplay.mp4", source_in: 12_000, source_duration: 5_000 },
        text: null,
        speed: { numerator: 1, denominator: 1 },
        opacity: 1,
        volume: 1,
        blend_mode: "normal",
        effects: [{ type: "crop", version: "1.0", parameters: { aspect: "9:16" } }],
        supporting_segment_ids: [uuid("6")],
        supporting_claim_ids: [],
      }],
    }],
    transitions: [],
    markers: [],
  };
}

test("valid timeline has no issues", () => {
  assert.deepEqual(validateTimeline(validTimeline()), []);
});

test("timeline rejects unallowlisted effects", () => {
  const timeline = validTimeline();
  const track = timeline.tracks[0];
  assert.ok(track);
  const clip = track.clips[0];
  assert.ok(clip);
  const invalid: TimelineProject = {
    ...timeline,
    tracks: [{ ...track, clips: [{ ...clip, effects: [{ type: "raw_ffmpeg", version: "1.0", parameters: {} }] }] }],
  };
  assert.equal(validateTimeline(invalid).some((issue) => issue.code === "TIMELINE_EFFECT_NOT_ALLOWED"), true);
});

test("a blocker overrides an otherwise strong quality score", () => {
  const score: QualityScore = {
    editorial_adherence: 0.95,
    factual_reliability: 0.95,
    visual_quality: 0.95,
    pacing: 0.95,
    audio_quality: 0.95,
    subtitle_quality: 0.95,
    platform_compliance: 0.95,
    overall: 0.95,
  };
  const checks: QualityCheckResult[] = [{
    id: uuid("7"),
    render_job_id: uuid("8"),
    check_id: "factual.claims_supported",
    check_version: "1.0",
    dimension: "factual",
    status: "fail",
    severity: "blocker",
    message: "A required claim has no admissible evidence.",
    measured_value: 1,
    threshold: 0,
    evidence_artifact_ids: [],
    correction_action: "Remove or qualify the unsupported claim.",
  }];
  const decision = evaluateQualityGate(checks, score);
  assert.equal(decision.passed, false);
  assert.deepEqual(decision.blocker_check_ids, ["factual.claims_supported"]);
});

