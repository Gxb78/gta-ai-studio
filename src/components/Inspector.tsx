// Inspecteur : les réglages de ce qui est sélectionné, et rien d'autre.
//
// Le cadrage vertical est un réglage du PROJET (il vaut pour toute la sortie) ;
// le décalage du cadrage, la vitesse et le son appartiennent au CLIP. Les deux
// niveaux sont donc séparés visuellement, pour qu'on ne croie jamais régler un
// clip alors qu'on règle le montage entier.

import { Icon } from "./Icon";
import { sourceName } from "./MediaPanel";
import type { Clip, FramingMode, SourceInfo } from "../types";
import {
  MAX_RATE,
  MAX_AUDIO_FADE_MS,
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
  onToggleAudio: () => void;
  onDelete: () => void;
  onCollapse: () => void;
}

export function Inspector(props: Props) {
  const { clip, source, framing } = props;
  const maxFadeMs = clip
    ? Math.min(MAX_AUDIO_FADE_MS, clipDurationMs(clip) / 2)
    : MAX_AUDIO_FADE_MS;
  const fadeLabel = (fadeMs: number): string =>
    fadeMs === 0 ? "Aucun" : `${(fadeMs / 1000).toFixed(fadeMs % 1000 === 0 ? 0 : 2)} s`;

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

      <section className="inspector-section">
        <h3>Cadrage du projet</h3>
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
      </section>

      {!clip || !source ? (
        <p className="muted small-text panel-empty">
          Sélectionne un clip sur la timeline pour régler son cadrage, sa vitesse et son
          son.
        </p>
      ) : (
        <>
          <section className="inspector-section">
            <h3>Clip</h3>
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
          </section>

          <section className="inspector-section">
            <h3>
              Cadrage du clip
              {framing === "blur" && <span className="muted"> — sans effet en fond flou</span>}
            </h3>
            <div className="slider-row">
              <Icon name="crop" size={15} />
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={clip.cropX}
                disabled={framing === "blur"}
                onChange={(event) => props.onSetCropX(Number(event.target.value))}
                aria-label="Décalage horizontal du cadrage"
              />
              <span className="slider-value">
                {clip.cropX === 0 ? "centré" : `${Math.round(clip.cropX * 100)} %`}
              </span>
            </div>
            {clip.cropX !== 0 && framing === "crop" && (
              <button type="button" className="ghost small" onClick={() => props.onSetCropX(0)}>
                Recentrer
              </button>
            )}
          </section>

          <section className="inspector-section">
            <h3>Vitesse</h3>
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
          </section>

          <section className="inspector-section">
            <h3>Son</h3>
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
              <Icon name={clip.volume === 0 ? "soundOff" : "volume"} size={15} />
              <input
                type="range"
                min={MIN_VOLUME}
                max={MAX_VOLUME}
                step={0.01}
                value={clip.volume}
                disabled={!clip.audioEnabled}
                onChange={(event) => props.onSetVolume(Number(event.target.value))}
                aria-label="Volume du clip"
              />
              <span className="slider-value">{Math.round(clip.volume * 100)} %</span>
            </div>
            {clip.volume !== 1 && clip.audioEnabled && (
              <button type="button" className="ghost small" onClick={() => props.onSetVolume(1)}>
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
                  value={clip.audioFadeInMs}
                  disabled={!clip.audioEnabled}
                  onChange={(event) => props.onSetAudioFade("in", Number(event.target.value))}
                  aria-label="Fondu audio d'entrée"
                />
                <span className="slider-value">{fadeLabel(clip.audioFadeInMs)}</span>
              </label>
              <label className="slider-row">
                <span className="fade-label">Sortie</span>
                <input
                  type="range"
                  min={0}
                  max={maxFadeMs}
                  step={50}
                  value={clip.audioFadeOutMs}
                  disabled={!clip.audioEnabled}
                  onChange={(event) => props.onSetAudioFade("out", Number(event.target.value))}
                  aria-label="Fondu audio de sortie"
                />
                <span className="slider-value">{fadeLabel(clip.audioFadeOutMs)}</span>
              </label>
            </div>
            {(clip.audioFadeInMs > 0 || clip.audioFadeOutMs > 0) && clip.audioEnabled && (
              <button
                type="button"
                className="ghost small"
                onClick={() => props.onSetAudioFade("both", 0)}
              >
                Retirer les fondus
              </button>
            )}
            <p className="muted small-text">
              Couper le son d'une surcouche laisse passer celui de la piste du dessous.
            </p>
          </section>

          <section className="inspector-section">
            <button type="button" className="ghost small warn" onClick={props.onDelete}>
              <Icon name="trash" size={15} />
              Supprimer le clip
            </button>
          </section>
        </>
      )}
    </aside>
  );
}
