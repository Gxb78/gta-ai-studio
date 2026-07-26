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
import { timelineTimeToSourceTime } from "../types";
import { mediaUrl } from "../ipc";
import type { CompiledSegment, CompiledTimeline } from "../timeline/compileTimeline";
import { findNextSegmentIndex, findSegmentIndex } from "../timeline/compileTimeline";

/** Marge de détection de fin de clip (ms) pour anticiper le saut. */
const BOUNDARY_EPSILON_MS = 26;

/** Écart au-delà duquel l'aperçu est re-calé sur le playhead après un montage. */
const RESYNC_TOLERANCE_MS = 45;

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

  const activeIsARef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const playheadRef = useRef(0);
  const clockControllerRef = useRef<PlaybackClockController | null>(null);
  if (!clockControllerRef.current) clockControllerRef.current = createPlaybackClock();
  /** Clip déjà préchargé sur la balise inactive, pour ne pas recharger en boucle. */
  const primedClipIdRef = useRef<string | null>(null);

  const compiledRef = useRef(compiledTimeline);
  compiledRef.current = compiledTimeline;
  const currentVideoIndexRef = useRef(-1);
  const currentAudioIndexRef = useRef(-1);
  /** Balise sonore active, et clip déjà préchargé sur l'autre. */
  const audioActiveIsARef = useRef(true);
  const primedAudioIdRef = useRef<string | null>(null);
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
      const clip = audioSegments.find(
        (segment) => segment.clip.id === element.dataset.clipId,
      )?.clip;
      element.volume = Math.min(1, previewVolume * (clip?.volume ?? 1));
    }
  }, [audioA, audioB, compiledTimeline, previewVolume]);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const pause = useCallback(() => {
    videoA.current?.pause();
    videoB.current?.pause();
    audioA.current?.pause();
    audioB.current?.pause();
    stopLoop();
    playingRef.current = false;
    setPlaying(false);
  }, [audioA, audioB, stopLoop, videoA, videoB]);

  /** Prépare la balise inactive sur le clip qui suit, sans la jouer. */
  const ensurePrimed = useCallback(
    (upcoming: CompiledSegment | undefined) => {
      if (!upcoming) {
        primedClipIdRef.current = null;
        return;
      }
      if (primedClipIdRef.current === upcoming.clip.id) return;
      const idle = getIdle();
      const source = sourcesRef.current[upcoming.clip.sourceId];
      if (!idle || !source) return;
      primedClipIdRef.current = upcoming.clip.id;
      idle.pause();
      idle.playbackRate = upcoming.clip.playbackRate;
      assign(idle, source, upcoming.clip.srcInMs);
    },
    [getIdle],
  );

  /** Place l'aperçu sur un temps timeline. Renvoie le clip trouvé, ou null (trou). */
  const applyPosition = useCallback(
    (timelineMs: number) => {
      const segments = compiledRef.current.video.segments;
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
      const segments = compiledRef.current.audio.segments;
      let index = currentAudioIndexRef.current;
      const current = segments[index];
      if (!current || timelineMs < current.startMs || timelineMs >= current.endMs) {
        index = findSegmentIndex(segments, timelineMs);
        currentAudioIndexRef.current = index;
      }

      if (index === -1) {
        for (const element of elements) element?.pause();
        primedAudioIdRef.current = null;
        return;
      }

      const clip = segments[index].clip;
      const source = sourcesRef.current[clip.sourceId];
      if (!source) return;

      // Changement de segment : on bascule sur la balise déjà préchargée.
      const currentId = audioActiveIsARef.current ? audioA.current : audioB.current;
      if (currentId && currentId.dataset.clipId !== clip.id) {
        if (primedAudioIdRef.current === clip.id) {
          audioActiveIsARef.current = !audioActiveIsARef.current;
          primedAudioIdRef.current = null;
        }
      }

      const active = audioActiveIsARef.current ? audioA.current : audioB.current;
      const idle = audioActiveIsARef.current ? audioB.current : audioA.current;
      if (!active) return;

      const targetMs = timelineTimeToSourceTime(clip, timelineMs);
      // La vitesse du son suit celle du clip ; le rattrapage de dérive vient en plus.
      const baseRate = clip.playbackRate;
      active.volume = Math.min(1, previewVolumeRef.current * clip.volume);
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
      const upcoming = segments[index + 1]?.clip;
      if (idle && upcoming && primedAudioIdRef.current !== upcoming.id) {
        const nextSource = sourcesRef.current[upcoming.sourceId];
        if (nextSource) {
          primedAudioIdRef.current = upcoming.id;
          idle.dataset.clipId = upcoming.id;
          idle.playbackRate = upcoming.playbackRate;
          idle.volume = Math.min(1, previewVolumeRef.current * upcoming.volume);
          assign(idle, nextSource, upcoming.srcInMs);
        }
      }
    },
    [audioA, audioB],
  );

  const seek = useCallback(
    (timelineMs: number) => {
      const clamped = Math.max(0, Math.min(timelineMs, compiledRef.current.video.durationMs));
      applyPosition(clamped);
      // Après un seek, le son est recalé d'autorité : aucune dérive à rattraper.
      syncAudio(clamped, false, true);
      publishPlayhead(clamped);
    },
    [applyPosition, publishPlayhead, syncAudio],
  );

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

      if (sourceMs >= clip.srcOutMs - BOUNDARY_EPSILON_MS) {
        const boundaryMs = segments[index].endMs;
        if (boundaryMs >= total - 1) {
          publishPlayhead(total);
          pause();
          return;
        }
        publishPlayhead(boundaryMs);
        const nextIndex =
          segments[index + 1]?.startMs === boundaryMs
            ? index + 1
            : findSegmentIndex(segments, boundaryMs);
        currentVideoIndexRef.current = nextIndex;
        if (nextIndex !== -1) {
          // Le clip suivant est déjà chargé et positionné sur la balise inactive.
          const nextSegment = segments[nextIndex];
          const nextClip = nextSegment.clip;
          const ready = primedClipIdRef.current === nextClip.id;
          if (ready) {
            const incoming = getIdle();
            swap();
            active.pause();
            primedClipIdRef.current = null;
            void incoming?.play().catch(() => undefined);
            ensurePrimed(segments[nextIndex + 1]);
          } else {
            // Préchargement non terminé : on se rabat sur un saut classique.
            applyPosition(boundaryMs);
            void active.play().catch(() => undefined);
          }
          setInGap(false);
          setActiveVideoClipId(nextSegment.sourceClipId);
        } else {
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
        currentVideoIndexRef.current = upcoming;
        if (primedClipIdRef.current === nextClip.id) {
          const incoming = getIdle();
          swap();
          primedClipIdRef.current = null;
          void incoming?.play().catch(() => undefined);
          ensurePrimed(segments[upcoming + 1]);
        } else {
          applyPosition(boundary);
          void getActive()?.play().catch(() => undefined);
        }
        setInGap(false);
        setActiveVideoClipId(nextSegment.sourceClipId);
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
    };
  }, []);

  // Si le montage change (cut, trim, undo…), re-cale l'aperçu — mais seulement
  // si l'image affichée ne correspond plus au playhead, pour ne pas provoquer
  // un seek parasite à la fin de chaque geste.
  useEffect(() => {
    const total = compiledTimeline.video.durationMs;
    if (playheadRef.current > total) {
      seek(total);
      return;
    }
    if (playing) return;
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
    const active = getActive();
    if (!active || !source) return;
    const targetMs = timelineTimeToSourceTime(clip, playheadRef.current);
    const sameSource = active.dataset.sourceId === source.id;
    if (!sameSource || Math.abs(active.currentTime * 1000 - targetMs) > RESYNC_TOLERANCE_MS) {
      assign(active, source, targetMs);
    }
    ensurePrimed(segments[index + 1]);
  }, [compiledTimeline, ensurePrimed, getActive, playing, seek, sources]);

  useEffect(() => stopLoop, [stopLoop]);

  return {
    playing,
    durationMs,
    inGap,
    activeIsA,
    activeVideoClipId,
    clock: clockControllerRef.current.clock,
    play,
    pause,
    toggle,
    seek,
    showFrame,
  };
}
