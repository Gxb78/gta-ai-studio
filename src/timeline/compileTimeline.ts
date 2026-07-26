import type { Clip, SourceInfo } from "../types";
import {
  GAP_EPSILON_MS,
  MAX_TRANSITION_MS,
  clipEndMs,
  resolveAudioPlan,
  resolveVideoPlan,
  timelineGaps,
  trackCount as countTracks,
} from "../types";

export interface CompiledSegment {
  clip: Clip;
  startMs: number;
  endMs: number;
  /** Identifiant du clip committé dont ce segment aplati provient. */
  sourceClipId: string;
  /** Clip committé portant l'enveloppe et les réglages non découpés. */
  sourceClip: Clip;
}

export interface CompiledPlan {
  segments: CompiledSegment[];
  transitions: CompiledTransition[];
  durationMs: number;
}

export interface CompiledTransition {
  fromIndex: number;
  toIndex: number;
  boundaryMs: number;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export function transitionCapacityMs(
  segments: readonly CompiledSegment[],
  toIndex: number,
  sources: Readonly<Record<string, SourceInfo>>,
): number {
  if (toIndex <= 0 || toIndex >= segments.length) return 0;
  const from = segments[toIndex - 1];
  const to = segments[toIndex];
  if (
    Math.abs(from.endMs - to.startMs) > GAP_EPSILON_MS ||
    Math.abs(to.startMs - to.sourceClip.timelineStartMs) > GAP_EPSILON_MS ||
    from.sourceClip.videoFadeOutMs > 0 ||
    to.sourceClip.videoFadeInMs > 0
  ) {
    return 0;
  }
  const fromSource = sources[from.clip.sourceId];
  const toSource = sources[to.clip.sourceId];
  if (!fromSource || !toSource) return 0;
  const outgoingHandleMs =
    (fromSource.probe.durationMs - from.clip.srcOutMs) / from.clip.playbackRate;
  const incomingHandleMs = to.clip.srcInMs / to.clip.playbackRate;
  return Math.max(
    0,
    Math.min(
      MAX_TRANSITION_MS,
      from.endMs - from.startMs,
      to.endMs - to.startMs,
      outgoingHandleMs * 2,
      incomingHandleMs * 2,
    ),
  );
}

export interface CompiledTimeline {
  video: CompiledPlan;
  audio: CompiledPlan;
  gaps: Array<{ startMs: number; endMs: number }>;
  clipsByTrack: ReadonlyMap<number, readonly Clip[]>;
  trackCount: number;
  sourceCount: number;
}

function sourceClipFor(segment: Clip, clips: readonly Clip[]): Clip {
  const match = clips.find(
    (clip) =>
      clip.track === segment.track &&
      clip.sourceId === segment.sourceId &&
      clip.cropX === segment.cropX &&
      clip.playbackRate === segment.playbackRate &&
      clip.timelineStartMs <= segment.timelineStartMs &&
      clipEndMs(clip) >= clipEndMs(segment),
  );
  return match ?? segment;
}

function compilePlan(
  plan: Clip[],
  clips: readonly Clip[],
  durationMs: number,
  sources: Readonly<Record<string, SourceInfo>>,
  withTransitions: boolean,
): CompiledPlan {
  const segments = plan.map((clip) => {
      const sourceClip = sourceClipFor(clip, clips);
      return {
        clip,
        startMs: clip.timelineStartMs,
        endMs: clipEndMs(clip),
        sourceClipId: sourceClip.id,
        sourceClip,
      };
    });
  const transitions: CompiledTransition[] = [];
  if (withTransitions) {
    for (let toIndex = 1; toIndex < segments.length; toIndex++) {
      const fromIndex = toIndex - 1;
      const from = segments[fromIndex];
      const to = segments[toIndex];
      const requested = to.sourceClip.transitionInMs;
      if (
        requested <= 0 ||
        Math.abs(from.endMs - to.startMs) > GAP_EPSILON_MS ||
        Math.abs(to.startMs - to.sourceClip.timelineStartMs) > GAP_EPSILON_MS
      ) {
        continue;
      }
      const durationMs = Math.max(
        0,
        Math.min(requested, transitionCapacityMs(segments, toIndex, sources)),
      );
      if (durationMs <= GAP_EPSILON_MS) continue;
      const boundaryMs = to.startMs;
      transitions.push({
        fromIndex,
        toIndex,
        boundaryMs,
        startMs: boundaryMs - durationMs / 2,
        endMs: boundaryMs + durationMs / 2,
        durationMs,
      });
    }
  }
  return {
    segments,
    transitions,
    durationMs,
  };
}

export function compileTimeline(
  clips: readonly Clip[],
  hiddenTracks: ReadonlySet<number>,
  sources: Readonly<Record<string, SourceInfo>> = {},
): CompiledTimeline {
  const mutableClips = [...clips];
  const videoClips = resolveVideoPlan(mutableClips, hiddenTracks);
  const audioClips = resolveAudioPlan(mutableClips, hiddenTracks);
  const durationMs = videoClips.reduce((max, clip) => Math.max(max, clipEndMs(clip)), 0);
  const clipsByTrack = new Map<number, readonly Clip[]>();

  for (const clip of clips) {
    const current = clipsByTrack.get(clip.track) ?? [];
    clipsByTrack.set(clip.track, [...current, clip]);
  }
  for (const [track, trackClips] of clipsByTrack) {
    clipsByTrack.set(
      track,
      [...trackClips].sort((a, b) => a.timelineStartMs - b.timelineStartMs),
    );
  }

  return {
    video: compilePlan(videoClips, clips, durationMs, sources, true),
    audio: compilePlan(audioClips, clips, durationMs, sources, false),
    gaps: timelineGaps(videoClips),
    clipsByTrack,
    trackCount: countTracks(mutableClips),
    sourceCount: new Set(clips.map((clip) => clip.sourceId)).size,
  };
}

/**
 * Segment couvrant `timelineMs`. Les segments sont triés, disjoints et leur
 * borne de fin est exclusive.
 */
export function findSegmentIndex(
  segments: readonly CompiledSegment[],
  timelineMs: number,
): number {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const segment = segments[middle];
    if (timelineMs < segment.startMs) {
      high = middle - 1;
    } else if (timelineMs >= segment.endMs) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return -1;
}

/** Premier segment commençant à `timelineMs` ou après. */
export function findNextSegmentIndex(
  segments: readonly CompiledSegment[],
  timelineMs: number,
): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].startMs < timelineMs) low = middle + 1;
    else high = middle;
  }
  return low < segments.length ? low : -1;
}
