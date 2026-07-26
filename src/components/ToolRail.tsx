// Barre d'outils verticale : le mode du pointeur sur la timeline, puis les
// panneaux latéraux.
//
// On n'y met QUE des outils qui existent. Texte et transitions appartiennent à
// la couche d'habillage (v0.3) : un bouton grisé pour chacun serait une promesse
// que l'application ne tient pas.

import { Icon } from "./Icon";

export type Tool = "select" | "blade";

interface Props {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  mediaOpen: boolean;
  onToggleMedia: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}

export function ToolRail(props: Props) {
  return (
    <nav className="tool-rail" aria-label="Outils">
      <button
        type="button"
        className={"icon-btn ghost" + (props.tool === "select" ? " active" : "")}
        onClick={() => props.onToolChange("select")}
        title="Sélection · V"
        aria-label="Outil sélection"
      >
        <Icon name="cursor" size={17} />
      </button>
      <button
        type="button"
        className={"icon-btn ghost" + (props.tool === "blade" ? " active" : "")}
        onClick={() => props.onToolChange("blade")}
        title="Lame — couper au clic · B"
        aria-label="Outil lame"
      >
        <Icon name="blade" size={17} />
      </button>

      <span className="rail-sep" aria-hidden="true" />

      <button
        type="button"
        className={"icon-btn ghost" + (props.mediaOpen ? " active" : "")}
        onClick={props.onToggleMedia}
        title="Panneau Médias"
        aria-label="Panneau Médias"
      >
        <Icon name="folder" size={17} />
      </button>
      <button
        type="button"
        className={"icon-btn ghost" + (props.inspectorOpen ? " active" : "")}
        onClick={props.onToggleInspector}
        title="Inspecteur"
        aria-label="Inspecteur"
      >
        <Icon name="settings" size={17} />
      </button>
    </nav>
  );
}
