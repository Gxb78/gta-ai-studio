// Écran d'accueil : choisir un rush et suivre la préparation (proxy, vignettes).

import { useEffect, useRef, useState } from "react";
import { CANCELLED, cancelImport, importSource, onImportProgress, pickVideoFile } from "../ipc";
import type { ImportProgress, SourceInfo } from "../types";
import { Icon } from "./Icon";

const STAGE_LABELS: Record<ImportProgress["stage"], string> = {
  hash: "Empreinte du fichier…",
  probe: "Lecture des métadonnées…",
  proxy: "Préparation du proxy de montage…",
  thumbs: "Génération des vignettes…",
  waveform: "Analyse audio…",
  done: "Terminé",
};

interface Props {
  onImported: (source: SourceInfo) => void;
  onOpenProjects: () => void;
  /** Import déclenché par un dépôt de fichiers, piloté par App. */
  droppedBusy: boolean;
  droppedProgress: ImportProgress | null;
  /** Le dernier projet n'a pas pu être repris au démarrage (piloté par App). */
  startupError?: string | null;
}

export function ImportView({
  onImported,
  onOpenProjects,
  droppedBusy,
  droppedProgress,
  startupError,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    void onImportProgress((p) => setProgress(p)).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenRef.current = unlisten;
    });
    return () => {
      disposed = true;
      unlistenRef.current?.();
    };
  }, []);

  const handlePick = async () => {
    setError(null);
    const path = await pickVideoFile();
    if (!path) return;
    setBusy(true);
    setProgress({ stage: "hash", percent: 0 });
    try {
      const source = await importSource(path);
      onImported(source);
    } catch (e) {
      // Une annulation n'est pas un échec : FFmpeg a été tué à la demande de
      // l'utilisateur, il n'y a rien à lui signaler comme une erreur.
      if (String(e) !== CANCELLED) setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // L'import peut aussi venir d'un dépôt de fichiers, piloté par App : les deux
  // sources d'occupation alimentent le même affichage.
  const working = busy || droppedBusy;
  const shown = droppedBusy ? droppedProgress : progress;

  return (
    <div className="import-view">
      <div className="import-card">
        <span className="brand-mark" aria-hidden="true">
          <span />
        </span>
        <h1>GTA Studio</h1>
        <p className="lead muted">
          Choisis un rush ou lâche-le dans la fenêtre : je prépare un proxy de montage ultra
          réactif, puis tu coupes. Ton fichier d'origine n'est jamais modifié.
        </p>

        {!working && (
          <>
            <button className="primary big" onClick={() => void handlePick()}>
              <Icon name="folder" size={18} />
              Choisir un rush
            </button>
            <button className="ghost small" onClick={onOpenProjects}>
              <Icon name="projects" size={15} />
              Projets récents
            </button>
            <ul className="import-facts muted">
              <li>Lecture et coupes 100 % locales, sans latence</li>
              <li>Aperçu vertical 9:16 identique à l'export</li>
              <li>MP4, MOV, MKV, M4V — glisser-déposer accepté</li>
            </ul>
          </>
        )}

        {working && (
          <div className="import-progress">
            {shown && (
              <>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.round(shown.percent)}%` }}
                  />
                </div>
                <span className="muted">
                  {STAGE_LABELS[shown.stage]} {Math.round(shown.percent)} %
                </span>
              </>
            )}
            {/* Occupé dès le dépôt, avant même la première progression reçue :
                le bouton doit exister tout de suite, sinon rien ne permet
                d'annuler pendant cette fenêtre. */}
            <button className="ghost small" onClick={() => void cancelImport()}>
              <Icon name="close" size={14} />
              Annuler
            </button>
          </div>
        )}

        {error && <p className="error">{error}</p>}
        {startupError && <p className="error">{startupError}</p>}
      </div>
    </div>
  );
}
