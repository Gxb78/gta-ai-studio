// Réglages d'un zoom animé.
//
// Un zoom décrit un geste de caméra : « rapproche-toi de là, pendant ce
// temps-là, puis reviens ». Les trois réglages sont donc le POINT visé,
// l'AGRANDISSEMENT, et le TEMPS — le reste est du bruit.
//
// Le point visé se règle surtout à la souris, en tirant le repère dans
// l'aperçu ; les curseurs sont là pour l'ajustement fin et pour dire ce que
// vaut le réglage courant.

import { Icon } from "./Icon";
import { InspectorSection } from "./InspectorSection";
import type { ZoomRegion } from "../types";
import {
  MAX_ZOOM_RAMP_MS,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_DURATION_MS,
  MIN_ZOOM_SCALE,
  clampZoomRampMs,
} from "../types";

interface Props {
  zoom: ZoomRegion;
  /** Durée totale du montage, pour borner les champs de temps. */
  durationMs: number;
  onUpdate: (patch: Partial<ZoomRegion>) => void;
  onDelete: () => void;
  onCollapse: () => void;
}

export function ZoomInspector({ zoom, durationMs, onUpdate, onDelete, onCollapse }: Props) {
  const zoomDurationMs = zoom.timelineEndMs - zoom.timelineStartMs;
  const maxRampMs = clampZoomRampMs(MAX_ZOOM_RAMP_MS, zoomDurationMs) || MAX_ZOOM_RAMP_MS;
  const rampLabel = (rampMs: number): string =>
    rampMs === 0 ? "Instantané" : `${(rampMs / 1000).toFixed(rampMs % 1000 === 0 ? 0 : 2)} s`;

  /** Déplacer le début garde la durée : on règle le quand, pas le combien. */
  const updateStart = (seconds: number) => {
    const startMs = Math.max(0, Math.min(durationMs - MIN_ZOOM_DURATION_MS, seconds * 1000));
    onUpdate({
      timelineStartMs: startMs,
      timelineEndMs: Math.min(durationMs, startMs + zoomDurationMs),
    });
  };

  return (
    <aside className="panel panel-inspector">
      <div className="panel-head">
        <h2>Zoom</h2>
        <button
          type="button"
          className="icon-btn ghost"
          onClick={onCollapse}
          title="Replier le panneau"
          aria-label="Replier l'inspecteur"
        >
          <Icon name="close" size={15} />
        </button>
      </div>

      <InspectorSection title="Agrandissement" summary={`${zoom.scale.toFixed(2)}×`}>
        <div className="slider-row">
          <Icon name="search" size={15} />
          <input
            type="range"
            min={MIN_ZOOM_SCALE}
            max={MAX_ZOOM_SCALE}
            step={0.05}
            value={zoom.scale}
            onChange={(event) => onUpdate({ scale: Number(event.target.value) })}
            aria-label="Agrandissement du zoom"
          />
          <span className="slider-value">{zoom.scale.toFixed(2)}×</span>
        </div>
        <p className="muted small-text">
          Au-delà de 2×, l'image du rush est étirée et devient molle : c'est le
          rush qui décide, pas le réglage.
        </p>
      </InspectorSection>

      <InspectorSection
        title="Point visé"
        summary={`${Math.round(zoom.x * 100)} % · ${Math.round(zoom.y * 100)} %`}
      >
        <p className="muted small-text">
          Tire le repère dans l'aperçu pour viser. Le zoom s'arrête au bord du
          cadre : viser un coin ne fait jamais entrer de noir.
        </p>
        {(["x", "y"] as const).map((axis) => (
          <label className="slider-row" key={axis}>
            <span className="fade-label">{axis === "x" ? "Gauche/droite" : "Haut/bas"}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={zoom[axis]}
              onChange={(event) => onUpdate({ [axis]: Number(event.target.value) })}
            />
            <span className="slider-value">{Math.round(zoom[axis] * 100)} %</span>
          </label>
        ))}
        {(zoom.x !== 0.5 || zoom.y !== 0.5) && (
          <button
            type="button"
            className="ghost small"
            onClick={() => onUpdate({ x: 0.5, y: 0.5 })}
          >
            Recentrer le point visé
          </button>
        )}
      </InspectorSection>

      <InspectorSection
        title="Timing"
        summary={`${(zoom.timelineStartMs / 1000).toFixed(1)} s · ${(zoomDurationMs / 1000).toFixed(1)} s`}
      >
        <div className="text-time-grid">
          <label>
            <span>Début</span>
            <input
              type="number"
              min={0}
              max={Math.max(0, (durationMs - MIN_ZOOM_DURATION_MS) / 1000)}
              step={0.1}
              value={(zoom.timelineStartMs / 1000).toFixed(1)}
              onChange={(event) => updateStart(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Durée</span>
            <input
              type="number"
              min={MIN_ZOOM_DURATION_MS / 1000}
              step={0.1}
              value={(zoomDurationMs / 1000).toFixed(1)}
              onChange={(event) =>
                onUpdate({
                  timelineEndMs:
                    zoom.timelineStartMs +
                    Math.max(MIN_ZOOM_DURATION_MS, Number(event.target.value) * 1000),
                })
              }
            />
          </label>
        </div>
      </InspectorSection>

      <InspectorSection
        title="Rampes"
        summary={`${rampLabel(zoom.rampInMs)} / ${rampLabel(zoom.rampOutMs)}`}
      >
        <p className="muted small-text">
          Le temps que met la caméra à s'approcher, puis à revenir. Une rampe
          nulle donne une coupe sèche sur le plan zoomé.
        </p>
        <div className="fade-control">
          <label className="slider-row">
            <span className="fade-label">Aller</span>
            <input
              type="range"
              min={0}
              max={maxRampMs}
              step={50}
              value={zoom.rampInMs}
              onChange={(event) => onUpdate({ rampInMs: Number(event.target.value) })}
              aria-label="Durée du zoom avant"
            />
            <span className="slider-value">{rampLabel(zoom.rampInMs)}</span>
          </label>
          <label className="slider-row">
            <span className="fade-label">Retour</span>
            <input
              type="range"
              min={0}
              max={maxRampMs}
              step={50}
              value={zoom.rampOutMs}
              onChange={(event) => onUpdate({ rampOutMs: Number(event.target.value) })}
              aria-label="Durée du retour"
            />
            <span className="slider-value">{rampLabel(zoom.rampOutMs)}</span>
          </label>
        </div>
      </InspectorSection>

      <div className="panel-danger">
        <button type="button" className="ghost small warn" onClick={onDelete}>
          <Icon name="trash" size={15} />
          Supprimer le zoom
        </button>
      </div>
    </aside>
  );
}
