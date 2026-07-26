// Panneau Médias : les rushs du projet, leur état, et l'entrée dans le montage.
//
// Un rush est toujours référencé par son chemin d'origine ; s'il a été déplacé,
// le montage reste lisible sur le proxy mais l'export échouerait. On le signale
// donc ici, avec le seul geste qui répare : retrouver le fichier.

import { Icon } from "./Icon";
import { mediaUrl } from "../ipc";
import type { ImportProgress, SourceInfo } from "../types";
import { formatTime } from "../types";

interface Props {
  sources: SourceInfo[];
  /** Rushs dont le fichier d'origine est introuvable, par identifiant. */
  missingIds: ReadonlySet<string>;
  /** Nombre de clips par rush : un rush inutilisé se voit. */
  clipCounts: Record<string, number>;
  importing: boolean;
  progress: ImportProgress | null;
  error: string | null;
  onImport: () => void;
  /** Pose le rush sur la timeline, au playhead. */
  onAddToTimeline: (source: SourceInfo) => void;
  /** Début d'un dépôt à la souris : la timeline prend la suite du geste. */
  onBeginDrag: (source: SourceInfo, event: React.PointerEvent) => void;
  onRelocate: (source: SourceInfo) => void;
  onCollapse: () => void;
}

const STAGE_LABELS: Record<ImportProgress["stage"], string> = {
  hash: "Empreinte…",
  probe: "Métadonnées…",
  proxy: "Proxy de montage…",
  thumbs: "Vignettes…",
  waveform: "Analyse audio…",
  done: "Terminé",
};

/** Nom court du rush, tiré de son chemin. */
export const sourceName = (source: SourceInfo): string => {
  const name = source.originalPath.split(/[\\/]/).pop() ?? "rush";
  return name.replace(/\.[^.]+$/, "");
};

export function MediaPanel(props: Props) {
  return (
    <aside className="panel panel-media">
      <div className="panel-head">
        <h2>Médias</h2>
        <button
          type="button"
          className="icon-btn ghost"
          onClick={props.onCollapse}
          title="Replier le panneau"
          aria-label="Replier le panneau Médias"
        >
          <Icon name="close" size={15} />
        </button>
      </div>

      <button
        type="button"
        className="primary panel-action"
        onClick={props.onImport}
        disabled={props.importing}
      >
        <Icon name="plus" size={15} />
        {props.importing ? "Import en cours…" : "Importer un média"}
      </button>

      {props.importing && props.progress && (
        <div className="import-progress">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${Math.round(props.progress.percent)}%` }}
            />
          </div>
          <span className="muted small-text">
            {STAGE_LABELS[props.progress.stage]} {Math.round(props.progress.percent)} %
          </span>
        </div>
      )}

      {props.error && <p className="error">{props.error}</p>}

      <div className="media-list">
        {props.sources.length === 0 && (
          <p className="muted small-text panel-empty">
            Glisse un fichier vidéo n'importe où dans la fenêtre, ou utilise le bouton
            ci-dessus.
          </p>
        )}
        {props.sources.map((source) => {
          const missing = props.missingIds.has(source.id);
          const used = props.clipCounts[source.id] ?? 0;
          return (
            <div
              key={source.id}
              className={"media-item" + (missing ? " media-missing" : "")}
              onPointerDown={(event) => props.onBeginDrag(source, event)}
              onDoubleClick={() => props.onAddToTimeline(source)}
              title={source.originalPath}
            >
              {source.thumbPaths[0] ? (
                <img
                  className="media-thumb"
                  src={mediaUrl(source.thumbPaths[0])}
                  alt=""
                  draggable={false}
                />
              ) : (
                <span className="media-thumb media-thumb-empty" />
              )}
              <div className="media-meta">
                <span className="media-name">{sourceName(source)}</span>
                <span className="muted small-text">
                  {formatTime(source.probe.durationMs)} ·{" "}
                  {used > 0 ? `${used} clip${used > 1 ? "s" : ""}` : "non utilisé"}
                </span>
                {missing && (
                  <button
                    type="button"
                    className="ghost small warn"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => props.onRelocate(source)}
                  >
                    <Icon name="alert" size={14} />
                    Fichier introuvable — retrouver
                  </button>
                )}
              </div>
              <button
                type="button"
                className="icon-btn ghost media-add"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => props.onAddToTimeline(source)}
                title="Poser au playhead"
                aria-label="Poser au playhead"
              >
                <Icon name="plus" size={15} />
              </button>
            </div>
          );
        })}
      </div>

      <p className="muted small-text panel-foot">
        Tire un média sur la timeline pour choisir sa position, ou double-clique pour le
        poser au playhead.
      </p>
    </aside>
  );
}
