// Timeline de montage. Tout est calculé côté client, à la milliseconde.
//
// Positionnement libre : chaque clip porte sa position (`timelineStartMs`).
// Tirer une poignée gauche déplace le bord ET la position, donc le bord reste
// sous le curseur. Les clips ne se chevauchent jamais ; entre deux clips, un
// intervalle vide est un trou, affiché hachuré et rendu noir.
//
// Règle de fluidité (budget < 16 ms/frame) :
//   - les gestes continus vivent dans des refs, PAS dans l'état React ;
//   - les événements pointeur sont coalescés dans une boucle requestAnimationFrame,
//     donc au plus un rendu par image quel que soit le taux de la souris ;
//   - les vignettes sont indexées sur le temps source absolu, donc les <img> sont
//     réutilisées pendant un redimensionnement au lieu d'être démontées.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { EditorAction } from "../state/editor";
import type { Clip, SourceInfo } from "../types";
import {
  clipDurationMs,
  clipEndMs,
  clipsOnTrack,
  flattenTracks,
  formatTime,
  quantizeToFrame,
  sortClips,
  sourceAspect,
  timelineTimeToSourceTime,
  timelineDurationMs,
  timelineGaps,
  trackCount,
} from "../types";
import { mediaUrl } from "../ipc";
import { Icon } from "./Icon";

/** Hauteur de la piste et de la bande audio. Le CSS les lit via des variables :
 *  la largeur d'un créneau de vignette en dépend, elles ne doivent pas diverger. */
const TRACK_HEIGHT_PX = 152;
const AUDIO_LANE_PX = 28;
/** Bordure de `.clip`. Avec box-sizing: border-box elle mange de la hauteur
 *  utile : l'oublier fausse le ratio du créneau et le rognage revient. */
const CLIP_BORDER_PX = 1;
const THUMB_STRIP_PX = TRACK_HEIGHT_PX - 2 * CLIP_BORDER_PX - AUDIO_LANE_PX;
/** Pas de quantification de la fenêtre visible transmise aux vignettes. */
const THUMB_WINDOW_QUANTUM = 128;
/** Écart vertical entre deux pistes. */
const TRACK_GAP_PX = 6;
/** Bandeau de dépôt affiché au-dessus pendant un déplacement. */
const DROP_TRACK_PX = 40;
const SNAP_PX = 9;
const EDGE_SCROLL_PX = 48;
const EDGE_SCROLL_SPEED = 20;
const MOVE_THRESHOLD_PX = 5;
/** Ralentissement du geste quand Maj est enfoncée. */
const FINE_FACTOR = 5;
const MIN_PX_PER_SEC = 2;
const MAX_PX_PER_SEC = 240;
const RULER_STEPS_S = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];

interface Props {
  clips: Clip[];
  /**
   * Clips committés. Ils servent de points d'aimantation : viser les positions
   * transitoires ferait suivre l'aimant aux clips repoussés par le geste.
   */
  anchorClips: Clip[];
  sources: Record<string, SourceInfo>;
  pxPerSec: number;
  onPxPerSecChange: (next: number) => void;
  playheadMs: number;
  playing: boolean;
  selectedClipId: string | null;
  onSeek: (timelineMs: number) => void;
  onSelect: (clipId: string | null) => void;
  /** Affiche l'image source à `srcMs` pendant un trim (feedback image par image). */
  onPreviewFrame: (sourceId: string, srcMs: number) => void;
  /** Met la lecture en pause avant un geste. */
  onPause: () => void;
  /** Recolle tous les clips bout à bout. */
  onCloseGaps: () => void;
  dispatch: (action: EditorAction) => void;
}

type GestureKind = "trim-left" | "trim-right" | "move";

interface Gesture {
  kind: GestureKind;
  clipId: string;
  origin: Clip;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  pointerX: number;
  pointerY: number;
  fine: boolean;
  /** Mode précis déjà pris en compte dans `startClientX`. */
  appliedFine: boolean;
  /** Un déplacement ne commence qu'au-delà d'un seuil, pour ne pas gêner la sélection. */
  engaged: boolean;
  lastValueMs: number | null;
  lastTrack: number | null;
  raf: number | null;
  abort: AbortController;
}

/** Ce qu'on affiche pendant le geste : la géométrie exacte est relue au rendu. */
interface GestureHud {
  clipId: string;
  kind: GestureKind;
  originDurationMs: number;
  originStartMs: number;
  snapped: boolean;
}

export function Timeline(props: Props) {
  const {
    clips, anchorClips, sources, pxPerSec, onPxPerSecChange, playheadMs, playing,
    selectedClipId, onSeek, onSelect, onPreviewFrame, onPause, onCloseGaps, dispatch,
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 1000 });
  const [hud, setHud] = useState<GestureHud | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const zoomAnchorRef = useRef<{ timeMs: number; viewportX: number } | null>(null);

  const pxPerMs = pxPerSec / 1000;
  const sorted = sortClips(clips);
  const totalMs = timelineDurationMs(clips);
  const totalPx = totalMs * pxPerMs;
  // Un trou, c'est un instant où RIEN n'est visible : il se lit sur le montage
  // aplati, pas sur la seule piste principale.
  const gaps = timelineGaps(flattenTracks(clips));
  const sourceCount = new Set(clips.map((clip) => clip.sourceId)).size;
  // Une piste vide n'est proposée que pendant un déplacement : le reste du
  // temps elle ne ferait qu'occuper de la hauteur pour rien.
  const occupied = trackCount(clips);
  const dropTrackVisible = hud?.kind === "move";
  const tracks = occupied + (dropTrackVisible ? 1 : 0);
  const trackOrder = Array.from({ length: tracks }, (_, i) => tracks - 1 - i);

  // Valeurs fraîches lisibles depuis la boucle rAF sans la faire dépendre du rendu.
  const liveRef = useRef({ pxPerMs, playheadMs, anchorClips, sources, maxTrack: occupied });
  liveRef.current = { pxPerMs, playheadMs, anchorClips, sources, maxTrack: occupied };

  // --- Fenêtre visible -------------------------------------------------------
  const syncViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport((previous) =>
      previous.scrollLeft === el.scrollLeft && previous.width === el.clientWidth
        ? previous
        : { scrollLeft: el.scrollLeft, width: el.clientWidth },
    );
  }, []);

  useEffect(() => {
    syncViewport();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(syncViewport);
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncViewport]);

  const visibleFromPx = Math.max(0, viewport.scrollLeft - 300);
  const visibleToPx = viewport.scrollLeft + viewport.width + 300;

  // --- Molette : défilement horizontal, zoom ancré avec Ctrl -----------------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const amount = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      event.preventDefault();
      if (!event.ctrlKey) {
        el.scrollLeft += amount;
        syncViewport();
        return;
      }
      const rect = el.getBoundingClientRect();
      const viewportX = event.clientX - rect.left;
      const timeMs = (el.scrollLeft + viewportX) / pxPerMs;
      const factor = amount < 0 ? 1.2 : 1 / 1.2;
      const next = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec * factor));
      if (next !== pxPerSec) {
        zoomAnchorRef.current = { timeMs, viewportX };
        onPxPerSecChange(next);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onPxPerSecChange, pxPerMs, pxPerSec, syncViewport]);

  useEffect(() => {
    const anchor = zoomAnchorRef.current;
    const el = scrollRef.current;
    if (anchor && el) {
      el.scrollLeft = Math.max(0, anchor.timeMs * pxPerMs - anchor.viewportX);
      zoomAnchorRef.current = null;
      syncViewport();
    }
  }, [pxPerMs, syncViewport]);

  // Zoom par boutons : ancré sur le playhead, pour ne jamais perdre son repère.
  const zoomBy = useCallback(
    (factor: number) => {
      const next = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec * factor));
      if (next === pxPerSec) return;
      const el = scrollRef.current;
      if (el) {
        const anchorPx = playheadMs * pxPerMs - el.scrollLeft;
        zoomAnchorRef.current = {
          timeMs: playheadMs,
          viewportX: Math.min(Math.max(anchorPx, 0), el.clientWidth),
        };
      }
      onPxPerSecChange(next);
    },
    [onPxPerSecChange, playheadMs, pxPerMs, pxPerSec],
  );

  const zoomToFit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || totalMs <= 0) return;
    const target = ((el.clientWidth - 48) / totalMs) * 1000;
    zoomAnchorRef.current = { timeMs: 0, viewportX: 24 };
    onPxPerSecChange(Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, target)));
  }, [onPxPerSecChange, totalMs]);

  // --- Suivi du playhead pendant la lecture ----------------------------------
  useEffect(() => {
    if (!playing) return;
    const el = scrollRef.current;
    if (!el) return;
    const playheadPx = playheadMs * pxPerMs;
    if (playheadPx < el.scrollLeft + 40 || playheadPx > el.scrollLeft + el.clientWidth - 120) {
      el.scrollLeft = Math.max(0, playheadPx - el.clientWidth / 3);
      syncViewport();
    }
  }, [playing, playheadMs, pxPerMs, syncViewport]);

  // --- Scrub (règle et fond de piste) ----------------------------------------
  const scrubTo = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      onSeek(Math.max(0, (el.scrollLeft + clientX - rect.left) / liveRef.current.pxPerMs));
    },
    [onSeek],
  );

  const handleScrubDown = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubTo(event.clientX);
  };
  const handleScrubMove = (event: React.PointerEvent) => {
    if (event.buttons & 1) scrubTo(event.clientX);
  };

  // Rangées de pistes, pour retrouver celle qui est sous le curseur.
  const trackRowsRef = useRef(new Map<number, HTMLDivElement>());
  const registerTrackRow = useCallback((track: number, el: HTMLDivElement | null) => {
    if (el) trackRowsRef.current.set(track, el);
    else trackRowsRef.current.delete(track);
  }, []);

  /** Piste sous une ordonnée écran ; la plus proche si on déborde en haut ou en bas. */
  const trackUnderPointer = useCallback((clientY: number, fallback: number): number => {
    let best = fallback;
    let bestDistance = Infinity;
    for (const [track, el] of trackRowsRef.current) {
      const rect = el.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return track;
      const distance = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = track;
      }
    }
    return best;
  }, []);

  // --- Gestes (trim et déplacement) -------------------------------------------
  // Une seule boucle rAF pour toute la durée du geste : elle absorbe les
  // événements pointeur (souvent 5 à 8 par image) et gère l'auto-défilement.
  const runGestureFrame = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const { pxPerMs: livePx, playheadMs: livePlayhead, anchorClips: liveAnchors, sources: liveSources } =
      liveRef.current;
    // Le calage image dépend de la cadence du rush travaillé, pas du projet :
    // deux rushs peuvent avoir des cadences différentes.
    const liveFps = liveSources[gesture.origin.sourceId]?.probe.fps || 30;
    const el = scrollRef.current;

    if (el && gesture.engaged) {
      const rect = el.getBoundingClientRect();
      const x = gesture.pointerX - rect.left;
      if (x < EDGE_SCROLL_PX) el.scrollLeft = Math.max(0, el.scrollLeft - EDGE_SCROLL_SPEED);
      else if (x > rect.width - EDGE_SCROLL_PX) el.scrollLeft += EDGE_SCROLL_SPEED;
    }

    const scrollDelta = el ? el.scrollLeft - gesture.startScrollLeft : 0;

    // Bascule du mode précis en cours de geste : on rebase l'origine, sinon le bord saute.
    if (gesture.fine !== gesture.appliedFine) {
      const previousRawPx = gesture.pointerX - gesture.startClientX + scrollDelta;
      gesture.startClientX =
        gesture.pointerX + scrollDelta - previousRawPx * (gesture.fine ? FINE_FACTOR : 1 / FINE_FACTOR);
      gesture.appliedFine = gesture.fine;
    }

    const rawPx = gesture.pointerX - gesture.startClientX + scrollDelta;
    if (!gesture.engaged) {
      if (Math.abs(rawPx) < MOVE_THRESHOLD_PX) {
        gesture.raf = requestAnimationFrame(runGestureFrame);
        return;
      }
      gesture.engaged = true;
      // Le curseur ne bascule qu'une fois le déplacement réellement engagé.
      document.body.classList.add("moving");
    }
    const deltaMs = (gesture.fine ? rawPx / FINE_FACTOR : rawPx) / livePx;

    // Tout l'aimantation se raisonne en temps TIMELINE : c'est ce que l'œil aligne.
    const tolerance = SNAP_PX / livePx;
    const anchors: number[] = [0, livePlayhead];
    for (const other of liveAnchors) {
      if (other.id === gesture.clipId) continue;
      anchors.push(other.timelineStartMs, clipEndMs(other));
    }

    const snapEdge = (value: number): { value: number; snapped: boolean } => {
      let best = quantizeToFrame(value, liveFps);
      let snapped = false;
      let distance = tolerance;
      for (const anchor of [...anchors, Math.round(value / 1000) * 1000]) {
        const d = Math.abs(anchor - value);
        if (d < distance) {
          distance = d;
          best = anchor;
          snapped = true;
        }
      }
      return { value: best, snapped };
    };

    const origin = gesture.origin;
    let snapped = false;
    let value: number;

    if (gesture.kind === "move") {
      const rawStart = origin.timelineStartMs + deltaMs;
      const duration = clipDurationMs(origin);
      // Les deux bords du clip cherchent un point d'accroche ; le plus proche gagne.
      const head = snapEdge(rawStart);
      const tail = snapEdge(rawStart + duration);
      const headDistance = Math.abs(head.value - rawStart);
      const tailDistance = Math.abs(tail.value - duration - rawStart);
      if (tail.snapped && (!head.snapped || tailDistance < headDistance)) {
        value = Math.max(0, tail.value - duration);
        snapped = true;
      } else {
        value = Math.max(0, head.value);
        snapped = head.snapped;
      }
      // Déplacement vertical : on cherche la rangée réellement sous le curseur
      // plutôt que de supposer une hauteur uniforme — le bandeau de dépôt est
      // plus fin que les pistes, un calcul par division se tromperait.
      const track = trackUnderPointer(gesture.pointerY, gesture.origin.track);
      if (value !== gesture.lastValueMs || track !== gesture.lastTrack) {
        gesture.lastValueMs = value;
        gesture.lastTrack = track;
        dispatch({ type: "MOVE_TRANSIENT", clipId: gesture.clipId, timelineStartMs: value, track });
      }
    } else {
      const side = gesture.kind === "trim-left" ? "left" : "right";
      const originEdge = side === "left" ? origin.timelineStartMs : clipEndMs(origin);
      const result = snapEdge(originEdge + deltaMs);
      value = result.value;
      snapped = result.snapped;
      // Retour en temps source par la conversion canonique : sans elle, un clip
      // accéléré verrait son bord partir deux fois trop loin dans le rush.
      const edgeSrcMs = timelineTimeToSourceTime(origin, value);
      if (value !== gesture.lastValueMs) {
        gesture.lastValueMs = value;
        dispatch({ type: "TRIM_TRANSIENT", clipId: gesture.clipId, side, edgeSrcMs });
        onPreviewFrame(gesture.origin.sourceId, edgeSrcMs);
      }
    }

    setHud((previous) =>
      previous && previous.snapped === snapped
        ? previous
        : {
            clipId: gesture.clipId,
            kind: gesture.kind,
            originDurationMs: clipDurationMs(origin),
            originStartMs: origin.timelineStartMs,
            snapped,
          },
    );

    gesture.raf = requestAnimationFrame(runGestureFrame);
  }, [dispatch, onPreviewFrame, trackUnderPointer]);

  const finishGesture = useCallback(
    (commit: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (gesture.raf !== null) cancelAnimationFrame(gesture.raf);
      gesture.abort.abort();
      gestureRef.current = null;
      document.body.classList.remove("trimming", "moving");
      setHud(null);
      if (gesture.engaged) dispatch({ type: commit ? "GESTURE_COMMIT" : "GESTURE_CANCEL" });
    },
    [dispatch],
  );

  const beginGesture = useCallback(
    (event: React.PointerEvent, clip: Clip, kind: GestureKind) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      if (gestureRef.current) finishGesture(true);
      onPause();
      onSelect(clip.id);

      const abort = new AbortController();
      const gesture: Gesture = {
        kind,
        clipId: clip.id,
        origin: { ...clip },
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
        pointerX: event.clientX,
        pointerY: event.clientY,
        fine: event.shiftKey,
        appliedFine: event.shiftKey,
        // Un trim est immédiat ; un déplacement attend le seuil.
        engaged: kind !== "move",
        lastValueMs: null,
        lastTrack: null,
        raf: null,
        abort,
      };
      gestureRef.current = gesture;
      if (kind !== "move") document.body.classList.add("trimming");

      const options = { signal: abort.signal } as const;
      // Écouteurs au niveau fenêtre : le geste survit à tout re-rendu de l'arbre React.
      window.addEventListener(
        "pointermove",
        (moveEvent: PointerEvent) => {
          gesture.pointerX = moveEvent.clientX;
          gesture.pointerY = moveEvent.clientY;
          gesture.fine = moveEvent.shiftKey;
        },
        options,
      );
      window.addEventListener("pointerup", () => finishGesture(true), options);
      window.addEventListener("pointercancel", () => finishGesture(false), options);
      window.addEventListener(
        "keydown",
        (keyEvent: KeyboardEvent) => {
          if (keyEvent.key === "Escape") {
            keyEvent.preventDefault();
            finishGesture(false);
          }
        },
        options,
      );

      gesture.raf = requestAnimationFrame(runGestureFrame);
    },
    [finishGesture, onPause, onSelect, runGestureFrame],
  );

  // Filet de sécurité : jamais de geste orphelin au démontage.
  useEffect(() => {
    return () => {
      gestureRef.current?.abort.abort();
      document.body.classList.remove("trimming", "moving");
    };
  }, []);

  // --- Règle ------------------------------------------------------------------
  const stepS = RULER_STEPS_S.find((s) => s * pxPerSec >= 70) ?? 120;
  const stepPx = stepS * pxPerSec;
  // Subdivisions non légendées, tant qu'elles restent lisibles.
  const divisions = stepPx / 4 >= 15 ? 4 : 1;
  const ticks: { px: number; label: string | null }[] = [];
  const firstTick = Math.floor(visibleFromPx / stepPx);
  const lastTick = Math.ceil(Math.min(visibleToPx, totalPx + 200) / stepPx);
  for (let i = firstTick; i <= lastTick; i++) {
    for (let d = 0; d < divisions; d++) {
      ticks.push({
        px: (i + d / divisions) * stepPx,
        label: d === 0 ? formatTime(i * stepS * 1000).slice(0, 5) : null,
      });
    }
  }

  const contentWidth = Math.max(totalPx + 240, viewport.width);
  // Fenêtre quantifiée sur une grille fixe : la largeur d'un créneau dépend
  // désormais du rush de chaque clip, mais le but reste le même — ne pas
  // invalider le memo des vignettes à chaque pixel de défilement.
  const thumbWindowFrom = Math.floor(visibleFromPx / THUMB_WINDOW_QUANTUM) * THUMB_WINDOW_QUANTUM;
  const thumbWindowTo = Math.ceil(visibleToPx / THUMB_WINDOW_QUANTUM) * THUMB_WINDOW_QUANTUM;

  // Géométrie du HUD relue sur le clip réel : elle reflète les butées appliquées.
  const hudClip = hud ? clips.find((clip) => clip.id === hud.clipId) : undefined;

  return (
    <div
      className="timeline"
      style={
        {
          "--track-h": `${TRACK_HEIGHT_PX}px`,
          "--audio-h": `${AUDIO_LANE_PX}px`,
          "--track-gap": `${TRACK_GAP_PX}px`,
          "--drop-h": `${DROP_TRACK_PX}px`,
          // La zone de pistes grandit avec leur nombre, jusqu'à un plafond
          // au-delà duquel elle défile verticalement.
          height: `${Math.min(3, occupied) * (TRACK_HEIGHT_PX + TRACK_GAP_PX) + 92}px`,
        } as React.CSSProperties
      }
    >
      <div className="timeline-scroll" ref={scrollRef} onScroll={syncViewport}>
        <div className="timeline-content" style={{ width: contentWidth }}>
          <div className="ruler" onPointerDown={handleScrubDown} onPointerMove={handleScrubMove}>
            {ticks.map((tick) => (
              <div
                key={tick.px}
                className={"tick" + (tick.label ? " tick-major" : "")}
                style={{ left: tick.px }}
              >
                {tick.label && <span>{tick.label}</span>}
              </div>
            ))}
          </div>

          {/* Pistes empilées, la plus haute en premier : sa priorité visuelle se
              lit directement dans l'ordre à l'écran. */}
          {trackOrder.map((track) => (
          <div
            key={`track-${track}`}
            ref={(el) => registerTrackRow(track, el)}
            className={
              "track" +
              (track === 0 ? " track-base" : "") +
              (track >= occupied ? " track-drop" : "")
            }
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) {
                onSelect(null);
                handleScrubDown(e);
              }
            }}
            onPointerMove={(e) => {
              if (e.target === e.currentTarget) handleScrubMove(e);
            }}
          >
            {track === 0 &&
              gaps.map((gap) => (
                <div
                  key={`gap-${gap.startMs}`}
                  className="gap"
                  style={{
                    left: Math.round(gap.startMs * pxPerMs),
                    width: Math.round(gap.endMs * pxPerMs) - Math.round(gap.startMs * pxPerMs),
                  }}
                  title={`Trou de ${formatTime(gap.endMs - gap.startMs)} — noir à l'export`}
                />
              ))}

            {clipsOnTrack(sorted, track).map((clip) => {
              // Positions entières : un <img> posé sur un pixel fractionnaire est
              // rééchantillonné par le compositeur, donc flou même à l'échelle 1.
              // Arrondir les deux bords garantit aussi que deux clips jointifs
              // partagent exactement la même colonne de pixels.
              const leftPx = Math.round(clip.timelineStartMs * pxPerMs);
              const widthPx = Math.max(2, Math.round(clipEndMs(clip) * pxPerMs) - leftPx);
              if (leftPx + widthPx < visibleFromPx || leftPx > visibleToPx) return null;
              const source = sources[clip.sourceId];
              if (!source) return null;
              return (
                <ClipView
                  key={clip.id}
                  clip={clip}
                  source={source}
                  leftPx={leftPx}
                  widthPx={widthPx}
                  pxPerMs={pxPerMs}
                  windowFromPx={thumbWindowFrom - leftPx}
                  windowToPx={thumbWindowTo - leftPx}
                  selected={clip.id === selectedClipId}
                  active={clip.id === hud?.clipId}
                  multiSource={sourceCount > 1}
                  onBeginGesture={beginGesture}
                />
              );
            })}

            {hud && hudClip && hudClip.track === track && (
              <>
                {hud.snapped && (
                  <div
                    className="snap-line"
                    style={{
                      left: Math.round(
                        (hud.kind === "trim-right" ? clipEndMs(hudClip) : hudClip.timelineStartMs) * pxPerMs,
                      ),
                    }}
                  />
                )}
                <div
                  className="trim-hud"
                  style={{
                    left: Math.max(
                      40,
                      (hud.kind === "trim-right" ? clipEndMs(hudClip) : hudClip.timelineStartMs) * pxPerMs,
                    ),
                  }}
                >
                  {hud.kind === "move" ? (
                    <>
                      {formatTime(hudClip.timelineStartMs)}
                      <span className="trim-delta">
                        {hudClip.timelineStartMs >= hud.originStartMs ? "+" : "−"}
                        {(Math.abs(hudClip.timelineStartMs - hud.originStartMs) / 1000).toFixed(2)} s
                      </span>
                    </>
                  ) : (
                    <>
                      {formatTime(clipDurationMs(hudClip))}
                      <span className="trim-delta">
                        {clipDurationMs(hudClip) >= hud.originDurationMs ? "+" : "−"}
                        {(Math.abs(clipDurationMs(hudClip) - hud.originDurationMs) / 1000).toFixed(2)} s
                      </span>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          ))}

          <div className="playhead" style={{ left: Math.round(playheadMs * pxPerMs) }} />
        </div>
      </div>
      <div className="timeline-bar">
        <div className="timeline-bar-group">
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => zoomBy(1 / 1.5)}
            disabled={pxPerSec <= MIN_PX_PER_SEC}
            title="Dézoomer"
            aria-label="Dézoomer"
          >
            <Icon name="zoomOut" size={15} />
          </button>
          <span className="zoom-value">{formatZoom(pxPerSec)}</span>
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => zoomBy(1.5)}
            disabled={pxPerSec >= MAX_PX_PER_SEC}
            title="Zoomer"
            aria-label="Zoomer"
          >
            <Icon name="zoomIn" size={15} />
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            onClick={zoomToFit}
            title="Ajuster à la fenêtre"
            aria-label="Ajuster à la fenêtre"
          >
            <Icon name="fit" size={15} />
          </button>
        </div>

        <div className="timeline-bar-group">
          <span className="muted timeline-stat">
            {clips.length} clip{clips.length > 1 ? "s" : ""} · {formatTime(totalMs)}
          </span>
          {gaps.length > 0 && (
            <button type="button" className="ghost small warn" onClick={onCloseGaps}>
              <Icon name="magnet" size={15} />
              Fermer {gaps.length} trou{gaps.length > 1 ? "s" : ""}
            </button>
          )}
        </div>

        <span className="muted timeline-tip">
          Poignées = durée · corps = position · Maj = précis
        </span>
      </div>
    </div>
  );
}

/** Échelle lisible : « 4 s » de rush par centimètre d'écran, plutôt que des px/s. */
function formatZoom(pxPerSec: number): string {
  const secondsPerScreenInch = 96 / pxPerSec;
  return secondsPerScreenInch >= 10
    ? `${Math.round(secondsPerScreenInch)} s`
    : `${secondsPerScreenInch.toFixed(1)} s`;
}

/** Nom court du rush, tiré de son chemin, pour étiqueter les clips. */
function sourceLabel(source: SourceInfo): string {
  const name = source.originalPath.split(/[\\/]/).pop() ?? "rush";
  return name.replace(/\.[^.]+$/, "");
}

// Un clip. Mémoïsé : pendant un geste, les clips inchangés ne re-rendent pas.
const ClipView = memo(function ClipView(props: {
  clip: Clip;
  source: SourceInfo;
  leftPx: number;
  widthPx: number;
  pxPerMs: number;
  windowFromPx: number;
  windowToPx: number;
  selected: boolean;
  active: boolean;
  /** Plusieurs rushs dans le projet : on affiche de quel rush vient le clip. */
  multiSource: boolean;
  onBeginGesture: (event: React.PointerEvent, clip: Clip, kind: GestureKind) => void;
}) {
  const {
    clip, source, leftPx, widthPx, pxPerMs, windowFromPx, windowToPx,
    selected, active, multiSource, onBeginGesture,
  } = props;

  // Le créneau a exactement le format du rush de CE clip : sans ça,
  // object-fit: cover rogne chaque image en une tranche verticale.
  const slotPx = Math.round(THUMB_STRIP_PX * sourceAspect(source.probe));
  // Échelle du RUSH à l'écran : un clip accéléré comprime son propre temps,
  // donc vignettes et forme d'onde doivent être comprimées d'autant.
  const pxPerSourceMs = pxPerMs / clip.playbackRate;
  // Sur un clip très court, les poignées rétrécissent pour rester saisissables.
  const handlePx = Math.max(5, Math.min(14, widthPx / 3));

  return (
    <div
      className={"clip" + (selected ? " selected" : "") + (active ? " active" : "")}
      style={{ left: leftPx, width: Math.max(widthPx, 8) }}
      onPointerDown={(event) => onBeginGesture(event, clip, "move")}
    >
      <ClipThumbs
        clip={clip}
        source={source}
        widthPx={widthPx}
        pxPerMs={pxPerSourceMs}
        slotPx={slotPx}
        windowFromPx={windowFromPx}
        windowToPx={windowToPx}
      />
      {source.waveformPath && (
        <div
          className="clip-wave"
          style={{
            backgroundImage: `url("${mediaUrl(source.waveformPath)}")`,
            backgroundSize: `${source.probe.durationMs * pxPerSourceMs}px 100%`,
            backgroundPosition: `-${clip.srcInMs * pxPerSourceMs}px 0`,
          }}
        />
      )}
      <span className="clip-duration">{formatTime(clipDurationMs(clip))}</span>
      {clip.playbackRate !== 1 && (
        <span className="clip-rate" title={`Vitesse ${clip.playbackRate}×`}>
          {clip.playbackRate}×
        </span>
      )}
      {!clip.audioEnabled && (
        <span className="clip-muted" title="Son coupé — la piste du dessous continue de s'entendre">
          <Icon name="soundOff" size={13} />
        </span>
      )}
      {multiSource && (
        <span className="clip-source" title={source.originalPath}>
          {sourceLabel(source)}
        </span>
      )}
      <div
        className="handle handle-l"
        style={{ width: handlePx }}
        onPointerDown={(event) => onBeginGesture(event, clip, "trim-left")}
        title="Ajuster le début du clip"
      />
      <div
        className="handle handle-r"
        style={{ width: handlePx }}
        onPointerDown={(event) => onBeginGesture(event, clip, "trim-right")}
        title="Ajuster la fin du clip"
      />
    </div>
  );
});

// Vignettes : les créneaux sont ancrés sur le temps source ABSOLU, donc leur `key`
// ne change pas quand le clip est redimensionné — les <img> sont réutilisées telles
// quelles au lieu d'être démontées et redécodées à chaque image du geste.
const ClipThumbs = memo(function ClipThumbs(props: {
  clip: Clip;
  source: SourceInfo;
  widthPx: number;
  pxPerMs: number;
  slotPx: number;
  windowFromPx: number;
  windowToPx: number;
}) {
  const { clip, source, widthPx, pxPerMs, slotPx, windowFromPx, windowToPx } = props;
  if (source.thumbPaths.length === 0) return null;

  const slotMs = slotPx / pxPerMs;
  const fromPx = Math.max(0, windowFromPx);
  const toPx = Math.min(widthPx, windowToPx);
  if (toPx <= fromPx) return null;

  const firstSlot = Math.floor((clip.srcInMs + fromPx / pxPerMs) / slotMs);
  const lastSlot = Math.floor((clip.srcInMs + toPx / pxPerMs) / slotMs);
  // Un seul arrondi, en amont : l'écart entre deux vignettes vaut alors
  // exactement slotPx, sans cumul d'erreur le long de la bande.
  const originPx = Math.round(clip.srcInMs * pxPerMs);
  const images = [];
  for (let slot = firstSlot; slot <= lastSlot; slot++) {
    const slotStartMs = slot * slotMs;
    const thumbIndex = Math.min(
      source.thumbPaths.length - 1,
      Math.max(0, Math.floor((slotStartMs + slotMs / 2) / source.thumbIntervalMs)),
    );
    images.push(
      <img
        key={slot}
        src={mediaUrl(source.thumbPaths[thumbIndex])}
        style={{ left: slot * slotPx - originPx, width: slotPx + 1 }}
        alt=""
        draggable={false}
      />,
    );
  }
  return <div className="clip-thumbs">{images}</div>;
});
