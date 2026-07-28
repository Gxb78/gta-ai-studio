// Barre d'outils verticale : les panneaux latéraux en haut, le mode du pointeur
// en bas.
//
// On n'y met que des outils et panneaux réellement disponibles : une entrée
// grisée « bientôt » ne rend service à personne et fait croire à une capacité.
//
// Chaque entrée porte son libellé sous l'icône. Une barre d'icônes nues oblige
// à survoler pour savoir ce qu'on regarde ; à cinq entrées, le coût en largeur
// est négligeable face à ce qu'il fait gagner.

import { Icon, type IconName } from "./Icon";

export type Tool = "select" | "blade";

/** Panneau affiché dans la colonne de gauche. Un seul à la fois, jamais deux. */
export type SidePanel = "media" | "text" | "inspector";

interface Props {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  sidePanel: SidePanel | null;
  onSelectPanel: (panel: SidePanel | null) => void;
}

interface Entry {
  icon: IconName;
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}

function RailButton({ entry }: { entry: Entry }) {
  return (
    <button
      type="button"
      className={"rail-btn" + (entry.active ? " active" : "")}
      onClick={entry.onClick}
      title={entry.title}
      aria-pressed={entry.active}
    >
      <Icon name={entry.icon} size={19} />
      <span className="rail-label">{entry.label}</span>
    </button>
  );
}

export function ToolRail(props: Props) {
  // Cliquer sur le panneau déjà ouvert le referme (bascule) ; cliquer sur un
  // autre panneau bascule dessus directement, sans étape intermédiaire de
  // fermeture — un seul est jamais affiché, ce n'est donc pas une action à
  // deux temps.
  const select = (panel: SidePanel) => () =>
    props.onSelectPanel(props.sidePanel === panel ? null : panel);

  const panels: Entry[] = [
    {
      icon: "folder",
      label: "Médias",
      title: "Panneau Médias",
      active: props.sidePanel === "media",
      onClick: select("media"),
    },
    {
      icon: "text",
      label: "Titres",
      title: "Panneau Titres",
      active: props.sidePanel === "text",
      onClick: select("text"),
    },
    {
      icon: "sliders",
      label: "Inspecteur",
      title: "Inspecteur",
      active: props.sidePanel === "inspector",
      onClick: select("inspector"),
    },
  ];

  const tools: Entry[] = [
    {
      icon: "cursor",
      label: "Sélection",
      title: "Sélection · V",
      active: props.tool === "select",
      onClick: () => props.onToolChange("select"),
    },
    {
      icon: "blade",
      label: "Lame",
      title: "Lame — couper au clic · B",
      active: props.tool === "blade",
      onClick: () => props.onToolChange("blade"),
    },
  ];

  return (
    <nav className="tool-rail" aria-label="Panneaux et outils">
      {panels.map((entry) => (
        <RailButton key={entry.label} entry={entry} />
      ))}

      <span className="rail-sep" aria-hidden="true" />

      {tools.map((entry) => (
        <RailButton key={entry.label} entry={entry} />
      ))}
    </nav>
  );
}
