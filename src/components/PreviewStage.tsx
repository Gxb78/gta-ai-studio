// Aperçu : un VRAI canvas 9:16. Ce qui est affiché est ce que l'export produit.
//
// Deux balises vidéo superposées, une seule visible : celle qui est masquée
// précharge le clip suivant (voir usePlayback). Le passage au format vertical est
// reproduit à l'identique du graphe FFmpeg :
//   - « recadrage » : object-fit: cover, décalé horizontalement par `cropX`
//     exactement comme le filtre `crop` décale sa fenêtre ;
//   - « fond flou » : image entière (contain) posée sur une copie élargie et
//     floutée, ici dessinée dans un canvas basse résolution puis étirée. Flouter
//     90×160 pixels ne coûte rien, et l'œil ne voit pas la différence.
//
// Mode secondaire « rush entier » : on sort du cadre de sortie pour voir tout ce
// que le rush contient, avec la fenêtre 9:16 conservée matérialisée par-dessus.
// Cette fenêtre EST le cadre de sortie : les titres, le point visé par le zoom
// et les zones de sécurité s'y dessinent, exactement là où ils tomberont à
// l'export. Les cacher faisait travailler à l'aveugle dès qu'on quittait la vue
// « sortie ». Le zoom lui-même reste en dehors : en vue « rush entier » on
// regarde volontairement à côté du cadre, agrandir l'image le contredirait.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { Clip, FramingMode, TextOverlay } from "../types";
import type { ZoomRegion } from "../types";
import {
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  clampCropX,
  clampZoomScale,
  cropXPercent,
  textFadeGainAt,
  videoFadeGainAt,
  zoomAt,
  zoomOffset,
  zoomScaleAt,
} from "../types";
import type { PlaybackClock } from "../playback/usePlayback";
import { PlaybackTimecode } from "./PlaybackTimecode";

/** Format de sortie, en rapport largeur/hauteur. */
const OUTPUT_RATIO = OUTPUT_WIDTH / OUTPUT_HEIGHT;

/** Définition du fond flou. Volontairement minuscule : il est flouté ensuite. */
const BLUR_W = 90;
const BLUR_H = 160;

/** Coins de la zone de zoom. Statique : jamais recréé à chaque rendu. */
const ZOOM_BOX_CORNERS: ReadonlyArray<{ corner: "tl" | "tr" | "bl" | "br"; cls: string }> = [
  { corner: "tl", cls: "zoom-box-handle-tl" },
  { corner: "tr", cls: "zoom-box-handle-tr" },
  { corner: "bl", cls: "zoom-box-handle-bl" },
  { corner: "br", cls: "zoom-box-handle-br" },
];

/**
 * Géométrie de la zone de zoom, en fraction du cadre de sortie — même fenêtre
 * que celle que lit `zoompan` côté export : un carré de côté 1/agrandissement,
 * centré sur le point visé, jamais poussé hors du cadre.
 */
function zoomBoxGeometry(x: number, y: number, scale: number) {
  const side = 1 / scale;
  return {
    left: Math.min(1 - side, Math.max(0, x - side / 2)),
    top: Math.min(1 - side, Math.max(0, y - side / 2)),
    side,
  };
}

/**
 * Zone de sécurité TikTok, en fraction de la hauteur ou de la largeur.
 * Tout ce qui compte (texte, visage) doit rester à l'intérieur : le reste est
 * mangé par les icônes, la légende et les boutons de l'interface TikTok.
 *
 * Marges recommandées sur une sortie 1080×1920 : 130 px en haut (icônes
 * recherche/son), 250 px en bas (légende, pseudo, boutons d'engagement),
 * 60 px de chaque côté — symétrique, pas de marge de droite élargie.
 */
const SAFE_TOP = 130 / OUTPUT_HEIGHT;
const SAFE_BOTTOM = 250 / OUTPUT_HEIGHT;
const SAFE_SIDE = 60 / OUTPUT_WIDTH;

/**
 * Reproduit `fix_bounds=1` de `drawtext` : le CENTRE du titre est ramené vers
 * l'intérieur du cadre jusqu'à ce que le titre entier y tienne, plutôt que de
 * laisser sa moitié déborder. À x=0 l'export garde le titre entier collé au
 * bord gauche ; sans ce recalage, l'aperçu le centrerait sur le bord et en
 * rognerait la moitié — ce que l'export ne fait jamais.
 */
const clampCenterFraction = (center: number, sizeFraction: number): number => {
  if (sizeFraction >= 1) return 0.5;
  const half = sizeFraction / 2;
  return Math.min(1 - half, Math.max(half, center));
};

export type ViewMode = "output" | "source";

interface Props {
  videoA: React.RefObject<HTMLVideoElement | null>;
  videoB: React.RefObject<HTMLVideoElement | null>;
  /** Balises sonores : le son est découplé de l'image (voir usePlayback). */
  audioA: React.RefObject<HTMLAudioElement | null>;
  audioB: React.RefObject<HTMLAudioElement | null>;
  activeIsA: boolean;
  /** Playhead dans un trou de la timeline : écran noir, comme à l'export. */
  inGap: boolean;
  framing: FramingMode;
  /** Clip committé dont l'image est visible, porteur de l'enveloppe complète. */
  visibleClip: Clip | null;
  /** Second clip visible uniquement pendant un fondu enchaîné. */
  transitionClip: Clip | null;
  /** Décalage du cadrage du clip visible au playhead. */
  cropX: number;
  /** Format du rush visible, pour le mode « rush entier ». */
  sourceAspect: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  showSafeZones: boolean;
  onToggleSafeZones: () => void;
  playing: boolean;
  clock: PlaybackClock;
  durationMs: number;
  volume: number;
  onVolumeChange: (volume: number) => void;
  onTogglePlay: () => void;
  /**
   * Coupe la lecture au début d'un geste de recadrage ou de point visé — même
   * principe que la Timeline pour ses gestes de clip : sans ça, le clip
   * visible peut changer EN PLEIN geste (le playhead franchit une frontière
   * pendant qu'on tire), et le repère continue d'appliquer le delta d'origine
   * sur l'image d'un autre clip jusqu'au relâchement.
   */
  onPause: () => void;
  /** Pas d'une image, dans un sens ou dans l'autre. */
  onStepFrame: (direction: -1 | 1) => void;
  /** Coupe au playhead, sur le clip sélectionné à défaut du clip visible. */
  onSplitAtPlayhead: () => void;
  /** Pose une zone de zoom au playhead et la sélectionne pour la régler. */
  onAddZoom: () => void;
  /**
   * Cadrage du clip visible, déplacé à la souris dans l'image. Appelé une seule
   * fois, au relâchement : pendant le geste, l'aperçu suit en local, donc le
   * déplacement ne remplit pas l'historique d'annulation.
   */
  onCommitCropX: ((cropX: number) => void) | null;
  /** Zooms animés du montage, appliqués à l'image de sortie. */
  zooms: ZoomRegion[];
  /** Zoom sélectionné : c'est le seul dont on montre et déplace le point visé. */
  selectedZoom: ZoomRegion | null;
  /** Point visé déplacé à la souris. Appelé une fois, au relâchement. */
  onCommitZoomTarget: ((x: number, y: number) => void) | null;
  /** Zone de zoom redimensionnée par un coin. Appelé une fois, au relâchement. */
  onCommitZoomBox: ((x: number, y: number, scale: number) => void) | null;
  textOverlays: TextOverlay[];
  selectedTextOverlayId: string | null;
  onSelectTextOverlay: (id: string) => void;
  onCommitTextPosition: (id: string, x: number, y: number) => void;
}

export function PreviewStage(props: Props) {
  if (import.meta.env.DEV) console.count("[render] PreviewStage");
  const {
    videoA, videoB, audioA, audioB, activeIsA, inGap, framing, visibleClip, transitionClip,
    cropX, sourceAspect,
    viewMode, onViewModeChange, showSafeZones, onToggleSafeZones, playing, clock,
    durationMs, volume, onVolumeChange, onTogglePlay, onPause, onStepFrame, onSplitAtPlayhead,
    onAddZoom, onCommitCropX,
    zooms, selectedZoom, onCommitZoomTarget, onCommitZoomBox,
    textOverlays, selectedTextOverlayId, onSelectTextOverlay, onCommitTextPosition,
  } = props;

  const frameRef = useRef<HTMLDivElement | null>(null);
  /**
   * Cadre de SORTIE, quelle que soit la vue.
   *
   * En vue « sortie » il se confond avec le cadre entier ; en vue « rush
   * entier » c'est le viseur 9:16. Tout ce qui se repère en fraction de
   * l'image de sortie — titres, point visé, zones de sécurité — vit DEDANS :
   * leurs coordonnées gardent ainsi le même sens dans les deux vues, et
   * l'aperçu montre les titres même quand on travaille sur le rush entier.
   */
  const outputBoxRef = useRef<HTMLDivElement | null>(null);
  /**
   * Couche qui porte le zoom. Elle enveloppe TOUT ce qui compose l'image de
   * sortie — les deux balises vidéo, le fond flou, la couche de fondu au noir —
   * mais PAS les titres : à l'export, `drawtext` est appliqué après le zoom,
   * donc un titre ne grossit pas avec l'image. L'aperçu doit mentir aussi peu
   * ici qu'ailleurs.
   */
  const zoomLayerRef = useRef<HTMLDivElement | null>(null);
  const blurRef = useRef<HTMLCanvasElement | null>(null);
  const fadeRef = useRef<HTMLDivElement | null>(null);
  const textNodesRef = useRef(new Map<string, HTMLDivElement>());
  /**
   * Zone de zoom : repositionnée en DOM pendant un geste (souris ou clavier),
   * exactement comme `applyCropX` pour le cadrage — un tirage ne doit pas
   * redéclencher un rendu React à chaque pixel parcouru ou à chaque frappe
   * répétée par le système. React ne reprend la main qu'au commit final, une
   * fois le geste terminé.
   */
  const zoomBoxRef = useRef<HTMLDivElement | null>(null);
  const zoomBoxScaleLabelRef = useRef<HTMLSpanElement | null>(null);
  const outputView = viewMode === "output";
  const blurred = framing === "blur" && outputView;
  /**
   * Un déplacement vient d'avoir lieu. C'est une ref, pas un état : le `click`
   * arrive juste après le `pointerup`, avant tout nouveau rendu, donc un état
   * remis à zéro ne serait pas encore visible et la lecture se déclencherait.
   */
  const draggedRef = useRef(false);
  /**
   * Largeur conservée par le cadrage, en fraction de la largeur du rush.
   *
   * Un rush 16:9 recadré en 9:16 ne garde qu'un peu moins d'un tiers de sa
   * largeur ; c'est cette fraction qui donne la taille du viseur et la course
   * disponible.
   */
  const keptFraction = Math.min(1, OUTPUT_RATIO / sourceAspect);
  // Le cadrage ne se déplace que là où il a un sens : en mode recadrage, si un
  // clip est visible pour le recevoir, et si le rush est réellement plus large
  // que la sortie — un rush déjà vertical n'a aucune marge à parcourir.
  const cropDraggable =
    framing === "crop" && onCommitCropX !== null && keptFraction < 0.999;

  /**
   * Course réelle du cadrage, en pixels.
   *
   * La même dans les deux vues, et ce n'est pas une coïncidence : en vue
   * « sortie » c'est la largeur d'image qui déborde du cadre 9:16, en vue
   * « rush entier » c'est la largeur de rush que le viseur peut parcourir.
   * Les deux valent `hauteur × (format du rush − format de sortie)`.
   *
   * C'est CETTE valeur que le geste doit diviser. L'ancien code divisait par la
   * largeur du cadre : sur un rush 16:9, le cadrage filait plus de deux fois
   * trop vite et l'image fuyait sous le doigt.
   */
  const cropTravelPx = (): number => {
    const el = frameRef.current;
    if (!el) return 0;
    return el.clientHeight * (sourceAspect - OUTPUT_RATIO);
  };

  /**
   * Applique un cadrage en cours de tirage directement en DOM : sur la balise
   * vidéo ACTIVE (l'autre garde le sien, celui d'un éventuel fondu enchaîné —
   * voir `objectPosition`/`transitionObjectPosition` plus bas, dont ce bloc
   * reproduit exactement le calcul) et, en vue « rush entier », sur le viseur
   * 9:16. Jamais via l'état React : un `setState` à chaque `pointermove`
   * redéclencherait un rendu complet de l'aperçu à chaque pixel parcouru,
   * pour un geste qui ne change au fond que deux pourcentages CSS.
   */
  const applyCropX = (value: number) => {
    const percent = cropXPercent(value);
    const activeVideo = activeIsA ? videoA.current : videoB.current;
    if (activeVideo) {
      activeVideo.style.objectPosition =
        outputView && framing === "crop" ? `${percent}% 50%` : "50% 50%";
    }
    if (!outputView) {
      const box = outputBoxRef.current;
      if (box) {
        box.style.left = `${percent}%`;
        box.style.transform = `translateX(-${percent}%)`;
      }
    }
  };

  /**
   * Déplacement horizontal du cadrage à la souris.
   *
   * Un simple clic reste un clic (lecture / pause) : le geste ne devient un
   * déplacement qu'au-delà d'un seuil, comme sur la timeline.
   *
   * Le SENS dépend de ce qu'on tire. En vue « sortie » on pousse l'IMAGE
   * derrière un cadre fixe : la tirer vers la droite révèle sa partie gauche,
   * donc le cadrage recule. En vue « rush entier » on déplace le VISEUR sur une
   * image fixe : il suit la main. Un viseur qui partirait à gauche quand la
   * main va à droite serait injouable.
   */
  const beginCropDrag = (event: React.PointerEvent) => {
    if (!cropDraggable || event.button !== 0) return;
    const travel = cropTravelPx();
    if (travel <= 1) return;
    const direction = outputView ? -1 : 1;
    const startX = event.clientX;
    const origin = cropX;
    const at = (clientX: number): number =>
      clampCropX(origin + (direction * 2 * (clientX - startX)) / travel);
    let engaged = false;
    const abort = new AbortController();
    const options = { signal: abort.signal } as const;

    window.addEventListener(
      "pointermove",
      (move: PointerEvent) => {
        if (!engaged && Math.abs(move.clientX - startX) < 4) return;
        // Ne couper la lecture qu'une fois le geste reconnu comme un tirage :
        // appelée dès le `pointerdown`, `onPause` coupait aussi le clic simple
        // de lecture/pause qui suit — celui-ci togglait alors sur une lecture
        // déjà arrêtée par ce `onPause`, annulant l'effet du clic.
        if (!engaged) {
          onPause();
          frameRef.current?.classList.add("crop-dragging");
        }
        engaged = true;
        draggedRef.current = true;
        applyCropX(at(move.clientX));
      },
      options,
    );
    const stop = (up: PointerEvent) => {
      abort.abort();
      frameRef.current?.classList.remove("crop-dragging");
      if (!engaged) return;
      onCommitCropX?.(at(up.clientX));
      // Filet de sécurité : si le relâchement tombe sur le repère de zoom ou
      // un titre, leur `onClick` stoppe la propagation avant `stage-frame`,
      // qui ne remet alors jamais `draggedRef` à zéro — il resterait bloqué et
      // avalerait le prochain clic de lecture/pause. Le clic qui suit ce
      // `pointerup` est déjà réparti avant qu'un timer 0 ms s'exécute, donc ce
      // filet ne fait rien si `stage-frame` a déjà fait la remise à zéro.
      setTimeout(() => {
        draggedRef.current = false;
      }, 0);
    };
    window.addEventListener("pointerup", stop, options);
    window.addEventListener(
      "pointercancel",
      () => {
        abort.abort();
        frameRef.current?.classList.remove("crop-dragging");
      },
      options,
    );
  };

  // Le fond flou se redessine quand le playhead bouge — donc à chaque image
  // pendant la lecture, et une seule fois à l'arrêt. Pas de boucle propre :
  // celle de la lecture suffit, et rien ne tourne quand rien ne bouge.
  useEffect(() => {
    if (!blurred) return;
    const draw = () => {
      const canvas = blurRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      context.clearRect(0, 0, BLUR_W, BLUR_H);
      const entries = [
        { video: videoA.current, fallbackOpacity: activeIsA ? 1 : 0 },
        { video: videoB.current, fallbackOpacity: activeIsA ? 0 : 1 },
      ];
      for (const { video, fallbackOpacity } of entries) {
        if (!video || video.readyState < 2) continue;
        const inlineOpacity = Number(video.style.opacity);
        const opacity = video.style.opacity === "" ? fallbackOpacity : inlineOpacity;
        if (!Number.isFinite(opacity) || opacity <= 0) continue;
        const scale = Math.max(BLUR_W / video.videoWidth, BLUR_H / video.videoHeight);
        const width = video.videoWidth * scale;
        const height = video.videoHeight * scale;
        context.globalAlpha = opacity;
        context.drawImage(
          video,
          (BLUR_W - width) / 2,
          (BLUR_H - height) / 2,
          width,
          height,
        );
      }
      context.globalAlpha = 1;
    };
    draw();
    return clock.subscribe(draw);
  }, [activeIsA, blurred, clock, inGap, videoA, videoB]);

  // Recale chaque titre comme `fix_bounds=1` à l'export : le centre se déplace
  // vers l'intérieur dès que le titre déborderait, sans jamais le rogner.
  // `useLayoutEffect` : la mesure et l'écriture doivent précéder la peinture,
  // sinon un titre en bord de cadre flasherait un instant à sa position brute.
  useLayoutEffect(() => {
    const box = outputBoxRef.current;
    if (!box) return;
    const applyBounds = () => {
      const boxRect = box.getBoundingClientRect();
      if (boxRect.width <= 0 || boxRect.height <= 0) return;
      for (const overlay of textOverlays) {
        const node = textNodesRef.current.get(overlay.id);
        if (!node) continue;
        const nodeRect = node.getBoundingClientRect();
        const x = clampCenterFraction(overlay.x, nodeRect.width / boxRect.width);
        const y = clampCenterFraction(overlay.y, nodeRect.height / boxRect.height);
        node.style.left = `${x * 100}%`;
        node.style.top = `${y * 100}%`;
      }
    };
    applyBounds();
    const observer = new ResizeObserver(applyBounds);
    observer.observe(box);
    for (const overlay of textOverlays) {
      const node = textNodesRef.current.get(overlay.id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [textOverlays]);

  useEffect(() => {
    const updateVisibility = (playheadMs: number) => {
      for (const overlay of textOverlays) {
        const node = textNodesRef.current.get(overlay.id);
        if (node) {
          const hidden =
            playheadMs < overlay.timelineStartMs ||
            playheadMs >= overlay.timelineEndMs;
          node.hidden = hidden;
          node.style.opacity = hidden ? "0" : String(textFadeGainAt(overlay, playheadMs));
        }
      }
    };
    updateVisibility(clock.getPlayheadMs());
    return clock.subscribe(updateVisibility);
  }, [clock, textOverlays]);

  useEffect(() => {
    const updateFade = (playheadMs: number) => {
      const node = fadeRef.current;
      if (!node) return;
      const gain = visibleClip ? videoFadeGainAt(visibleClip, playheadMs) : 1;
      node.style.opacity = String(1 - gain);
    };
    updateFade(clock.getPlayheadMs());
    return clock.subscribe(updateFade);
  }, [clock, visibleClip]);

  /**
   * Zoom appliqué à chaque image, depuis l'horloge impérative — comme les
   * fondus, et pour la même raison : repasser par un rendu React à chaque image
   * coûterait le budget de la lecture.
   *
   * `transform-origin` est fixé au centre et le décalage est exprimé en
   * pourcentage de la couche, donc en fraction du cadre de sortie : c'est
   * exactement ce que `zoomOffset` calcule, et ce que l'export applique.
   */
  useEffect(() => {
    const updateZoom = (playheadMs: number) => {
      const node = zoomLayerRef.current;
      if (!node) return;
      // Le zoom décrit le cadre de SORTIE : en vue « rush entier » on regarde
      // volontairement à côté, on ne l'applique donc pas.
      const zoom = outputView ? zoomAt(zooms, playheadMs) : null;
      if (!zoom) {
        node.style.transform = "";
        return;
      }
      const scale = zoomScaleAt(zoom, playheadMs);
      if (scale <= 1) {
        node.style.transform = "";
        return;
      }
      const dx = zoomOffset(zoom.x, scale) * 100;
      const dy = zoomOffset(zoom.y, scale) * 100;
      node.style.transform = `scale(${scale}) translate(${-dx}%, ${-dy}%)`;
    };
    updateZoom(clock.getPlayheadMs());
    return clock.subscribe(updateZoom);
  }, [clock, outputView, zooms]);

  /**
   * Zone en cours de redimensionnement au CLAVIER — voir `handleZoomBoxKeyDown`
   * un peu plus bas. La souris ne passe JAMAIS par cet état : ses deux gestes
   * (`beginZoomTargetDrag`, `beginZoomResizeDrag`) écrivent directement en DOM
   * via `applyZoomBox`, sans jamais appeler `setDragBox`. Le clavier, lui, ne
   * déclenche qu'une poignée d'événements par seconde au pire — un `setState`
   * par frappe n'a donc rien du problème qu'a un `setState` par pixel de
   * souris, et React reste le moyen le plus simple de prévisualiser un geste
   * qui doit rester annulable avant sa validation à froid (400 ms plus bas).
   */
  const [dragBox, setDragBox] = useState<{ x: number; y: number; scale: number } | null>(null);
  const zoomBoxScale = dragBox?.scale ?? selectedZoom?.scale ?? null;
  const zoomBoxCenter = dragBox ?? (selectedZoom ? { x: selectedZoom.x, y: selectedZoom.y } : null);

  /**
   * Repeint la zone de zoom directement en DOM : position/taille sur
   * `zoomBoxRef`, texte de l'agrandissement sur `zoomBoxScaleLabelRef`. Utilisé
   * par les DEUX gestes à la souris (déplacement du centre, redimensionnement
   * par un coin) — jamais par un `setState`, qui redéclencherait un rendu
   * complet de l'aperçu à chaque pixel parcouru pour une simple case qui suit
   * le pointeur.
   */
  const applyZoomBox = (x: number, y: number, scale: number) => {
    const box = zoomBoxRef.current;
    if (!box) return;
    const { left, top, side } = zoomBoxGeometry(x, y, scale);
    box.style.left = `${left * 100}%`;
    box.style.top = `${top * 100}%`;
    box.style.width = `${side * 100}%`;
    box.style.height = `${side * 100}%`;
    if (zoomBoxScaleLabelRef.current) {
      zoomBoxScaleLabelRef.current.textContent = `${scale.toFixed(2)}×`;
    }
  };

  /**
   * Déplacement du point visé, en fraction du cadre de sortie.
   *
   * Le repère se saisit lui-même : contrairement au cadrage, il ne s'agit pas
   * de pousser l'image mais de désigner un endroit. Le point suit donc le
   * pointeur exactement, et un clic simple le pose là où on a cliqué.
   */
  const beginZoomTargetDrag = (event: React.PointerEvent) => {
    event.stopPropagation();
    if (event.button !== 0 || !onCommitZoomTarget || !selectedZoom) return;
    onPause();
    const box = outputBoxRef.current;
    if (!box) return;
    const bounds = box.getBoundingClientRect();
    // Un déplacement du CENTRE ne change jamais l'agrandissement : fixé une
    // fois pour tout le geste, pas relu à chaque image.
    const scale = selectedZoom.scale;
    const abort = new AbortController();
    const options = { signal: abort.signal } as const;
    const at = (clientX: number, clientY: number) => ({
      x: Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height)),
    });
    const initial = at(event.clientX, event.clientY);
    applyZoomBox(initial.x, initial.y, scale);
    window.addEventListener(
      "pointermove",
      (move: PointerEvent) => {
        // `draggedRef` sert à faire taire le clic de lecture/pause qui suit un
        // tirage de CADRAGE sur `stage-frame` (même élément, pas de
        // `stopPropagation`). Ici, le repère a déjà son propre `onClick` qui
        // stoppe la propagation : ce clic n'atteint jamais `stage-frame`, donc
        // jamais la branche qui remet `draggedRef` à `false`. Le poser à `true`
        // ici le laissait bloqué — le clic de lecture SUIVANT, sur l'image,
        // était avalé au lieu de lancer ou d'arrêter la lecture.
        const next = at(move.clientX, move.clientY);
        applyZoomBox(next.x, next.y, scale);
      },
      options,
    );
    const stop = (up: PointerEvent) => {
      abort.abort();
      const next = at(up.clientX, up.clientY);
      onCommitZoomTarget(next.x, next.y);
    };
    window.addEventListener("pointerup", stop, options);
    window.addEventListener("pointercancel", () => abort.abort(), options);
  };

  /**
   * Redimensionnement de la zone de zoom par un coin.
   *
   * Le coin OPPOSÉ à celui qu'on tire reste fixe — le geste habituel d'un
   * redimensionnement — plutôt que le centre : tirer le coin bas-droit agrandit
   * la zone vers le bas-droit sans faire bouger son coin haut-gauche. Le point
   * visé (le centre de la zone) se déplace donc avec le geste ; seul un
   * déplacement du CORPS de la zone le laisse intact.
   */
  const beginZoomResizeDrag = (
    event: React.PointerEvent,
    corner: "tl" | "tr" | "bl" | "br",
  ) => {
    event.stopPropagation();
    if (event.button !== 0 || !onCommitZoomBox || !selectedZoom) return;
    onPause();
    const box = outputBoxRef.current;
    if (!box) return;
    const bounds = box.getBoundingClientRect();
    const { left: left0, top: top0, side: side0 } = zoomBoxGeometry(
      selectedZoom.x,
      selectedZoom.y,
      selectedZoom.scale,
    );
    // Coin fixe : celui à l'opposé de celui qu'on tire.
    const anchorX = corner.includes("r") ? left0 : left0 + side0;
    const anchorY = corner.includes("b") ? top0 : top0 + side0;
    const grows = { right: corner.includes("r"), bottom: corner.includes("b") };
    const abort = new AbortController();
    const options = { signal: abort.signal } as const;
    const at = (clientX: number, clientY: number) => {
      const px = (clientX - bounds.left) / bounds.width;
      const py = (clientY - bounds.top) / bounds.height;
      const dx = grows.right ? px - anchorX : anchorX - px;
      const dy = grows.bottom ? py - anchorY : anchorY - py;
      const scale = clampZoomScale(1 / Math.max(0.02, Math.max(dx, dy)));
      const side = 1 / scale;
      const x = Math.min(1, Math.max(0, grows.right ? anchorX + side / 2 : anchorX - side / 2));
      const y = Math.min(1, Math.max(0, grows.bottom ? anchorY + side / 2 : anchorY - side / 2));
      return { x, y, scale };
    };
    if (zoomBoxScaleLabelRef.current) zoomBoxScaleLabelRef.current.style.display = "flex";
    const initial = at(event.clientX, event.clientY);
    applyZoomBox(initial.x, initial.y, initial.scale);
    window.addEventListener(
      "pointermove",
      (move: PointerEvent) => {
        const next = at(move.clientX, move.clientY);
        applyZoomBox(next.x, next.y, next.scale);
      },
      options,
    );
    const stop = (up: PointerEvent) => {
      abort.abort();
      if (zoomBoxScaleLabelRef.current) zoomBoxScaleLabelRef.current.style.display = "none";
      const next = at(up.clientX, up.clientY);
      onCommitZoomBox(next.x, next.y, next.scale);
    };
    window.addEventListener("pointerup", stop, options);
    window.addEventListener(
      "pointercancel",
      () => {
        abort.abort();
        if (zoomBoxScaleLabelRef.current) zoomBoxScaleLabelRef.current.style.display = "none";
      },
      options,
    );
  };

  /**
   * Clavier : flèches pour déplacer le point visé (fin, 1 % ; large avec Maj,
   * 5 %), +/- pour agrandir/rétrécir. Sans ça, la zone n'était réglable qu'à
   * la souris, au pixel près — jamais commode pour un cadrage précis.
   *
   * La répétition automatique du système sur une touche maintenue déclenche
   * un `keydown` toutes les ~30 ms : commiter (donc empiler une entrée
   * d'annulation) à CHAQUE frappe noierait l'historique en une seconde de
   * touche maintenue. On accumule donc localement dans une ref et on ne
   * commite qu'une fois le clavier resté silencieux 400 ms — un seul geste
   * logique, un seul "Annuler", comme un tirage à la souris.
   */
  const zoomKeyPendingRef = useRef<{ x: number; y: number; scale: number } | null>(null);
  const zoomKeyTimerRef = useRef<number | null>(null);
  useEffect(() => {
    // Changer de zoom sélectionné (ou le désélectionner) abandonne un geste
    // clavier en attente plutôt que de l'appliquer au mauvais zoom.
    zoomKeyPendingRef.current = null;
    if (zoomKeyTimerRef.current !== null) {
      window.clearTimeout(zoomKeyTimerRef.current);
      zoomKeyTimerRef.current = null;
    }
    setDragBox(null);
  }, [selectedZoom?.id]);
  useEffect(
    () => () => {
      if (zoomKeyTimerRef.current !== null) window.clearTimeout(zoomKeyTimerRef.current);
    },
    [],
  );

  // Synchronise l'étiquette d'agrandissement sur le geste CLAVIER : la souris
  // l'écrit elle-même, en DOM (voir `applyZoomBox`/`beginZoomResizeDrag`),
  // sans jamais passer par `dragBox`. Le style ici est un littéral figé côté
  // JSX (`display: none`, voir plus bas) : React ne le réapplique donc jamais
  // par-dessus une valeur posée à la souris, les deux chemins coexistent sans
  // se marcher dessus.
  useEffect(() => {
    const label = zoomBoxScaleLabelRef.current;
    if (!label) return;
    label.style.display = dragBox ? "flex" : "none";
    if (dragBox) label.textContent = `${dragBox.scale.toFixed(2)}×`;
  }, [dragBox]);

  const handleZoomBoxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!selectedZoom || !onCommitZoomBox) return;
    // Deux pas distincts : déplacer de 5 % à chaque pression serait beaucoup
    // trop grossier pour viser, alors qu'agrandir de 0,05× à chaque pression
    // serait beaucoup trop lent — les deux gestes n'ont pas la même échelle.
    const moveStep = event.shiftKey ? 0.05 : 0.01;
    const scaleStep = event.shiftKey ? 0.25 : 0.05;
    const base = zoomKeyPendingRef.current ?? {
      x: selectedZoom.x,
      y: selectedZoom.y,
      scale: selectedZoom.scale,
    };
    let next = base;
    if (event.key === "ArrowLeft") next = { ...base, x: Math.max(0, base.x - moveStep) };
    else if (event.key === "ArrowRight") next = { ...base, x: Math.min(1, base.x + moveStep) };
    else if (event.key === "ArrowUp") next = { ...base, y: Math.max(0, base.y - moveStep) };
    else if (event.key === "ArrowDown") next = { ...base, y: Math.min(1, base.y + moveStep) };
    else if (event.key === "+" || event.key === "=")
      next = { ...base, scale: clampZoomScale(base.scale + scaleStep) };
    else if (event.key === "-") next = { ...base, scale: clampZoomScale(base.scale - scaleStep) };
    else return;

    event.preventDefault();
    zoomKeyPendingRef.current = next;
    setDragBox(next);
    if (zoomKeyTimerRef.current !== null) window.clearTimeout(zoomKeyTimerRef.current);
    zoomKeyTimerRef.current = window.setTimeout(() => {
      const commit = zoomKeyPendingRef.current;
      zoomKeyPendingRef.current = null;
      zoomKeyTimerRef.current = null;
      setDragBox(null);
      if (commit) onCommitZoomBox(commit.x, commit.y, commit.scale);
    }, 400);
  };

  const beginTextDrag = (event: React.PointerEvent, overlay: TextOverlay) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    onSelectTextOverlay(overlay.id);
    const box = outputBoxRef.current;
    const node = textNodesRef.current.get(overlay.id);
    if (!box || !node) return;
    const bounds = box.getBoundingClientRect();
    const abort = new AbortController();
    const options = { signal: abort.signal } as const;
    let x = overlay.x;
    let y = overlay.y;
    window.addEventListener(
      "pointermove",
      (move: PointerEvent) => {
        x = Math.max(0, Math.min(1, (move.clientX - bounds.left) / bounds.width));
        y = Math.max(0, Math.min(1, (move.clientY - bounds.top) / bounds.height));
        node.style.left = `${x * 100}%`;
        node.style.top = `${y * 100}%`;
      },
      options,
    );
    window.addEventListener(
      "pointerup",
      () => {
        abort.abort();
        onCommitTextPosition(overlay.id, x, y);
      },
      options,
    );
    window.addEventListener("pointercancel", () => abort.abort(), options);
  };

  const videoClass = (visible: boolean): string =>
    "preview-video" +
    (visible ? " visible" : "") +
    (outputView && framing === "crop" ? " fit-cover" : " fit-contain");

  // Le repos vient toujours de la prop : un tirage en cours s'applique en DOM
  // (voir `applyCropX`), sans passer par un re-rendu React.
  const objectPosition =
    outputView && framing === "crop" ? `${cropXPercent(cropX)}% 50%` : "50% 50%";
  const transitionObjectPosition =
    outputView && framing === "crop" && transitionClip
      ? `${cropXPercent(transitionClip.cropX)}% 50%`
      : objectPosition;

  /**
   * Viseur 9:16 du mode « rush entier ».
   *
   * `left: P%` place son BORD GAUCHE à P % de la largeur du rush ; la
   * translation de −P % de sa PROPRE largeur le ramène d'autant. Le bord gauche
   * atterrit donc à `P × (1 − largeur du viseur)`, ce qui est exactement la
   * définition de `object-position: P% ` — donc exactement ce que fait le
   * filtre `crop` de l'export.
   *
   * Un `translateX(-50%)` fixe, comme avant, centrait le viseur sur la
   * position : à cadrage extrême il débordait de moitié hors du rush et
   * annonçait une portion que l'export n'écrit pas. L'aperçu ne ment pas.
   */
  const guidePercent = cropXPercent(cropX);

  return (
    <div className="stage">
      <div className="stage-scroll">
        <div
          className={
            "stage-frame" +
            (outputView ? " frame-output" : " frame-source") +
            (cropDraggable ? " crop-draggable" : "")
            // "crop-dragging" est ajoutée/retirée directement en DOM par
            // `beginCropDrag` : un tirage ne doit pas redéclencher un rendu
            // React à chaque pixel parcouru.
          }
          ref={frameRef}
          style={{ "--source-aspect": String(sourceAspect) } as React.CSSProperties}
          onPointerDown={beginCropDrag}
          onClick={() => {
            // Un déplacement de cadrage ne doit pas déclencher la lecture.
            if (draggedRef.current) {
              draggedRef.current = false;
              return;
            }
            onTogglePlay();
          }}
          role="button"
          tabIndex={-1}
          title={
            cropDraggable
              ? outputView
                ? "Cliquer pour lire · tirer l'image pour choisir la partie gardée"
                : "Cliquer pour lire · tirer pour déplacer le viseur 9:16"
              : "Cliquer pour lire ou mettre en pause"
          }
        >
          {/* Couche zoomée : tout ce qui compose l'image de sortie. Les titres
              et les repères restent en dehors, comme à l'export. */}
          <div className="zoom-layer" ref={zoomLayerRef}>
          {blurred && (
            <canvas
              className="stage-blur"
              ref={blurRef}
              width={BLUR_W}
              height={BLUR_H}
              aria-hidden="true"
            />
          )}
          {/* Les balises vidéo sont MUETTES : tout le son passe par les balises
              audio, seules à connaître le plan sonore. */}
          <video
            ref={videoA}
            className={videoClass(activeIsA)}
            style={{
              objectPosition: activeIsA ? objectPosition : transitionObjectPosition,
            }}
            preload="auto"
            playsInline
            muted
          />
          <video
            ref={videoB}
            className={videoClass(!activeIsA)}
            style={{
              objectPosition: activeIsA ? transitionObjectPosition : objectPosition,
            }}
            preload="auto"
            playsInline
            muted
          />
          <audio ref={audioA} preload="auto" />
          <audio ref={audioB} preload="auto" />
          <div ref={fadeRef} className="preview-video-fade" aria-hidden="true" />
          </div>

          {inGap && (
            <div className="preview-gap">
              <span>Trou — écran noir</span>
            </div>
          )}

          {/* Cadre de sortie : le cadre entier en vue « sortie », le viseur
              9:16 en vue « rush entier ». Il ne capte pas le pointeur — ses
              enfants le reprennent — pour qu'un clic à côté d'un titre reste un
              clic sur l'image, donc une lecture ou un déplacement du cadrage. */}
          <div
            className={"output-box" + (outputView ? "" : " guide-916")}
            ref={outputBoxRef}
            style={
              outputView
                ? undefined
                : {
                    left: `${guidePercent}%`,
                    transform: `translateX(-${guidePercent}%)`,
                  }
            }
            title={
              outputView
                ? undefined
                : cropDraggable
                  ? "Portion conservée — tirer le viseur pour la déplacer"
                  : "Portion conservée par le cadrage vertical"
            }
          >
            {zoomBoxCenter && zoomBoxScale && (
              (() => {
                const { left, top, side } = zoomBoxGeometry(
                  zoomBoxCenter.x,
                  zoomBoxCenter.y,
                  zoomBoxScale,
                );
                return (
                  <div
                    className="zoom-box"
                    ref={zoomBoxRef}
                    style={{
                      left: `${left * 100}%`,
                      top: `${top * 100}%`,
                      width: `${side * 100}%`,
                      height: `${side * 100}%`,
                    }}
                    onPointerDown={beginZoomTargetDrag}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={handleZoomBoxKeyDown}
                    tabIndex={0}
                    role="group"
                    aria-label="Zone de zoom : flèches pour déplacer, +/- pour agrandir ou rétrécir"
                    title="Zone de zoom — tirer pour la déplacer, un coin pour l'agrandir/la rétrécir, flèches et +/- au clavier"
                  >
                    {/* Toujours monté, visibilité et texte pilotés en DOM (voir
                        `applyZoomBox` pour la souris, l'effet ci-dessus pour le
                        clavier) : un littéral JSX figé (`display: none`) n'est
                        jamais réappliqué par React par-dessus une valeur posée
                        ainsi — les deux gestes peuvent l'écrire sans conflit. */}
                    <span
                      className="zoom-box-scale"
                      ref={zoomBoxScaleLabelRef}
                      aria-hidden="true"
                      style={{ display: "none" }}
                    />
                    {ZOOM_BOX_CORNERS.map(({ corner, cls }) => (
                      <i
                        key={corner}
                        className={`zoom-box-handle ${cls}`}
                        onPointerDown={(event) => beginZoomResizeDrag(event, corner)}
                        aria-label={`Redimensionner la zone de zoom (coin ${corner})`}
                        role="slider"
                        aria-valuenow={Math.round(zoomBoxScale * 100)}
                      />
                    ))}
                  </div>
                );
              })()
            )}

            {textOverlays.map((overlay) => (
              <div
                key={overlay.id}
                ref={(node) => {
                  if (node) textNodesRef.current.set(overlay.id, node);
                  else textNodesRef.current.delete(overlay.id);
                }}
                className={
                  `preview-text text-${overlay.style}` +
                  (overlay.id === selectedTextOverlayId ? " selected" : "")
                }
                style={{
                  left: `${overlay.x * 100}%`,
                  top: `${overlay.y * 100}%`,
                  fontSize: `${(overlay.fontSizePx / 1080) * 100}cqw`,
                }}
                onPointerDown={(event) => beginTextDrag(event, overlay)}
                onClick={(event) => event.stopPropagation()}
              >
                {overlay.text || "Titre vide"}
              </div>
            ))}

            {showSafeZones && (
              <div className="safe-zones" aria-hidden="true">
                <div
                  className="safe-box"
                  style={{
                    top: `${SAFE_TOP * 100}%`,
                    bottom: `${SAFE_BOTTOM * 100}%`,
                    left: `${SAFE_SIDE * 100}%`,
                    right: `${SAFE_SIDE * 100}%`,
                  }}
                />
                <span className="safe-label">Zone lisible TikTok</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="viewer-bar">
        {/* Les trois commandes de lecture forment un seul groupe soudé : ce sont
            les seules de la barre qu'on utilise sans quitter l'image des yeux. */}
        <div className="viewer-group">
          <div className="transport">
            <button
              type="button"
              className="icon-btn ghost"
              onClick={() => onStepFrame(-1)}
              title="Image précédente · ←"
              aria-label="Image précédente"
            >
              <Icon name="stepBack" size={16} />
            </button>
            <button
              type="button"
              className="play-btn"
              onClick={onTogglePlay}
              title={playing ? "Pause · Espace" : "Lecture · Espace"}
              aria-label={playing ? "Pause" : "Lecture"}
            >
              <Icon name={playing ? "pause" : "play"} size={18} />
            </button>
            <button
              type="button"
              className="icon-btn ghost"
              onClick={() => onStepFrame(1)}
              title="Image suivante · →"
              aria-label="Image suivante"
            >
              <Icon name="stepForward" size={16} />
            </button>
          </div>
          <PlaybackTimecode clock={clock} durationMs={durationMs} />
          {/* Les deux actions qui travaillent AU PLAYHEAD, donc à côté de lui :
              couper le clip sous le curseur, poser une zone de zoom qu'on règle
              ensuite dans l'image et dans la timeline. */}
          <div className="btn-group">
            <button
              type="button"
              className="small ghost"
              onClick={onSplitAtPlayhead}
              title="Couper le clip au playhead · S"
            >
              <Icon name="split" size={15} />
              Couper
            </button>
            <button
              type="button"
              className="small ghost"
              onClick={onAddZoom}
              title="Poser une zone de zoom au playhead"
            >
              <Icon name="search" size={15} />
              Zoom
            </button>
          </div>
        </div>

        <div className="viewer-group">
          <div className="volume" title="Volume général de l'aperçu">
            <Icon name={volume === 0 ? "soundOff" : "volume"} size={15} />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => onVolumeChange(Number(event.target.value))}
              aria-label="Volume"
            />
          </div>
          <div className="btn-group">
            <button
              type="button"
              className={"small ghost" + (outputView ? " active" : "")}
              onClick={() => onViewModeChange("output")}
              title="Voir exactement la sortie 9:16"
            >
              Sortie
            </button>
            <button
              type="button"
              className={"small ghost" + (!outputView ? " active" : "")}
              onClick={() => onViewModeChange("source")}
              title="Voir le rush entier et la portion conservée"
            >
              Rush entier
            </button>
          </div>
          <button
            type="button"
            className={"icon-btn ghost" + (showSafeZones ? " active" : "")}
            onClick={onToggleSafeZones}
            title="Zones de sécurité TikTok"
            aria-label="Zones de sécurité TikTok"
          >
            <Icon name="safe" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => void frameRef.current?.requestFullscreen().catch(() => undefined)}
            title="Plein écran"
            aria-label="Plein écran"
          >
            <Icon name="fullscreen" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
