// Export TikTok 1080×1920. Le seul moment où FFmpeg travaille sur le rush original.

import { useEffect, useRef, useState } from "react";
import { exportTimeline, onExportProgress, revealPath } from "../ipc";
import { Icon } from "./Icon";
import type { Clip, ExportRequest, ExportSegment, FramingMode, SourceInfo } from "../types";
import {
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  clipEndMs,
  formatTime,
  sortClips,
  timelineGaps,
  usedSources,
} from "../types";

/**
 * Ordre temporel : une entrée FFmpeg par rush utilisé, chaque segment pointant
 * vers la sienne et précédé de son éventuel trou (noir silencieux).
 */
/** Segments d'un plan, chacun précédé de son éventuel silence ou noir. */
function toSegments(clips: Clip[], indexOf: Map<string, number>): ExportSegment[] {
  let cursor = 0;
  const segments: ExportSegment[] = [];
  for (const clip of sortClips(clips)) {
    const index = indexOf.get(clip.sourceId);
    if (index === undefined) continue;
    segments.push({
      sourceIndex: index,
      srcInMs: clip.srcInMs,
      srcOutMs: clip.srcOutMs,
      playbackRate: clip.playbackRate,
      gapBeforeMs: Math.max(0, clip.timelineStartMs - cursor),
      cropX: clip.cropX,
    });
    cursor = clipEndMs(clip);
  }
  return segments;
}

function buildRequest(
  sources: Record<string, SourceInfo>,
  clips: Clip[],
  audioClips: Clip[],
): Pick<ExportRequest, "sources" | "segments" | "audioSegments" | "hasAudio" | "frameFps"> {
  // Les deux plans partagent la même liste de rushs : les index concordent.
  const used = usedSources(sources, clips.concat(audioClips));
  const indexOf = new Map(used.map((source, index) => [source.id, index]));
  const segments = toSegments(clips, indexOf);
  const audioSegments = toSegments(audioClips, indexOf);

  // La définition de sortie est imposée (1080×1920) et appliquée segment par
  // segment ; seule la cadence se cale sur le premier rush.
  const reference = used[0];
  return {
    sources: used.map((source) => ({ path: source.originalPath, hasAudio: source.probe.hasAudio })),
    segments,
    audioSegments,
    // Un montage sans aucun clip sonore sort muet, plutôt que du silence encodé.
    hasAudio: audioSegments.length > 0 && used.some((source) => source.probe.hasAudio),
    frameFps: reference?.probe.fps ?? 30,
  };
}

interface Props {
  sources: Record<string, SourceInfo>;
  /** Plan vidéo. */
  clips: Clip[];
  /** Plan audio, indépendant du plan vidéo. */
  audioClips: Clip[];
  /**
   * Cadrage du projet. Il n'est PAS choisi ici : l'aperçu le montre déjà, et
   * deux valeurs distinctes rendraient l'aperçu menteur. On peut le changer
   * depuis cette fenêtre, mais c'est bien le projet qu'on change.
   */
  framing: FramingMode;
  onSetFraming: (framing: FramingMode) => void;
  /** Rushs dont le fichier d'origine est introuvable : l'export échouerait. */
  missingIds: ReadonlySet<string>;
  defaultName: string;
  onClose: () => void;
}

type Phase = "config" | "running" | "done" | "error";

export function ExportDialog(props: Props) {
  const { sources, clips, audioClips, framing, onSetFraming, missingIds, defaultName, onClose } =
    props;
  const [fileName, setFileName] = useState(defaultName);
  const [phase, setPhase] = useState<Phase>("config");
  const [percent, setPercent] = useState(0);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    void onExportProgress((p) => {
      setPercent(p.percent);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenRef.current = unlisten;
    });
    return () => {
      disposed = true;
      unlistenRef.current?.();
    };
  }, []);

  const sanitized = fileName.replace(/[^A-Za-z0-9 _-]/g, "").trim();
  const gaps = timelineGaps(clips);
  const gapTotalMs = gaps.reduce((sum, gap) => sum + (gap.endMs - gap.startMs), 0);
  // Un rush introuvable fait échouer FFmpeg : autant le dire avant de lancer.
  const missingUsed = usedSources(sources, clips.concat(audioClips)).filter((source) =>
    missingIds.has(source.id),
  );

  const start = async () => {
    if (!sanitized || missingUsed.length > 0) return;
    setPhase("running");
    setPercent(0);
    try {
      const path = await exportTimeline({
        ...buildRequest(sources, clips, audioClips),
        mode: framing,
        fileName: sanitized,
      });
      setOutputPath(path);
      setPhase("done");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  return (
    <div className="modal-backdrop" onClick={phase === "running" ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            Exporter en {OUTPUT_WIDTH}×{OUTPUT_HEIGHT}
          </h2>
          {phase !== "running" && (
            <button className="icon-btn ghost" onClick={onClose} title="Fermer">
              <Icon name="close" />
            </button>
          )}
        </div>

        {phase === "config" && (
          <>
            <label className="field">
              <span>Nom du fichier</span>
              <input
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                maxLength={60}
                autoFocus
              />
            </label>
            <div className="field">
              <span>Passage au format vertical — réglage du projet</span>
              <div className="option-grid">
                <label className={"option" + (framing === "crop" ? " selected" : "")}>
                  <input
                    type="radio"
                    checked={framing === "crop"}
                    onChange={() => onSetFraming("crop")}
                  />
                  <span className="option-preview option-crop" aria-hidden="true" />
                  <span className="option-label">Recadrage</span>
                  <span className="option-note muted">Plein écran, coupe les côtés</span>
                </label>
                <label className={"option" + (framing === "blur" ? " selected" : "")}>
                  <input
                    type="radio"
                    checked={framing === "blur"}
                    onChange={() => onSetFraming("blur")}
                  />
                  <span className="option-preview option-blur" aria-hidden="true" />
                  <span className="option-label">Fond flou</span>
                  <span className="option-note muted">Image entière conservée</span>
                </label>
              </div>
            </div>
            {missingUsed.length > 0 && (
              <p className="error">
                {missingUsed.length} rush introuvable sur le disque. Retrouve-le dans le
                panneau Médias avant d'exporter : l'export lit les fichiers d'origine, pas
                les proxys.
              </p>
            )}
            {gaps.length > 0 && (
              <p className="warn">
                {gaps.length} trou{gaps.length > 1 ? "s" : ""} dans la timeline (
                {formatTime(gapTotalMs)} au total) : {gaps.length > 1 ? "ils seront rendus" : "il sera rendu"}{" "}
                en noir silencieux. Ferme les trous avant d'exporter si ce n'est pas voulu.
              </p>
            )}
            <div className="modal-actions">
              <button className="ghost" onClick={onClose}>Annuler</button>
              <button
                className="primary"
                onClick={() => void start()}
                disabled={!sanitized || missingUsed.length > 0}
              >
                Lancer l'export
              </button>
            </div>
          </>
        )}

        {phase === "running" && (
          <div className="import-progress">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${Math.round(percent)}%` }} />
            </div>
            <span className="muted">Rendu en cours… {Math.round(percent)}%</span>
          </div>
        )}

        {phase === "done" && outputPath && (
          <>
            <p>Export terminé ✅</p>
            <p className="muted path">{outputPath}</p>
            <div className="modal-actions">
              <button className="ghost" onClick={() => void revealPath(outputPath)}>
                Ouvrir le dossier
              </button>
              <button className="primary" onClick={onClose}>Fermer</button>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <p className="error">{error}</p>
            <div className="modal-actions">
              <button className="primary" onClick={() => setPhase("config")}>Réessayer</button>
              <button className="ghost" onClick={onClose}>Fermer</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
