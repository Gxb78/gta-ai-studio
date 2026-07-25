import type { QualityCheckResult, QualityGateDecision, QualityScore } from "../../contracts/src/quality.js";

const scoreKeys = [
  "editorial_adherence",
  "factual_reliability",
  "visual_quality",
  "pacing",
  "audio_quality",
  "subtitle_quality",
  "platform_compliance",
  "overall",
] as const satisfies readonly (keyof QualityScore)[];

export function validateQualityScore(score: QualityScore): readonly string[] {
  return scoreKeys
    .filter((key) => !Number.isFinite(score[key]) || score[key] < 0 || score[key] > 1)
    .map((key) => `QUALITY_SCORE_OUT_OF_RANGE:${key}`);
}

export function evaluateQualityGate(
  checks: readonly QualityCheckResult[],
  score: QualityScore,
  minimumOverall = 0.8,
): QualityGateDecision {
  const scoreErrors = validateQualityScore(score);
  if (scoreErrors.length > 0 || minimumOverall < 0 || minimumOverall > 1) {
    throw new Error(scoreErrors[0] ?? "QUALITY_INVALID_THRESHOLD");
  }

  const blockers = checks
    .filter((check) => check.status === "fail" && check.severity === "blocker")
    .map((check) => check.check_id);
  const warnings = checks
    .filter((check) => check.status === "warn" || (check.status === "fail" && check.severity !== "blocker"))
    .map((check) => check.check_id);

  return {
    passed: blockers.length === 0 && score.overall >= minimumOverall,
    blocker_check_ids: blockers,
    warning_check_ids: warnings,
    score,
  };
}

