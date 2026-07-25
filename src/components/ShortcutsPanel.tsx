// Aide-mémoire des raccourcis. Remplace la ligne d'aide tronquée : tout est
// visible d'un coup, et la fenêtre se ferme au moindre clic ou à Échap.

import { useEffect } from "react";
import { Icon } from "./Icon";

interface Props {
  frameStepMs: number;
  onClose: () => void;
}

interface Row {
  keys: string[];
  label: string;
}

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Lecture",
    rows: [
      { keys: ["Espace"], label: "Lecture / pause" },
      { keys: ["←", "→"], label: "Image précédente / suivante" },
      { keys: ["Maj", "←→"], label: "Reculer / avancer d'une seconde" },
    ],
  },
  {
    title: "Montage",
    rows: [
      { keys: ["S"], label: "Couper au playhead" },
      { keys: ["Suppr"], label: "Supprimer le clip sélectionné" },
      { keys: ["I"], label: "Début du clip au playhead" },
      { keys: ["O"], label: "Fin du clip au playhead" },
      { keys: ["Alt", "←→"], label: "Ajuster la fin, une image à la fois" },
      { keys: ["Alt", "Maj", "←→"], label: "Ajuster le début, une image à la fois" },
      { keys: ["Ctrl", "Alt", "←→"], label: "Ajuster par pas de 10 images" },
      { keys: ["Ctrl", "Z"], label: "Annuler" },
      { keys: ["Ctrl", "Y"], label: "Rétablir" },
    ],
  },
  {
    title: "Timeline",
    rows: [
      { keys: ["Molette"], label: "Défiler horizontalement" },
      { keys: ["Ctrl", "Molette"], label: "Zoomer sous le curseur" },
      { keys: ["Maj"], label: "Mode précis pendant un geste" },
      { keys: ["Échap"], label: "Annuler le geste en cours" },
    ],
  },
];

export function ShortcutsPanel({ frameStepMs, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Raccourcis</h2>
          <button className="icon-btn ghost" onClick={onClose} title="Fermer (Échap)">
            <Icon name="close" />
          </button>
        </div>

        <div className="shortcut-groups">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcut-group">
              <h3>{group.title}</h3>
              {group.rows.map((row) => (
                <div key={row.label} className="shortcut-row">
                  <span className="shortcut-keys">
                    {row.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                  <span className="muted">{row.label}</span>
                </div>
              ))}
            </section>
          ))}
        </div>

        <p className="muted footnote">
          Une image de ce rush dure {frameStepMs.toFixed(0)} ms. Les poignées d'un clip règlent sa
          durée, le corps du clip règle sa position.
        </p>
      </div>
    </div>
  );
}
