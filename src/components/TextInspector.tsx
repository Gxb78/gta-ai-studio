import { Icon } from "./Icon";
import { InspectorSection } from "./InspectorSection";
import { useDebouncedSlider } from "../hooks/useDebouncedSlider";
import type { TextOverlay, TextStyle } from "../types";
import {
  MAX_TEXT_FADE_MS,
  MAX_TEXT_LENGTH,
  MAX_TEXT_SIZE_PX,
  MIN_TEXT_SIZE_PX,
} from "../types";

const STYLES: Array<{ value: TextStyle; label: string }> = [
  { value: "impact", label: "Impact" },
  { value: "caption", label: "Légende" },
  { value: "minimal", label: "Minimal" },
];

interface Props {
  overlay: TextOverlay;
  durationMs: number;
  onUpdate: (patch: Partial<TextOverlay>) => void;
  onDelete: () => void;
  onCollapse: () => void;
}

export function TextInspector({ overlay, durationMs, onUpdate, onDelete, onCollapse }: Props) {
  const duration = Math.max(0.1, (overlay.timelineEndMs - overlay.timelineStartMs) / 1000);
  const maxFadeMs = Math.min(
    MAX_TEXT_FADE_MS,
    (overlay.timelineEndMs - overlay.timelineStartMs) / 2,
  );
  const fadeLabel = (fadeMs: number): string =>
    fadeMs === 0 ? "Aucun" : `${(fadeMs / 1000).toFixed(fadeMs % 1000 === 0 ? 0 : 2)} s`;

  // Un curseur par réglage, chacun ne committant qu'une fois relâché ou
  // resté silencieux (voir useDebouncedSlider) : sans ça, tirer la taille ou
  // un fondu empile une entrée d'historique par tick de la souris.
  const fontSizeSlider = useDebouncedSlider(
    overlay.fontSizePx,
    (value) => onUpdate({ fontSizePx: value }),
    overlay.id,
  );
  const xSlider = useDebouncedSlider(overlay.x, (value) => onUpdate({ x: value }), overlay.id);
  const ySlider = useDebouncedSlider(overlay.y, (value) => onUpdate({ y: value }), overlay.id);
  const fadeInSlider = useDebouncedSlider(
    overlay.fadeInMs,
    (value) => onUpdate({ fadeInMs: value }),
    overlay.id,
  );
  const fadeOutSlider = useDebouncedSlider(
    overlay.fadeOutMs,
    (value) => onUpdate({ fadeOutMs: value }),
    overlay.id,
  );

  const updateStart = (seconds: number) => {
    const start = Math.max(0, Math.min(durationMs - 100, seconds * 1000));
    onUpdate({
      timelineStartMs: start,
      timelineEndMs: Math.min(durationMs, start + duration * 1000),
    });
  };

  return (
    <aside className="panel panel-inspector">
      <div className="panel-head">
        <h2>Titre</h2>
        <button type="button" className="icon-btn ghost" onClick={onCollapse} title="Replier le panneau">
          <Icon name="close" size={15} />
        </button>
      </div>
      <InspectorSection title="Contenu" summary={overlay.text.split(/\r?\n/)[0]}>
        <textarea
          className="text-content-input"
          value={overlay.text}
          maxLength={MAX_TEXT_LENGTH}
          rows={4}
          onChange={(event) => onUpdate({ text: event.target.value })}
          aria-label="Texte du titre"
        />
        <span className="muted small-text">{overlay.text.length}/{MAX_TEXT_LENGTH}</span>
      </InspectorSection>
      <InspectorSection
        title="Style"
        summary={STYLES.find((style) => style.value === overlay.style)?.label}
      >
        <div className="chip-row">
          {STYLES.map((style) => (
            <button
              key={style.value}
              type="button"
              className={"chip" + (overlay.style === style.value ? " active" : "")}
              onClick={() => onUpdate({ style: style.value })}
            >
              {style.label}
            </button>
          ))}
        </div>
        <label className="slider-row">
          <span className="fade-label">Taille</span>
          <input
            type="range"
            min={MIN_TEXT_SIZE_PX}
            max={MAX_TEXT_SIZE_PX}
            step={2}
            value={fontSizeSlider.value}
            onChange={(event) => fontSizeSlider.onChange(Number(event.target.value))}
            onPointerUp={fontSizeSlider.commitNow}
            onBlur={fontSizeSlider.commitNow}
          />
          <span className="slider-value">{Math.round(fontSizeSlider.value)} px</span>
        </label>
      </InspectorSection>
      <InspectorSection
        title="Position"
        summary={`${Math.round(xSlider.value * 100)} % · ${Math.round(ySlider.value * 100)} %`}
      >
        {(
          [
            { axis: "X", slider: xSlider },
            { axis: "Y", slider: ySlider },
          ] as const
        ).map(({ axis, slider }) => (
          <label className="slider-row" key={axis}>
            <span className="fade-label">{axis}</span>
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
      </InspectorSection>
      <InspectorSection
        title="Timing"
        summary={`${(overlay.timelineStartMs / 1000).toFixed(1)} s · ${duration.toFixed(1)} s`}
      >
        <div className="text-time-grid">
          <label>
            <span>Début</span>
            <input
              type="number"
              min={0}
              max={Math.max(0, durationMs / 1000 - 0.1)}
              step={0.1}
              value={(overlay.timelineStartMs / 1000).toFixed(1)}
              onChange={(event) => updateStart(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Durée</span>
            <input
              type="number"
              min={0.1}
              max={Math.max(0.1, (durationMs - overlay.timelineStartMs) / 1000)}
              step={0.1}
              value={duration.toFixed(1)}
              onChange={(event) =>
                onUpdate({
                  timelineEndMs:
                    overlay.timelineStartMs + Math.max(0.1, Number(event.target.value)) * 1000,
                })
              }
            />
          </label>
        </div>
      </InspectorSection>
      <InspectorSection
        title="Animation"
        summary={
          fadeInSlider.value === 0 && fadeOutSlider.value === 0
            ? "Aucune"
            : `${fadeLabel(fadeInSlider.value)} / ${fadeLabel(fadeOutSlider.value)}`
        }
      >
        <div className="fade-control">
          <label className="slider-row">
            <span className="fade-label">Entrée</span>
            <input
              type="range"
              min={0}
              max={maxFadeMs}
              step={50}
              value={fadeInSlider.value}
              onChange={(event) => fadeInSlider.onChange(Number(event.target.value))}
              onPointerUp={fadeInSlider.commitNow}
              onBlur={fadeInSlider.commitNow}
              aria-label="Fondu d'entrée du titre"
            />
            <span className="slider-value">{fadeLabel(fadeInSlider.value)}</span>
          </label>
          <label className="slider-row">
            <span className="fade-label">Sortie</span>
            <input
              type="range"
              min={0}
              max={maxFadeMs}
              step={50}
              value={fadeOutSlider.value}
              onChange={(event) => fadeOutSlider.onChange(Number(event.target.value))}
              onPointerUp={fadeOutSlider.commitNow}
              onBlur={fadeOutSlider.commitNow}
              aria-label="Fondu de sortie du titre"
            />
            <span className="slider-value">{fadeLabel(fadeOutSlider.value)}</span>
          </label>
        </div>
        {(overlay.fadeInMs > 0 || overlay.fadeOutMs > 0) && (
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              fadeInSlider.cancel();
              fadeOutSlider.cancel();
              onUpdate({ fadeInMs: 0, fadeOutMs: 0 });
            }}
          >
            Retirer les fondus
          </button>
        )}
      </InspectorSection>
      <div className="panel-danger">
        <button type="button" className="ghost small warn" onClick={onDelete}>
          <Icon name="trash" size={15} />
          Supprimer le titre
        </button>
      </div>
    </aside>
  );
}
