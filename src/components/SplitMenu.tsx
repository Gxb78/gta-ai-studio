// Menu contextuel qui coupe PLUSIEURS éléments — clips, titres, zooms — à la
// MÊME position, en une seule entrée d'historique (voir SPLIT_MANY_AT).
//
// Ouvert au clic droit sur un espace vide de la timeline (règle, bandes
// Titres/Zooms, piste sans clip), ou depuis « Couper ici et étendre... » du
// menu d'un clip. La liste ne montre QUE ce qui existe réellement à cet
// instant précis : un clip par piste qui le recouvre, tout titre ou zoom qui
// le recouvre, en excluant tout ce qu'une coupe ne pourrait pas produire (bord
// trop proche, piste verrouillée) — même principe que ClipMenu : un menu court
// se lit plus vite qu'un menu majoritairement inerte.

import { useState } from "react";
import { useFloatingMenu } from "../hooks/useFloatingMenu";
import { Icon, type IconName } from "./Icon";
import type { EditorAction } from "../state/editor";
import { formatTime } from "../types";

export interface SplitCandidate {
  kind: "clip" | "text" | "zoom";
  id: string;
  label: string;
}

export interface SplitMenuTarget {
  x: number;
  y: number;
  timelineMs: number;
  candidates: SplitCandidate[];
  /** Précoché : l'élément visé par le clic d'origine, s'il y en a un. */
  primaryId: string | null;
}

interface Props {
  target: SplitMenuTarget;
  onClose: () => void;
  dispatch: (action: EditorAction) => void;
}

const KIND_ICON: Record<SplitCandidate["kind"], IconName> = {
  clip: "layers",
  text: "text",
  zoom: "search",
};

export function SplitMenu({ target, onClose, dispatch }: Props) {
  const { ref, placement } = useFloatingMenu<HTMLDivElement>(target.x, target.y, onClose);
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(target.primaryId ? [target.primaryId] : []),
  );

  const toggle = (id: string) => {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = () => {
    dispatch({
      type: "SPLIT_MANY_AT",
      timelineMs: target.timelineMs,
      clipIds: target.candidates
        .filter((c) => c.kind === "clip" && checked.has(c.id))
        .map((c) => c.id),
      textOverlayIds: target.candidates
        .filter((c) => c.kind === "text" && checked.has(c.id))
        .map((c) => c.id),
      zoomIds: target.candidates
        .filter((c) => c.kind === "zoom" && checked.has(c.id))
        .map((c) => c.id),
    });
    onClose();
  };

  return (
    <div
      ref={ref}
      className="menu split-menu"
      role="menu"
      style={placement}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="split-menu-head">
        <Icon name="split" size={14} />
        Couper à {formatTime(target.timelineMs)}
      </div>

      {target.candidates.length === 0 ? (
        <p className="muted small-text split-menu-empty">Rien à couper ici.</p>
      ) : (
        <div className="split-menu-list">
          {target.candidates.map((candidate) => (
            <label
              key={`${candidate.kind}-${candidate.id}`}
              className="split-menu-item"
            >
              <input
                type="checkbox"
                checked={checked.has(candidate.id)}
                onChange={() => toggle(candidate.id)}
              />
              <Icon name={KIND_ICON[candidate.kind]} size={13} />
              <span>{candidate.label}</span>
            </label>
          ))}
        </div>
      )}

      <button
        type="button"
        className="primary split-menu-confirm"
        disabled={checked.size === 0}
        onClick={confirm}
      >
        Couper{checked.size > 0 ? ` (${checked.size})` : ""}
      </button>
    </div>
  );
}
