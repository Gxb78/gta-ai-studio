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
import { useDebouncedSlider } from "../hooks/useDebouncedSlider";
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

  // Un curseur par réglage, chacun ne committant qu'une fois relâché ou
  // resté silencieux (voir useDebouncedSlider) : sans ça, tirer l'agrandissement
  // ou une rampe empile une entrée d'historique par tick de la souris.
  const scaleSlider = useDebouncedSlider(zoom.scale, (value) => onUpdate({ scale: value }), zoom.id);
  const xSlider = useDebouncedSlider(zoom.x, (value) => onUpdate({ x: value }), zoom.id);
  const ySlider = useDebouncedSlider(zoom.y, (value) => onUpdate({ y: value }), zoom.id);
  const rampInSlider = useDebouncedSlider(
    zoom.rampInMs,
    (value) => onUpdate({ rampInMs: value }),
    zoom.id,
  );
  const rampOutSlider = useDebouncedSlider(
    zoom.rampOutMs,
    (value) => onUpdate({ rampOutMs: value }),
    zoom.id,
  );

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

      <InspectorSection
        title="Zone"
        summary={`${scaleSlider.value.toFixed(2)}× · ${Math.round(100 / scaleSlider.value)} % du cadre`}
      >
        <div className="slider-row">
          <Icon name="search" size={15} />
          <input
            type="range"
            min={MIN_ZOOM_SCALE}
            max={MAX_ZOOM_SCALE}
            step={0.05}
            value={scaleSlider.value}
            onChange={(event) => scaleSlider.onChange(Number(event.target.value))}
            onPointerUp={scaleSlider.commitNow}
            onBlur={scaleSlider.commitNow}
            aria-label="Agrandissement du zoom"
          />
          <input
            type="number"
            className="slider-number"
            min={MIN_ZOOM_SCALE}
            max={MAX_ZOOM_SCALE}
            step={0.05}
            value={Number(scaleSlider.value.toFixed(2))}
            onChange={(event) => scaleSlider.onChange(Number(event.target.value))}
            onBlur={scaleSlider.commitNow}
            aria-label="Agrandissement du zoom, valeur exacte"
          />
        </div>
        <p className="muted small-text">
          Au-delà de 2×, l'image du rush est étirée et devient molle : c'est le
          rush qui décide, pas le réglage. Tire aussi un coin de la zone dans
          l'aperçu pour l'agrandir ou la rétrécir directement.
        </p>
        <div className="zoom-presets">
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              scaleSlider.cancel();
              onUpdate({ scale: 2 });
            }}
          >
            Moitié
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              scaleSlider.cancel();
              onUpdate({ scale: 3 });
            }}
          >
            Tiers
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              scaleSlider.cancel();
              onUpdate({ scale: 4 });
            }}
          >
            Quart
          </button>
        </div>
      </InspectorSection>

      <InspectorSection
        title="Point visé"
        summary={`${Math.round(xSlider.value * 100)} % · ${Math.round(ySlider.value * 100)} %`}
      >
        <p className="muted small-text">
          Tire le repère dans l'aperçu pour viser, ou pose un coin d'un clic.
          Le zoom s'arrête au bord du cadre : viser un coin ne fait jamais
          entrer de noir.
        </p>
        {(
          [
            { axis: "x" as const, label: "Gauche/droite", slider: xSlider },
            { axis: "y" as const, label: "Haut/bas", slider: ySlider },
          ]
        ).map(({ axis, label, slider }) => (
          <label className="slider-row" key={axis}>
            <span className="fade-label">{label}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={slider.value}
              onChange={(event) => slider.onChange(Number(event.target.value))}
              onPointerUp={slider.commitNow}
              onBlur={slider.commitNow}
            />
            <span className="slider-value">{Math.round(slider.value * 100)} %</span>
          </label>
        ))}
        <div className="zoom-presets zoom-presets-grid">
          {(
            [
              { x: 0, y: 0, label: "↖ Coin" },
              { x: 0.5, y: 0, label: "↑ Haut" },
              { x: 1, y: 0, label: "↗ Coin" },
              { x: 0, y: 0.5, label: "← Gauche" },
              { x: 0.5, y: 0.5, label: "• Centre" },
              { x: 1, y: 0.5, label: "Droite →" },
              { x: 0, y: 1, label: "↙ Coin" },
              { x: 0.5, y: 1, label: "↓ Bas" },
              { x: 1, y: 1, label: "↘ Coin" },
            ] as const
          ).map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="ghost small"
              onClick={() => {
                xSlider.cancel();
                ySlider.cancel();
                onUpdate({ x: preset.x, y: preset.y });
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </InspectorSection>

      <InspectorSection
        title="Effet"
        summary={`${zoom.direction === "out" ? "Éloignement" : "Rapprochement"} · ${zoom.easing === "ease" ? "progressif" : "linéaire"}`}
      >
        <p className="muted small-text">
          Le sens du mouvement, et si la caméra démarre/s'arrête net ou en
          douceur.
        </p>
        <div className="zoom-effect-row">
          <button
            type="button"
            className={"ghost small" + (zoom.direction !== "out" ? " active" : "")}
            onClick={() => onUpdate({ direction: "in" })}
          >
            Rapprochement
          </button>
          <button
            type="button"
            className={"ghost small" + (zoom.direction === "out" ? " active" : "")}
            onClick={() => onUpdate({ direction: "out" })}
          >
            Éloignement
          </button>
        </div>
        <div className="zoom-effect-row">
          <button
            type="button"
            className={"ghost small" + (zoom.easing !== "ease" ? " active" : "")}
            onClick={() => onUpdate({ easing: "linear" })}
          >
            Linéaire
          </button>
          <button
            type="button"
            className={"ghost small" + (zoom.easing === "ease" ? " active" : "")}
            onClick={() => onUpdate({ easing: "ease" })}
          >
            Progressif
          </button>
        </div>
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
        summary={`${rampLabel(rampInSlider.value)} / ${rampLabel(rampOutSlider.value)}`}
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
              value={rampInSlider.value}
              onChange={(event) => rampInSlider.onChange(Number(event.target.value))}
              onPointerUp={rampInSlider.commitNow}
              onBlur={rampInSlider.commitNow}
              aria-label="Durée du zoom avant"
            />
            <span className="slider-value">{rampLabel(rampInSlider.value)}</span>
          </label>
          <label className="slider-row">
            <span className="fade-label">Retour</span>
            <input
              type="range"
              min={0}
              max={maxRampMs}
              step={50}
              value={rampOutSlider.value}
              onChange={(event) => rampOutSlider.onChange(Number(event.target.value))}
              onPointerUp={rampOutSlider.commitNow}
              onBlur={rampOutSlider.commitNow}
              aria-label="Durée du retour"
            />
            <span className="slider-value">{rampLabel(rampOutSlider.value)}</span>
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
