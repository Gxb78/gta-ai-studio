import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ExportDialog } from "./components/ExportDialog";
import { ImportView } from "./components/ImportView";
import { Inspector } from "./components/Inspector";
import { MediaPanel } from "./components/MediaPanel";
import { PreviewStage, type ViewMode } from "./components/PreviewStage";
import { ProjectsDialog } from "./components/ProjectsDialog";
import { ShortcutsPanel } from "./components/ShortcutsPanel";
import { Timeline } from "./components/Timeline";
import { ToolRail, type Tool } from "./components/ToolRail";
import { TopBar, type SaveState } from "./components/TopBar";
import {
  importSource,
  loadLastProject,
  onFilesDropped,
  onImportProgress,
  pathsExist,
  pickVideoFile,
  pickVideoFiles,
  saveProject,
} from "./ipc";
import { usePlayback } from "./playback/usePlayback";
import { editorReducer, effectiveClips, initialEditorState, newClipId } from "./state/editor";
import type { FramingMode, ImportProgress, Project, SourceInfo, StoredProject } from "./types";
import {
  ASSET_VERSION,
  clipAt,
  frameMs,
  resolveAudioPlan,
  resolveVideoPlan,
  sortClips,
  sourceAspect,
  topClipAt,
} from "./types";

/** Référence stable : évite de recréer un objet vide à chaque rendu. */
const EMPTY_SOURCES: Record<string, SourceInfo> = {};

/** Bornes de la zone timeline, pour qu'elle ne mange jamais tout l'aperçu. */
const MIN_TIMELINE_PX = 180;
const MAX_TIMELINE_PX = 720;
const DEFAULT_TIMELINE_PX = 320;

export default function App() {
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const [pxPerSec, setPxPerSec] = useState(30);
  const [tool, setTool] = useState<Tool>("select");
  const [mediaOpen, setMediaOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("output");
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [volume, setVolume] = useState(1);
  const [timelineHeight, setTimelineHeight] = useState(DEFAULT_TIMELINE_PX);
  const [exporting, setExporting] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  /** Rushs dont le fichier d'origine est introuvable (déplacé, supprimé). */
  const [missingIds, setMissingIds] = useState<ReadonlySet<string>>(new Set());
  /** Média tiré depuis le panneau Médias, en attente de dépôt sur la timeline. */
  const [pendingSource, setPendingSource] = useState<SourceInfo | null>(null);

  // Deux balises : celle qui est masquée précharge le clip suivant.
  const videoA = useRef<HTMLVideoElement | null>(null);
  const videoB = useRef<HTMLVideoElement | null>(null);
  // Balises sonores : le son suit le plan audio, pas le plan vidéo.
  const audioA = useRef<HTMLAudioElement | null>(null);
  const audioB = useRef<HTMLAudioElement | null>(null);

  const clips = effectiveClips(state);
  const sources = state.project?.sources ?? EMPTY_SOURCES;
  const framing: FramingMode = state.project?.framing ?? "crop";

  // Une piste masquée sort des DEUX plans : l'aperçu et l'export doivent
  // montrer la même chose, sinon la promesse du canvas exact ne tient plus.
  const hiddenTracks = useMemo(() => new Set(state.hiddenTracks), [state.hiddenTracks]);
  const lockedTracks = useMemo(() => new Set(state.lockedTracks), [state.lockedTracks]);
  const videoPlan = useMemo(
    () => resolveVideoPlan(state.clips, hiddenTracks),
    [hiddenTracks, state.clips],
  );
  const audioPlan = useMemo(
    () => resolveAudioPlan(state.clips, hiddenTracks),
    [hiddenTracks, state.clips],
  );
  const playback = usePlayback(videoA, videoB, audioA, audioB, videoPlan, audioPlan, sources);

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

  // Sauvegarde automatique (débouncée) à chaque modification committée, avec son
  // état visible dans la barre supérieure : une sauvegarde silencieuse qui
  // échoue est le pire des cas.
  useEffect(() => {
    if (!state.project) return;
    const project: Project = {
      ...state.project,
      clips: state.clips,
      updatedAt: new Date().toISOString(),
    };
    const timer = setTimeout(() => {
      setSaveState("saving");
      setSaveError(null);
      void saveProject(project)
        .then(() => setSaveState("saved"))
        .catch((error: unknown) => {
          setSaveState("error");
          setSaveError(String(error));
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [state.clips, state.project]);

  // Progression d'import, affichée dans le panneau Médias.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onImportProgress((progress) => setImportProgress(progress)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Volume général de l'aperçu : il ne concerne que les balises sonores, les
  // balises vidéo étant muettes par construction.
  useEffect(() => {
    for (const ref of [audioA, audioB]) {
      if (ref.current) ref.current.volume = volume;
    }
  }, [volume]);

  // Rushs déplacés ou supprimés : le montage reste lisible sur le proxy, mais
  // l'export échouerait. On vérifie à chaque changement de liste de rushs.
  useEffect(() => {
    const list = Object.values(sources);
    if (list.length === 0) {
      setMissingIds(new Set());
      return;
    }
    let disposed = false;
    void pathsExist(list.map((source) => source.originalPath))
      .then((results) => {
        if (disposed) return;
        const missing = new Set<string>();
        results.forEach((exists, index) => {
          if (!exists) missing.add(list[index].id);
        });
        setMissingIds(missing);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [sources]);

  const playheadRef = useRef(0);
  playheadRef.current = playback.playheadMs;

  const handleImported = useCallback((source: SourceInfo) => {
    const now = new Date().toISOString();
    const baseName = source.originalPath.split(/[\\/]/).pop() ?? "rush";
    const project: Project = {
      version: 4,
      id: source.id,
      name: baseName.replace(/\.[^.]+$/, ""),
      sources: { [source.id]: source },
      clips: [
        {
          id: newClipId(),
          sourceId: source.id,
          cropX: 0,
          track: 0,
          timelineStartMs: 0,
          srcInMs: 0,
          srcOutMs: source.probe.durationMs,
          audioEnabled: true,
          playbackRate: 1,
        },
      ],
      framing: "crop",
      createdAt: now,
      updatedAt: now,
    };
    dispatch({ type: "LOAD", project });
    void saveProject(project).catch(console.error);
  }, []);

  /**
   * Importe des fichiers et les fait entrer dans le projet.
   *
   * Sans projet ouvert, le premier fichier crée le projet ; les suivants s'y
   * ajoutent. C'est ce qui permet de lâcher plusieurs rushs d'un coup sur la
   * fenêtre sans réfléchir à l'ordre.
   */
  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setImporting(true);
      setImportError(null);
      let hasProject = state.project !== null;
      try {
        for (const path of paths) {
          setImportProgress({ stage: "hash", percent: 0 });
          const source = await importSource(path);
          if (hasProject) {
            dispatch({ type: "ADD_SOURCE", source, atMs: playheadRef.current });
          } else {
            handleImported(source);
            hasProject = true;
          }
        }
      } catch (error) {
        setImportError(String(error));
      } finally {
        setImporting(false);
        setImportProgress(null);
      }
    },
    [handleImported, state.project],
  );

  // Dépôt de fichiers sur la fenêtre. C'est Tauri qui intercepte le glisser du
  // système : sans cet abonnement, rien n'arrive au DOM.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onFilesDropped((paths) => void importPaths(paths)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importPaths]);

  const handlePickAndImport = useCallback(() => {
    void pickVideoFiles().then((paths) => void importPaths(paths));
  }, [importPaths]);

  /** Rush retrouvé après un déplacement : les clips sont rattachés au nouveau. */
  const handleRelocate = useCallback(async (missing: SourceInfo) => {
    setImportError(null);
    const path = await pickVideoFile("Retrouver le rush déplacé");
    if (!path) return;
    setImporting(true);
    setImportProgress({ stage: "hash", percent: 0 });
    try {
      const source = await importSource(path);
      dispatch({ type: "RELINK_SOURCE", missingId: missing.id, source });
    } catch (error) {
      setImportError(String(error));
    } finally {
      setImporting(false);
      setImportProgress(null);
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
  const selectedClip = state.clips.find((clip) => clip.id === state.selectedClipId) ?? null;
  const referenceFps =
    (selectedClip ? sources[selectedClip.sourceId]?.probe.fps : undefined) ??
    Object.values(sources)[0]?.probe.fps ??
    30;

  const toggleClipAudio = useCallback(() => {
    if (state.selectedClipId) dispatch({ type: "TOGGLE_CLIP_AUDIO", clipId: state.selectedClipId });
  }, [state.selectedClipId]);

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

  const stepFrame = useCallback(
    (direction: -1 | 1) => {
      const step = frameMs(referenceFps);
      playback.seek(
        Math.max(0, Math.min(playback.durationMs, playback.playheadMs + direction * step)),
      );
    },
    [playback, referenceFps],
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
      } else if (event.key === "v" || event.key === "V") {
        setTool("select");
      } else if (event.key === "b" || event.key === "B") {
        setTool("blade");
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
      } else if (event.key === "m" || event.key === "M") {
        toggleClipAudio();
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
  }, [
    deleteSelected, exporting, playback, referenceFps, splitAtPlayhead, state.project,
    toggleClipAudio, trimSelected,
  ]);

  const openStoredProject = useCallback((project: StoredProject) => {
    dispatch({ type: "LOAD", project });
    setShowProjects(false);
  }, []);

  if (!state.project) {
    return (
      <>
        <ImportView
          onImported={handleImported}
          onOpenProjects={() => setShowProjects(true)}
          droppedBusy={importing}
          droppedProgress={importProgress}
        />
        {showProjects && (
          <ProjectsDialog
            currentId={null}
            onOpen={openStoredProject}
            onNewProject={() => setShowProjects(false)}
            onClose={() => setShowProjects(false)}
          />
        )}
      </>
    );
  }

  // Clip réellement visible au playhead : c'est SON cadrage que l'aperçu doit
  // appliquer, et son rush qui donne le format en mode « rush entier ».
  const visibleClip = topClipAt(
    state.clips.filter((clip) => !hiddenTracks.has(clip.track)),
    playback.playheadMs,
  );
  const visibleSource = visibleClip ? sources[visibleClip.sourceId] : undefined;
  const clipCounts = state.clips.reduce<Record<string, number>>((counts, clip) => {
    counts[clip.sourceId] = (counts[clip.sourceId] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <div className="app">
      <TopBar
        projectName={state.project.name}
        onRename={(name) => dispatch({ type: "RENAME_PROJECT", name })}
        saveState={saveState}
        saveError={saveError}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        onUndo={() => dispatch({ type: "UNDO" })}
        onRedo={() => dispatch({ type: "REDO" })}
        onOpenProjects={() => setShowProjects(true)}
        onShowShortcuts={() => setShowShortcuts(true)}
        onNewProject={() => dispatch({ type: "CLOSE" })}
        onExport={() => {
          playback.pause();
          setExporting(true);
        }}
      />

      <div className="workspace">
        <ToolRail
          tool={tool}
          onToolChange={setTool}
          mediaOpen={mediaOpen}
          onToggleMedia={() => setMediaOpen((open) => !open)}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
        />

        {mediaOpen && (
          <MediaPanel
            sources={Object.values(sources)}
            missingIds={missingIds}
            clipCounts={clipCounts}
            importing={importing}
            progress={importProgress}
            error={importError}
            onImport={handlePickAndImport}
            onAddToTimeline={(source) =>
              dispatch({ type: "ADD_SOURCE", source, atMs: playheadRef.current })
            }
            onBeginDrag={(source) => setPendingSource(source)}
            onRelocate={(source) => void handleRelocate(source)}
            onCollapse={() => setMediaOpen(false)}
          />
        )}

        <PreviewStage
          videoA={videoA}
          videoB={videoB}
          audioA={audioA}
          audioB={audioB}
          activeIsA={playback.activeIsA}
          inGap={playback.inGap}
          framing={framing}
          cropX={visibleClip?.cropX ?? 0}
          sourceAspect={visibleSource ? sourceAspect(visibleSource.probe) : 16 / 9}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          showSafeZones={showSafeZones}
          onToggleSafeZones={() => setShowSafeZones((visible) => !visible)}
          playing={playback.playing}
          playheadMs={playback.playheadMs}
          durationMs={playback.durationMs}
          volume={volume}
          onVolumeChange={setVolume}
          onTogglePlay={playback.toggle}
          onStepFrame={stepFrame}
          onCommitCropX={
            visibleClip
              ? (cropX) => dispatch({ type: "SET_CLIP_CROP_X", clipId: visibleClip.id, cropX })
              : null
          }
        />

        {inspectorOpen && (
          <Inspector
            clip={selectedClip}
            source={selectedClip ? sources[selectedClip.sourceId] ?? null : null}
            framing={framing}
            onSetFraming={(next) => dispatch({ type: "SET_FRAMING", framing: next })}
            onSetCropX={(cropX) => {
              if (state.selectedClipId) {
                dispatch({ type: "SET_CLIP_CROP_X", clipId: state.selectedClipId, cropX });
              }
            }}
            onSetRate={(rate) => {
              if (state.selectedClipId) {
                dispatch({ type: "SET_CLIP_RATE", clipId: state.selectedClipId, rate });
              }
            }}
            onToggleAudio={toggleClipAudio}
            onDelete={deleteSelected}
            onCollapse={() => setInspectorOpen(false)}
          />
        )}
      </div>

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
        hiddenTracks={hiddenTracks}
        lockedTracks={lockedTracks}
        tool={tool}
        pendingSource={pendingSource}
        onDropSource={(source, atMs, track) => {
          setPendingSource(null);
          dispatch({ type: "ADD_SOURCE", source, atMs, track });
        }}
        onCancelDrop={() => setPendingSource(null)}
        height={timelineHeight}
        onHeightChange={(next) =>
          setTimelineHeight(Math.min(MAX_TIMELINE_PX, Math.max(MIN_TIMELINE_PX, next)))
        }
        dispatch={dispatch}
      />

      {showShortcuts && (
        <ShortcutsPanel
          frameStepMs={frameMs(referenceFps)}
          onClose={() => setShowShortcuts(false)}
        />
      )}

      {showProjects && (
        <ProjectsDialog
          currentId={state.project.id}
          onOpen={openStoredProject}
          onNewProject={() => {
            setShowProjects(false);
            dispatch({ type: "CLOSE" });
          }}
          onClose={() => setShowProjects(false)}
        />
      )}

      {exporting && (
        <ExportDialog
          sources={sources}
          clips={videoPlan}
          audioClips={audioPlan}
          framing={framing}
          onSetFraming={(next) => dispatch({ type: "SET_FRAMING", framing: next })}
          missingIds={missingIds}
          defaultName={`${state.project.name} tiktok`}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
