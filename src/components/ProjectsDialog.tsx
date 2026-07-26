// Projets récents : ouvrir un montage déjà commencé, ou repartir de zéro.
//
// La liste vient du dossier de projets, triée du plus récent au plus ancien.
// Un projet dont les fichiers de montage ont été nettoyés reste listé : on
// préfère un message clair au clic plutôt qu'une liste qui cache des entrées.

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { listProjects, loadProject, mediaUrl } from "../ipc";
import type { ProjectSummary, StoredProject } from "../types";

interface Props {
  /** Projet actuellement ouvert, pour le signaler dans la liste. */
  currentId: string | null;
  onOpen: (project: StoredProject) => void;
  onNewProject: () => void;
  onClose: () => void;
}

/** Date lisible, sans dépendance de mise en forme. */
const shortDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "date inconnue";
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export function ProjectsDialog({ currentId, onOpen, onNewProject, onClose }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch((e) => {
        setProjects([]);
        setError(String(e));
      });
  }, []);

  const open = async (id: string) => {
    setError(null);
    setOpening(id);
    try {
      const project = await loadProject(id);
      if (!project) throw new Error("Projet introuvable.");
      onOpen(project);
    } catch (e) {
      setError(String(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>Projets récents</h2>
          <button className="icon-btn ghost" onClick={onClose} title="Fermer">
            <Icon name="close" />
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {projects === null && <p className="muted">Lecture du dossier de projets…</p>}

        {projects !== null && projects.length === 0 && (
          <p className="muted">Aucun projet enregistré pour le moment.</p>
        )}

        {projects !== null && projects.length > 0 && (
          <div className="project-list">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={"project-card" + (project.id === currentId ? " current" : "")}
                onClick={() => void open(project.id)}
                disabled={opening !== null}
              >
                {project.thumbPath ? (
                  <img src={mediaUrl(project.thumbPath)} alt="" draggable={false} />
                ) : (
                  <span className="project-thumb-empty" />
                )}
                <span className="project-meta">
                  <span className="project-name">{project.name}</span>
                  <span className="muted small-text">
                    {project.clipCount} clip{project.clipCount > 1 ? "s" : ""} ·{" "}
                    {shortDate(project.updatedAt)}
                  </span>
                </span>
                {project.id === currentId && <span className="badge">Ouvert</span>}
              </button>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="primary" onClick={onNewProject}>
            <Icon name="plus" size={15} />
            Nouveau projet
          </button>
        </div>
      </div>
    </div>
  );
}
