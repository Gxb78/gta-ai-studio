// Inspecteur : les réglages de ce qui est sélectionné, et rien d'autre.
//
// Le cadrage vertical est un réglage du PROJET (il vaut pour toute la sortie) ;
// le décalage du cadrage, la vitesse et le son appartiennent au CLIP. Les deux
// niveaux sont donc séparés visuellement, pour qu'on ne croie jamais régler un
// clip alors qu'on règle le montage entier.

import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { InspectorSection } from "./InspectorSection";
import { sourceName } from "./MediaPanel";
import { useDebouncedSlider } from "../hooks/useDebouncedSlider";
import type { Clip, FramingMode, SourceInfo } from "../types";
import {
  MAX_RATE,
  MAX_AUDIO_FADE_MS,
  MAX_VIDEO_FADE_MS,
  MAX_VOLUME,
  MIN_RATE,
  MIN_VOLUME,
  clipDurationMs,
  clipEndMs,
  formatTime,
} from "../types";

const RATES = [0.25, 0.5, 1, 1.5, 2, 3, 4];

interface Props {
  clip: Clip | null;
  source: SourceInfo | null;
  framing: FramingMode;
  onSetFraming: (framing: FramingMode) => void;
  onSetCropX: (cropX: number) => void;
  onSetRate: (rate: number) => void;
  onSetVolume: (volume: number) => void;
  onSetAudioFade: (side: "in" | "out" | "both", fadeMs: number) => void;
  onSetVideoFade: (side: "in" | "out" | "both", fadeMs: number) => void;
  transitionMaxMs: number;
  effectiveTransitionMs: number;
  onSetTransitionIn: (durationMs: number) => void;
  onToggleAudio: () => void;
  /** Faux sur le dernier clip : le réducteur en garde toujours un au montage. */
  canDelete: boolean;
  onDelete: () => void;
  onCollapse: () => void;
}

export function Inspector(props: Props) {
  const { clip, source, framing } = props;
  const maxFadeMs = clip
    ? Math.min(MAX_AUDIO_FADE_MS, clipDurationMs(clip) / 2)
    : MAX_AUDIO_FADE_MS;
  const maxVideoFadeMs = clip
    ? Math.min(MAX_VIDEO_FADE_MS, clipDurationMs(clip) / 2)
    : MAX_VIDEO_FADE_MS;
  const fadeLabel = (fadeMs: number): string =>
    fadeMs === 0 ? "Aucun" : `${(fadeMs / 1000).toFixed(fadeMs % 1000 === 0 ? 0 : 2)} s`;

  // Un curseur par réglage, chacun ne committant qu'une fois relâché ou
  // resté silencieux (voir useDebouncedSlider) : sans ça, resserrer un fondu
  // empile une entrée d'historique par tick de la souris. Appelés
  // inconditionnellement (hooks), avec 0 comme repli hors sélection — les
  // callbacks de commit sont déjà gardées côté App si `clip` est null.
  const resetKey = clip?.id ?? "none";
  const cropXSlider = useDebouncedSlider(clip?.cropX ?? 0, props.onSetCropX, resetKey);
  const videoFadeInSlider = useDebouncedSlider(
    clip?.videoFadeInMs ?? 0,
    (value) => props.onSetVideoFade("in", value),
    resetKey,
  );
  const videoFadeOutSlider = useDebouncedSlider(
    clip?.videoFadeOutMs ?? 0,
    (value) => props.onSetVideoFade("out", value),
    resetKey,
  );
  const transitionInSlider = useDebouncedSlider(
    props.effectiveTransitionMs,
    props.onSetTransitionIn,
    resetKey,
  );
  const volumeSlider = useDebouncedSlider(clip?.volume ?? 1, props.onSetVolume, resetKey);
  const audioFadeInSlider = useDebouncedSlider(
    clip?.audioFadeInMs ?? 0,
    (value) => props.onSetAudioFade("in", value),
    resetKey,
  );
  const audioFadeOutSlider = useDebouncedSlider(
    clip?.audioFadeOutMs ?? 0,
    (value) => props.onSetAudioFade("out", value),
    resetKey,
  );

  return (
    <aside className="panel panel-inspector">
      <div className="panel-head">
        <h2>Inspecteur</h2>
        <button
          type="button"
          className="icon-btn ghost"
          onClick={props.onCollapse}
          title="Replier le panneau"
          aria-label="Replier l'inspecteur"
        >
          <Icon name="close" size={15} />
        </button>
      </div>

      <InspectorSection
        title="Cadrage du projet"
        summary={framing === "crop" ? "Recadrage" : "Fond flou"}
      >
        <div className="option-grid">
          <label className={"option" + (framing === "crop" ? " selected" : "")}>
            <input
              type="radio"
              checked={framing === "crop"}
              onChange={() => props.onSetFraming("crop")}
            />
            <span className="option-preview option-crop" aria-hidden="true" />
            <span className="option-label">Recadrage</span>
            <span className="option-note muted">Plein écran, coupe les côtés</span>
          </label>
          <label className={"option" + (framing === "blur" ? " selected" : "")}>
            <input
              type="radio"
              checked={framing === "blur"}
              onChange={() => props.onSetFraming("blur")}
            />
            <span className="option-preview option-blur" aria-hidden="true" />
            <span className="option-label">Fond flou</span>
            <span className="option-note muted">Image entière conservée</span>
          </label>
        </div>
      </InspectorSection>

      {!clip || !source ? (
        <EmptyState
          icon="cursor"
          title="Aucun clip sélectionné."
          hint="Clique un clip sur la timeline pour régler son cadrage, sa vitesse, ses fondus et son son."
        />
      ) : (
        <>
          <InspectorSection title="Clip" summary={sourceName(source)}>
            <dl className="prop-list">
              <dt>Rush</dt>
              <dd title={source.originalPath}>{sourceName(source)}</dd>
              <dt>Position</dt>
              <dd>
                {formatTime(clip.timelineStartMs)} → {formatTime(clipEndMs(clip))}
              </dd>
              <dt>Durée</dt>
              <dd>{formatTime(clipDurationMs(clip))}</dd>
              <dt>Dans le rush</dt>
              <dd>
                {formatTime(clip.srcInMs)} → {formatTime(clip.srcOutMs)}
              </dd>
              <dt>Piste</dt>
              <dd>V{clip.track + 1}</dd>
            </dl>
          </InspectorSection>

          <InspectorSection
            title="Cadrage du clip"
            note={framing === "blur" ? "sans effet en fond flou" : undefined}
            summary={cropXSlider.value === 0 ? "centré" : `${Math.round(cropXSlider.value * 100)} %`}
          >
            <div className="slider-row">
              <Icon name="crop" size={15} />
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={cropXSlider.value}
                disabled={framing === "blur"}
                onChange={(event) => cropXSlider.onChange(Number(event.target.value))}
                onPointerUp={cropXSlider.commitNow}
                onBlur={cropXSlider.commitNow}
                aria-label="Décalage horizontal du cadrage"
              />
              <span className="slider-value">
                {cropXSlider.value === 0 ? "centré" : `${Math.round(cropXSlider.value * 100)} %`}
              </span>
            </div>
            {clip.cropX !== 0 && framing === "crop" && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  cropXSlider.cancel();
                  props.onSetCropX(0);
                }}
              >
                Recentrer
              </button>
            )}
          </InspectorSection>

          <InspectorSection title="Vitesse" summary={`${clip.playbackRate}×`}>
            <div className="chip-row">
              {RATES.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  className={"chip" + (clip.playbackRate === rate ? " active" : "")}
                  onClick={() => props.onSetRate(rate)}
                >
                  {rate}×
                </button>
              ))}
            </div>
            {(clip.playbackRate < MIN_RATE || clip.playbackRate > MAX_RATE) && (
              <p className="warn">Vitesse hors bornes, ramenée à l'application.</p>
            )}
          </InspectorSection>

          <InspectorSection
            title="Fondu vidéo"
            summary={
              videoFadeInSlider.value === 0 && videoFadeOutSlider.value === 0
                ? "Aucun"
                : `${fadeLabel(videoFadeInSlider.value)} / ${fadeLabel(videoFadeOutSlider.value)}`
            }
          >
            <div className="fade-control">
              <label className="slider-row">
                <span className="fade-label">Entrée</span>
                <input
                  type="range"
                  min={0}
                  max={maxVideoFadeMs}
                  step={50}
                  value={videoFadeInSlider.value}
                  onChange={(event) => videoFadeInSlider.onChange(Number(event.target.value))}
                  onPointerUp={videoFadeInSlider.commitNow}
                  onBlur={videoFadeInSlider.commitNow}
                  aria-label="Fondu vidéo d'entrée"
                />
                <span className="slider-value">{fadeLabel(videoFadeInSlider.value)}</span>
              </label>
              <label className="slider-row">
                <span className="fade-label">Sortie</span>
                <input
                  type="range"
                  min={0}
                  max={maxVideoFadeMs}
                  step={50}
                  value={videoFadeOutSlider.value}
                  onChange={(event) => videoFadeOutSlider.onChange(Number(event.target.value))}
                  onPointerUp={videoFadeOutSlider.commitNow}
                  onBlur={videoFadeOutSlider.commitNow}
                  aria-label="Fondu vidéo de sortie"
                />
                <span className="slider-value">{fadeLabel(videoFadeOutSlider.value)}</span>
              </label>
            </div>
            {(clip.videoFadeInMs > 0 || clip.videoFadeOutMs > 0) && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  videoFadeInSlider.cancel();
                  videoFadeOutSlider.cancel();
                  props.onSetVideoFade("both", 0);
                }}
              >
                Retirer les fondus
              </button>
            )}
          </InspectorSection>

          <InspectorSection
            title="Transition"
            summary={fadeLabel(transitionInSlider.value)}
          >
            <label className="slider-row">
              <span className="fade-label">Enchaîné</span>
              <input
                type="range"
                min={0}
                max={Math.max(50, props.transitionMaxMs)}
                step={50}
                value={transitionInSlider.value}
                disabled={props.transitionMaxMs <= 0}
                onChange={(event) => transitionInSlider.onChange(Number(event.target.value))}
                onPointerUp={transitionInSlider.commitNow}
                onBlur={transitionInSlider.commitNow}
                aria-label="Durée du fondu enchaîné"
              />
              <span className="slider-value">{fadeLabel(transitionInSlider.value)}</span>
            </label>
            {props.transitionMaxMs <= 0 && (
              <p className="muted small-text">Coupe incompatible ou poignées insuffisantes.</p>
            )}
            {clip.transitionInMs > 0 && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  transitionInSlider.cancel();
                  props.onSetTransitionIn(0);
                }}
              >
                Retirer la transition
              </button>
            )}
          </InspectorSection>

          <InspectorSection
            title="Son"
            summary={
              clip.audioEnabled ? `${Math.round(volumeSlider.value * 100)} %` : "Coupé"
            }
          >
            <button
              type="button"
              className={"ghost small" + (clip.audioEnabled ? "" : " active")}
              onClick={props.onToggleAudio}
              title="M"
            >
              <Icon name={clip.audioEnabled ? "sound" : "soundOff"} size={15} />
              {clip.audioEnabled ? "Son actif" : "Son coupé"}
            </button>
            <div className="slider-row">
              <Icon name={volumeSlider.value === 0 ? "soundOff" : "volume"} size={15} />
              <input
                type="range"
                min={MIN_VOLUME}
                max={MAX_VOLUME}
                step={0.01}
                value={volumeSlider.value}
                disabled={!clip.audioEnabled}
                onChange={(event) => volumeSlider.onChange(Number(event.target.value))}
                onPointerUp={volumeSlider.commitNow}
                onBlur={volumeSlider.commitNow}
                aria-label="Volume du clip"
              />
              <span className="slider-value">{Math.round(volumeSlider.value * 100)} %</span>
            </div>
            {clip.volume !== 1 && clip.audioEnabled && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  volumeSlider.cancel();
                  props.onSetVolume(1);
                }}
              >
                Rétablir 100 %
              </button>
            )}
            <div className="fade-control">
              <label className="slider-row">
                <span className="fade-label">Entrée</span>
                <input
                  type="range"
                  min={0}
                  max={maxFadeMs}
                  step={50}
                  value={audioFadeInSlider.value}
                  disabled={!clip.audioEnabled}
                  onChange={(event) => audioFadeInSlider.onChange(Number(event.target.value))}
                  onPointerUp={audioFadeInSlider.commitNow}
                  onBlur={audioFadeInSlider.commitNow}
                  aria-label="Fondu audio d'entrée"
                />
                <span className="slider-value">{fadeLabel(audioFadeInSlider.value)}</span>
              </label>
              <label className="slider-row">
                <span className="fade-label">Sortie</span>
                <input
                  type="range"
                  min={0}
                  max={maxFadeMs}
                  step={50}
                  value={audioFadeOutSlider.value}
                  disabled={!clip.audioEnabled}
                  onChange={(event) => audioFadeOutSlider.onChange(Number(event.target.value))}
                  onPointerUp={audioFadeOutSlider.commitNow}
                  onBlur={audioFadeOutSlider.commitNow}
                  aria-label="Fondu audio de sortie"
                />
                <span className="slider-value">{fadeLabel(audioFadeOutSlider.value)}</span>
              </label>
            </div>
            {(clip.audioFadeInMs > 0 || clip.audioFadeOutMs > 0) && clip.audioEnabled && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  audioFadeInSlider.cancel();
                  audioFadeOutSlider.cancel();
                  props.onSetAudioFade("both", 0);
                }}
              >
                Retirer les fondus
              </button>
            )}
            <p className="muted small-text">
              Couper le son d'une surcouche laisse passer celui de la piste du dessous.
            </p>
          </InspectorSection>

          <div className="panel-danger">
            <button
              type="button"
              className="ghost small warn"
              onClick={props.onDelete}
              disabled={!props.canDelete}
              title={
                props.canDelete
                  ? "Supprimer le clip"
                  : "Le montage garde toujours au moins un clip"
              }
            >
              <Icon name="trash" size={15} />
              Supprimer le clip
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
