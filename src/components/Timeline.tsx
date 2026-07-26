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
import type { PlaybackClock } from "../playback/usePlayback";
import type { CompiledTimeline } from "../timeline/compileTimeline";
import type { Tool } from "./ToolRail";
import type { Clip, SourceInfo, TextOverlay, ZoomRegion } from "../types";
import {
  MIN_TEXT_DURATION_MS,
  MIN_ZOOM_DURATION_MS,
  clipDurationMs,
  clipEndMs,
  clipsOnTrack,
  formatTime,
  quantizeToFrame,
  sortClips,
  sourceAspect,
  timelineTimeToSourceTime,
} from "../types";
import { mediaUrl } from "../ipc";
import { ClipMenu, type ClipMenuTarget } from "./ClipMenu";
import { Icon } from "./Icon";

/** Hauteur de la piste et de la bande audio. Le CSS les lit via des variables :
 *  la largeur d'un créneau de vignette en dépend, elles ne doivent pas diverger.
 *
 *  Ces hauteurs décident du nombre de pistes visibles sans défilement. À 152 px,
 *  deux pistes plus la règle et la bande Titres dépassaient déjà la hauteur par
 *  défaut de la zone : la piste principale sortait de l'écran alors même qu'on
 *  la regardait. Une piste doit rester lisible, pas confortable — c'est
 *  l'aperçu qui montre l'image, la timeline montre la structure. */
const TRACK_HEIGHT_PX = 84;
const AUDIO_LANE_PX = 22;
/** Bordure de `.clip`. Avec box-sizing: border-box elle mange de la hauteur
 *  utile : l'oublier fausse le ratio du créneau et le rognage revient. */
const CLIP_BORDER_PX = 1;
const THUMB_STRIP_PX = TRACK_HEIGHT_PX - 2 * CLIP_BORDER_PX - AUDIO_LANE_PX;
/** Pas de quantification de la fenêtre visible transmise aux vignettes. */
const THUMB_WINDOW_QUANTUM = 128;
/** Écart vertical entre deux pistes. */
const TRACK_GAP_PX = 4;
/** Bandeau de dépôt affiché au-dessus pendant un déplacement. */
const DROP_TRACK_PX = 30;
const TITLE_LANE_PX = 32;
/** Bande des zooms : plus fine, elle ne porte qu'un intervalle et son taux. */
const ZOOM_LANE_PX = 26;
const SNAP_PX = 9;
const EDGE_SCROLL_PX = 48;
const EDGE_SCROLL_SPEED = 20;
const MOVE_THRESHOLD_PX = 5;
/**
 * Durée de maintien avant qu'un appui puisse déplacer un clip.
 *
 * Un simple clic sélectionne, il ne déplace pas : le seuil en distance seul ne
 * suffisait pas, une main qui tremble de six pixels sur un clic déplaçait le
 * montage. Le déplacement demande donc de MAINTENIR le bouton. Contrepartie
 * assumée : on ne peut plus attraper un clip et le jeter d'un geste vif, il
 * faut marquer le temps — c'est le prix d'un montage qu'on ne bouge pas par
 * accident. Le curseur passe en « saisie » dès que le maintien est acquis :
 * c'est ce qui dit que le clip est prêt à suivre.
 */
const MOVE_HOLD_MS = 160;
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
  compiledTimeline: CompiledTimeline;
  clock: PlaybackClock;
  selectedClipId: string | null;
  textOverlays: TextOverlay[];
  anchorTextOverlays: TextOverlay[];
  selectedTextOverlayId: string | null;
  onSelectTextOverlay: (textOverlayId: string | null) => void;
  onSeek: (timelineMs: number) => void;
  onSelect: (clipId: string | null) => void;
  /** Affiche l'image source à `srcMs` pendant un trim (feedback image par image). */
  onPreviewFrame: (sourceId: string, srcMs: number) => void;
  /** Met la lecture en pause avant un geste. */
  onPause: () => void;
  /** Recolle tous les clips bout à bout. */
  onCloseGaps: () => void;
  /** Pistes masquées et pistes verrouillées, pilotées par les en-têtes. */
  hiddenTracks: ReadonlySet<number>;
  lockedTracks: ReadonlySet<number>;
  /** Outil courant : la lame coupe au clic au lieu de déplacer. */
  tool: Tool;
  /** Zooms animés, affichés dans leur propre bande sous les titres. */
  zooms: ZoomRegion[];
  /**
   * Zooms COMMITTÉS. Ils servent de points d'aimantation : viser les positions
   * transitoires ferait suivre l'aimant au zoom que le geste est en train de
   * déplacer — un geste ne mesure jamais ses propres effets.
   */
  anchorZooms: ZoomRegion[];
  selectedZoomId: string | null;
  onSelectZoom: (zoomId: string | null) => void;
  /** Un clip est dans le presse-papiers de session : « Coller » a de quoi poser. */
  canPasteClip: boolean;
  /** Média en cours de dépôt depuis le panneau Médias, sinon null. */
  pendingSource: SourceInfo | null;
  onDropSource: (source: SourceInfo, atMs: number, track: number) => void;
  onCancelDrop: () => void;
  /** Hauteur de la zone timeline, ajustable par la poignée du haut. */
  height: number;
  onHeightChange: (height: number) => void;
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
  /** Instant à partir duquel le maintien est acquis (voir MOVE_HOLD_MS). */
  holdUntilMs: number;
  /** Maintien acquis : le geste peut désormais devenir un déplacement. */
  armed: boolean;
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

type TextGestureKind = "trim-left" | "trim-right" | "move";

interface TextGesture {
  kind: TextGestureKind;
  overlayId: string;
  origin: TextOverlay;
  startClientX: number;
  startScrollLeft: number;
  pointerX: number;
  fine: boolean;
  appliedFine: boolean;
  engaged: boolean;
  /** Mêmes règles de maintien que pour un clip : voir MOVE_HOLD_MS. */
  holdUntilMs: number;
  armed: boolean;
  lastStartMs: number | null;
  lastEndMs: number | null;
  raf: number | null;
  abort: AbortController;
}

interface ZoomGesture {
  kind: TextGestureKind;
  zoomId: string;
  origin: ZoomRegion;
  startClientX: number;
  startScrollLeft: number;
  pointerX: number;
  fine: boolean;
  appliedFine: boolean;
  engaged: boolean;
  /** Mêmes règles de maintien que pour un clip : voir MOVE_HOLD_MS. */
  holdUntilMs: number;
  armed: boolean;
  lastStartMs: number | null;
  lastEndMs: number | null;
  raf: number | null;
  abort: AbortController;
}

interface TextGestureHud {
  overlayId: string;
  kind: TextGestureKind;
  snapped: boolean;
  edge: "start" | "end";
}

export function Timeline(props: Props) {
  if (import.meta.env.DEV) console.count("[render] Timeline");
  const {
    clips, anchorClips, sources, pxPerSec, onPxPerSecChange, compiledTimeline, clock,
    selectedClipId, textOverlays, anchorTextOverlays, selectedTextOverlayId,
    onSelectTextOverlay, onSeek, onSelect, onPreviewFrame, onPause, onCloseGaps,
    zooms, anchorZooms, selectedZoomId, onSelectZoom,
    hiddenTracks, lockedTracks, tool, canPasteClip, pendingSource, onDropSource, onCancelDrop,
    height, onHeightChange, dispatch,
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Colonne des en-têtes : hors du défilement horizontal, recalée en vertical. */
  const headersRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 1000 });
  const [hud, setHud] = useState<GestureHud | null>(null);
  /** Clip sur lequel un menu contextuel est ouvert, sinon null. */
  const [clipMenu, setClipMenu] = useState<ClipMenuTarget | null>(null);
  /**
   * Clip dont le maintien est acquis : il est prêt à suivre le pointeur.
   *
   * Posé UNE fois quand le maintien est acquis, effacé UNE fois à la fin du
   * geste — donc deux rendus par geste, jamais un par image. Sans ce retour,
   * seul le curseur changeait, et le curseur est ce qu'on regarde le moins
   * quand on vise un clip.
   */
  const [grabbedClipId, setGrabbedClipId] = useState<string | null>(null);
  const [textHud, setTextHud] = useState<TextGestureHud | null>(null);
  const [zoomHud, setZoomHud] = useState<TextGestureHud | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const textGestureRef = useRef<TextGesture | null>(null);
  const zoomGestureRef = useRef<ZoomGesture | null>(null);
  const zoomAnchorRef = useRef<{ timeMs: number; viewportX: number } | null>(null);
  const playheadElementRef = useRef<HTMLDivElement | null>(null);

  const pxPerMs = pxPerSec / 1000;
  const sorted = sortClips(clips);
  const totalMs = compiledTimeline.video.durationMs;
  const totalPx = totalMs * pxPerMs;
  // Un trou, c'est un instant où RIEN n'est visible : il se lit sur le montage
  // aplati, pas sur la seule piste principale — et sans les pistes désactivées,
  // sinon la timeline annoncerait des trous que l'export n'a pas, ou l'inverse.
  const gaps = compiledTimeline.gaps;
  const sourceCount = compiledTimeline.sourceCount;
  // Une piste vide n'est proposée que pendant un déplacement : le reste du
  // temps elle ne ferait qu'occuper de la hauteur pour rien.
  //
  // Calculé sur anchorClips (COMMITTÉS), jamais sur clips (transitoires) :
  // sinon, pendant un déplacement, chaque image qui pose le clip sur la piste
  // fantôme fait grimper le nombre de pistes de un, ce qui fait remonter la
  // piste fantôme d'autant — si le pointeur ne bouge pas, il se retrouve
  // de nouveau dessus l'image suivante, et ainsi de suite. Un montage s'est
  // retrouvé avec 76 pistes de cette façon en moins de deux secondes.
  const occupied = compiledTimeline.trackCount;
  // Piste vide proposée UNIQUEMENT pendant le dépôt d'un média venu du panneau :
  // là, la question « au-dessus ou dans les pistes existantes ? » se pose
  // vraiment, puisqu'on introduit quelque chose de neuf.
  //
  // Elle ne s'affiche PLUS pendant le déplacement d'un clip déjà posé. Elle
  // apparaissait dès l'appui, avant le moindre mouvement, et poussait toutes
  // les pistes vers le bas : sur un montage à deux pistes, maintenir le clic
  // pour intervertir deux clips faisait sauter la timeline entière alors que
  // le seul choix réel était « l'une ou l'autre ». Une rangée qui n'offre un
  // choix qu'une fois sur dix ne vaut pas un décalage de toute la vue à chaque
  // prise. Pour poser un clip existant sur une piste neuve, le menu du clic
  // droit propose « Nouvelle piste au-dessus ».
  const dropTrackVisible = pendingSource !== null;
  const tracks = occupied + (dropTrackVisible ? 1 : 0);
  const trackOrder = Array.from({ length: tracks }, (_, i) => tracks - 1 - i);

  // Valeurs fraîches lisibles depuis la boucle rAF sans la faire dépendre du rendu.
  const liveRef = useRef({
    pxPerMs,
    anchorClips,
    anchorTextOverlays,
    anchorZooms,
    sources,
    maxTrack: occupied,
    totalMs,
  });
  liveRef.current = {
    pxPerMs,
    anchorClips,
    anchorTextOverlays,
    anchorZooms,
    sources,
    maxTrack: occupied,
    totalMs,
  };

  // Démontage pendant un geste (fermeture du projet, par exemple) : sans ce
  // nettoyage, la boucle rAF continue de tourner, les écouteurs fenêtre
  // survivent et les classes de curseur restent posées sur <body> — l'appli
  // entière se retrouve avec un curseur de déplacement définitif.
  useEffect(
    () => () => {
      document.body.classList.remove("trimming", "moving", "resizing-v");
      for (const ref of [gestureRef, textGestureRef, zoomGestureRef]) {
        const gesture = ref.current;
        if (!gesture) continue;
        if (gesture.raf !== null) cancelAnimationFrame(gesture.raf);
        gesture.abort.abort();
        ref.current = null;
      }
    },
    [],
  );

  // --- Fenêtre visible -------------------------------------------------------
  const syncViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Les en-têtes suivent le défilement VERTICAL des pistes sans passer par
    // l'état React : une écriture directe de transform, donc rien à recalculer.
    if (headersRef.current) {
      headersRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    }
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
        const playheadMs = clock.getPlayheadMs();
        const anchorPx = playheadMs * pxPerMs - el.scrollLeft;
        zoomAnchorRef.current = {
          timeMs: playheadMs,
          viewportX: Math.min(Math.max(anchorPx, 0), el.clientWidth),
        };
      }
      onPxPerSecChange(next);
    },
    [clock, onPxPerSecChange, pxPerMs, pxPerSec],
  );

  const zoomToFit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || totalMs <= 0) return;
    const target = ((el.clientWidth - 48) / totalMs) * 1000;
    zoomAnchorRef.current = { timeMs: 0, viewportX: 24 };
    onPxPerSecChange(Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, target)));
  }, [onPxPerSecChange, totalMs]);

  useEffect(() => {
    let lastViewportSync = 0;
    return clock.subscribe((playheadMs) => {
      const playheadPx = playheadMs * pxPerMs;
      if (playheadElementRef.current) {
        playheadElementRef.current.style.transform = `translate3d(${playheadPx}px, 0, 0)`;
      }
      const el = scrollRef.current;
      if (!el) return;
      if (playheadPx < el.scrollLeft + 40 || playheadPx > el.scrollLeft + el.clientWidth - 120) {
        el.scrollLeft = Math.max(0, playheadPx - el.clientWidth / 3);
        const now = performance.now();
        if (now - lastViewportSync >= 33) {
          lastViewportSync = now;
          syncViewport();
        }
      }
    });
  }, [clock, pxPerMs, syncViewport]);

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
    const { pxPerMs: livePx, anchorClips: liveAnchors, sources: liveSources } =
      liveRef.current;
    const livePlayhead = clock.getPlayheadMs();
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
      // Le maintien d'abord : tant qu'il n'est pas acquis, l'appui reste une
      // sélection, quelle que soit la distance parcourue.
      if (!gesture.armed) {
        if (performance.now() < gesture.holdUntilMs) {
          gesture.raf = requestAnimationFrame(runGestureFrame);
          return;
        }
        gesture.armed = true;
        // On rebase l'origine sur la position COURANTE : sans ça, le chemin
        // parcouru pendant l'attente s'appliquerait d'un coup et le clip
        // sauterait à l'instant où le maintien est acquis.
        gesture.startClientX = gesture.pointerX + scrollDelta;
        gesture.startClientY = gesture.pointerY;
        // Curseur ET clip : le signal que le maintien a été pris en compte.
        document.body.classList.add("moving");
        setGrabbedClipId(gesture.clipId);
        gesture.raf = requestAnimationFrame(runGestureFrame);
        return;
      }
      if (Math.abs(rawPx) < MOVE_THRESHOLD_PX) {
        gesture.raf = requestAnimationFrame(runGestureFrame);
        return;
      }
      gesture.engaged = true;
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
      // plus fin que les pistes, un calcul par division se tromperait. Borné à
      // au plus une piste neuve au-dessus des pistes committées : c'est le
      // filet visuel, le réducteur applique la même borne sur les données.
      const track = Math.min(
        trackUnderPointer(gesture.pointerY, gesture.origin.track),
        liveRef.current.maxTrack,
      );
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

  const openClipMenu = useCallback(
    (event: React.MouseEvent, clip: Clip) => {
      event.preventDefault();
      event.stopPropagation();
      // Un geste est en cours (clic gauche maintenu) : ouvrir un menu par-dessus
      // laisserait le clip suivre le pointeur derrière lui, et le premier clic
      // dans le menu conclurait le déplacement à un endroit non voulu.
      if (gestureRef.current || textGestureRef.current || zoomGestureRef.current) return;
      // Une piste verrouillée ne propose rien : c'est tout l'intérêt du verrou.
      if (lockedTracks.has(clip.track)) return;
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const timelineMs =
        (el.scrollLeft + event.clientX - rect.left) / liveRef.current.pxPerMs;
      onSelect(clip.id);
      setClipMenu({ clipId: clip.id, x: event.clientX, y: event.clientY, timelineMs });
    },
    [lockedTracks, onSelect],
  );

  // Le menu vise un clip précis : si ce clip disparaît (suppression, annulation,
  // changement de projet), le menu n'a plus d'objet.
  const menuClip = clipMenu ? clips.find((c) => c.id === clipMenu.clipId) ?? null : null;
  useEffect(() => {
    if (clipMenu && !menuClip) setClipMenu(null);
  }, [clipMenu, menuClip]);

  const finishGesture = useCallback(
    (commit: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (gesture.raf !== null) cancelAnimationFrame(gesture.raf);
      gesture.abort.abort();
      gestureRef.current = null;
      document.body.classList.remove("trimming", "moving");
      setHud(null);
      setGrabbedClipId(null);
      if (gesture.engaged) dispatch({ type: commit ? "GESTURE_COMMIT" : "GESTURE_CANCEL" });
    },
    [dispatch],
  );

  const beginGesture = useCallback(
    (event: React.PointerEvent, clip: Clip, kind: GestureKind) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      // Piste verrouillée : rien ne bouge, on ne sélectionne même pas — c'est
      // tout l'intérêt du verrou.
      if (lockedTracks.has(clip.track)) return;
      if (gestureRef.current) finishGesture(true);
      onPause();
      onSelect(clip.id);

      // Outil lame : on coupe là où on clique, et aucun geste ne démarre.
      if (tool === "blade" && kind === "move") {
        const el = scrollRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const timelineMs = (el.scrollLeft + event.clientX - rect.left) / liveRef.current.pxPerMs;
        dispatch({ type: "SPLIT_AT", timelineMs });
        return;
      }

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
        // Un trim est immédiat ; un déplacement attend le maintien puis le seuil.
        engaged: kind !== "move",
        holdUntilMs: performance.now() + MOVE_HOLD_MS,
        armed: kind !== "move",
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
    [dispatch, finishGesture, lockedTracks, onPause, onSelect, runGestureFrame, tool],
  );

  const runTextGestureFrame = useCallback(() => {
    const gesture = textGestureRef.current;
    if (!gesture) return;
    const el = scrollRef.current;
    const live = liveRef.current;

    if (el && gesture.engaged) {
      const rect = el.getBoundingClientRect();
      const x = gesture.pointerX - rect.left;
      if (x < EDGE_SCROLL_PX) el.scrollLeft = Math.max(0, el.scrollLeft - EDGE_SCROLL_SPEED);
      else if (x > rect.width - EDGE_SCROLL_PX) el.scrollLeft += EDGE_SCROLL_SPEED;
    }

    const scrollDelta = el ? el.scrollLeft - gesture.startScrollLeft : 0;
    if (gesture.fine !== gesture.appliedFine) {
      const previousRawPx = gesture.pointerX - gesture.startClientX + scrollDelta;
      gesture.startClientX =
        gesture.pointerX +
        scrollDelta -
        previousRawPx * (gesture.fine ? FINE_FACTOR : 1 / FINE_FACTOR);
      gesture.appliedFine = gesture.fine;
    }
    const rawPx = gesture.pointerX - gesture.startClientX + scrollDelta;
    if (!gesture.engaged) {
      // Le maintien d'abord : tant qu'il n'est pas acquis, l'appui reste une
      // sélection, quelle que soit la distance parcourue.
      if (!gesture.armed) {
        if (performance.now() < gesture.holdUntilMs) {
          gesture.raf = requestAnimationFrame(runTextGestureFrame);
          return;
        }
        gesture.armed = true;
        // On rebase l'origine sur la position COURANTE : sans ça, le chemin
        // parcouru pendant l'attente s'appliquerait d'un coup et le clip
        // sauterait à l'instant où le maintien est acquis.
        gesture.startClientX = gesture.pointerX + scrollDelta;
        // Le curseur bascule ici, pas à l'engagement : c'est le signal que le
        // maintien a été pris en compte et que le clip suivra.
        document.body.classList.add("moving");
        gesture.raf = requestAnimationFrame(runTextGestureFrame);
        return;
      }
      if (Math.abs(rawPx) < MOVE_THRESHOLD_PX) {
        gesture.raf = requestAnimationFrame(runTextGestureFrame);
        return;
      }
      gesture.engaged = true;
    }

    const deltaMs = (gesture.fine ? rawPx / FINE_FACTOR : rawPx) / live.pxPerMs;
    const toleranceMs = SNAP_PX / live.pxPerMs;
    const anchors = [0, live.totalMs, clock.getPlayheadMs()];
    for (const clip of live.anchorClips) {
      anchors.push(clip.timelineStartMs, clipEndMs(clip));
    }
    for (const overlay of live.anchorTextOverlays) {
      if (overlay.id !== gesture.overlayId) {
        anchors.push(overlay.timelineStartMs, overlay.timelineEndMs);
      }
    }
    const snap = (raw: number): { value: number; snapped: boolean } => {
      let value = Math.round(raw / 10) * 10;
      let distance = toleranceMs;
      let snapped = false;
      for (const anchor of [...anchors, Math.round(raw / 1000) * 1000]) {
        const nextDistance = Math.abs(anchor - raw);
        if (nextDistance < distance) {
          value = anchor;
          distance = nextDistance;
          snapped = true;
        }
      }
      return { value, snapped };
    };

    const durationMs = gesture.origin.timelineEndMs - gesture.origin.timelineStartMs;
    let timelineStartMs = gesture.origin.timelineStartMs;
    let timelineEndMs = gesture.origin.timelineEndMs;
    let snapped = false;
    let snapEdge: "start" | "end" = gesture.kind === "trim-right" ? "end" : "start";
    if (gesture.kind === "move") {
      const rawStart = gesture.origin.timelineStartMs + deltaMs;
      const head = snap(rawStart);
      const tail = snap(rawStart + durationMs);
      if (
        tail.snapped &&
        (!head.snapped ||
          Math.abs(tail.value - durationMs - rawStart) < Math.abs(head.value - rawStart))
      ) {
        timelineStartMs = tail.value - durationMs;
        snapped = true;
        snapEdge = "end";
      } else {
        timelineStartMs = head.value;
        snapped = head.snapped;
      }
      timelineStartMs = Math.max(0, Math.min(live.totalMs - durationMs, timelineStartMs));
      timelineEndMs = timelineStartMs + durationMs;
    } else if (gesture.kind === "trim-left") {
      const result = snap(gesture.origin.timelineStartMs + deltaMs);
      timelineStartMs = Math.max(
        0,
        Math.min(gesture.origin.timelineEndMs - MIN_TEXT_DURATION_MS, result.value),
      );
      snapped = result.snapped;
    } else {
      const result = snap(gesture.origin.timelineEndMs + deltaMs);
      timelineEndMs = Math.min(
        live.totalMs,
        Math.max(gesture.origin.timelineStartMs + MIN_TEXT_DURATION_MS, result.value),
      );
      snapped = result.snapped;
      snapEdge = "end";
    }

    if (timelineStartMs !== gesture.lastStartMs || timelineEndMs !== gesture.lastEndMs) {
      gesture.lastStartMs = timelineStartMs;
      gesture.lastEndMs = timelineEndMs;
      dispatch({
        type: "TEXT_TRANSIENT",
        textOverlayId: gesture.overlayId,
        timelineStartMs,
        timelineEndMs,
      });
    }
    setTextHud((previous) =>
      previous?.snapped === snapped && previous.edge === snapEdge
        ? previous
        : { overlayId: gesture.overlayId, kind: gesture.kind, snapped, edge: snapEdge },
    );
    gesture.raf = requestAnimationFrame(runTextGestureFrame);
  }, [clock, dispatch]);

  const finishTextGesture = useCallback(
    (commit: boolean) => {
      const gesture = textGestureRef.current;
      if (!gesture) return;
      if (gesture.raf !== null) cancelAnimationFrame(gesture.raf);
      gesture.abort.abort();
      textGestureRef.current = null;
      document.body.classList.remove("trimming", "moving");
      setTextHud(null);
      if (gesture.engaged) {
        dispatch({ type: commit ? "TEXT_GESTURE_COMMIT" : "TEXT_GESTURE_CANCEL" });
      }
    },
    [dispatch],
  );


  // --- Gestes sur un zoom ------------------------------------------------------
  // Meme moteur que les titres : boucle rAF unique, etat transitoire, aucune
  // entree d'historique avant le relachement. La seule difference tient a la
  // regle de non-chevauchement, appliquee par le reducteur : le zoom bute
  // contre ses voisins au lieu de les repousser.
  const runZoomGestureFrame = useCallback(() => {
    const gesture = zoomGestureRef.current;
    if (!gesture) return;
    const el = scrollRef.current;
    const live = liveRef.current;

    if (el && gesture.engaged) {
      const rect = el.getBoundingClientRect();
      const x = gesture.pointerX - rect.left;
      if (x < EDGE_SCROLL_PX) el.scrollLeft = Math.max(0, el.scrollLeft - EDGE_SCROLL_SPEED);
      else if (x > rect.width - EDGE_SCROLL_PX) el.scrollLeft += EDGE_SCROLL_SPEED;
    }

    const scrollDelta = el ? el.scrollLeft - gesture.startScrollLeft : 0;
    if (gesture.fine !== gesture.appliedFine) {
      const previousRawPx = gesture.pointerX - gesture.startClientX + scrollDelta;
      gesture.startClientX =
        gesture.pointerX +
        scrollDelta -
        previousRawPx * (gesture.fine ? FINE_FACTOR : 1 / FINE_FACTOR);
      gesture.appliedFine = gesture.fine;
    }
    const rawPx = gesture.pointerX - gesture.startClientX + scrollDelta;
    if (!gesture.engaged) {
      if (!gesture.armed) {
        if (performance.now() < gesture.holdUntilMs) {
          gesture.raf = requestAnimationFrame(runZoomGestureFrame);
          return;
        }
        gesture.armed = true;
        gesture.startClientX = gesture.pointerX + scrollDelta;
        document.body.classList.add("moving");
        gesture.raf = requestAnimationFrame(runZoomGestureFrame);
        return;
      }
      if (Math.abs(rawPx) < MOVE_THRESHOLD_PX) {
        gesture.raf = requestAnimationFrame(runZoomGestureFrame);
        return;
      }
      gesture.engaged = true;
    }

    const deltaMs = (gesture.fine ? rawPx / FINE_FACTOR : rawPx) / live.pxPerMs;
    const toleranceMs = SNAP_PX / live.pxPerMs;
    // On s'aimante sur ce qui a un sens pour un mouvement de camera : les
    // coupes, les bords du montage, le playhead, et les autres zooms.
    const anchors = [0, live.totalMs, clock.getPlayheadMs()];
    for (const clip of live.anchorClips) {
      anchors.push(clip.timelineStartMs, clipEndMs(clip));
    }
    for (const other of live.anchorZooms) {
      if (other.id !== gesture.zoomId) {
        anchors.push(other.timelineStartMs, other.timelineEndMs);
      }
    }
    const snap = (raw: number): { value: number; snapped: boolean } => {
      let value = Math.round(raw / 10) * 10;
      let distance = toleranceMs;
      let snapped = false;
      for (const anchor of [...anchors, Math.round(raw / 1000) * 1000]) {
        const nextDistance = Math.abs(anchor - raw);
        if (nextDistance < distance) {
          value = anchor;
          distance = nextDistance;
          snapped = true;
        }
      }
      return { value, snapped };
    };

    const durationMs = gesture.origin.timelineEndMs - gesture.origin.timelineStartMs;
    let timelineStartMs = gesture.origin.timelineStartMs;
    let timelineEndMs = gesture.origin.timelineEndMs;
    let snapped = false;
    let snapEdge: "start" | "end" = gesture.kind === "trim-right" ? "end" : "start";
    if (gesture.kind === "move") {
      const rawStart = gesture.origin.timelineStartMs + deltaMs;
      const head = snap(rawStart);
      const tail = snap(rawStart + durationMs);
      if (
        tail.snapped &&
        (!head.snapped ||
          Math.abs(tail.value - durationMs - rawStart) < Math.abs(head.value - rawStart))
      ) {
        timelineStartMs = tail.value - durationMs;
        snapped = true;
        snapEdge = "end";
      } else {
        timelineStartMs = head.value;
        snapped = head.snapped;
      }
      timelineStartMs = Math.max(0, Math.min(live.totalMs - durationMs, timelineStartMs));
      timelineEndMs = timelineStartMs + durationMs;
    } else if (gesture.kind === "trim-left") {
      const result = snap(gesture.origin.timelineStartMs + deltaMs);
      timelineStartMs = Math.max(
        0,
        Math.min(gesture.origin.timelineEndMs - MIN_ZOOM_DURATION_MS, result.value),
      );
      snapped = result.snapped;
    } else {
      const result = snap(gesture.origin.timelineEndMs + deltaMs);
      timelineEndMs = Math.min(
        live.totalMs,
        Math.max(gesture.origin.timelineStartMs + MIN_ZOOM_DURATION_MS, result.value),
      );
      snapped = result.snapped;
      snapEdge = "end";
    }

    if (timelineStartMs !== gesture.lastStartMs || timelineEndMs !== gesture.lastEndMs) {
      gesture.lastStartMs = timelineStartMs;
      gesture.lastEndMs = timelineEndMs;
      dispatch({
        type: "ZOOM_TRANSIENT",
        zoomId: gesture.zoomId,
        timelineStartMs,
        timelineEndMs,
      });
    }

    setZoomHud((previous) =>
      previous && previous.snapped === snapped && previous.edge === snapEdge
        ? previous
        : { overlayId: gesture.zoomId, kind: gesture.kind, snapped, edge: snapEdge },
    );

    gesture.raf = requestAnimationFrame(runZoomGestureFrame);
  }, [clock, dispatch]);

  const finishZoomGesture = useCallback(
    (commit: boolean) => {
      const gesture = zoomGestureRef.current;
      if (!gesture) return;
      if (gesture.raf !== null) cancelAnimationFrame(gesture.raf);
      gesture.abort.abort();
      zoomGestureRef.current = null;
      document.body.classList.remove("trimming", "moving");
      setZoomHud(null);
      if (gesture.engaged) {
        dispatch({ type: commit ? "ZOOM_GESTURE_COMMIT" : "ZOOM_GESTURE_CANCEL" });
      }
    },
    [dispatch],
  );

  const beginZoomGesture = useCallback(
    (event: React.PointerEvent, zoom: ZoomRegion, kind: TextGestureKind) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      if (zoomGestureRef.current) finishZoomGesture(true);
      onPause();
      onSelectZoom(zoom.id);

      const abort = new AbortController();
      const gesture: ZoomGesture = {
        kind,
        zoomId: zoom.id,
        origin: { ...zoom },
        startClientX: event.clientX,
        startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
        pointerX: event.clientX,
        fine: event.shiftKey,
        appliedFine: event.shiftKey,
        engaged: kind !== "move",
        holdUntilMs: performance.now() + MOVE_HOLD_MS,
        armed: kind !== "move",
        lastStartMs: null,
        lastEndMs: null,
        raf: null,
        abort,
      };
      zoomGestureRef.current = gesture;
      if (kind !== "move") document.body.classList.add("trimming");

      const options = { signal: abort.signal } as const;
      window.addEventListener(
        "pointermove",
        (moveEvent: PointerEvent) => {
          gesture.pointerX = moveEvent.clientX;
          gesture.fine = moveEvent.shiftKey;
        },
        options,
      );
      window.addEventListener("pointerup", () => finishZoomGesture(true), options);
      window.addEventListener("pointercancel", () => finishZoomGesture(false), options);
      window.addEventListener(
        "keydown",
        (keyEvent: KeyboardEvent) => {
          if (keyEvent.key === "Escape") {
            keyEvent.preventDefault();
            finishZoomGesture(false);
          }
        },
        options,
      );

      gesture.raf = requestAnimationFrame(runZoomGestureFrame);
    },
    [finishZoomGesture, onPause, onSelectZoom, runZoomGestureFrame],
  );

  const beginTextGesture = useCallback(
    (event: React.PointerEvent, overlay: TextOverlay, kind: TextGestureKind) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      if (textGestureRef.current) finishTextGesture(true);
      onPause();
      onSelectTextOverlay(overlay.id);

      const abort = new AbortController();
      const gesture: TextGesture = {
        kind,
        overlayId: overlay.id,
        origin: { ...overlay },
        startClientX: event.clientX,
        startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
        pointerX: event.clientX,
        fine: event.shiftKey,
        appliedFine: event.shiftKey,
        engaged: kind !== "move",
        holdUntilMs: performance.now() + MOVE_HOLD_MS,
        armed: kind !== "move",
        lastStartMs: null,
        lastEndMs: null,
        raf: null,
        abort,
      };
      textGestureRef.current = gesture;
      if (kind !== "move") document.body.classList.add("trimming");
      const options = { signal: abort.signal } as const;
      window.addEventListener(
        "pointermove",
        (moveEvent: PointerEvent) => {
          gesture.pointerX = moveEvent.clientX;
          gesture.fine = moveEvent.shiftKey;
        },
        options,
      );
      window.addEventListener("pointerup", () => finishTextGesture(true), options);
      window.addEventListener("pointercancel", () => finishTextGesture(false), options);
      window.addEventListener(
        "keydown",
        (keyEvent: KeyboardEvent) => {
          if (keyEvent.key === "Escape") {
            keyEvent.preventDefault();
            finishTextGesture(false);
          }
        },
        options,
      );
      gesture.raf = requestAnimationFrame(runTextGestureFrame);
    },
    [finishTextGesture, onPause, onSelectTextOverlay, runTextGestureFrame],
  );

  // Filet de sécurité : jamais de geste orphelin au démontage.
  useEffect(() => {
    return () => {
      gestureRef.current?.abort.abort();
      textGestureRef.current?.abort.abort();
      document.body.classList.remove("trimming", "moving");
    };
  }, []);

  // --- Dépôt d'un média venu du panneau Médias --------------------------------
  // Le geste est démarré par le panneau, mais c'est la timeline qui connaît la
  // géométrie : c'est donc elle qui suit le pointeur et décide de la position.
  const [dropTarget, setDropTarget] = useState<{ atMs: number; track: number } | null>(null);

  useEffect(() => {
    if (!pendingSource) {
      setDropTarget(null);
      return;
    }
    const abort = new AbortController();
    const options = { signal: abort.signal } as const;

    /** Position visée, ou null si le pointeur n'est pas sur la timeline. */
    const resolve = (event: PointerEvent): { atMs: number; track: number } | null => {
      const el = scrollRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return null;
      }
      const atMs = Math.max(
        0,
        (el.scrollLeft + event.clientX - rect.left) / liveRef.current.pxPerMs,
      );
      const track = trackUnderPointer(event.clientY, 0);
      return lockedTracks.has(track) ? null : { atMs, track };
    };

    window.addEventListener(
      "pointermove",
      (event: PointerEvent) => setDropTarget(resolve(event)),
      options,
    );
    window.addEventListener(
      "pointerup",
      (event: PointerEvent) => {
        const target = resolve(event);
        if (target) onDropSource(pendingSource, target.atMs, target.track);
        else onCancelDrop();
      },
      options,
    );
    window.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (event.key === "Escape") onCancelDrop();
      },
      options,
    );
    return () => abort.abort();
  }, [lockedTracks, onCancelDrop, onDropSource, pendingSource, trackUnderPointer]);

  // --- Hauteur de la zone timeline ---------------------------------------------
  const beginResize = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = height;
      const abort = new AbortController();
      const options = { signal: abort.signal } as const;
      document.body.classList.add("resizing-v");
      window.addEventListener(
        "pointermove",
        (move: PointerEvent) => {
          // Tirer vers le haut agrandit la timeline : elle grandit vers l'aperçu.
          onHeightChange(startHeight + (startY - move.clientY));
        },
        options,
      );
      const stop = () => {
        document.body.classList.remove("resizing-v");
        abort.abort();
      };
      window.addEventListener("pointerup", stop, options);
      window.addEventListener("pointercancel", stop, options);
    },
    [height, onHeightChange],
  );

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
          "--title-h": `${TITLE_LANE_PX}px`,
          "--zoom-h": `${ZOOM_LANE_PX}px`,
          // La zone de pistes grandit avec leur nombre, jusqu'à un plafond
          // au-delà duquel elle défile verticalement.
          height: `${height}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="timeline-grip"
        onPointerDown={beginResize}
        title="Ajuster la hauteur de la timeline"
        role="separator"
        aria-orientation="horizontal"
      />

      <div className="timeline-body">
        {/* Colonne d'en-têtes : hors du défilement horizontal, donc toujours
            lisible, mais recalée sur le défilement vertical des pistes. */}
        <div className="track-headers">
          <div className="headers-inner" ref={headersRef}>
            <div className="headers-spacer" />
            <div className="title-lane-head">
              <Icon name="text" size={14} />
              <span>Titres</span>
            </div>
            <div className="zoom-lane-head">
              <Icon name="search" size={13} />
              <span>Zooms</span>
            </div>
            {trackOrder.map((track) => {
              if (track >= occupied) {
                return <div key={`head-drop-${track}`} className="track-head track-head-drop" />;
              }
              const onTrack = clipsOnTrack(clips, track);
              const audible = onTrack.some((clip) => clip.audioEnabled);
              const hidden = hiddenTracks.has(track);
              const locked = lockedTracks.has(track);
              return (
                <div
                  key={`head-${track}`}
                  className={
                    "track-head" +
                    (track === 0 ? " track-head-base" : "") +
                    (hidden ? " is-hidden" : "") +
                    (locked ? " is-locked" : "")
                  }
                >
                  <span className="track-label">V{track + 1}</span>
                  <div className="track-buttons">
                    <button
                      type="button"
                      className={"icon-btn ghost tiny" + (hidden ? " active" : "")}
                      onClick={() => dispatch({ type: "TOGGLE_TRACK_HIDDEN", track })}
                      title={
                        hidden
                          ? "Réactiver la piste (image et son)"
                          : "Désactiver la piste : elle disparaît de l'aperçu ET de l'export"
                      }
                      aria-label={hidden ? "Réactiver la piste" : "Désactiver la piste"}
                    >
                      <Icon name={hidden ? "eyeOff" : "eye"} size={14} />
                    </button>
                    <button
                      type="button"
                      className={"icon-btn ghost tiny" + (locked ? " active" : "")}
                      onClick={() => dispatch({ type: "TOGGLE_TRACK_LOCKED", track })}
                      title={locked ? "Déverrouiller la piste" : "Verrouiller la piste"}
                      aria-label={locked ? "Déverrouiller la piste" : "Verrouiller la piste"}
                    >
                      <Icon name={locked ? "lock" : "unlock"} size={14} />
                    </button>
                    <button
                      type="button"
                      className={"icon-btn ghost tiny" + (audible ? "" : " active")}
                      onClick={() =>
                        dispatch({ type: "SET_TRACK_AUDIO", track, audioEnabled: !audible })
                      }
                      disabled={onTrack.length === 0}
                      title={audible ? "Couper le son de la piste" : "Rendre le son à la piste"}
                      aria-label={audible ? "Couper le son de la piste" : "Rendre le son à la piste"}
                    >
                      <Icon name={audible ? "sound" : "soundOff"} size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

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

          <div
            className="title-lane"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) {
                onSelectTextOverlay(null);
                onSelect(null);
                handleScrubDown(event);
              }
            }}
            onPointerMove={(event) => {
              if (event.target === event.currentTarget) handleScrubMove(event);
            }}
          >
            {textOverlays.map((overlay) => {
              const leftPx = Math.round(overlay.timelineStartMs * pxPerMs);
              const widthPx = Math.max(
                12,
                Math.round(overlay.timelineEndMs * pxPerMs) - leftPx,
              );
              if (leftPx + widthPx < visibleFromPx || leftPx > visibleToPx) return null;
              return (
                <TextOverlayView
                  key={overlay.id}
                  overlay={overlay}
                  leftPx={leftPx}
                  widthPx={widthPx}
                  selected={overlay.id === selectedTextOverlayId}
                  active={overlay.id === textHud?.overlayId}
                  onBeginGesture={beginTextGesture}
                />
              );
            })}
            {textHud?.snapped && (
              <div
                className="snap-line title-snap-line"
                style={{
                  left: Math.round(
                    ((textHud.edge === "end"
                      ? textOverlays.find((overlay) => overlay.id === textHud.overlayId)
                          ?.timelineEndMs
                      : textOverlays.find((overlay) => overlay.id === textHud.overlayId)
                          ?.timelineStartMs) ?? 0) * pxPerMs,
                  ),
                }}
              />
            )}
          </div>

          {/* Bande des zooms. Un zoom n'appartient à aucune piste : il agit sur
              l'image de SORTIE, donc il vit sur sa propre ligne, sous les
              titres et au-dessus des pistes. */}
          <div
            className="zoom-lane"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return;
              onSelectZoom(null);
              handleScrubDown(event);
            }}
            onPointerMove={(event) => {
              if (event.target === event.currentTarget) handleScrubMove(event);
            }}
          >
            {zooms.map((zoom) => {
              const leftPx = zoom.timelineStartMs * pxPerMs;
              const widthPx = Math.max(6, (zoom.timelineEndMs - zoom.timelineStartMs) * pxPerMs);
              return (
                <div
                  key={zoom.id}
                  className={
                    "zoom-clip" +
                    (zoom.id === selectedZoomId ? " selected" : "") +
                    (zoom.id === zoomHud?.overlayId ? " grabbed" : "")
                  }
                  style={{ left: leftPx, width: widthPx }}
                  onPointerDown={(event) => beginZoomGesture(event, zoom, "move")}
                  title={`Zoom ${zoom.scale.toFixed(2)}× · ${formatTime(zoom.timelineStartMs)} - ${formatTime(zoom.timelineEndMs)}`}
                >
                  <span>{zoom.scale.toFixed(1)}×</span>
                  {/* Poignées de rognage : elles rétrécissent sur un zoom court pour
                      rester saisissables sans manger tout le corps du bloc. */}
                  <i
                    className="zoom-handle zoom-handle-l"
                    style={{ width: Math.max(4, Math.min(10, widthPx / 3)) }}
                    onPointerDown={(event) => beginZoomGesture(event, zoom, "trim-left")}
                  />
                  <i
                    className="zoom-handle zoom-handle-r"
                    style={{ width: Math.max(4, Math.min(10, widthPx / 3)) }}
                    onPointerDown={(event) => beginZoomGesture(event, zoom, "trim-right")}
                  />
                  {zoom.id === zoomHud?.overlayId && zoomHud.snapped && (
                    <i
                      className={
                        "zoom-snap" + (zoomHud.edge === "end" ? " zoom-snap-end" : "")
                      }
                      aria-hidden="true"
                    />
                  )}
                </div>
              );
            })}
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
              (track >= occupied ? " track-drop" : "") +
              (hiddenTracks.has(track) ? " track-hidden" : "") +
              (lockedTracks.has(track) ? " track-locked" : "")
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
            {/* Repère de dépôt : la durée réelle du média, à l'endroit exact où
                il tombera si on relâche maintenant. */}
            {dropTarget && pendingSource && dropTarget.track === track && (
              <div
                className="drop-ghost"
                style={{
                  left: Math.round(dropTarget.atMs * pxPerMs),
                  width: Math.max(3, Math.round(pendingSource.probe.durationMs * pxPerMs)),
                }}
              >
                <span>{formatTime(dropTarget.atMs)}</span>
              </div>
            )}

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
                  grabbed={clip.id === grabbedClipId}
                  onBeginGesture={beginGesture}
                  onContextMenu={openClipMenu}
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

          <div className="playhead" ref={playheadElementRef} style={{ left: 0 }} />
        </div>
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
          <button
            type="button"
            className="ghost small"
            onClick={() => dispatch({ type: "ADD_ZOOM", atMs: clock.getPlayheadMs() })}
            title="Poser un zoom au playhead"
          >
            <Icon name="search" size={15} />
            Zoom
          </button>
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
          Clic = sélection · maintien = déplacement · clic droit = menu · Maj = précis
        </span>
      </div>

      {clipMenu && menuClip && (
        <ClipMenu
          target={clipMenu}
          clip={menuClip}
          // Diviser n'a de sens qu'à l'intérieur du clip, pas sur un de ses bords.
          canSplit={
            clipMenu.timelineMs > menuClip.timelineStartMs + 1 &&
            clipMenu.timelineMs < clipEndMs(menuClip) - 1
          }
          canPaste={canPasteClip}
          // Le réducteur garde toujours au moins un clip : sur le dernier,
          // l'entrée ne ferait rien du tout. On ne l'affiche donc pas.
          canDelete={clips.length > 1}
          onClose={() => setClipMenu(null)}
          dispatch={dispatch}
        />
      )}
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

const TextOverlayView = memo(function TextOverlayView(props: {
  overlay: TextOverlay;
  leftPx: number;
  widthPx: number;
  selected: boolean;
  active: boolean;
  onBeginGesture: (
    event: React.PointerEvent,
    overlay: TextOverlay,
    kind: TextGestureKind,
  ) => void;
}) {
  const { overlay, leftPx, widthPx, selected, active, onBeginGesture } = props;
  const handlePx = Math.max(4, Math.min(9, widthPx / 3));
  const durationMs = overlay.timelineEndMs - overlay.timelineStartMs;
  const fadeInWidth = durationMs > 0 ? (overlay.fadeInMs / durationMs) * widthPx : 0;
  const fadeOutWidth = durationMs > 0 ? (overlay.fadeOutMs / durationMs) * widthPx : 0;
  return (
    <div
      className={
        `title-clip title-${overlay.style}` +
        (selected ? " selected" : "") +
        (active ? " active" : "")
      }
      style={{ left: leftPx, width: widthPx }}
      onPointerDown={(event) => onBeginGesture(event, overlay, "move")}
      title={`${overlay.text || "Titre vide"} · ${formatTime(overlay.timelineStartMs)} - ${formatTime(overlay.timelineEndMs)}`}
    >
      {overlay.fadeInMs > 0 && (
        <i
          className="title-fade title-fade-in"
          style={{ width: Math.max(2, fadeInWidth) }}
          aria-hidden="true"
        />
      )}
      {overlay.fadeOutMs > 0 && (
        <i
          className="title-fade title-fade-out"
          style={{ width: Math.max(2, fadeOutWidth) }}
          aria-hidden="true"
        />
      )}
      <Icon name="text" size={12} />
      <span>{overlay.text || "Titre vide"}</span>
      <div
        className="title-handle title-handle-l"
        style={{ width: handlePx }}
        onPointerDown={(event) => onBeginGesture(event, overlay, "trim-left")}
        title="Ajuster le début du titre"
      />
      <div
        className="title-handle title-handle-r"
        style={{ width: handlePx }}
        onPointerDown={(event) => onBeginGesture(event, overlay, "trim-right")}
        title="Ajuster la fin du titre"
      />
    </div>
  );
});

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
  /** Maintien acquis : ce clip est prêt à suivre le pointeur. */
  grabbed: boolean;
  onBeginGesture: (event: React.PointerEvent, clip: Clip, kind: GestureKind) => void;
  onContextMenu: (event: React.MouseEvent, clip: Clip) => void;
}) {
  const {
    clip, source, leftPx, widthPx, pxPerMs, windowFromPx, windowToPx,
    selected, active, multiSource, grabbed, onBeginGesture, onContextMenu,
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
      className={
        "clip" +
        (selected ? " selected" : "") +
        (active ? " active" : "") +
        (grabbed ? " grabbed" : "")
      }
      style={{ left: leftPx, width: Math.max(widthPx, 8) }}
      onPointerDown={(event) => onBeginGesture(event, clip, "move")}
      onContextMenu={(event) => onContextMenu(event, clip)}
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
      {clip.audioFadeInMs > 0 && (
        <span
          className="clip-audio-fade fade-in"
          style={{ width: Math.max(2, clip.audioFadeInMs * pxPerMs) }}
          aria-hidden="true"
        />
      )}
      {clip.audioFadeOutMs > 0 && (
        <span
          className="clip-audio-fade fade-out"
          style={{ width: Math.max(2, clip.audioFadeOutMs * pxPerMs) }}
          aria-hidden="true"
        />
      )}
      {clip.videoFadeInMs > 0 && (
        <span
          className="clip-video-fade fade-in"
          style={{ width: Math.max(2, clip.videoFadeInMs * pxPerMs) }}
          aria-hidden="true"
        />
      )}
      {clip.videoFadeOutMs > 0 && (
        <span
          className="clip-video-fade fade-out"
          style={{ width: Math.max(2, clip.videoFadeOutMs * pxPerMs) }}
          aria-hidden="true"
        />
      )}
      {clip.transitionInMs > 0 && (
        <span
          className="clip-transition-in"
          style={{ width: Math.max(3, (clip.transitionInMs / 2) * pxPerMs) }}
          title={`Fondu enchaîné ${(clip.transitionInMs / 1000).toFixed(2)} s`}
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
