// Panneau Médias : les rushs du projet, leur état, et l'entrée dans le montage.
//
// Un rush est toujours référencé par son chemin d'origine ; s'il a été déplacé,
// le montage reste lisible sur le proxy mais l'export échouerait. On le signale
// donc ici, avec le seul geste qui répare : retrouver le fichier.
//
// Deux présentations, au choix de l'utilisateur : une grille de vignettes (on
// reconnaît un rush à son image) et une liste compacte (on le reconnaît à son
// nom, et il en tient plus à l'écran). Le filtre et la présentation sont de
// l'état de vue : ils ne touchent pas au montage et ne sont pas enregistrés.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { mediaUrl } from "../ipc";
import type { ImportProgress, SourceInfo } from "../types";
import { formatTime } from "../types";

type View = "grid" | "list";

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
  onBeginDrag: (source: SourceInfo) => void;
  /**
   * Rush actuellement tiré vers la timeline, une fois le seuil de glisser
   * franchi. Distinct de `pressedId` : celui-ci ne couvre que l'attente
   * d'avant seuil, alors que la carte doit rester marquée pendant tout le
   * geste — sans quoi elle reprend son apparence normale à l'instant précis
   * où le déplacement commence vraiment, alors que rien n'indique plus
   * ensuite ce qu'on est en train de poser.
   */
  draggingId: string | null;
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

/** Emploi du rush dans le montage, en une ligne. */
const usageLabel = (used: number): string =>
  used > 0 ? `${used} clip${used > 1 ? "s" : ""}` : "non utilisé";

/**
 * Distance à parcourir avant qu'un appui devienne un glisser.
 *
 * Sans ce seuil, l'appui armait le dépôt immédiatement : un simple clic faisait
 * apparaître la piste fantôme dans la timeline et posait le rush au
 * relâchement, à l'endroit exact où le pointeur se trouvait. Un clic n'est pas
 * un glisser tant que rien n'a bougé. Même valeur que le seuil des gestes de la
 * timeline, pour que la main apprenne un seul réflexe.
 */
const DRAG_THRESHOLD_PX = 5;

export function MediaPanel(props: Props) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("grid");
  /** Rush dont l'appui est en cours : sert uniquement au retour visuel. */
  const [pressedId, setPressedId] = useState<string | null>(null);
  /** Geste d'appui en cours, pour pouvoir l'interrompre au démontage. */
  const pressAbortRef = useRef<AbortController | null>(null);

  // Le panneau peut disparaître pendant l'appui (bascule vers Titres, projet
  // fermé). Sans cette coupure, les écouteurs survivent et le prochain
  // relâchement de souris, n'importe où dans l'application, poserait un rush
  // sur la timeline.
  useEffect(() => () => pressAbortRef.current?.abort(), []);

  const { onAddToTimeline, onBeginDrag } = props;

  /**
   * Un seul geste, deux issues : relâcher sans bouger pose le rush au playhead,
   * bouger passe la main à la timeline qui choisit la position et la piste.
   */
  const beginPress = useCallback(
    (source: SourceInfo, event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const abort = new AbortController();
      pressAbortRef.current = abort;
      const options = { signal: abort.signal } as const;
      setPressedId(source.id);

      window.addEventListener(
        "pointermove",
        (move: PointerEvent) => {
          if (Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD_PX) {
            return;
          }
          // La timeline écoute la suite : on se retire pour ne pas traiter
          // deux fois le même relâchement.
          setPressedId(null);
          abort.abort();
          onBeginDrag(source);
        },
        options,
      );
      window.addEventListener(
        "pointerup",
        (up: PointerEvent) => {
          if (up.button !== 0) return;
          setPressedId(null);
          abort.abort();
          onAddToTimeline(source);
        },
        options,
      );
      window.addEventListener(
        "pointercancel",
        () => {
          setPressedId(null);
          abort.abort();
        },
        options,
      );
    },
    [onAddToTimeline, onBeginDrag],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return props.sources;
    return props.sources.filter((source) =>
      sourceName(source).toLowerCase().includes(needle),
    );
  }, [props.sources, query]);

  return (
    <aside className="panel panel-media">
      <div className="panel-head">
        <h2>Médias du projet</h2>
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

      {props.sources.length > 0 && (
        <div className="panel-tools">
          <div className="search-field">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={query}
              placeholder="Rechercher"
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filtrer les médias par nom"
            />
          </div>
          <div className="btn-group">
            <button
              type="button"
              className={"icon-btn ghost" + (view === "grid" ? " active" : "")}
              onClick={() => setView("grid")}
              title="Vue grille"
              aria-pressed={view === "grid"}
            >
              <Icon name="grid" size={15} />
            </button>
            <button
              type="button"
              className={"icon-btn ghost" + (view === "list" ? " active" : "")}
              onClick={() => setView("list")}
              title="Vue liste"
              aria-pressed={view === "list"}
            >
              <Icon name="rows" size={15} />
            </button>
          </div>
        </div>
      )}

      <div className={view === "grid" ? "media-grid" : "media-list"}>
        {props.sources.length === 0 && (
          <EmptyState
            icon="folder"
            title="Aucun média importé."
            hint="Glisse un fichier vidéo n'importe où dans la fenêtre, ou utilise le bouton ci-dessus."
          />
        )}
        {props.sources.length > 0 && visible.length === 0 && (
          <EmptyState icon="search" title="Aucun média ne correspond." />
        )}
        {visible.map((source) => {
          const missing = props.missingIds.has(source.id);
          const used = props.clipCounts[source.id] ?? 0;
          const thumb = source.thumbPaths[0];
          return (
            <div
              key={source.id}
              className={
                (view === "grid" ? "media-card" : "media-item") +
                (missing ? " media-missing" : "") +
                (used === 0 ? " media-unused" : "") +
                (pressedId === source.id || props.draggingId === source.id ? " is-pressed" : "")
              }
              onPointerDown={(event) => beginPress(source, event)}
              title={`${sourceName(source)}\nClic : poser au playhead · Glisser : choisir la position\n${source.originalPath}`}
            >
              <div className="media-thumb-wrap">
                {thumb ? (
                  <img
                    className="media-thumb"
                    src={mediaUrl(thumb)}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <span className="media-thumb media-thumb-empty" />
                )}
                <span className="media-duration">
                  {formatTime(source.probe.durationMs)}
                </span>
                {missing && (
                  <span className="media-flag" title="Fichier introuvable">
                    <Icon name="alert" size={13} />
                  </span>
                )}
              </div>

              <div className="media-meta">
                <span className="media-name">{sourceName(source)}</span>
                <span className="muted small-text">{usageLabel(used)}</span>
                {missing && (
                  <button
                    type="button"
                    className="ghost small warn media-relocate"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => props.onRelocate(source)}
                  >
                    Retrouver le fichier
                  </button>
                )}
              </div>

            </div>
          );
        })}
      </div>

      <div className="panel-foot">
        {props.sources.length > 0 && (
          <span className="muted small-text">
            {props.sources.length} média{props.sources.length > 1 ? "s" : ""}
            {visible.length !== props.sources.length && ` · ${visible.length} affiché${visible.length > 1 ? "s" : ""}`}
          </span>
        )}
        <p className="muted small-text">
          Clique un média pour le poser au playhead, ou tire-le sur la timeline pour
          choisir sa position et sa piste.
        </p>
      </div>
    </aside>
  );
}
