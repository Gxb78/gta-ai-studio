import type { Rational } from "../../contracts/src/common.js";
import type { TimelineClip, TimelineProject } from "../../contracts/src/timeline.js";

export interface TimelineValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export const ALLOWED_TIMELINE_EFFECTS = new Set([
  "blur_background",
  "artifact_source",
  "color",
  "comparison_split",
  "crop",
  "ducking",
  "freeze",
  "mask",
  "opacity",
  "overlay_template",
  "scale",
  "speed",
  "subtitle_style",
  "subject_reframe",
  "translate",
  "volume",
  "zoom",
]);

function isPositiveRational(value: Rational): boolean {
  return Number.isInteger(value.numerator) && Number.isInteger(value.denominator) && value.numerator > 0 && value.denominator > 0;
}

function clipEnd(clip: TimelineClip): number {
  return clip.start + clip.duration;
}

export function validateTimeline(timeline: TimelineProject): readonly TimelineValidationIssue[] {
  const issues: TimelineValidationIssue[] = [];
  const add = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message });
  };

  if (timeline.width <= 0 || timeline.height <= 0 || timeline.duration <= 0) {
    add("TIMELINE_INVALID_CANVAS", "$", "Width, height and duration must be positive.");
  }
  if (!isPositiveRational(timeline.fps) || !isPositiveRational(timeline.timebase)) {
    add("TIMELINE_INVALID_RATIONAL", "$", "FPS and timebase must be positive integer rationals.");
  }

  const safe = timeline.safe_area;
  const safeValues = [safe.top, safe.right, safe.bottom, safe.left];
  if (safeValues.some((value) => value < 0 || value >= 1) || safe.top + safe.bottom >= 1 || safe.left + safe.right >= 1) {
    add("TIMELINE_INVALID_SAFE_AREA", "$.safe_area", "Safe area fractions must leave a visible rectangle.");
  }

  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  const clipsById = new Map<string, TimelineClip>();

  timeline.tracks.forEach((track, trackIndex) => {
    const trackPath = `$.tracks[${trackIndex}]`;
    if (trackIds.has(track.id)) {
      add("TIMELINE_DUPLICATE_TRACK", `${trackPath}.id`, "Track IDs must be unique.");
    }
    trackIds.add(track.id);

    track.clips.forEach((clip, clipIndex) => {
      const clipPath = `${trackPath}.clips[${clipIndex}]`;
      if (clipIds.has(clip.id)) {
        add("TIMELINE_DUPLICATE_CLIP", `${clipPath}.id`, "Clip IDs must be unique.");
      }
      clipIds.add(clip.id);
      clipsById.set(clip.id, clip);

      if (clip.track_id !== track.id) {
        add("TIMELINE_TRACK_MISMATCH", `${clipPath}.track_id`, "Clip track_id must reference its containing track.");
      }
      if (!Number.isInteger(clip.start) || !Number.isInteger(clip.duration) || clip.start < 0 || clip.duration <= 0) {
        add("TIMELINE_INVALID_CLIP_TIME", clipPath, "Clip start and duration must be non-negative integer units with positive duration.");
      }
      if (clipEnd(clip) > timeline.duration) {
        add("TIMELINE_CLIP_OUT_OF_BOUNDS", clipPath, "Clip exceeds timeline duration.");
      }
      if (!isPositiveRational(clip.speed)) {
        add("TIMELINE_INVALID_SPEED", `${clipPath}.speed`, "Clip speed must be a positive rational.");
      }
      if (clip.opacity < 0 || clip.opacity > 1 || clip.volume < 0 || clip.volume > 4) {
        add("TIMELINE_INVALID_LEVEL", clipPath, "Opacity must be 0..1 and volume must be 0..4.");
      }
      if (clip.source !== null && (clip.source.source_in < 0 || clip.source.source_duration <= 0)) {
        add("TIMELINE_INVALID_SOURCE_RANGE", `${clipPath}.source`, "Source in-point and duration are invalid.");
      }
      if (track.kind === "text" && (clip.text === null || clip.text.trim().length === 0)) {
        add("TIMELINE_TEXT_REQUIRED", `${clipPath}.text`, "Text tracks require non-empty text clips.");
      }
      clip.effects.forEach((effect, effectIndex) => {
        if (!ALLOWED_TIMELINE_EFFECTS.has(effect.type)) {
          add("TIMELINE_EFFECT_NOT_ALLOWED", `${clipPath}.effects[${effectIndex}]`, `Effect '${effect.type}' is not allowed.`);
        }
      });
    });
  });

  const transitionPairs = new Set<string>();
  timeline.transitions.forEach((transition, transitionIndex) => {
    const path = `$.transitions[${transitionIndex}]`;
    if (!clipsById.has(transition.from_clip_id) || !clipsById.has(transition.to_clip_id)) {
      add("TIMELINE_UNKNOWN_TRANSITION_CLIP", path, "Transition clips must exist.");
    }
    if (transition.duration < 0 || !Number.isInteger(transition.duration)) {
      add("TIMELINE_INVALID_TRANSITION_DURATION", `${path}.duration`, "Transition duration must be a non-negative integer.");
    }
    transitionPairs.add(`${transition.from_clip_id}:${transition.to_clip_id}`);
    transitionPairs.add(`${transition.to_clip_id}:${transition.from_clip_id}`);
  });

  timeline.tracks.filter((track) => track.exclusive).forEach((track) => {
    const ordered = [...track.clips].sort((left, right) => left.start - right.start);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous !== undefined && current !== undefined && current.start < clipEnd(previous) && !transitionPairs.has(`${previous.id}:${current.id}`)) {
        add("TIMELINE_UNDECLARED_OVERLAP", `$.tracks.${track.id}`, "Exclusive track clips overlap without a transition.");
      }
    }
  });

  return issues;
}
