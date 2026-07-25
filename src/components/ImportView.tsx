// Écran d'accueil : choisir un rush et suivre la préparation (proxy, vignettes).

import { useEffect, useRef, useState } from "react";
import { importSource, onImportProgress, pickVideoFile } from "../ipc";
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
}

export function ImportView({ onImported }: Props) {
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
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className="import-view">
      <div className="import-card">
        <span className="brand-mark" aria-hidden="true">
          <span />
        </span>
        <h1>GTA Studio</h1>
        <p className="lead muted">
          Choisis un rush : je prépare un proxy de montage ultra réactif, puis tu coupes.
          Ton fichier d'origine n'est jamais modifié.
        </p>

        {!busy && (
          <>
            <button className="primary big" onClick={() => void handlePick()}>
              <Icon name="folder" size={18} />
              Choisir un rush
            </button>
            <ul className="import-facts muted">
              <li>Lecture et coupes 100 % locales, sans latence</li>
              <li>Export vertical 1080×1920, prêt pour TikTok</li>
              <li>MP4, MOV, MKV, M4V</li>
            </ul>
          </>
        )}

        {busy && progress && (
          <div className="import-progress">
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.round(progress.percent)}%` }}
              />
            </div>
            <span className="muted">
              {STAGE_LABELS[progress.stage]} {Math.round(progress.percent)} %
            </span>
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
