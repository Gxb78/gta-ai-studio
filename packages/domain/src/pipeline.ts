export const PIPELINE_STAGES = [
  "CREATED",
  "SOURCE_SELECTED",
  "BRIEF_CAPTURED",
  "BRIEF_STRUCTURED",
  "INGESTED",
  "PROXIED",
  "ANALYZED",
  "SEGMENTED",
  "NARRATIVE_MAPPED",
  "COVERAGE_CHECKED",
  "CONTENT_PLANNED",
  "FACTS_VERIFIED",
  "SCRIPTED",
  "VOICED",
  "TIMELINE_BUILT",
  "DRAFT_RENDERED",
  "QC_ANALYZED",
  "CORRECTED",
  "FINAL_RENDERED",
  "READY_TO_PUBLISH",
  "PUBLISHED",
  "ANALYTICS_COLLECTED",
  "LEARNING_UPDATED",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const RUN_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "WAITING_FOR_USER",
  "WAITING_FOR_PROVIDER",
  "MISSING_FOOTAGE",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "CANCELLED",
  "COMPLETED",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

const nextLinearStage = new Map<PipelineStage, PipelineStage>(
  PIPELINE_STAGES.slice(0, -1).map((stage, index) => [stage, PIPELINE_STAGES[index + 1] as PipelineStage]),
);

const alternateTransitions = new Set<string>([
  "SOURCE_SELECTED:INGESTED",
  "QC_ANALYZED:FINAL_RENDERED",
  "CORRECTED:DRAFT_RENDERED",
]);

export function canTransitionStage(from: PipelineStage, to: PipelineStage): boolean {
  return nextLinearStage.get(from) === to || alternateTransitions.has(`${from}:${to}`);
}

export function assertStageTransition(from: PipelineStage, to: PipelineStage): void {
  if (!canTransitionStage(from, to)) {
    throw new Error(`DOMAIN_INVALID_STAGE_TRANSITION: ${from} -> ${to}`);
  }
}

export function canScheduleJobs(status: RunStatus): boolean {
  return status === "ACTIVE";
}

export function isTerminalStatus(status: RunStatus): boolean {
  return status === "FAILED_FINAL" || status === "CANCELLED" || status === "COMPLETED";
}

export function targetReached(current: PipelineStage, target: PipelineStage): boolean {
  const currentIndex = PIPELINE_STAGES.indexOf(current);
  const targetIndex = PIPELINE_STAGES.indexOf(target);
  return currentIndex >= targetIndex;
}
