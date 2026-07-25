// Barre de transport : identité du projet, lecture, actions de montage, export.
// Trois zones stables — gauche / centre / droite — pour que rien ne saute
// quand le temps ou l'état changent.

import { Icon, type IconName } from "./Icon";
import { formatTime } from "../types";

interface Props {
  projectName: string;
  playing: boolean;
  playheadMs: number;
  durationMs: number;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  /** Le clip sélectionné participe-t-il au montage sonore ? */
  selectionAudible: boolean;
  onToggleClipAudio: () => void;
  showGuide: boolean;
  onTogglePlay: () => void;
  onSplit: () => void;
  onDeleteSelected: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleGuide: () => void;
  onNewRush: () => void;
  /** Import d'un rush supplémentaire en cours. */
  addingRush: boolean;
  onAddRush: () => void;
  onShowShortcuts: () => void;
  onExport: () => void;
}

function IconButton(props: {
  icon: IconName;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const { icon, label, shortcut, onClick, disabled, active } = props;
  return (
    <button
      type="button"
      className={"icon-btn ghost" + (active ? " active" : "")}
      onClick={onClick}
      disabled={disabled}
      title={shortcut ? `${label} · ${shortcut}` : label}
      aria-label={label}
    >
      <Icon name={icon} />
    </button>
  );
}

export function TransportBar(props: Props) {
  return (
    <header className="transport">
      <div className="transport-side">
        <span className="project-name" title={props.projectName}>
          {props.projectName}
        </span>
        <button
          type="button"
          className="ghost small"
          onClick={props.onAddRush}
          disabled={props.addingRush}
          title="Ajouter un rush à la suite du montage"
        >
          <Icon name="folder" size={15} />
          {props.addingRush ? "Import…" : "Ajouter un rush"}
        </button>
        <button type="button" className="ghost small" onClick={props.onNewRush} title="Fermer ce projet">
          Nouveau projet
        </button>
      </div>

      <div className="transport-center">
        <div className="btn-group">
          <IconButton icon="undo" label="Annuler" shortcut="Ctrl+Z" onClick={props.onUndo} disabled={!props.canUndo} />
          <IconButton icon="redo" label="Rétablir" shortcut="Ctrl+Y" onClick={props.onRedo} disabled={!props.canRedo} />
        </div>

        <button
          type="button"
          className="play-btn"
          onClick={props.onTogglePlay}
          title={props.playing ? "Pause · Espace" : "Lecture · Espace"}
          aria-label={props.playing ? "Pause" : "Lecture"}
        >
          <Icon name={props.playing ? "pause" : "play"} size={20} />
        </button>

        <div className="time">
          <span className="time-now">{formatTime(props.playheadMs)}</span>
          <span className="time-sep">/</span>
          <span className="time-total">{formatTime(props.durationMs)}</span>
        </div>

        <div className="btn-group">
          <IconButton icon="split" label="Couper au playhead" shortcut="S" onClick={props.onSplit} />
          <IconButton
            icon={props.selectionAudible ? "sound" : "soundOff"}
            label={props.selectionAudible ? "Couper le son du clip" : "Rendre le son au clip"}
            shortcut="M"
            onClick={props.onToggleClipAudio}
            disabled={!props.hasSelection}
            active={props.hasSelection && !props.selectionAudible}
          />
          <IconButton
            icon="trash"
            label="Supprimer le clip"
            shortcut="Suppr"
            onClick={props.onDeleteSelected}
            disabled={!props.hasSelection}
          />
        </div>
      </div>

      <div className="transport-side transport-right">
        <IconButton
          icon="keyboard"
          label="Raccourcis"
          shortcut="?"
          onClick={props.onShowShortcuts}
        />
        <button
          type="button"
          className={"ghost small" + (props.showGuide ? " active" : "")}
          onClick={props.onToggleGuide}
          title="Afficher la zone 9:16 conservée à l'export"
        >
          <Icon name="frame" size={15} />
          9:16
        </button>
        <button type="button" className="primary" onClick={props.onExport}>
          <Icon name="export" size={15} />
          Exporter
        </button>
      </div>
    </header>
  );
}
