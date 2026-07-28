// Moteur de lecture EDL : les vidéos (proxys) sont pilotées côté client.
// Aucun serveur, aucun réencodage.
//
// DEUX BALISES VIDÉO EN ALTERNANCE. Changer le `src` d'une balise coûte un
// chargement, un décodage et un seek — plusieurs centaines de millisecondes de
// noir. Inacceptable à chaque jonction de clips, et rédhibitoire dès qu'un
// projet mélange plusieurs rushs. Donc : pendant qu'une balise joue, l'autre
// charge et pré-positionne déjà le clip suivant ; à la jonction on échange, et
// le saut devient invisible. C'est ce mécanisme qui portera plus tard les
// fondus enchaînés (les deux balises visibles en même temps).
//
// Entre deux clips disjoints, on traverse le trou à l'horloge, écran noir.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceInfo } from "../types";
import { audioFadeGainAt, timelineTimeToSourceTime } from "../types";
import { mediaUrl } from "../ipc";
import type {
  CompiledSegment,
  CompiledTimeline,
  CompiledTransition,
} from "../timeline/compileTimeline";
import { findNextSegmentIndex, findSegmentIndex } from "../timeline/compileTimeline";

/** Marge de détection de fin de clip (ms) pour anticiper le saut. */
const BOUNDARY_EPSILON_MS = 26;

/** Écart au-delà duquel l'aperçu est re-calé sur le playhead après un montage. */
const RESYNC_TOLERANCE_MS = 45;
/** Tolérance de seek pour considérer la première image du clip comme prête. */
const PRIME_TOLERANCE_SEC = 0.06;
/** Au-delà, on préfère un seek classique à un gel durable de la dernière image. */
const MAX_CUT_HOLD_MS = 500;

export function mediaIsPrimed(
  readyState: number,
  seeking: boolean,
  currentTimeSec: number,
  targetTimeSec: number,
): boolean {
  return (
    // HAVE_CURRENT_DATA = 2. Garder la valeur évite de dépendre du DOM dans les tests Node.
    readyState >= 2 &&
    !seeking &&
    Math.abs(currentTimeSec - targetTimeSec) <= PRIME_TOLERANCE_SEC
  );
}

export type MediaPrimeDecision = "swap" | "hold" | "fallback";

export function decideMediaPrime(ready: boolean, elapsedMs: number): MediaPrimeDecision {
  if (ready) return "swap";
  return elapsedMs < MAX_CUT_HOLD_MS ? "hold" : "fallback";
}

export function audioTransitionGains(progress: number): [number, number] {
  const mix = Math.max(0, Math.min(1, progress));
  return [1 - mix, mix];
}

export interface PlaybackClock {
  getPlayheadMs: () => number;
  subscribe: (listener: (playheadMs: number) => void) => () => void;
}

export interface PlaybackClockController {
  clock: PlaybackClock;
  publish: (playheadMs: number) => void;
}

export function createPlaybackClock(initialPlayheadMs = 0): PlaybackClockController {
  let playheadMs = initialPlayheadMs;
  const listeners = new Set<(nextPlayheadMs: number) => void>();
  return {
    clock: {
      getPlayheadMs: () => playheadMs,
      subscribe: (listener) => {
        listeners.add(listener);
        listener(playheadMs);
        return () => listeners.delete(listener);
      },
    },
    publish: (nextPlayheadMs) => {
      playheadMs = nextPlayheadMs;
      for (const listener of listeners) listener(nextPlayheadMs);
    },
  };
}

export interface PlaybackApi {
  playing: boolean;
  durationMs: number;
  /** Vrai quand le playhead est dans un trou : l'aperçu affiche du noir. */
  inGap: boolean;
  /** Balise actuellement visible. L'autre précharge le clip suivant. */
  activeIsA: boolean;
  activeVideoClipId: string | null;
  /** Clip entrant pendant un fondu enchaîné, sans mise à jour React par image. */
  transitionVideoClipId: string | null;
  clock: PlaybackClock;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (timelineMs: number) => void;
  /** Aperçu image par image pendant un trim, sur le rush indiqué. */
  showFrame: (sourceId: string, srcMs: number) => void;
}

/** Positionne une balise, en attendant ses métadonnées si elle charge encore. */
const pendingSeeks = new WeakMap<HTMLMediaElement, () => void>();

function seekWhenReady(video: HTMLMediaElement, timeSec: number): void {
  const previous = pendingSeeks.get(video);
  if (previous) previous();
  if (video.readyState >= 1) {
    video.currentTime = timeSec;
    return;
  }
  const onReady = () => {
    cleanup();
    video.currentTime = timeSec;
  };
  const cleanup = () => {
    video.removeEventListener("loadedmetadata", onReady);
    pendingSeeks.delete(video);
  };
  pendingSeeks.set(video, cleanup);
  video.addEventListener("loadedmetadata", onReady);
}

/** Charge le rush voulu si besoin, puis positionne la balise. */
function assign(media: HTMLMediaElement, source: SourceInfo, srcMs: number): void {
  if (media.dataset.sourceId !== source.id) {
    media.dataset.sourceId = source.id;
    media.src = mediaUrl(source.proxyPath);
    media.load();
  }
  seekWhenReady(media, Math.max(0, srcMs) / 1000);
}

interface MediaPrime {
  clipId: string;
  targetTimeSec: number;
  startedAt: number;
  ready: boolean;
  cancel: () => void;
}

function startMediaPrime(
  media: HTMLMediaElement,
  clipId: string,
  source: SourceInfo,
  srcMs: number,
): MediaPrime {
  const targetTimeSec = Math.max(0, srcMs) / 1000;
  const prime: MediaPrime = {
    clipId,
    targetTimeSec,
    startedAt: performance.now(),
    ready: false,
    cancel: () => undefined,
  };
  const check = () => {
    prime.ready = mediaIsPrimed(
      media.readyState,
      media.seeking,
      media.currentTime,
      targetTimeSec,
    );
    if (prime.ready) prime.cancel();
  };
  const events: Array<keyof HTMLMediaElementEventMap> = ["loadeddata", "seeked", "canplay"];
  const cancel = () => {
    for (const event of events) media.removeEventListener(event, check);
  };
  prime.cancel = cancel;
  for (const event of events) media.addEventListener(event, check);
  assign(media, source, srcMs);
  check();
  return prime;
}

function measurePresentedCut(video: HTMLVideoElement | null, startedAt: number): void {
  if (!video || !("requestVideoFrameCallback" in video)) return;
  video.requestVideoFrameCallback((now) => {
    performance.measure("gta-cut-first-frame", { start: startedAt, end: now });
  });
}

function setVideoMix(
  outgoing: HTMLVideoElement,
  incoming: HTMLVideoElement,
  progress: number,
): void {
  const mix = Math.max(0, Math.min(1, progress));
  outgoing.style.opacity = String(1 - mix);
  incoming.style.opacity = String(mix);
}

function releaseVideoMix(outgoing: HTMLVideoElement, incoming: HTMLVideoElement): void {
  requestAnimationFrame(() => {
    outgoing.style.removeProperty("opacity");
    incoming.style.removeProperty("opacity");
  });
}

/**
 * Dérive du son par rapport à l'image, en trois zones.
 *
 * En dessous du seuil bas on ne touche à rien : réassigner `currentTime` en
 * permanence s'entend plus que la dérive elle-même. Entre les deux seuils, on
 * rattrape en douceur en jouant très légèrement plus vite ou moins vite — un
 * écart de 3 % est inaudible. Au-delà du seuil haut, on saute franchement.
 */
const AUDIO_DRIFT_OK_MS = 40;
const AUDIO_DRIFT_HARD_MS = 80;
/** Écart de vitesse appliqué pour rattraper en douceur. */
const AUDIO_NUDGE = 0.03;

export function usePlayback(
  videoA: React.RefObject<HTMLVideoElement | null>,
  videoB: React.RefObject<HTMLVideoElement | null>,
  audioA: React.RefObject<HTMLAudioElement | null>,
  audioB: React.RefObject<HTMLAudioElement | null>,
  compiledTimeline: CompiledTimeline,
  sources: Record<string, SourceInfo>,
  previewVolume: number,
): PlaybackApi {
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const [inGap, setInGap] = useState(false);
  const [activeIsA, setActiveIsA] = useState(true);
  const [activeVideoClipId, setActiveVideoClipId] = useState<string | null>(null);
  const [transitionVideoClipId, setTransitionVideoClipId] = useState<string | null>(null);

  const activeIsARef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const playheadRef = useRef(0);
  const clockControllerRef = useRef<PlaybackClockController | null>(null);
  if (!clockControllerRef.current) clockControllerRef.current = createPlaybackClock();
  /** Première image réellement décodée sur la balise vidéo inactive. */
  const videoPrimeRef = useRef<MediaPrime | null>(null);
  const pendingCutRef = useRef<{
    fromIndex: number;
    toIndex: number;
    boundaryMs: number;
    startedAt: number;
  } | null>(null);
  const activeTransitionRef = useRef<{
    transition: CompiledTransition;
    outgoing: HTMLVideoElement;
    incoming: HTMLVideoElement;
  } | null>(null);
  const transitionWaitRef = useRef<{
    transition: CompiledTransition;
    startedAt: number;
  } | null>(null);
  const skippedTransitionsRef = useRef(new Set<string>());

  const compiledRef = useRef(compiledTimeline);
  compiledRef.current = compiledTimeline;
  const currentVideoIndexRef = useRef(-1);
  const currentAudioIndexRef = useRef(-1);
  /** Balise sonore active, et segment réellement prêt sur l'autre. */
  const audioActiveIsARef = useRef(true);
  const audioPrimeRef = useRef<MediaPrime | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const previewVolumeRef = useRef(previewVolume);
  previewVolumeRef.current = previewVolume;

  const durationMs = compiledTimeline.video.durationMs;

  const getActive = useCallback(
    () => (activeIsARef.current ? videoA.current : videoB.current),
    [videoA, videoB],
  );
  const getIdle = useCallback(
    () => (activeIsARef.current ? videoB.current : videoA.current),
    [videoA, videoB],
  );

  const publishPlayhead = useCallback((ms: number) => {
    playheadRef.current = ms;
    clockControllerRef.current?.publish(ms);
  }, []);

  useEffect(() => {
    const audioSegments = compiledTimeline.audio.segments;
    for (const element of [audioA.current, audioB.current]) {
      if (!element) continue;
      const segment = audioSegments.find(
        (segment) => segment.clip.id === element.dataset.clipId,
      );
      const envelope = segment
        ? audioFadeGainAt(segment.sourceClip, clockControllerRef.current!.clock.getPlayheadMs())
        : 1;
      element.volume = Math.min(1, previewVolume * (segment?.clip.volume ?? 1) * envelope);
    }
  }, [audioA, audioB, compiledTimeline, previewVolume]);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /**
   * Efface toute coupe ou tout fondu en attente/en cours, et rend aux balises
   * leur opacité normale.
   *
   * Partagé par `seek`, `pause` et le recalage après montage : ces trois refs
   * portent un chrono (`startedAt`) et des index de segment qui ne veulent
   * plus rien dire dès qu'on quitte le déroulé qui les a armés — les laisser
   * traîner fait repartir la boucle sur un temps d'attente déjà écoulé ou des
   * index qu'un montage a décalés.
   */
  const clearInFlightTransitions = useCallback(() => {
    pendingCutRef.current = null;
    transitionWaitRef.current = null;
    const activeTransition = activeTransitionRef.current;
    if (activeTransition) {
      activeTransition.outgoing.pause();
      activeTransition.incoming.pause();
      activeTransition.outgoing.style.removeProperty("opacity");
      activeTransition.incoming.style.removeProperty("opacity");
    }
    activeTransitionRef.current = null;
    setTransitionVideoClipId(null);
  }, []);

  /** Prépare la balise inactive sur le clip qui suit, sans la jouer. */
  const ensurePrimed = useCallback(
    (upcoming: CompiledSegment | undefined) => {
      if (!upcoming) {
        videoPrimeRef.current?.cancel();
        videoPrimeRef.current = null;
        return;
      }
      if (videoPrimeRef.current?.clipId === upcoming.clip.id) return;
      const idle = getIdle();
      const source = sourcesRef.current[upcoming.clip.sourceId];
      if (!idle || !source) return;
      videoPrimeRef.current?.cancel();
      idle.pause();
      idle.playbackRate = upcoming.clip.playbackRate;
      const upcomingIndex = compiledRef.current.video.segments.indexOf(upcoming);
      const transition = compiledRef.current.video.transitions.find(
        (candidate) => candidate.toIndex === upcomingIndex,
      );
      const transitionKey = transition
        ? `${transition.fromIndex}:${transition.toIndex}:${transition.boundaryMs}`
        : "";
      const targetTimelineMs =
        transition && !skippedTransitionsRef.current.has(transitionKey)
          ? transition.startMs
          : upcoming.startMs;
      videoPrimeRef.current = startMediaPrime(
        idle,
        upcoming.clip.id,
        source,
        timelineTimeToSourceTime(upcoming.clip, targetTimelineMs),
      );
    },
    [getIdle],
  );

  /** Place l'aperçu sur un temps timeline. Renvoie le clip trouvé, ou null (trou). */
  const applyPosition = useCallback(
    (timelineMs: number) => {
      const segments = compiledRef.current.video.segments;
      const transition = compiledRef.current.video.transitions.find(
        (candidate) => timelineMs >= candidate.startMs && timelineMs < candidate.endMs,
      );
      if (transition) {
        const from = segments[transition.fromIndex];
        const to = segments[transition.toIndex];
        const active = getActive();
        const idle = getIdle();
        const fromSource = sourcesRef.current[from.clip.sourceId];
        const toSource = sourcesRef.current[to.clip.sourceId];
        if (active && idle && fromSource && toSource) {
          currentVideoIndexRef.current = transition.fromIndex;
          active.playbackRate = from.clip.playbackRate;
          assign(active, fromSource, timelineTimeToSourceTime(from.clip, timelineMs));
          videoPrimeRef.current?.cancel();
          idle.pause();
          idle.playbackRate = to.clip.playbackRate;
          videoPrimeRef.current = startMediaPrime(
            idle,
            to.clip.id,
            toSource,
            timelineTimeToSourceTime(to.clip, timelineMs),
          );
          setVideoMix(
            active,
            idle,
            (timelineMs - transition.startMs) / transition.durationMs,
          );
          setTransitionVideoClipId(to.sourceClipId);
          setInGap(false);
          setActiveVideoClipId(from.sourceClipId);
          // Un seek qui atterrit en plein fondu doit armer l'attente de la
          // boucle, sinon celle-ci ne reconnaît jamais la transition en cours
          // (activeTransitionRef reste vide) et retombe sur le calcul d'index
          // générique — avec la mauvaise balise pour lire le temps source.
          transitionWaitRef.current = { transition, startedAt: performance.now() };
          return transition.fromIndex;
        }
      }
      const index = findSegmentIndex(segments, timelineMs);
      currentVideoIndexRef.current = index;
      const active = getActive();
      if (index !== -1) {
        const segment = segments[index];
        const clip = segment.clip;
        const source = sourcesRef.current[clip.sourceId];
        if (active && source) {
          active.playbackRate = clip.playbackRate;
          assign(active, source, timelineTimeToSourceTime(clip, timelineMs));
        }
        setInGap(false);
        setActiveVideoClipId(segment.sourceClipId);
        ensurePrimed(segments[index + 1]);
      } else {
        active?.pause();
        setInGap(true);
        setActiveVideoClipId(null);
        const upcoming = findNextSegmentIndex(segments, timelineMs);
        ensurePrimed(upcoming === -1 ? undefined : segments[upcoming]);
      }
      return index;
    },
    [ensurePrimed, getActive],
  );

  /**
   * Cale le son sur le playhead, indépendamment de ce qui est à l'image.
   *
   * L'image reste maître du temps ; le son suit et se recale s'il dérive. C'est
   * ce découplage qui permet à la piste principale de continuer à s'entendre
   * pendant qu'une surcouche muette occupe l'écran.
   */
  const syncAudio = useCallback(
    (timelineMs: number, shouldPlay: boolean, force = false) => {
      const elements = [audioA.current, audioB.current];
      const audioPlan = compiledRef.current.audio;
      const segments = audioPlan.segments;
      const transition = audioPlan.transitions.find(
        (candidate) =>
          timelineMs >= candidate.startMs && timelineMs < candidate.endMs,
      );
      if (transition) {
        const from = segments[transition.fromIndex];
        const to = segments[transition.toIndex];
        const fromSource = from ? sourcesRef.current[from.clip.sourceId] : undefined;
        const toSource = to ? sourcesRef.current[to.clip.sourceId] : undefined;
        const first = audioA.current;
        const second = audioB.current;
        if (from && to && fromSource && toSource && first && second) {
          const outgoing = second.dataset.clipId === from.clip.id ? second : first;
          const incoming = outgoing === first ? second : first;
          audioActiveIsARef.current = outgoing === first;
          currentAudioIndexRef.current =
            timelineMs < transition.boundaryMs ? transition.fromIndex : transition.toIndex;
          const [outgoingGain, incomingGain] = audioTransitionGains(
            (timelineMs - transition.startMs) / transition.durationMs,
          );
          const syncElement = (
            element: HTMLAudioElement,
            segment: CompiledSegment,
            source: SourceInfo,
            mixGain: number,
          ) => {
            const targetMs = timelineTimeToSourceTime(segment.clip, timelineMs);
            const baseRate = segment.clip.playbackRate;
            element.volume = Math.min(
              1,
              previewVolumeRef.current *
                segment.clip.volume *
                audioFadeGainAt(segment.sourceClip, timelineMs) *
                mixGain,
            );
            if (element.dataset.clipId !== segment.clip.id || force) {
              element.dataset.clipId = segment.clip.id;
              element.playbackRate = baseRate;
              assign(element, source, targetMs);
            } else {
              const driftMs = element.currentTime * 1000 - targetMs;
              if (Math.abs(driftMs) > AUDIO_DRIFT_HARD_MS) {
                element.playbackRate = baseRate;
                seekWhenReady(element, targetMs / 1000);
              } else if (Math.abs(driftMs) > AUDIO_DRIFT_OK_MS) {
                element.playbackRate =
                  baseRate * (driftMs < 0 ? 1 + AUDIO_NUDGE : 1 - AUDIO_NUDGE);
              } else if (element.playbackRate !== baseRate) {
                element.playbackRate = baseRate;
              }
            }
            if (shouldPlay && element.paused) void element.play().catch(() => undefined);
            if (!shouldPlay && !element.paused) element.pause();
          };
          syncElement(outgoing, from, fromSource, outgoingGain);
          syncElement(incoming, to, toSource, incomingGain);
          return;
        }
      }
      let index = currentAudioIndexRef.current;
      const current = segments[index];
      if (!current || timelineMs < current.startMs || timelineMs >= current.endMs) {
        index = findSegmentIndex(segments, timelineMs);
        currentAudioIndexRef.current = index;
      }

      if (index === -1) {
        for (const element of elements) element?.pause();
        audioPrimeRef.current?.cancel();
        audioPrimeRef.current = null;
        return;
      }

      const segment = segments[index];
      const clip = segment.clip;
      const source = sourcesRef.current[clip.sourceId];
      if (!source) return;

      // Changement de segment : on bascule sur la balise déjà préchargée.
      const currentId = audioActiveIsARef.current ? audioA.current : audioB.current;
      if (currentId && currentId.dataset.clipId !== clip.id) {
        const audioPrime = audioPrimeRef.current?.clipId === clip.id
          ? audioPrimeRef.current
          : null;
        const decision = decideMediaPrime(
          audioPrime?.ready ?? false,
          audioPrime ? performance.now() - audioPrime.startedAt : MAX_CUT_HOLD_MS,
        );
        if (decision === "swap" && audioPrime) {
          audioActiveIsARef.current = !audioActiveIsARef.current;
          performance.measure("gta-audio-prime-wait", {
            start: audioPrime.startedAt,
            end: performance.now(),
          });
          audioPrime.cancel();
          audioPrimeRef.current = null;
        } else if (decision === "hold" && audioPrime) {
          currentId.pause();
          return;
        } else if (audioPrime) {
          console.warn(
            `[cut audio] Préchargement incomplet après ${MAX_CUT_HOLD_MS} ms, seek de secours.`,
          );
          audioPrime.cancel();
          audioPrimeRef.current = null;
        }
      }

      const active = audioActiveIsARef.current ? audioA.current : audioB.current;
      const idle = audioActiveIsARef.current ? audioB.current : audioA.current;
      if (!active) return;

      const targetMs = timelineTimeToSourceTime(clip, timelineMs);
      // La vitesse du son suit celle du clip ; le rattrapage de dérive vient en plus.
      const baseRate = clip.playbackRate;
      active.volume = Math.min(
        1,
        previewVolumeRef.current * clip.volume * audioFadeGainAt(segment.sourceClip, timelineMs),
      );
      if (active.dataset.clipId !== clip.id || force) {
        // Changement de segment, ou recalage forcé après un seek ou une pause :
        // on repositionne sans état d'âme, il n'y a rien à préserver.
        active.dataset.clipId = clip.id;
        active.playbackRate = baseRate;
        assign(active, source, targetMs);
      } else {
        const driftMs = active.currentTime * 1000 - targetMs;
        const drift = Math.abs(driftMs);
        if (drift > AUDIO_DRIFT_HARD_MS) {
          active.playbackRate = baseRate;
          seekWhenReady(active, targetMs / 1000);
        } else if (drift > AUDIO_DRIFT_OK_MS) {
          // En retard on accélère, en avance on ralentit, très légèrement.
          active.playbackRate = baseRate * (driftMs < 0 ? 1 + AUDIO_NUDGE : 1 - AUDIO_NUDGE);
        } else if (active.playbackRate !== baseRate) {
          active.playbackRate = baseRate;
        }
      }

      if (shouldPlay && active.paused) void active.play().catch(() => undefined);
      if (!shouldPlay && !active.paused) active.pause();
      idle?.pause();

      // Préchargement du segment sonore suivant.
      const upcoming = segments[index + 1];
      if (idle && upcoming && audioPrimeRef.current?.clipId !== upcoming.clip.id) {
        const nextSource = sourcesRef.current[upcoming.clip.sourceId];
        if (nextSource) {
          const upcomingTransition = audioPlan.transitions.find(
            (candidate) => candidate.fromIndex === index && candidate.toIndex === index + 1,
          );
          const primeTimelineMs = upcomingTransition?.startMs ?? upcoming.startMs;
          audioPrimeRef.current?.cancel();
          idle.dataset.clipId = upcoming.clip.id;
          idle.playbackRate = upcoming.clip.playbackRate;
          idle.volume = Math.min(
            1,
            previewVolumeRef.current *
              upcoming.clip.volume *
              audioFadeGainAt(upcoming.sourceClip, upcoming.startMs),
          );
          audioPrimeRef.current = startMediaPrime(
            idle,
            upcoming.clip.id,
            nextSource,
            timelineTimeToSourceTime(upcoming.clip, primeTimelineMs),
          );
        }
      }
    },
    [audioA, audioB],
  );

  const seek = useCallback(
    (timelineMs: number) => {
      clearInFlightTransitions();
      videoA.current?.style.removeProperty("opacity");
      videoB.current?.style.removeProperty("opacity");
      skippedTransitionsRef.current.clear();
      videoPrimeRef.current?.cancel();
      videoPrimeRef.current = null;
      const clamped = Math.max(0, Math.min(timelineMs, compiledRef.current.video.durationMs));
      applyPosition(clamped);
      // Après un seek, le son est recalé d'autorité : aucune dérive à rattraper.
      syncAudio(clamped, false, true);
      publishPlayhead(clamped);
    },
    [applyPosition, clearInFlightTransitions, publishPlayhead, syncAudio],
  );

  const pause = useCallback(() => {
    // Un fondu armé ou en cours a un chrono et des index qui n'ont de sens que
    // pendant qu'on joue : les laisser en l'état pendant la pause puis
    // reprendre dessus tel quel désynchronise le fondu (le temps d'attente
    // écoulé continue de courir hors lecture, et lecture/pause seule ne
    // touche jamais aux balises l'une par rapport à l'autre). On repositionne
    // donc proprement sur le même instant, comme le ferait un seek immobile.
    const hadInFlightTransition =
      pendingCutRef.current !== null ||
      transitionWaitRef.current !== null ||
      activeTransitionRef.current !== null;
    videoA.current?.pause();
    videoB.current?.pause();
    audioA.current?.pause();
    audioB.current?.pause();
    stopLoop();
    playingRef.current = false;
    setPlaying(false);
    if (hadInFlightTransition) {
      seek(playheadRef.current);
    } else {
      pendingCutRef.current = null;
    }
  }, [audioA, audioB, seek, stopLoop, videoA, videoB]);

  /** Bascule sur la balise préchargée : c'est l'opération qui rend la jonction invisible. */
  const swap = useCallback(() => {
    activeIsARef.current = !activeIsARef.current;
    setActiveIsA(activeIsARef.current);
  }, []);

  const loop = useCallback(() => {
    const segments = compiledRef.current.video.segments;
    if (segments.length === 0) return;

    const now = performance.now();
    const elapsed = Math.max(0, now - lastTickRef.current);
    lastTickRef.current = now;

    const total = compiledRef.current.video.durationMs;
    const pendingCut = pendingCutRef.current;
    if (pendingCut) {
      const nextSegment = segments[pendingCut.toIndex];
      const prime = videoPrimeRef.current;
      const primeReady = Boolean(
        nextSegment && prime?.clipId === nextSegment.clip.id && prime.ready,
      );
      const decision = decideMediaPrime(primeReady, now - pendingCut.startedAt);
      if (decision === "swap" && nextSegment && prime) {
        const outgoing = getActive();
        const incoming = getIdle();
        pendingCutRef.current = null;
        currentVideoIndexRef.current = pendingCut.toIndex;
        publishPlayhead(pendingCut.boundaryMs);
        swap();
        outgoing?.pause();
        prime.cancel();
        videoPrimeRef.current = null;
        void incoming?.play().catch(() => undefined);
        measurePresentedCut(incoming, pendingCut.startedAt);
        performance.measure("gta-cut-prime-wait", {
          start: pendingCut.startedAt,
          end: now,
        });
        ensurePrimed(segments[pendingCut.toIndex + 1]);
        setInGap(false);
        setActiveVideoClipId(nextSegment.sourceClipId);
        syncAudio(pendingCut.boundaryMs, true);
      } else if (decision === "hold") {
        syncAudio(Math.max(0, pendingCut.boundaryMs - 0.001), false);
        rafRef.current = requestAnimationFrame(loop);
        return;
      } else {
        pendingCutRef.current = null;
        console.warn(
          `[cut] Préchargement incomplet après ${MAX_CUT_HOLD_MS} ms, seek de secours.`,
        );
        const outgoing = getActive();
        const fallback = getIdle();
        currentVideoIndexRef.current = pendingCut.toIndex;
        publishPlayhead(pendingCut.boundaryMs);
        swap();
        outgoing?.pause();
        prime?.cancel();
        videoPrimeRef.current = null;
        void fallback?.play().catch(() => undefined);
        measurePresentedCut(fallback, pendingCut.startedAt);
        ensurePrimed(segments[pendingCut.toIndex + 1]);
        setInGap(false);
        setActiveVideoClipId(nextSegment?.sourceClipId ?? null);
        syncAudio(pendingCut.boundaryMs, true, true);
      }
      rafRef.current = requestAnimationFrame(loop);
      return;
    }

    const transitionWait = transitionWaitRef.current;
    if (transitionWait) {
      const transition = transitionWait.transition;
      const toSegment = segments[transition.toIndex];
      const prime = videoPrimeRef.current;
      const ready = Boolean(toSegment && prime?.clipId === toSegment.clip.id && prime.ready);
      const decision = decideMediaPrime(ready, now - transitionWait.startedAt);
      if (decision === "swap" && toSegment && prime) {
        const outgoing = getActive();
        const incoming = getIdle();
        if (outgoing && incoming) {
          transitionWaitRef.current = null;
          prime.cancel();
          videoPrimeRef.current = null;
          activeTransitionRef.current = { transition, outgoing, incoming };
          setTransitionVideoClipId(toSegment.sourceClipId);
          setVideoMix(outgoing, incoming, 0);
          void outgoing.play().catch(() => undefined);
          void incoming.play().catch(() => undefined);
          performance.measure("gta-transition-prime-wait", {
            start: transitionWait.startedAt,
            end: now,
          });
        }
      } else if (decision === "fallback") {
        const key = `${transition.fromIndex}:${transition.toIndex}:${transition.boundaryMs}`;
        skippedTransitionsRef.current.add(key);
        transitionWaitRef.current = null;
        prime?.cancel();
        videoPrimeRef.current = null;
        ensurePrimed(toSegment);
        void getActive()?.play().catch(() => undefined);
        console.warn(
          `[transition] Préchargement incomplet après ${MAX_CUT_HOLD_MS} ms, coupe franche conservée.`,
        );
      }
      rafRef.current = requestAnimationFrame(loop);
      return;
    }

    const activeTransition = activeTransitionRef.current;
    if (activeTransition) {
      const { transition, outgoing, incoming } = activeTransition;
      const fromSegment = segments[transition.fromIndex];
      const toSegment = segments[transition.toIndex];
      if (!fromSegment || !toSegment) {
        activeTransitionRef.current = null;
        setTransitionVideoClipId(null);
        releaseVideoMix(outgoing, incoming);
      } else {
        const timelineMs =
          fromSegment.startMs +
          (outgoing.currentTime * 1000 - fromSegment.clip.srcInMs) /
            fromSegment.clip.playbackRate;
        const progress = (timelineMs - transition.startMs) / transition.durationMs;
        setVideoMix(outgoing, incoming, progress);
        publishPlayhead(Math.min(transition.endMs, timelineMs));
        if (timelineMs >= transition.endMs) {
          activeTransitionRef.current = null;
          currentVideoIndexRef.current = transition.toIndex;
          publishPlayhead(transition.endMs);
          swap();
          outgoing.pause();
          setVideoMix(outgoing, incoming, 1);
          releaseVideoMix(outgoing, incoming);
          setTransitionVideoClipId(null);
          setInGap(false);
          setActiveVideoClipId(toSegment.sourceClipId);
          ensurePrimed(segments[transition.toIndex + 1]);
          measurePresentedCut(incoming, now);
        } else {
          if (outgoing.paused) void outgoing.play().catch(() => undefined);
          if (incoming.paused) void incoming.play().catch(() => undefined);
        }
        syncAudio(playheadRef.current, true);
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
    }

    let index = currentVideoIndexRef.current;
    const indexed = segments[index];
    if (!indexed || playheadRef.current < indexed.startMs || playheadRef.current >= indexed.endMs) {
      index = findSegmentIndex(segments, playheadRef.current);
      currentVideoIndexRef.current = index;
    }
    const active = getActive();

    if (index !== -1 && active) {
      const clip = segments[index].clip;
      const sourceMs = active.currentTime * 1000;
      const transition = compiledRef.current.video.transitions.find(
        (candidate) => candidate.fromIndex === index,
      );
      const timelineMs =
        segments[index].startMs +
        (sourceMs - clip.srcInMs) / clip.playbackRate;
      if (
        transition &&
        !skippedTransitionsRef.current.has(
          `${transition.fromIndex}:${transition.toIndex}:${transition.boundaryMs}`,
        ) &&
        timelineMs >= transition.startMs - BOUNDARY_EPSILON_MS
      ) {
        active.pause();
        publishPlayhead(Math.max(transition.startMs, timelineMs));
        transitionWaitRef.current = { transition, startedAt: now };
        syncAudio(playheadRef.current, false);
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      if (sourceMs >= clip.srcOutMs - BOUNDARY_EPSILON_MS) {
        const boundaryMs = segments[index].endMs;
        if (boundaryMs >= total - 1) {
          publishPlayhead(total);
          pause();
          return;
        }
        const nextIndex =
          segments[index + 1]?.startMs === boundaryMs
            ? index + 1
            : findSegmentIndex(segments, boundaryMs);
        if (nextIndex !== -1) {
          // Le clip suivant est déjà chargé et positionné sur la balise inactive.
          const nextSegment = segments[nextIndex];
          const nextClip = nextSegment.clip;
          const prime = videoPrimeRef.current;
          const ready = prime?.clipId === nextClip.id && prime.ready;
          if (ready) {
            const incoming = getIdle();
            const cutStartedAt = performance.now();
            publishPlayhead(boundaryMs);
            currentVideoIndexRef.current = nextIndex;
            swap();
            active.pause();
            prime.cancel();
            videoPrimeRef.current = null;
            void incoming?.play().catch(() => undefined);
            measurePresentedCut(incoming, cutStartedAt);
            ensurePrimed(segments[nextIndex + 1]);
          } else {
            active.pause();
            publishPlayhead(Math.max(segments[index].startMs, boundaryMs - 0.001));
            currentVideoIndexRef.current = index;
            pendingCutRef.current = {
              fromIndex: index,
              toIndex: nextIndex,
              boundaryMs,
              startedAt: now,
            };
            syncAudio(Math.max(0, boundaryMs - 0.001), false);
            rafRef.current = requestAnimationFrame(loop);
            return;
          }
          setInGap(false);
          setActiveVideoClipId(nextSegment.sourceClipId);
        } else {
          publishPlayhead(boundaryMs);
          currentVideoIndexRef.current = -1;
          active.pause();
          setInGap(true);
          setActiveVideoClipId(null);
          const upcoming = findNextSegmentIndex(segments, boundaryMs);
          ensurePrimed(upcoming === -1 ? undefined : segments[upcoming]);
        }
      } else {
        // Conversion inverse : le temps source lu donne le temps timeline.
        publishPlayhead(
          clip.timelineStartMs + Math.max(0, sourceMs - clip.srcInMs) / clip.playbackRate,
        );
        if (active.paused) void active.play().catch(() => undefined);
      }
    } else {
      // Dans un trou : on avance à l'horloge, écran noir.
      const target = playheadRef.current + elapsed;
      const upcoming = findNextSegmentIndex(segments, playheadRef.current);
      const boundary = upcoming === -1 ? total : segments[upcoming].startMs;
      if (target >= boundary) {
        publishPlayhead(boundary);
        if (upcoming === -1) {
          pause();
          return;
        }
        const nextSegment = segments[upcoming];
        const nextClip = nextSegment.clip;
        const prime = videoPrimeRef.current;
        if (prime?.clipId === nextClip.id && prime.ready) {
          const incoming = getIdle();
          currentVideoIndexRef.current = upcoming;
          swap();
          prime.cancel();
          videoPrimeRef.current = null;
          void incoming?.play().catch(() => undefined);
          measurePresentedCut(incoming, now);
          ensurePrimed(segments[upcoming + 1]);
          setInGap(false);
          setActiveVideoClipId(nextSegment.sourceClipId);
        } else {
          pendingCutRef.current = {
            fromIndex: -1,
            toIndex: upcoming,
            boundaryMs: boundary,
            startedAt: now,
          };
          syncAudio(Math.max(0, boundary - 0.001), false);
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
      } else {
        publishPlayhead(target);
      }
    }
    // Le son se recale sur le playhead à chaque image, sans dépendre de ce qui
    // est affiché : une surcouche muette laisse donc passer le son du dessous.
    syncAudio(playheadRef.current, true);
    rafRef.current = requestAnimationFrame(loop);
  }, [applyPosition, ensurePrimed, getActive, getIdle, pause, publishPlayhead, swap, syncAudio]);

  const play = useCallback(() => {
    const segments = compiledRef.current.video.segments;
    if (segments.length === 0) return;
    const total = compiledRef.current.video.durationMs;
    if (playheadRef.current >= total - 1) seek(0);

    playingRef.current = true;
    setPlaying(true);
    lastTickRef.current = performance.now();
    stopLoop();
    // Dans un trou, la lecture avance à l'horloge : pas d'appel à play().
    if (findSegmentIndex(segments, playheadRef.current) !== -1) {
      void getActive()?.play().catch(() => undefined);
    }
    syncAudio(playheadRef.current, true);
    rafRef.current = requestAnimationFrame(loop);
  }, [getActive, loop, seek, stopLoop, syncAudio]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  // Aperçu pendant un trim : un seul seek en vol à la fois, sinon le décodeur
  // s'étrangle et l'image saccade.
  const pendingFrameRef = useRef<{ sourceId: string; srcMs: number } | null>(null);
  const frameRafRef = useRef<number | null>(null);
  const showFrame = useCallback(
    (sourceId: string, srcMs: number) => {
      pendingFrameRef.current = { sourceId, srcMs };
      if (frameRafRef.current !== null) return;
      const flush = () => {
        frameRafRef.current = null;
        const target = pendingFrameRef.current;
        const active = getActive();
        if (!active || !target) return;
        if (active.seeking) {
          frameRafRef.current = requestAnimationFrame(flush);
          return;
        }
        pendingFrameRef.current = null;
        const source = sourcesRef.current[target.sourceId];
        if (source) assign(active, source, target.srcMs);
      };
      frameRafRef.current = requestAnimationFrame(flush);
    },
    [getActive],
  );

  useEffect(() => {
    return () => {
      if (frameRafRef.current !== null) cancelAnimationFrame(frameRafRef.current);
      videoPrimeRef.current?.cancel();
      audioPrimeRef.current?.cancel();
    };
  }, []);

  // Si le montage change (cut, trim, undo…), re-cale l'aperçu — mais seulement
  // si l'image affichée ne correspond plus au playhead, pour ne pas provoquer
  // un seek parasite à la fin de chaque geste.
  useEffect(() => {
    const total = compiledTimeline.video.durationMs;
    // Un LOAD remplace le projet entier : clips, sources, playhead n'ont plus
    // aucun rapport avec ce qui était chargé. Si la balise active pointe vers
    // une source absente de ce nouveau montage, la lecture ne peut pas
    // continuer sur cet acquis — en cours ou non, on l'arrête et on repart de
    // zéro, plutôt que de laisser la boucle lire l'ancien média avec les
    // segments du nouveau (`playing` seul ne suffit pas à distinguer un
    // simple montage, où l'on ne veut surtout pas interrompre la lecture,
    // d'un changement de projet complet).
    const active = getActive();
    const activeSourceId = active?.dataset.sourceId;
    if (activeSourceId && !(activeSourceId in sources)) {
      pause();
      seek(0);
      return;
    }
    if (playheadRef.current > total) {
      seek(total);
      return;
    }
    if (playing) return;
    // Un montage ordinaire (découpe, réordonnancement, undo…) sur pause ne
    // remplace pas le projet — la branche ci-dessus ne s'en charge donc pas —
    // mais peut décaler ou faire disparaître les segments qu'une coupe ou un
    // fondu encore armé visait par index. Laissés en l'état, ces refs
    // pointeraient la boucle vers un `toIndex`/`fromIndex` qui ne correspond
    // plus au même morceau du montage une fois la lecture reprise.
    clearInFlightTransitions();
    const segments = compiledTimeline.video.segments;
    const index = findSegmentIndex(segments, playheadRef.current);
    currentVideoIndexRef.current = index;
    if (index === -1) {
      setInGap(true);
      setActiveVideoClipId(null);
      return;
    }
    setInGap(false);
    const segment = segments[index];
    const clip = segment.clip;
    setActiveVideoClipId(segment.sourceClipId);
    const source = sources[clip.sourceId];
    if (!active || !source) return;
    const targetMs = timelineTimeToSourceTime(clip, playheadRef.current);
    const sameSource = active.dataset.sourceId === source.id;
    if (!sameSource || Math.abs(active.currentTime * 1000 - targetMs) > RESYNC_TOLERANCE_MS) {
      assign(active, source, targetMs);
    }
    ensurePrimed(segments[index + 1]);
  }, [clearInFlightTransitions, compiledTimeline, ensurePrimed, getActive, pause, playing, seek, sources]);

  useEffect(() => stopLoop, [stopLoop]);

  return {
    playing,
    durationMs,
    inGap,
    activeIsA,
    activeVideoClipId,
    transitionVideoClipId,
    clock: clockControllerRef.current.clock,
    play,
    pause,
    toggle,
    seek,
    showFrame,
  };
}
