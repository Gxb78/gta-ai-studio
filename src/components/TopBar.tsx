// Barre supérieure : l'identité du projet à gauche, l'action principale à
// droite, rien entre les deux.
//
// Tout ce qui concerne la LECTURE est passé sous l'aperçu, tout ce qui concerne
// le MONTAGE est passé dans la barre d'outils ou l'inspecteur. Cette barre ne
// garde donc que ce qui parle du projet lui-même : son nom, son état de
// sauvegarde, l'historique, les réglages, l'export.

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

/** Où en est la sauvegarde automatique du projet. */
export type SaveState = "clean" | "saving" | "saved" | "error";

interface Props {
  projectName: string;
  onRename: (name: string) => void;
  saveState: SaveState;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onOpenProjects: () => void;
  onShowShortcuts: () => void;
  onNewProject: () => void;
  onExport: () => void;
}

const SAVE_LABEL: Record<SaveState, string> = {
  clean: "Enregistré",
  saving: "Enregistrement…",
  saved: "Enregistré",
  error: "Échec de la sauvegarde",
};

export function TopBar(props: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.projectName);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Fermeture au clic extérieur : un menu qui reste ouvert derrière l'aperçu
  // est plus gênant que pas de menu du tout.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  const commitName = () => {
    setEditing(false);
    props.onRename(draft);
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand-dot" aria-hidden="true" />
        {editing ? (
          <input
            className="name-input"
            value={draft}
            autoFocus
            maxLength={60}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitName();
              if (event.key === "Escape") {
                setDraft(props.projectName);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="ghost name-btn"
            title="Renommer le projet"
            onClick={() => {
              setDraft(props.projectName);
              setEditing(true);
            }}
          >
            {props.projectName}
          </button>
        )}
        <span
          className={"save-state save-" + props.saveState}
          title={props.saveError ?? SAVE_LABEL[props.saveState]}
        >
          {props.saveState === "error" ? (
            <Icon name="alert" size={13} />
          ) : props.saveState === "saving" ? (
            <span className="save-spinner" aria-hidden="true" />
          ) : (
            <Icon name="saved" size={13} />
          )}
          {SAVE_LABEL[props.saveState]}
        </span>
      </div>

      <div className="topbar-right">
        <div className="btn-group">
          <button
            type="button"
            className="icon-btn ghost"
            onClick={props.onUndo}
            disabled={!props.canUndo}
            title="Annuler · Ctrl+Z"
            aria-label="Annuler"
          >
            <Icon name="undo" />
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            onClick={props.onRedo}
            disabled={!props.canRedo}
            title="Rétablir · Ctrl+Y"
            aria-label="Rétablir"
          >
            <Icon name="redo" />
          </button>
        </div>

        <div className="menu-anchor" ref={menuRef}>
          <button
            type="button"
            className={"icon-btn ghost" + (menuOpen ? " active" : "")}
            onClick={() => setMenuOpen((open) => !open)}
            title="Paramètres"
            aria-label="Paramètres"
          >
            <Icon name="settings" />
          </button>
          {menuOpen && (
            <div className="menu" role="menu">
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenProjects();
                }}
              >
                <Icon name="projects" size={15} />
                Projets récents
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  props.onShowShortcuts();
                }}
              >
                <Icon name="keyboard" size={15} />
                Raccourcis clavier
                <kbd>?</kbd>
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  props.onNewProject();
                }}
              >
                <Icon name="plus" size={15} />
                Nouveau projet
              </button>
            </div>
          )}
        </div>

        <button type="button" className="primary" onClick={props.onExport}>
          <Icon name="export" size={15} />
          Exporter
        </button>
      </div>
    </header>
  );
}
