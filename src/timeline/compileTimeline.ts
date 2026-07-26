import type { Clip } from "../types";
import {
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
  durationMs: number;
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

function compilePlan(plan: Clip[], clips: readonly Clip[], durationMs: number): CompiledPlan {
  return {
    segments: plan.map((clip) => {
      const sourceClip = sourceClipFor(clip, clips);
      return {
        clip,
        startMs: clip.timelineStartMs,
        endMs: clipEndMs(clip),
        sourceClipId: sourceClip.id,
        sourceClip,
      };
    }),
    durationMs,
  };
}

export function compileTimeline(
  clips: readonly Clip[],
  hiddenTracks: ReadonlySet<number>,
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
    video: compilePlan(videoClips, clips, durationMs),
    audio: compilePlan(audioClips, clips, durationMs),
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
