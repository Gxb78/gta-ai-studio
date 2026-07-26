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

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { Clip, FramingMode, TextOverlay } from "../types";
import type { ZoomRegion } from "../types";
import {
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  clampCropX,
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

/**
 * Zones de sécurité TikTok, en fraction de la hauteur ou de la largeur.
 * Tout ce qui compte (texte, visage) doit rester à l'intérieur : le reste est
 * mangé par les pastilles, la légende et les boutons de l'application.
 */
const SAFE_TOP = 0.08;
const SAFE_BOTTOM = 0.2;
const SAFE_SIDE = 0.06;
const SAFE_RIGHT = 0.16;

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
  /** Pas d'une image, dans un sens ou dans l'autre. */
  onStepFrame: (direction: -1 | 1) => void;
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
    durationMs, volume, onVolumeChange, onTogglePlay, onStepFrame, onCommitCropX,
    zooms, selectedZoom, onCommitZoomTarget,
    textOverlays, selectedTextOverlayId, onSelectTextOverlay, onCommitTextPosition,
  } = props;

  const frameRef = useRef<HTMLDivElement | null>(null);
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
  const outputView = viewMode === "output";
  const blurred = framing === "blur" && outputView;
  /** Cadrage en cours de déplacement : il prime sur la valeur du clip. */
  const [dragCropX, setDragCropX] = useState<number | null>(null);
  /**
   * Un déplacement vient d'avoir lieu. C'est une ref, pas un état : le `click`
   * arrive juste après le `pointerup`, avant tout nouveau rendu, donc un état
   * remis à zéro ne serait pas encore visible et la lecture se déclencherait.
   */
  const draggedRef = useRef(false);
  const effectiveCropX = dragCropX ?? cropX;
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
        engaged = true;
        draggedRef.current = true;
        setDragCropX(at(move.clientX));
      },
      options,
    );
    const stop = (up: PointerEvent) => {
      abort.abort();
      if (!engaged) {
        setDragCropX(null);
        return;
      }
      const next = at(up.clientX);
      setDragCropX(null);
      onCommitCropX?.(next);
    };
    window.addEventListener("pointerup", stop, options);
    window.addEventListener(
      "pointercancel",
      () => {
        abort.abort();
        setDragCropX(null);
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

  useEffect(() => {
    const updateVisibility = (playheadMs: number) => {
      for (const overlay of textOverlays) {
        const node = textNodesRef.current.get(overlay.id);
        if (node) {
          const hidden =
            !outputView ||
            playheadMs < overlay.timelineStartMs ||
            playheadMs >= overlay.timelineEndMs;
          node.hidden = hidden;
          node.style.opacity = hidden ? "0" : String(textFadeGainAt(overlay, playheadMs));
        }
      }
    };
    updateVisibility(clock.getPlayheadMs());
    return clock.subscribe(updateVisibility);
  }, [clock, outputView, textOverlays]);

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

  /** Point visé en cours de déplacement : il prime sur celui du zoom. */
  const [dragTarget, setDragTarget] = useState<{ x: number; y: number } | null>(null);
  const zoomTarget = dragTarget ?? (selectedZoom ? { x: selectedZoom.x, y: selectedZoom.y } : null);

  /**
   * Déplacement du point visé, en fraction du cadre de sortie.
   *
   * Le repère se saisit lui-même : contrairement au cadrage, il ne s'agit pas
   * de pousser l'image mais de désigner un endroit. Le point suit donc le
   * pointeur exactement, et un clic simple le pose là où on a cliqué.
   */
  const beginZoomTargetDrag = (event: React.PointerEvent) => {
    event.stopPropagation();
    if (event.button !== 0 || !onCommitZoomTarget) return;
    const frame = frameRef.current;
    if (!frame) return;
    const bounds = frame.getBoundingClientRect();
    const abort = new AbortController();
    const options = { signal: abort.signal } as const;
    const at = (clientX: number, clientY: number) => ({
      x: Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height)),
    });
    setDragTarget(at(event.clientX, event.clientY));
    window.addEventListener(
      "pointermove",
      (move: PointerEvent) => {
        draggedRef.current = true;
        setDragTarget(at(move.clientX, move.clientY));
      },
      options,
    );
    const stop = (up: PointerEvent) => {
      abort.abort();
      const next = at(up.clientX, up.clientY);
      setDragTarget(null);
      onCommitZoomTarget(next.x, next.y);
    };
    window.addEventListener("pointerup", stop, options);
    window.addEventListener(
      "pointercancel",
      () => {
        abort.abort();
        setDragTarget(null);
      },
      options,
    );
  };

  const beginTextDrag = (event: React.PointerEvent, overlay: TextOverlay) => {
    event.stopPropagation();
    if (event.button !== 0 || !outputView) return;
    onSelectTextOverlay(overlay.id);
    const frame = frameRef.current;
    const node = textNodesRef.current.get(overlay.id);
    if (!frame || !node) return;
    const bounds = frame.getBoundingClientRect();
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

  const objectPosition =
    outputView && framing === "crop" ? `${cropXPercent(effectiveCropX)}% 50%` : "50% 50%";
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
  const guidePercent = cropXPercent(effectiveCropX);

  return (
    <div className="stage">
      <div className="stage-scroll">
        <div
          className={
            "stage-frame" +
            (outputView ? " frame-output" : " frame-source") +
            (cropDraggable ? " crop-draggable" : "") +
            (dragCropX !== null ? " crop-dragging" : "")
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

          {outputView && zoomTarget && (
            <div
              className="zoom-target"
              style={{ left: `${zoomTarget.x * 100}%`, top: `${zoomTarget.y * 100}%` }}
              onPointerDown={beginZoomTargetDrag}
              title="Point visé par le zoom — tirer pour le déplacer"
            >
              <span aria-hidden="true" />
            </div>
          )}

          {inGap && (
            <div className="preview-gap">
              <span>Trou — écran noir</span>
            </div>
          )}

          {outputView &&
            textOverlays.map((overlay) => (
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

          {!outputView && (
            <div
              className="guide-916"
              style={{
                left: `${guidePercent}%`,
                transform: `translateX(-${guidePercent}%)`,
              }}
              title={
                cropDraggable
                  ? "Portion conservée — tirer le viseur pour la déplacer"
                  : "Portion conservée par le cadrage vertical"
              }
            >
              <span>9:16</span>
            </div>
          )}

          {showSafeZones && outputView && (
            <div className="safe-zones" aria-hidden="true">
              <div
                className="safe-box"
                style={{
                  top: `${SAFE_TOP * 100}%`,
                  bottom: `${SAFE_BOTTOM * 100}%`,
                  left: `${SAFE_SIDE * 100}%`,
                  right: `${SAFE_RIGHT * 100}%`,
                }}
              />
              <span className="safe-label">Zone lisible TikTok</span>
            </div>
          )}
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
            disabled={!outputView}
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
