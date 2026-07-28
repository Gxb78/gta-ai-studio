import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import type { TextOverlay } from "../types";
import { formatTime } from "../types";

interface Props {
  overlays: TextOverlay[];
  selectedId: string | null;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onCollapse: () => void;
}

export function TextPanel({ overlays, selectedId, onAdd, onSelect, onCollapse }: Props) {
  return (
    <aside className="panel panel-text">
      <div className="panel-head">
        <h2>Titres</h2>
        <button
          type="button"
          className="icon-btn ghost"
          onClick={onCollapse}
          title="Replier le panneau"
          aria-label="Replier le panneau Titres"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
      <button type="button" className="primary panel-action" onClick={onAdd}>
        <Icon name="plus" size={15} />
        Ajouter un titre
      </button>
      {overlays.length === 0 ? (
        <EmptyState
          icon="text"
          title="Aucun titre dans ce montage."
          hint="Un titre se pose au playhead, puis se déplace dans la bande Titres de la timeline."
        />
      ) : (
        <div className="text-list">
          {[...overlays]
            .sort((a, b) => a.timelineStartMs - b.timelineStartMs)
            .map((overlay) => (
              <button
                key={overlay.id}
                type="button"
                className={"text-list-item" + (overlay.id === selectedId ? " selected" : "")}
                onClick={() => onSelect(overlay.id)}
              >
                <span className="text-list-copy">{overlay.text || "Titre vide"}</span>
                <span className="muted">
                  {formatTime(overlay.timelineStartMs)} - {formatTime(overlay.timelineEndMs)}
                </span>
              </button>
            ))}
        </div>
      )}
    </aside>
  );
}
