// Projets récents : ouvrir un montage déjà commencé, ou repartir de zéro.
//
// La liste vient du dossier de projets, triée du plus récent au plus ancien.
// Un projet dont les fichiers de montage ont été nettoyés reste listé : on
// préfère un message clair au clic plutôt qu'une liste qui cache des entrées.

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { listProjects, loadProject, mediaUrl } from "../ipc";
import type { ProjectSummary, StoredProject } from "../types";
import { UnsupportedProjectVersionError, isProjectVersionSupported } from "../types";

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
  // Fermer la boîte de dialogue (clic sur le fond, Échap…) pendant qu'un
  // chargement est en vol ne doit pas faire basculer l'app sur ce projet une
  // fois la promesse résolue : l'utilisateur a déjà annulé son choix.
  const closedRef = useRef(false);

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch((e) => {
        setProjects([]);
        setError(String(e));
      });
    return () => {
      closedRef.current = true;
    };
  }, []);

  const open = async (id: string) => {
    setError(null);
    setOpening(id);
    try {
      const project = await loadProject(id);
      if (closedRef.current) return;
      if (!project) throw new Error("Projet introuvable.");
      // Refuse plutôt que de migrer en aveugle un format plus récent que ce
      // que ce build sait lire : migrer perdrait ses champs inconnus, et le
      // projet ouvert écraserait aussitôt le fichier d'origine par l'autosave.
      if (!isProjectVersionSupported(project.version)) {
        throw new UnsupportedProjectVersionError(project.version);
      }
      onOpen(project);
    } catch (e) {
      if (!closedRef.current) setError(String(e));
    } finally {
      if (!closedRef.current) setOpening(null);
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
                className={
                  "project-card" +
                  (project.id === currentId ? " current" : "") +
                  (project.readable ? "" : " unreadable")
                }
                onClick={() => void open(project.id)}
                disabled={opening !== null}
                title={project.readable ? undefined : "Fichier de projet illisible ou corrompu"}
              >
                {project.thumbPath ? (
                  <img src={mediaUrl(project.thumbPath)} alt="" draggable={false} />
                ) : (
                  <span className="project-thumb-empty" />
                )}
                <span className="project-meta">
                  <span className="project-name">{project.name}</span>
                  <span className="muted small-text">
                    {project.readable
                      ? `${project.clipCount} clip${project.clipCount > 1 ? "s" : ""} · ${shortDate(project.updatedAt)}`
                      : "Fichier corrompu — clique pour plus de détails"}
                  </span>
                </span>
                {project.id === currentId && <span className="badge">Ouvert</span>}
                {!project.readable && <span className="badge badge-warn">Illisible</span>}
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
