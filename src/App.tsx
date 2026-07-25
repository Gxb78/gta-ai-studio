import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ExportDialog } from "./components/ExportDialog";
import { ImportView } from "./components/ImportView";
import { PreviewPlayer } from "./components/PreviewPlayer";
import { ShortcutsPanel } from "./components/ShortcutsPanel";
import { Timeline } from "./components/Timeline";
import { TransportBar } from "./components/TransportBar";
import { importSource, loadLastProject, pickVideoFile, saveProject } from "./ipc";
import { usePlayback } from "./playback/usePlayback";
import { editorReducer, effectiveClips, initialEditorState, newClipId } from "./state/editor";
import type { Project, SourceInfo } from "./types";
import { ASSET_VERSION, clipAt, flattenTracks, frameMs, sortClips } from "./types";

/** Référence stable : évite de recréer un objet vide à chaque rendu. */
const EMPTY_SOURCES: Record<string, SourceInfo> = {};

export default function App() {
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const [pxPerSec, setPxPerSec] = useState(30);
  const [showGuide, setShowGuide] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Deux balises : celle qui est masquée précharge le clip suivant.
  const videoA = useRef<HTMLVideoElement | null>(null);
  const videoB = useRef<HTMLVideoElement | null>(null);

  const clips = effectiveClips(state);
  const sources = state.project?.sources ?? EMPTY_SOURCES;
  // Le lecteur et l'export ne connaissent pas les pistes : ils consomment le
  // montage APLATI, où la piste la plus haute a déjà gagné à chaque instant.
  const flatClips = useMemo(() => flattenTracks(state.clips), [state.clips]);
  const playback = usePlayback(videoA, videoB, flatClips, sources);

  // Reprendre le dernier projet au lancement. Si les fichiers dérivés d'un rush
  // datent d'une version antérieure, on les régénère : l'import réutilise le
  // proxy en cache, seuls les fichiers dérivés sont refaits.
  useEffect(() => {
    void loadLastProject().then(async (project) => {
      if (!project) return;
      dispatch({ type: "LOAD", project });
      const stale = Object.values(project.sources ?? {})
        .concat(project.source ? [project.source] : [])
        .filter((source) => source.assetVersion < ASSET_VERSION);
      for (const source of stale) {
        try {
          const refreshed = await importSource(source.originalPath);
          // Action dédiée : remplacer le projet entier écraserait le montage en
          // cours et l'historique pendant que la régénération tourne.
          dispatch({ type: "REFRESH_SOURCE", source: refreshed });
        } catch {
          // Rush introuvable ou déplacé : on garde les anciens fichiers.
        }
      }
    });
  }, []);

  // Sauvegarde automatique (débouncée) à chaque modification committée.
  useEffect(() => {
    if (!state.project) return;
    const project: Project = {
      ...state.project,
      clips: state.clips,
      updatedAt: new Date().toISOString(),
    };
    const timer = setTimeout(() => void saveProject(project).catch(console.error), 600);
    return () => clearTimeout(timer);
  }, [state.clips, state.project]);

  const handleImported = useCallback((source: SourceInfo) => {
    const now = new Date().toISOString();
    const baseName = source.originalPath.split(/[\\/]/).pop() ?? "rush";
    const project: Project = {
      version: 3,
      id: source.id,
      name: baseName.replace(/\.[^.]+$/, ""),
      sources: { [source.id]: source },
      clips: [
        {
          id: newClipId(),
          sourceId: source.id,
          track: 0,
          timelineStartMs: 0,
          srcInMs: 0,
          srcOutMs: source.probe.durationMs,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    dispatch({ type: "LOAD", project });
    void saveProject(project).catch(console.error);
  }, []);

  // Ajouter un rush au projet en cours : il se pose sur une nouvelle piste, au
  // playhead. La ref évite de recréer le gestionnaire à chaque image de lecture.
  const playheadRef = useRef(0);
  playheadRef.current = playback.playheadMs;
  const [addingRush, setAddingRush] = useState(false);
  const handleAddRush = useCallback(async () => {
    setAddingRush(true);
    try {
      const path = await pickVideoFile();
      if (!path) return;
      const source = await importSource(path);
      dispatch({ type: "ADD_SOURCE", source, atMs: playheadRef.current });
    } catch (error) {
      console.error(error);
    } finally {
      setAddingRush(false);
    }
  }, []);

  const selectClip = useCallback((clipId: string | null) => {
    dispatch({ type: "SELECT", clipId });
  }, []);

  const splitAtPlayhead = useCallback(() => {
    dispatch({ type: "SPLIT_AT", timelineMs: playback.playheadMs });
  }, [playback.playheadMs]);

  const deleteSelected = useCallback(() => {
    if (state.selectedClipId) dispatch({ type: "DELETE_CLIP", clipId: state.selectedClipId });
  }, [state.selectedClipId]);

  // Cadence de référence pour les pas clavier : celle du clip sélectionné, à
  // défaut celle du premier rush. Deux rushs peuvent différer.
  const selectedClip = state.clips.find((clip) => clip.id === state.selectedClipId);
  const referenceFps =
    (selectedClip ? sources[selectedClip.sourceId]?.probe.fps : undefined) ??
    Object.values(sources)[0]?.probe.fps ??
    30;

  // Trim au clavier : précision à l'image quel que soit le zoom.
  const trimSelected = useCallback(
    (side: "left" | "right", mode: { deltaMs: number } | { toPlayhead: true }) => {
      if (!state.selectedClipId) return;
      const clip = state.clips.find((c) => c.id === state.selectedClipId);
      if (!clip) return;
      let edgeSrcMs: number;
      if ("toPlayhead" in mode) {
        // Le playhead doit être dans le clip sélectionné, sinon le geste n'a pas de sens.
        const position = clipAt(sortClips(state.clips), playback.playheadMs);
        if (!position || sortClips(state.clips)[position.clipIndex].id !== clip.id) return;
        edgeSrcMs = clip.srcInMs + position.offsetMs;
      } else {
        edgeSrcMs = (side === "left" ? clip.srcInMs : clip.srcOutMs) + mode.deltaMs;
      }
      dispatch({ type: "TRIM_EDGE", clipId: clip.id, side, edgeSrcMs });
    },
    [playback.playheadMs, state.clips, state.selectedClipId],
  );

  // Raccourcis clavier globaux.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (!state.project || exporting) return;

      if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        event.preventDefault();
        setShowShortcuts((visible) => !visible);
      } else if (event.code === "Space") {
        event.preventDefault();
        playback.toggle();
      } else if (event.key === "s" || event.key === "S") {
        splitAtPlayhead();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelected();
      } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: "UNDO" });
      } else if (
        (event.ctrlKey && event.key.toLowerCase() === "y") ||
        (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "z")
      ) {
        event.preventDefault();
        dispatch({ type: "REDO" });
      } else if (event.key === "i" || event.key === "I") {
        trimSelected("left", { toPlayhead: true });
      } else if (event.key === "o" || event.key === "O") {
        trimSelected("right", { toPlayhead: true });
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const fps = referenceFps;
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        if (event.altKey) {
          // Alt = ajuster la fin du clip sélectionné, Alt+Maj = ajuster son début.
          const step = frameMs(fps) * (event.ctrlKey ? 10 : 1);
          trimSelected(event.shiftKey ? "left" : "right", { deltaMs: direction * step });
          return;
        }
        const step = event.shiftKey ? 1000 : frameMs(fps);
        playback.seek(
          Math.max(0, Math.min(playback.durationMs, playback.playheadMs + direction * step)),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, exporting, playback, splitAtPlayhead, state.project, trimSelected]);

  if (!state.project) {
    return <ImportView onImported={handleImported} />;
  }

  return (
    <div className="app">
      <TransportBar
        projectName={state.project.name}
        playing={playback.playing}
        playheadMs={playback.playheadMs}
        durationMs={playback.durationMs}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        showGuide={showGuide}
        hasSelection={state.selectedClipId !== null}
        onTogglePlay={playback.toggle}
        onSplit={splitAtPlayhead}
        onShowShortcuts={() => setShowShortcuts(true)}
        onDeleteSelected={deleteSelected}
        onUndo={() => dispatch({ type: "UNDO" })}
        onRedo={() => dispatch({ type: "REDO" })}
        onToggleGuide={() => setShowGuide((v) => !v)}
        onNewRush={() => dispatch({ type: "CLOSE" })}
        addingRush={addingRush}
        onAddRush={() => void handleAddRush()}
        onExport={() => {
          playback.pause();
          setExporting(true);
        }}
      />

      <PreviewPlayer
        videoA={videoA}
        videoB={videoB}
        activeIsA={playback.activeIsA}
        showGuide={showGuide}
        inGap={playback.inGap}
        onTogglePlay={playback.toggle}
      />

      <Timeline
        clips={clips}
        anchorClips={state.clips}
        sources={sources}
        pxPerSec={pxPerSec}
        onPxPerSecChange={setPxPerSec}
        playheadMs={playback.playheadMs}
        playing={playback.playing}
        selectedClipId={state.selectedClipId}
        onSeek={playback.seek}
        onSelect={selectClip}
        onPreviewFrame={playback.showFrame}
        onPause={playback.pause}
        onCloseGaps={() => dispatch({ type: "CLOSE_GAPS" })}
        dispatch={dispatch}
      />

      {showShortcuts && (
        <ShortcutsPanel
          frameStepMs={frameMs(referenceFps)}
          onClose={() => setShowShortcuts(false)}
        />
      )}

      {exporting && (
        <ExportDialog
          sources={sources}
          clips={flatClips}
          defaultName={`${state.project.name} tiktok`}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
