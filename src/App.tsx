import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { DragPreview } from "./components/DragPreview";
import { ExportDialog } from "./components/ExportDialog";
import { ImportView } from "./components/ImportView";
import { Inspector } from "./components/Inspector";
import { MediaPanel } from "./components/MediaPanel";
import { TextInspector } from "./components/TextInspector";
import { TextPanel } from "./components/TextPanel";
import { ZoomInspector } from "./components/ZoomInspector";
import { PreviewStage, type ViewMode } from "./components/PreviewStage";
import { ProjectsDialog } from "./components/ProjectsDialog";
import { ShortcutsPanel } from "./components/ShortcutsPanel";
import { Timeline } from "./components/Timeline";
import { ToolRail, type SidePanel, type Tool } from "./components/ToolRail";
import { TopBar, type SaveState } from "./components/TopBar";
import {
  CANCELLED,
  importSource,
  getHardwareCapabilities,
  loadLastProject,
  onCloseRequested,
  onFilesDropped,
  onImportProgress,
  pathsExist,
  pickVideoFile,
  pickVideoFiles,
  saveProject,
} from "./ipc";
import { usePlayback } from "./playback/usePlayback";
import {
  compileTimeline,
  rawTransitionCapacityMs,
  transitionCapacityMs,
} from "./timeline/compileTimeline";
import {
  editorReducer,
  effectiveClips,
  effectiveTextOverlays,
  effectiveZooms,
  initialEditorState,
  newClipId,
} from "./state/editor";
import type {
  FramingMode,
  HardwareCapabilities,
  ImportProgress,
  Project,
  SourceInfo,
  StoredProject,
} from "./types";
import {
  ASSET_VERSION,
  clipEndMs,
  frameMs,
  isProjectVersionSupported,
  isUnwantedKeyRepeat,
  sourceAspect,
  sourcesNeedingRegeneration,
  timelineDurationMs,
  timelineTimeToSourceTime,
} from "./types";

/** Référence stable : évite de recréer un objet vide à chaque rendu. */
const EMPTY_SOURCES: Record<string, SourceInfo> = {};

/**
 * Bornes de la zone timeline, pour qu'elle ne mange jamais tout l'aperçu.
 *
 * `minHeight` de la fenêtre (tauri.conf.json) vaut 700 px. La barre du haut
 * et la barre de lecture sous l'aperçu prennent chacune ~48 px de chrome fixe
 * ; le reste doit rester à l'aperçu et à l'inspecteur, pas à la timeline.
 * 720 dépassait déjà la fenêtre minimale à lui seul — poignée tirée à fond
 * sur une petite fenêtre, l'aperçu et l'inspecteur étaient écrasés à rien.
 */
const MIN_TIMELINE_PX = 180;
const MAX_TIMELINE_PX = 420;
const DEFAULT_TIMELINE_PX = 320;

export default function App() {
  if (import.meta.env.DEV) console.count("[render] App");
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const [pxPerSec, setPxPerSec] = useState(30);
  const [tool, setTool] = useState<Tool>("select");
  /** Panneau ouvert dans la colonne de gauche : un seul à la fois, jamais deux. */
  const [sidePanel, setSidePanel] = useState<SidePanel | null>("media");
  const [viewMode, setViewMode] = useState<ViewMode>("source");
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
  /**
   * Refus d'ouvrir un projet dont le format dépasse ce que ce build sait lire
   * (voir `isProjectVersionSupported`). Distinct de `importError` : ce n'est
   * pas un rush qui a échoué à s'importer, c'est un fichier de projet entier
   * qu'on refuse délibérément de toucher pour ne rien lui faire perdre.
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Rushs dont le fichier d'origine est introuvable (déplacé, supprimé). */
  const [missingIds, setMissingIds] = useState<ReadonlySet<string>>(new Set());
  /** Média tiré depuis le panneau Médias, en attente de dépôt sur la timeline. */
  const [pendingSource, setPendingSource] = useState<SourceInfo | null>(null);
  const [hardware, setHardware] = useState<HardwareCapabilities | null>(null);

  // Deux balises : celle qui est masquée précharge le clip suivant.
  const videoA = useRef<HTMLVideoElement | null>(null);
  const videoB = useRef<HTMLVideoElement | null>(null);
  // Balises sonores : le son suit le plan audio, pas le plan vidéo.
  const audioA = useRef<HTMLAudioElement | null>(null);
  const audioB = useRef<HTMLAudioElement | null>(null);

  const clips = effectiveClips(state);
  const textOverlays = effectiveTextOverlays(state);
  const zooms = effectiveZooms(state);
  const sources = state.project?.sources ?? EMPTY_SOURCES;
  const framing: FramingMode = state.project?.framing ?? "crop";

  // Une piste masquée sort des DEUX plans : l'aperçu et l'export doivent
  // montrer la même chose, sinon la promesse du canvas exact ne tient plus.
  const hiddenTracks = useMemo(() => new Set(state.hiddenTracks), [state.hiddenTracks]);
  const lockedTracks = useMemo(() => new Set(state.lockedTracks), [state.lockedTracks]);
  const compiledTimeline = useMemo(
    () => compileTimeline(state.clips, hiddenTracks, state.project?.sources ?? {}),
    [hiddenTracks, state.clips, state.project?.sources],
  );
  // Ne dépend que des clips COMMITTÉS : recalculer à chaque rendu referait ce
  // travail sur chaque image d'un glisser/redimensionnement de clip, qui ne
  // change que `transientClips`, jamais `state.clips`.
  //
  // Doit vivre AVANT le retour anticipé « pas de projet » plus bas : tous les
  // hooks d'un composant doivent s'exécuter à chaque rendu, dans le même
  // ordre — un `useMemo` posé après ce retour ne s'exécute que lorsqu'un
  // projet est chargé, ce qui change le nombre de hooks appelés d'un rendu à
  // l'autre et fait planter React (« Rendered more hooks than during the
  // previous render »), écran noir au démarrage puisque l'écran d'import est
  // justement ce qui s'affiche avant qu'un projet existe.
  const clipCounts = useMemo(
    () =>
      state.clips.reduce<Record<string, number>>((counts, clip) => {
        counts[clip.sourceId] = (counts[clip.sourceId] ?? 0) + 1;
        return counts;
      }, {}),
    [state.clips],
  );
  const playback = usePlayback(
    videoA,
    videoB,
    audioA,
    audioB,
    compiledTimeline,
    sources,
    volume,
  );

  useEffect(() => {
    void getHardwareCapabilities().then(setHardware).catch(() => undefined);
  }, []);
  const refreshHardware = useCallback(() => {
    void getHardwareCapabilities().then(setHardware).catch(() => undefined);
  }, []);

  // Reprendre le dernier projet au lancement. Si les fichiers dérivés d'un rush
  // datent d'une version antérieure, on les régénère : l'import réutilise le
  // proxy en cache, seuls les fichiers dérivés sont refaits.
  useEffect(() => {
    void loadLastProject().then(async (project) => {
      if (!project) return;
      // Un format plus récent que ce que ce build sait lire : on refuse de
      // charger plutôt que de migrer en aveugle. Migrer perdrait les champs
      // inconnus, puis l'autosave réécrirait aussitôt le fichier appauvri sur
      // le disque — irréversible. L'écran d'accueil reste affiché, intact.
      if (!isProjectVersionSupported(project.version)) {
        setLoadError(
          `Le dernier projet ouvert vient d'une version plus récente de l'application ` +
            `(format ${project.version}). Mets à jour GTA Studio pour le récupérer ; ` +
            `il n'a pas été modifié.`,
        );
        return;
      }
      dispatch({ type: "LOAD", project });
      const allSources = Object.values(project.sources ?? {}).concat(
        project.source ? [project.source] : [],
      );
      // Le backend n'exige plus qu'un proxy soit présent pour ouvrir le
      // projet (voir project.rs) : c'est ici qu'on répare ceux qui manquent.
      // Coûteux (un aller-retour IPC), donc seulement pour les sources pas
      // déjà connues comme périmées — celles-là seront de toute façon
      // refaites, régénérer leur proxy en plus ne changerait rien.
      const freshEnough = allSources.filter((source) => source.assetVersion >= ASSET_VERSION);
      const proxyExists = new Set(
        freshEnough.length === 0
          ? []
          : await pathsExist(freshEnough.map((source) => source.proxyPath))
              .then((results) =>
                freshEnough.filter((_, index) => results[index]).map((source) => source.id),
              )
              .catch(() => freshEnough.map((source) => source.id)),
      );
      const stale = sourcesNeedingRegeneration(allSources, proxyExists);
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
    }).catch((error) => {
      // Une erreur backend authentique (pas le « aucun projet » ni le format
      // trop récent, déjà gérés plus haut) laissait sinon une rejection non
      // suivie : l'écran d'accueil restait affiché, sans message, comme si
      // rien ne s'était passé.
      setLoadError(
        `Impossible de reprendre le dernier projet : ${String(error)}`,
      );
    });
  }, []);

  /**
   * Sauvegarde automatique débouncée : le point le plus sensible de l'appli,
   * celui où une erreur silencieuse perd du travail.
   *
   * `pendingSaveRef` porte la DERNIÈRE version du projet, mise à jour à chaque
   * rendu, indépendamment du minuteur. Le nettoyage de l'effet se contente
   * d'annuler le minuteur en cours — il ne perd rien, puisque la donnée à
   * sauvegarder vit dans la ref, pas dans le minuteur. `flushSave` peut donc
   * être appelée à tout moment (fermer le projet, fermer la fenêtre) pour
   * écrire immédiatement ce qu'il reste en attente, au lieu de laisser le
   * minuteur de 600 ms s'annoncer et disparaître avec la dernière modification.
   */
  const pendingSaveRef = useRef<Project | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    if (!pending) return;
    pendingSaveRef.current = null;
    setSaveState("saving");
    setSaveError(null);
    try {
      await saveProject(pending);
      setSaveState("saved");
    } catch (error) {
      // Ne jamais relancer : un appelant (la fermeture de la fenêtre, en
      // particulier) doit pouvoir attendre cette promesse sans jamais rester
      // bloqué sur un échec d'écriture.
      setSaveState("error");
      setSaveError(String(error));
    }
  }, []);

  useEffect(() => {
    if (!state.project) return;
    pendingSaveRef.current = {
      ...state.project,
      clips: state.clips,
      textOverlays: state.textOverlays,
      zooms: state.zooms,
      updatedAt: new Date().toISOString(),
    };
    saveTimerRef.current = setTimeout(() => void flushSave(), 600);
    return () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    };
  }, [state.clips, state.project, state.textOverlays, state.zooms, flushSave]);

  // Fermeture de la fenêtre : Tauri attend que le handler se résolve avant de
  // détruire la fenêtre, donc avant de vider une sauvegarde en attente laisse
  // filer la dernière modification sans qu'elle ait jamais touché le disque.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onCloseRequested(flushSave).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flushSave]);

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

  // Curseur « saisie » sur toute la fenêtre pendant qu'un rush est tiré depuis
  // le panneau Médias — le pointeur peut survoler des éléments qui portent
  // leur propre curseur (bouton, texte) en chemin vers la timeline ; sans
  // cette classe globale, il y reprendrait sa forme normale en plein geste.
  // Même mécanisme que `body.moving` pour le déplacement d'un clip déjà posé.
  useEffect(() => {
    document.body.classList.toggle("dragging-media", pendingSource !== null);
    return () => document.body.classList.remove("dragging-media");
  }, [pendingSource]);

  const handleImported = useCallback((source: SourceInfo) => {
    const now = new Date().toISOString();
    const baseName = source.originalPath.split(/[\\/]/).pop() ?? "rush";
    const project: Project = {
      version: 9,
      // Distinct de l'empreinte du rush : deux projets créés depuis le même
      // fichier partageraient sinon le même identifiant, donc le même fichier
      // JSON, et s'écraseraient l'un l'autre.
      id: crypto.randomUUID(),
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
          volume: 1,
          audioFadeInMs: 0,
          audioFadeOutMs: 0,
          videoFadeInMs: 0,
          videoFadeOutMs: 0,
          transitionInMs: 0,
          playbackRate: 1,
        },
      ],
      textOverlays: [],
      zooms: [],
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
            dispatch({
              type: "ADD_SOURCE",
              source,
              atMs: playback.clock.getPlayheadMs(),
            });
          } else {
            handleImported(source);
            hasProject = true;
          }
        }
      } catch (error) {
        // Une annulation n'est pas un échec : FFmpeg a été tué à la demande
        // de l'utilisateur, il n'y a rien à lui signaler comme une erreur —
        // et un dépôt de plusieurs fichiers s'arrête net, sans enchaîner sur
        // les suivants.
        if (String(error) !== CANCELLED) setImportError(String(error));
      } finally {
        setImporting(false);
        setImportProgress(null);
      }
    },
    [handleImported, playback.clock, state.project],
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
    dispatch({ type: "SPLIT_AT", timelineMs: playback.clock.getPlayheadMs() });
  }, [playback.clock]);

  // Même ordre de priorité que l'inspecteur affiché plus bas (zoom, puis
  // titre, puis clip) : Suppr doit toujours agir sur ce que l'utilisateur voit
  // réellement à l'écran. Bug réel : les trois sélections n'étaient pas
  // mutuellement exclusives (voir SELECT_ZOOM dans editor.ts), et ce
  // gestionnaire ne connaissait même pas les zooms — sélectionner un zoom
  // laissait le clip précédemment sélectionné « actif » en silence, et Suppr
  // le supprimait à la place du zoom affiché dans l'inspecteur.
  const deleteSelected = useCallback(() => {
    if (state.selectedZoomId) {
      dispatch({ type: "DELETE_ZOOM", zoomId: state.selectedZoomId });
    } else if (state.selectedTextOverlayId) {
      dispatch({ type: "DELETE_TEXT", textOverlayId: state.selectedTextOverlayId });
    } else if (state.selectedClipId) {
      dispatch({ type: "DELETE_CLIP", clipId: state.selectedClipId });
    }
  }, [state.selectedClipId, state.selectedTextOverlayId, state.selectedZoomId]);

  // Cadence de référence pour les pas clavier : celle du clip sélectionné, à
  // défaut celle du premier rush. Deux rushs peuvent différer.
  //
  // `clips` (transient-aware) et non `state.clips` (committé) : sinon les
  // champs numériques de l'inspecteur — durée de trim, transition — restent
  // figés sur la valeur d'avant-geste pendant qu'on fait glisser le clip,
  // alors même que la Timeline affiche déjà la position en cours.
  const selectedClip = clips.find((clip) => clip.id === state.selectedClipId) ?? null;
  const selectedTransitionIndex = selectedClip
    ? compiledTimeline.video.segments.findIndex(
        (segment) =>
          segment.sourceClipId === selectedClip.id &&
          Math.abs(segment.startMs - selectedClip.timelineStartMs) < 1,
      )
    : -1;
  /**
   * Secours quand la frontière n'existe plus comme segments adjacents.
   *
   * `flattenTracks` fusionne deux clips committés contigus dès qu'ils sont,
   * pour l'instant, réglés à l'identique — c'est systématiquement le cas juste
   * après une découpe (SPLIT_AT), tant qu'aucune des deux moitiés n'a été
   * retouchée (voir compileTimeline.ts). Sans ce secours, `selectedTransitionIndex`
   * vaut -1 et l'inspecteur affiche « poignées insuffisantes » sur une coupe
   * fraîche qui n'a pourtant aucun problème de poignées — juste plus de
   * frontière visible. Le clip committé qui précède directement `selectedClip`
   * sur SA piste, sans trou, reste la même frontière, qu'elle soit ou non
   * visible comme segment distinct.
   */
  const precedingClip =
    selectedClip && selectedTransitionIndex === -1
      ? (clips.find(
          (c) =>
            c.id !== selectedClip.id &&
            c.track === selectedClip.track &&
            Math.abs(clipEndMs(c) - selectedClip.timelineStartMs) < 1,
        ) ?? null)
      : null;
  const selectedTransitionMaxMs =
    selectedTransitionIndex !== -1
      ? transitionCapacityMs(compiledTimeline.video.segments, selectedTransitionIndex, sources)
      : precedingClip && selectedClip
        ? rawTransitionCapacityMs(precedingClip, selectedClip, sources)
        : 0;
  const selectedTransitionMs =
    selectedTransitionIndex !== -1
      ? (compiledTimeline.video.transitions.find(
          (transition) => transition.toIndex === selectedTransitionIndex,
        )?.durationMs ?? 0)
      : selectedClip
        ? Math.max(0, Math.min(selectedClip.transitionInMs, selectedTransitionMaxMs))
        : 0;
  const selectedTextOverlay =
    textOverlays.find((overlay) => overlay.id === state.selectedTextOverlayId) ?? null;
  const selectedZoom = zooms.find((zoom) => zoom.id === state.selectedZoomId) ?? null;
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
        const playheadMs = playback.clock.getPlayheadMs();
        if (playheadMs <= clip.timelineStartMs || playheadMs >= clip.timelineStartMs + (clip.srcOutMs - clip.srcInMs) / clip.playbackRate) return;
        edgeSrcMs = timelineTimeToSourceTime(clip, playheadMs);
      } else {
        edgeSrcMs = (side === "left" ? clip.srcInMs : clip.srcOutMs) + mode.deltaMs;
      }
      dispatch({ type: "TRIM_EDGE", clipId: clip.id, side, edgeSrcMs });
    },
    [playback.clock, state.clips, state.selectedClipId],
  );

  const stepFrame = useCallback(
    (direction: -1 | 1) => {
      const step = frameMs(referenceFps);
      playback.seek(
        Math.max(
          0,
          Math.min(playback.durationMs, playback.clock.getPlayheadMs() + direction * step),
        ),
      );
    },
    [playback.clock, playback.durationMs, playback.seek, referenceFps],
  );

  // Raccourcis clavier globaux.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (!state.project || exporting) return;

      // Répétition clavier (maintenir la touche) : voir isUnwantedKeyRepeat.
      if (isUnwantedKeyRepeat(event.repeat, event.key)) return;

      // Les combinaisons Ctrl passent AVANT les touches simples : sans ce
      // traitement séparé, Ctrl+V déclencherait aussi la branche « v », qui
      // bascule sur l'outil de sélection.
      if (event.ctrlKey && !event.shiftKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "d" && state.selectedClipId) {
          event.preventDefault();
          dispatch({ type: "DUPLICATE_CLIP", clipId: state.selectedClipId });
          return;
        }
        if (key === "c" && state.selectedClipId) {
          event.preventDefault();
          dispatch({ type: "COPY_CLIP", clipId: state.selectedClipId });
          return;
        }
        if (key === "v" && state.clipboard) {
          event.preventDefault();
          dispatch({ type: "PASTE_CLIP", atMs: playback.clock.getPlayheadMs() });
          return;
        }
        if (key === "z") {
          event.preventDefault();
          dispatch({ type: "UNDO" });
          return;
        }
        if (key === "y") {
          event.preventDefault();
          dispatch({ type: "REDO" });
          return;
        }
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: "REDO" });
        return;
      }
      // Toute autre combinaison Ctrl (Ctrl+S, Ctrl+B, Ctrl+I…) ne doit RIEN
      // faire ici plutôt que de retomber sur les raccourcis à touche seule :
      // sans ce garde-fou, Ctrl+S coupait le clip au playhead au lieu de ne
      // rien faire, et un Ctrl+V sans presse-papiers basculait l'outil.
      if (event.ctrlKey || event.metaKey) return;

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
          Math.max(
            0,
            Math.min(playback.durationMs, playback.clock.getPlayheadMs() + direction * step),
          ),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    deleteSelected, exporting, playback.clock, playback.durationMs, playback.seek, playback.toggle,
    referenceFps, splitAtPlayhead, state.clipboard, state.project, state.selectedClipId,
    toggleClipAudio, trimSelected,
  ]);

  const openStoredProject = useCallback(
    (project: StoredProject) => {
      // Même risque qu'un « Nouveau projet » : LOAD remplace clips, titres et
      // zooms d'un coup, et une modification encore en attente de minuteur
      // n'aurait plus personne pour la recevoir.
      void flushSave();
      // Le projet remplacé peut être en cours de lecture : sans l'arrêter et
      // remettre le playhead à zéro AVANT le remplacement, la balise vidéo
      // active continue de lire l'ancien média pendant que la boucle de
      // lecture bascule déjà sur les segments du nouveau projet.
      playback.pause();
      playback.seek(0);
      dispatch({ type: "LOAD", project });
      setShowProjects(false);
    },
    [flushSave, playback.pause, playback.seek],
  );

  if (!state.project) {
    return (
      <>
        <ImportView
          onImported={handleImported}
          onOpenProjects={() => setShowProjects(true)}
          droppedBusy={importing}
          droppedProgress={importProgress}
          startupError={loadError}
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
  const visibleClip =
    state.clips.find((clip) => clip.id === playback.activeVideoClipId) ?? null;
  const transitionClip =
    state.clips.find((clip) => clip.id === playback.transitionVideoClipId) ?? null;
  const visibleSource = visibleClip ? sources[visibleClip.sourceId] : undefined;

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
        onNewProject={() => {
          // Vide la sauvegarde en attente AVANT de fermer le projet : sinon
          // la dernière modification n'a plus de projet vers lequel écrire une
          // fois le minuteur écoulé, et disparaît silencieusement.
          void flushSave();
          dispatch({ type: "CLOSE" });
        }}
        onExport={() => {
          playback.pause();
          setExporting(true);
        }}
        hardware={hardware}
        onRefreshHardware={refreshHardware}
      />

      <div className="workspace">
        <ToolRail
          tool={tool}
          onToolChange={setTool}
          sidePanel={sidePanel}
          onSelectPanel={setSidePanel}
        />

        {/* Colonne de gauche : un seul panneau à la fois, qui en prend toute
            la hauteur. Elle disparaît quand aucun panneau n'est ouvert. */}
        {sidePanel !== null && (
          <div className="side-column">
        {sidePanel === "media" && (
          <MediaPanel
            sources={Object.values(sources)}
            missingIds={missingIds}
            clipCounts={clipCounts}
            importing={importing}
            progress={importProgress}
            error={importError}
            onImport={handlePickAndImport}
            onAddToTimeline={(source) =>
              dispatch({
                type: "ADD_SOURCE",
                source,
                atMs: playback.clock.getPlayheadMs(),
              })
            }
            draggingId={pendingSource?.id ?? null}
            onBeginDrag={setPendingSource}
            onRelocate={(source) => void handleRelocate(source)}
            onCollapse={() => setSidePanel(null)}
          />
        )}

        {sidePanel === "text" && (
          <TextPanel
            overlays={textOverlays}
            selectedId={state.selectedTextOverlayId}
            onAdd={() => {
              dispatch({ type: "ADD_TEXT", atMs: playback.clock.getPlayheadMs() });
              setSidePanel("inspector");
            }}
            onSelect={(textOverlayId) => {
              dispatch({ type: "SELECT_TEXT", textOverlayId });
              setSidePanel("inspector");
            }}
            onCollapse={() => setSidePanel(null)}
          />
        )}

        {sidePanel === "inspector" && (
        selectedZoom ? (
          <ZoomInspector
            zoom={selectedZoom}
            durationMs={timelineDurationMs(state.clips)}
            onUpdate={(patch) =>
              dispatch({ type: "UPDATE_ZOOM", zoomId: selectedZoom.id, patch })
            }
            onDelete={() => dispatch({ type: "DELETE_ZOOM", zoomId: selectedZoom.id })}
            onCollapse={() => setSidePanel(null)}
          />
        ) : selectedTextOverlay ? (
          <TextInspector
            overlay={selectedTextOverlay}
            durationMs={timelineDurationMs(state.clips)}
            onUpdate={(patch) =>
              dispatch({
                type: "UPDATE_TEXT",
                textOverlayId: selectedTextOverlay.id,
                patch,
              })
            }
            onDelete={() =>
              dispatch({ type: "DELETE_TEXT", textOverlayId: selectedTextOverlay.id })
            }
            onCollapse={() => setSidePanel(null)}
          />
        ) : (
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
            onSetVolume={(volume) => {
              if (state.selectedClipId) {
                dispatch({ type: "SET_CLIP_VOLUME", clipId: state.selectedClipId, volume });
              }
            }}
            onSetAudioFade={(side, fadeMs) => {
              if (state.selectedClipId) {
                dispatch({
                  type: "SET_CLIP_AUDIO_FADE",
                  clipId: state.selectedClipId,
                  side,
                  fadeMs,
                });
              }
            }}
            onSetVideoFade={(side, fadeMs) => {
              if (state.selectedClipId) {
                dispatch({
                  type: "SET_CLIP_VIDEO_FADE",
                  clipId: state.selectedClipId,
                  side,
                  fadeMs,
                });
              }
            }}
            transitionMaxMs={selectedTransitionMaxMs}
            effectiveTransitionMs={selectedTransitionMs}
            onSetTransitionIn={(durationMs) => {
              if (state.selectedClipId) {
                dispatch({
                  type: "SET_CLIP_TRANSITION_IN",
                  clipId: state.selectedClipId,
                  durationMs,
                });
              }
            }}
            onToggleAudio={toggleClipAudio}
            canDelete={state.clips.length > 1}
            onDelete={deleteSelected}
            onCollapse={() => setSidePanel(null)}
          />
        )
        )}
        </div>
        )}

        {/* Colonne centrale : l'aperçu et le montage. La timeline ne traverse
            plus toute la fenêtre — elle commence là où commence l'aperçu, si
            bien que les panneaux latéraux tiennent toute la hauteur et que
            l'œil garde une seule colonne de travail. */}
        <div className="center">
        <PreviewStage
          videoA={videoA}
          videoB={videoB}
          audioA={audioA}
          audioB={audioB}
          activeIsA={playback.activeIsA}
          inGap={playback.inGap}
          framing={framing}
          visibleClip={visibleClip}
          transitionClip={transitionClip}
          cropX={visibleClip?.cropX ?? 0}
          // Tant que la source visible n'est pas connue (chargement, coupe en
          // cours…), 16:9 donnait un format toujours plus large que la sortie,
          // ce qui rendait le cadrage « glissable » (curseur ew-resize) même
          // sur un rush déjà vertical qui n'a rien à recadrer. 9:16 — le
          // format de sortie lui-même — ne peut jamais déclencher ça : par
          // défaut, tant qu'on ne sait pas, on suppose qu'il n'y a rien à
          // glisser plutôt que l'inverse.
          sourceAspect={visibleSource ? sourceAspect(visibleSource.probe) : 9 / 16}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          showSafeZones={showSafeZones}
          onToggleSafeZones={() => setShowSafeZones((visible) => !visible)}
          playing={playback.playing}
          clock={playback.clock}
          durationMs={playback.durationMs}
          volume={volume}
          onVolumeChange={setVolume}
          onTogglePlay={playback.toggle}
          onPause={playback.pause}
          onStepFrame={stepFrame}
          onSplitAtPlayhead={splitAtPlayhead}
          onAddZoom={() => {
            dispatch({ type: "ADD_ZOOM", atMs: playback.clock.getPlayheadMs() });
            // Le zoom naît sélectionné : ouvrir l'inspecteur évite d'avoir posé
            // une zone sans voir par quoi on la règle.
            setSidePanel("inspector");
          }}
          onCommitCropX={
            visibleClip
              ? (cropX) => dispatch({ type: "SET_CLIP_CROP_X", clipId: visibleClip.id, cropX })
              : null
          }
          zooms={zooms}
          selectedZoom={selectedZoom}
          onCommitZoomTarget={
            selectedZoom
              ? (x, y) =>
                  dispatch({ type: "UPDATE_ZOOM", zoomId: selectedZoom.id, patch: { x, y } })
              : null
          }
          onCommitZoomBox={
            selectedZoom
              ? (x, y, scale) =>
                  dispatch({ type: "UPDATE_ZOOM", zoomId: selectedZoom.id, patch: { x, y, scale } })
              : null
          }
          textOverlays={textOverlays}
          selectedTextOverlayId={state.selectedTextOverlayId}
          onSelectTextOverlay={(textOverlayId) => {
            dispatch({ type: "SELECT_TEXT", textOverlayId });
            setSidePanel("inspector");
          }}
          onCommitTextPosition={(textOverlayId, x, y) =>
            dispatch({ type: "UPDATE_TEXT", textOverlayId, patch: { x, y } })
          }
        />

        <Timeline
          clips={clips}
          anchorClips={state.clips}
          sources={sources}
          pxPerSec={pxPerSec}
          onPxPerSecChange={setPxPerSec}
          compiledTimeline={compiledTimeline}
          clock={playback.clock}
          selectedClipId={state.selectedClipId}
          textOverlays={textOverlays}
          anchorTextOverlays={state.textOverlays}
          selectedTextOverlayId={state.selectedTextOverlayId}
          onSelectTextOverlay={(textOverlayId) =>
            dispatch({ type: "SELECT_TEXT", textOverlayId })
          }
          zooms={zooms}
          anchorZooms={state.zooms}
          selectedZoomId={state.selectedZoomId}
          onSelectZoom={(zoomId) => dispatch({ type: "SELECT_ZOOM", zoomId })}
          // Ouvre l'inspecteur seulement une fois le geste sur le zoom conclu :
          // le faire dès le pointerdown changerait la mise en page pendant que
          // le geste lit encore sa géométrie en direct, et décalerait la
          // timeline sous le curseur en plein déplacement. Inconditionnel :
          // ce callback ne se déclenche que si un zoom a bien été visé.
          onZoomGestureEnd={() => setSidePanel("inspector")}
          onSeek={playback.seek}
          onSelect={selectClip}
          onPreviewFrame={playback.showFrame}
          onPause={playback.pause}
          onCloseGaps={() => dispatch({ type: "CLOSE_GAPS" })}
          hiddenTracks={hiddenTracks}
          lockedTracks={lockedTracks}
          tool={tool}
          canPasteClip={state.clipboard !== null}
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
        </div>

      </div>

      <DragPreview source={pendingSource} />

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
            void flushSave();
            setShowProjects(false);
            dispatch({ type: "CLOSE" });
          }}
          onClose={() => setShowProjects(false)}
        />
      )}

      {exporting && (
        <ExportDialog
          sources={sources}
          compiledTimeline={compiledTimeline}
          textOverlays={state.textOverlays}
          zooms={state.zooms}
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
