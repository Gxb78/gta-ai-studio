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
import { cropXPercent, textFadeGainAt, videoFadeGainAt } from "../types";
import type { PlaybackClock } from "../playback/usePlayback";
import { PlaybackTimecode } from "./PlaybackTimecode";

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
  textOverlays: TextOverlay[];
  selectedTextOverlayId: string | null;
  onSelectTextOverlay: (id: string) => void;
  onCommitTextPosition: (id: string, x: number, y: number) => void;
}

export function PreviewStage(props: Props) {
  if (import.meta.env.DEV) console.count("[render] PreviewStage");
  const {
    videoA, videoB, audioA, audioB, activeIsA, inGap, framing, visibleClip, cropX, sourceAspect,
    viewMode, onViewModeChange, showSafeZones, onToggleSafeZones, playing, clock,
    durationMs, volume, onVolumeChange, onTogglePlay, onStepFrame, onCommitCropX,
    textOverlays, selectedTextOverlayId, onSelectTextOverlay, onCommitTextPosition,
  } = props;

  const frameRef = useRef<HTMLDivElement | null>(null);
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
  // Le cadrage ne se déplace que là où il a un sens : sur le cadre de sortie,
  // en mode recadrage, et si un clip est visible pour le recevoir.
  const cropDraggable = framing === "crop" && onCommitCropX !== null;

  /**
   * Déplacement horizontal du cadrage à la souris.
   *
   * Un simple clic reste un clic (lecture / pause) : le geste ne devient un
   * déplacement qu'au-delà d'un seuil, comme sur la timeline.
   */
  const beginCropDrag = (event: React.PointerEvent) => {
    if (!cropDraggable || event.button !== 0) return;
    const width = frameRef.current?.clientWidth ?? 0;
    if (width === 0) return;
    const startX = event.clientX;
    const origin = cropX;
    let engaged = false;
    const abort = new AbortController();
    const options = { signal: abort.signal } as const;

    window.addEventListener(
      "pointermove",
      (move: PointerEvent) => {
        const dx = move.clientX - startX;
        if (!engaged && Math.abs(dx) < 4) return;
        engaged = true;
        draggedRef.current = true;
        // Tirer l'image vers la droite révèle sa partie gauche : le cadrage
        // recule d'autant. Une largeur de cadre parcourt toute la marge.
        setDragCropX(Math.min(1, Math.max(-1, origin - (2 * dx) / width)));
      },
      options,
    );
    const stop = (up: PointerEvent) => {
      abort.abort();
      const dx = up.clientX - startX;
      if (!engaged) {
        setDragCropX(null);
        return;
      }
      const next = Math.min(1, Math.max(-1, origin - (2 * dx) / width));
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
    const canvas = blurRef.current;
    const video = (activeIsA ? videoA.current : videoB.current) ?? null;
    if (!canvas || !video || video.readyState < 2) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    // Recouvrement : on garde le centre de l'image, comme le fait `crop` après
    // un `scale ... increase` dans le graphe d'export.
    const scale = Math.max(BLUR_W / video.videoWidth, BLUR_H / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    context.drawImage(video, (BLUR_W - width) / 2, (BLUR_H - height) / 2, width, height);
    return clock.subscribe(() => {
      const currentCanvas = blurRef.current;
      const currentVideo = (activeIsA ? videoA.current : videoB.current) ?? null;
      if (!currentCanvas || !currentVideo || currentVideo.readyState < 2) return;
      const currentContext = currentCanvas.getContext("2d");
      if (!currentContext) return;
      const currentScale = Math.max(
        BLUR_W / currentVideo.videoWidth,
        BLUR_H / currentVideo.videoHeight,
      );
      const currentWidth = currentVideo.videoWidth * currentScale;
      const currentHeight = currentVideo.videoHeight * currentScale;
      currentContext.drawImage(
        currentVideo,
        (BLUR_W - currentWidth) / 2,
        (BLUR_H - currentHeight) / 2,
        currentWidth,
        currentHeight,
      );
    });
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

  // Le viseur 9:16 du mode « rush entier » se place là où le cadrage regarde :
  // il montre la portion réellement conservée, pas un rectangle décoratif.
  const guideLeft = `${cropXPercent(effectiveCropX)}%`;

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
              ? "Cliquer pour lire · tirer horizontalement pour déplacer le cadrage"
              : "Cliquer pour lire ou mettre en pause"
          }
        >
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
            style={{ objectPosition }}
            preload="auto"
            playsInline
            muted
          />
          <video
            ref={videoB}
            className={videoClass(!activeIsA)}
            style={{ objectPosition }}
            preload="auto"
            playsInline
            muted
          />
          <audio ref={audioA} preload="auto" />
          <audio ref={audioB} preload="auto" />
          <div ref={fadeRef} className="preview-video-fade" aria-hidden="true" />

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
              style={{ left: guideLeft }}
              title="Portion conservée par le cadrage vertical"
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
        <div className="viewer-group">
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
