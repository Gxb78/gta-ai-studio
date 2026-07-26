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
import type { Clip, SourceInfo } from "../types";
import {
  clipAt,
  clipEndMs,
  nextClipIndex,
  sortClips,
  timelineDurationMs,
  timelineTimeToSourceTime,
} from "../types";
import { mediaUrl } from "../ipc";

/** Marge de détection de fin de clip (ms) pour anticiper le saut. */
const BOUNDARY_EPSILON_MS = 26;

/** Écart au-delà duquel l'aperçu est re-calé sur le playhead après un montage. */
const RESYNC_TOLERANCE_MS = 45;

export interface PlaybackApi {
  playing: boolean;
  playheadMs: number;
  durationMs: number;
  /** Vrai quand le playhead est dans un trou : l'aperçu affiche du noir. */
  inGap: boolean;
  /** Balise actuellement visible. L'autre précharge le clip suivant. */
  activeIsA: boolean;
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
  clips: Clip[],
  audioClips: Clip[],
  sources: Record<string, SourceInfo>,
): PlaybackApi {
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [inGap, setInGap] = useState(false);
  const [activeIsA, setActiveIsA] = useState(true);

  const activeIsARef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const playheadRef = useRef(0);
  /** Clip déjà préchargé sur la balise inactive, pour ne pas recharger en boucle. */
  const primedClipIdRef = useRef<string | null>(null);

  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const audioClipsRef = useRef(audioClips);
  audioClipsRef.current = audioClips;
  /** Balise sonore active, et clip déjà préchargé sur l'autre. */
  const audioActiveIsARef = useRef(true);
  const primedAudioIdRef = useRef<string | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const durationMs = timelineDurationMs(clips);

  const getActive = useCallback(
    () => (activeIsARef.current ? videoA.current : videoB.current),
    [videoA, videoB],
  );
  const getIdle = useCallback(
    () => (activeIsARef.current ? videoB.current : videoA.current),
    [videoA, videoB],
  );

  const setPlayhead = useCallback((ms: number) => {
    playheadRef.current = ms;
    setPlayheadMs(ms);
  }, []);

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
    setPlaying(false);
  }, [audioA, audioB, stopLoop, videoA, videoB]);

  /** Prépare la balise inactive sur le clip qui suit, sans la jouer. */
  const ensurePrimed = useCallback(
    (upcoming: Clip | undefined) => {
      if (!upcoming) {
        primedClipIdRef.current = null;
        return;
      }
      if (primedClipIdRef.current === upcoming.id) return;
      const idle = getIdle();
      const source = sourcesRef.current[upcoming.sourceId];
      if (!idle || !source) return;
      primedClipIdRef.current = upcoming.id;
      idle.pause();
      idle.playbackRate = upcoming.playbackRate;
      assign(idle, source, upcoming.srcInMs);
    },
    [getIdle],
  );

  /** Place l'aperçu sur un temps timeline. Renvoie le clip trouvé, ou null (trou). */
  const applyPosition = useCallback(
    (timelineMs: number) => {
      const sorted = sortClips(clipsRef.current);
      const position = clipAt(sorted, timelineMs);
      const active = getActive();
      if (position) {
        const clip = sorted[position.clipIndex];
        const source = sourcesRef.current[clip.sourceId];
        if (active && source) {
          active.playbackRate = clip.playbackRate;
          assign(active, source, timelineTimeToSourceTime(clip, timelineMs));
        }
        setInGap(false);
        ensurePrimed(sorted[position.clipIndex + 1]);
      } else {
        active?.pause();
        setInGap(true);
        const upcoming = nextClipIndex(sorted, timelineMs);
        ensurePrimed(upcoming === -1 ? undefined : sorted[upcoming]);
      }
      return position;
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
      const sorted = sortClips(audioClipsRef.current);
      const position = clipAt(sorted, timelineMs);

      if (!position) {
        for (const element of elements) element?.pause();
        primedAudioIdRef.current = null;
        return;
      }

      const clip = sorted[position.clipIndex];
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
      const upcoming = sorted[position.clipIndex + 1];
      if (idle && upcoming && primedAudioIdRef.current !== upcoming.id) {
        const nextSource = sourcesRef.current[upcoming.sourceId];
        if (nextSource) {
          primedAudioIdRef.current = upcoming.id;
          idle.dataset.clipId = upcoming.id;
          idle.playbackRate = upcoming.playbackRate;
          assign(idle, nextSource, upcoming.srcInMs);
        }
      }
    },
    [audioA, audioB],
  );

  const seek = useCallback(
    (timelineMs: number) => {
      const clamped = Math.max(0, Math.min(timelineMs, timelineDurationMs(clipsRef.current)));
      applyPosition(clamped);
      // Après un seek, le son est recalé d'autorité : aucune dérive à rattraper.
      syncAudio(clamped, false, true);
      setPlayhead(clamped);
    },
    [applyPosition, setPlayhead, syncAudio],
  );

  /** Bascule sur la balise préchargée : c'est l'opération qui rend la jonction invisible. */
  const swap = useCallback(() => {
    activeIsARef.current = !activeIsARef.current;
    setActiveIsA(activeIsARef.current);
  }, []);

  const loop = useCallback(() => {
    const sorted = sortClips(clipsRef.current);
    if (sorted.length === 0) return;

    const now = performance.now();
    const elapsed = Math.max(0, now - lastTickRef.current);
    lastTickRef.current = now;

    const total = timelineDurationMs(sorted);
    const position = clipAt(sorted, playheadRef.current);
    const active = getActive();

    if (position && active) {
      const clip = sorted[position.clipIndex];
      const sourceMs = active.currentTime * 1000;

      if (sourceMs >= clip.srcOutMs - BOUNDARY_EPSILON_MS) {
        const boundaryMs = clipEndMs(clip);
        if (boundaryMs >= total - 1) {
          setPlayhead(total);
          pause();
          return;
        }
        setPlayhead(boundaryMs);
        const nextPosition = clipAt(sorted, boundaryMs);
        if (nextPosition) {
          // Le clip suivant est déjà chargé et positionné sur la balise inactive.
          const nextClip = sorted[nextPosition.clipIndex];
          const ready = primedClipIdRef.current === nextClip.id;
          if (ready) {
            const incoming = getIdle();
            swap();
            active.pause();
            primedClipIdRef.current = null;
            void incoming?.play().catch(() => undefined);
            ensurePrimed(sorted[nextPosition.clipIndex + 1]);
          } else {
            // Préchargement non terminé : on se rabat sur un saut classique.
            applyPosition(boundaryMs);
            void active.play().catch(() => undefined);
          }
          setInGap(false);
        } else {
          active.pause();
          setInGap(true);
          const upcoming = nextClipIndex(sorted, boundaryMs);
          ensurePrimed(upcoming === -1 ? undefined : sorted[upcoming]);
        }
      } else {
        // Conversion inverse : le temps source lu donne le temps timeline.
        setPlayhead(clip.timelineStartMs + Math.max(0, sourceMs - clip.srcInMs) / clip.playbackRate);
        if (active.paused) void active.play().catch(() => undefined);
        setInGap(false);
      }
    } else {
      // Dans un trou : on avance à l'horloge, écran noir.
      const target = playheadRef.current + elapsed;
      const upcoming = nextClipIndex(sorted, playheadRef.current);
      const boundary = upcoming === -1 ? total : sorted[upcoming].timelineStartMs;
      if (target >= boundary) {
        setPlayhead(boundary);
        if (upcoming === -1) {
          pause();
          return;
        }
        const nextClip = sorted[upcoming];
        if (primedClipIdRef.current === nextClip.id) {
          const incoming = getIdle();
          swap();
          primedClipIdRef.current = null;
          void incoming?.play().catch(() => undefined);
          ensurePrimed(sorted[upcoming + 1]);
        } else {
          applyPosition(boundary);
          void getActive()?.play().catch(() => undefined);
        }
        setInGap(false);
      } else {
        setPlayhead(target);
        setInGap(true);
      }
    }
    // Le son se recale sur le playhead à chaque image, sans dépendre de ce qui
    // est affiché : une surcouche muette laisse donc passer le son du dessous.
    syncAudio(playheadRef.current, true);
    rafRef.current = requestAnimationFrame(loop);
  }, [applyPosition, ensurePrimed, getActive, getIdle, pause, setPlayhead, swap, syncAudio]);

  const play = useCallback(() => {
    const sorted = sortClips(clipsRef.current);
    if (sorted.length === 0) return;
    const total = timelineDurationMs(sorted);
    if (playheadRef.current >= total - 1) seek(0);

    setPlaying(true);
    lastTickRef.current = performance.now();
    stopLoop();
    // Dans un trou, la lecture avance à l'horloge : pas d'appel à play().
    if (clipAt(sorted, playheadRef.current)) {
      void getActive()?.play().catch(() => undefined);
    }
    syncAudio(playheadRef.current, true);
    rafRef.current = requestAnimationFrame(loop);
  }, [getActive, loop, seek, stopLoop, syncAudio]);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [pause, play, playing]);

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
    const total = timelineDurationMs(clips);
    if (playheadRef.current > total) {
      seek(total);
      return;
    }
    if (playing) return;
    const sorted = sortClips(clips);
    const position = clipAt(sorted, playheadRef.current);
    if (!position) {
      setInGap(true);
      return;
    }
    setInGap(false);
    const clip = sorted[position.clipIndex];
    const source = sources[clip.sourceId];
    const active = getActive();
    if (!active || !source) return;
    const targetMs = clip.srcInMs + position.offsetMs;
    const sameSource = active.dataset.sourceId === source.id;
    if (!sameSource || Math.abs(active.currentTime * 1000 - targetMs) > RESYNC_TOLERANCE_MS) {
      assign(active, source, targetMs);
    }
    ensurePrimed(sorted[position.clipIndex + 1]);
    // playheadMs volontairement absent : on ne re-cale que sur changement de montage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  useEffect(() => stopLoop, [stopLoop]);

  return { playing, playheadMs, durationMs, inGap, activeIsA, play, pause, toggle, seek, showFrame };
}
