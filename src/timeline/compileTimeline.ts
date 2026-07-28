import type { Clip, SourceInfo } from "../types";
import {
  GAP_EPSILON_MS,
  MAX_TRANSITION_MS,
  TRANSITION_CONTIGUITY_EPSILON_MS,
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
    // Contiguïté au sens de l'export (voir TRANSITION_CONTIGUITY_EPSILON_MS) :
    // un intervalle invisible à l'œil mais réel ferait accepter ici une
    // transition que Rust refuse ensuite.
    Math.abs(from.endMs - to.startMs) > TRANSITION_CONTIGUITY_EPSILON_MS ||
    Math.abs(to.startMs - to.sourceClip.timelineStartMs) > TRANSITION_CONTIGUITY_EPSILON_MS ||
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

/**
 * Même calcul que `transitionCapacityMs`, mais depuis deux clips COMMITTÉS
 * bruts plutôt que deux segments compilés adjacents.
 *
 * Nécessaire parce que `flattenTracks` peut fusionner la frontière entre deux
 * clips committés qui ne diffèrent, pour l'instant, en rien de ce que le plan
 * vidéo rend (voir `sourceClipFor` un peu plus haut) — c'est systématiquement
 * le cas juste après une découpe (SPLIT_AT). La frontière entre les deux
 * clips reste alors parfaitement valide pour y poser une transition ; elle
 * n'est simplement plus visible comme un couple de segments adjacents. Cette
 * fonction sert de secours quand `transitionCapacityMs` n'a personne à qui
 * s'appliquer, PAS de remplacement : dès qu'une vraie frontière de segments
 * existe, on continue de lui faire confiance en priorité (voir App.tsx), pour
 * ne jamais faire diverger l'aperçu du calcul qui produit l'export.
 */
export function rawTransitionCapacityMs(
  from: Clip,
  to: Clip,
  sources: Readonly<Record<string, SourceInfo>>,
): number {
  if (
    Math.abs(clipEndMs(from) - to.timelineStartMs) > TRANSITION_CONTIGUITY_EPSILON_MS ||
    from.videoFadeOutMs > 0 ||
    to.videoFadeInMs > 0
  ) {
    return 0;
  }
  const fromSource = sources[from.sourceId];
  const toSource = sources[to.sourceId];
  if (!fromSource || !toSource) return 0;
  const outgoingHandleMs = (fromSource.probe.durationMs - from.srcOutMs) / from.playbackRate;
  const incomingHandleMs = to.srcInMs / to.playbackRate;
  return Math.max(
    0,
    Math.min(
      MAX_TRANSITION_MS,
      clipEndMs(from) - from.timelineStartMs,
      clipEndMs(to) - to.timelineStartMs,
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

/**
 * Retrouve le clip COMMITTÉ dont un segment aplati est issu.
 *
 * `flattenTracks` fusionne délibérément, PAR PLAN, deux clips committés
 * distincts qui ne diffèrent que par un réglage étranger à ce plan (le volume
 * pour la vidéo, le cadrage pour l'audio) — voir le commentaire à côté de
 * `videoEnvelopeCanMerge`/`audioEnvelopeCanMerge`. Un segment issu d'une telle
 * fusion ne correspond donc plus forcément à UN SEUL clip committé ; c'est
 * systématiquement le cas juste après une découpe (SPLIT_AT), tant qu'aucune
 * des deux moitiés n'a été retouchée.
 *
 * Exiger qu'un seul clip couvre le segment EN ENTIER échouait alors toujours :
 * `match` valait `undefined`, le repli `?? segment` renvoyait un objet
 * synthétique dont l'id (`"<clipId>@<départMs>"`) ne correspond à AUCUN clip
 * réel. Côté App.tsx, `visibleClip` (résolu par cet id) devenait `null` et le
 * cadrage retombait à 0 — alors que l'export, lui, gardait le vrai cadrage,
 * identique sur les deux moitiés (c'est justement pour ça qu'elles avaient pu
 * fusionner). Et la frontière de la découpe disparaissait purement et
 * simplement des segments compilés, rendant impossible d'y poser une
 * transition tant que rien d'autre ne différenciait les deux moitiés.
 *
 * Il suffit qu'un clip couvre le DÉBUT du segment : les clips d'une même piste
 * ne se chevauchant jamais, il y en a au plus un, et — la fusion l'exigeant
 * déjà pour ce plan — il porte forcément les mêmes réglages que le segment
 * entier. `track`/`sourceId`/`cropX`/`playbackRate` restent vérifiés par
 * prudence ; ils sont toujours vrais par construction pour ce clip-là.
 *
 * Recherche binaire dans les clips de LA SEULE piste du segment, triés par
 * `timelineStartMs` : un balayage linéaire de tous les clips ici rendait la
 * compilation quadratique (chaque segment revisitait tout le montage), un
 * budget de 16 ms par image largement dépassé dès quelques centaines de
 * clips. Les clips d'une piste ne se chevauchant jamais, la même disjonction
 * qui justifie `findSegmentIndex` sur des segments s'applique ici à l'identique.
 */
function sourceClipFor(segment: Clip, clipsByTrack: ReadonlyMap<number, readonly Clip[]>): Clip {
  const trackClips = clipsByTrack.get(segment.track);
  if (!trackClips) return segment;
  let low = 0;
  let high = trackClips.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const clip = trackClips[middle];
    if (segment.timelineStartMs < clip.timelineStartMs) {
      high = middle - 1;
    } else if (segment.timelineStartMs >= clipEndMs(clip)) {
      low = middle + 1;
    } else {
      return clip.sourceId === segment.sourceId &&
        clip.cropX === segment.cropX &&
        clip.playbackRate === segment.playbackRate
        ? clip
        : segment;
    }
  }
  return segment;
}

function compilePlan(
  plan: Clip[],
  clipsByTrack: ReadonlyMap<number, readonly Clip[]>,
  durationMs: number,
  sources: Readonly<Record<string, SourceInfo>>,
  withTransitions: boolean,
): CompiledPlan {
  const segments = plan.map((clip) => {
      const sourceClip = sourceClipFor(clip, clipsByTrack);
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
        Math.abs(from.endMs - to.startMs) > TRANSITION_CONTIGUITY_EPSILON_MS ||
        Math.abs(to.startMs - to.sourceClip.timelineStartMs) > TRANSITION_CONTIGUITY_EPSILON_MS
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

/**
 * Reprend une transition vidéo dans le plan sonore seulement si les deux plans
 * décrivent exactement la même coupe. Une surcouche muette peut ainsi fondre à
 * l'image pendant que le son de la piste inférieure reste parfaitement continu.
 */
function compileAudioTransitions(
  audioSegments: readonly CompiledSegment[],
  videoPlan: CompiledPlan,
  sources: Readonly<Record<string, SourceInfo>>,
): CompiledTransition[] {
  const transitions: CompiledTransition[] = [];
  for (const videoTransition of videoPlan.transitions) {
    const videoFrom = videoPlan.segments[videoTransition.fromIndex];
    const videoTo = videoPlan.segments[videoTransition.toIndex];
    const fromIndex = audioSegments.findIndex(
      (segment) =>
        segment.sourceClipId === videoFrom.sourceClipId &&
        Math.abs(segment.endMs - videoTransition.boundaryMs) <= TRANSITION_CONTIGUITY_EPSILON_MS,
    );
    const toIndex = fromIndex + 1;
    const audioFrom = audioSegments[fromIndex];
    const audioTo = audioSegments[toIndex];
    if (
      !audioFrom ||
      !audioTo ||
      audioTo.sourceClipId !== videoTo.sourceClipId ||
      Math.abs(audioTo.startMs - videoTransition.boundaryMs) > TRANSITION_CONTIGUITY_EPSILON_MS ||
      audioFrom.endMs - audioFrom.startMs + TRANSITION_CONTIGUITY_EPSILON_MS <
        videoTransition.durationMs ||
      audioTo.endMs - audioTo.startMs + TRANSITION_CONTIGUITY_EPSILON_MS <
        videoTransition.durationMs ||
      audioFrom.sourceClip.audioFadeOutMs > 0 ||
      audioTo.sourceClip.audioFadeInMs > 0 ||
      !sources[audioFrom.clip.sourceId]?.probe.hasAudio ||
      !sources[audioTo.clip.sourceId]?.probe.hasAudio
    ) {
      continue;
    }
    transitions.push({
      ...videoTransition,
      fromIndex,
      toIndex,
    });
  }
  return transitions;
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
  // Un `push` par clip : le spread `[...current, clip]` précédent recopiait
  // tout le tableau à chaque insertion, quadratique dès qu'une piste porte
  // beaucoup de clips.
  const clipsByTrack = new Map<number, Clip[]>();
  for (const clip of clips) {
    let bucket = clipsByTrack.get(clip.track);
    if (!bucket) {
      bucket = [];
      clipsByTrack.set(clip.track, bucket);
    }
    bucket.push(clip);
  }
  for (const bucket of clipsByTrack.values()) {
    bucket.sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  }

  const video = compilePlan(videoClips, clipsByTrack, durationMs, sources, true);
  const audio = compilePlan(audioClips, clipsByTrack, durationMs, sources, false);
  audio.transitions = compileAudioTransitions(audio.segments, video, sources);

  return {
    video,
    audio,
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
