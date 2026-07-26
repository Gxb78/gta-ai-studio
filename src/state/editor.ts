// État de l'éditeur : clips committés + état transitoire pendant les drags.
// Règle : les interactions continues (trim, déplacement) passent par
// `transientClips` et ne créent AUCUNE entrée d'historique tant qu'elles ne
// sont pas commitées.
//
// Les clips ont une position explicite sur la timeline : ils ne se chevauchent
// jamais, mais ils peuvent être disjoints (« trous »).

import type {
  Clip,
  FramingMode,
  Project,
  SourceInfo,
  StoredProject,
  TextOverlay,
  ZoomRegion,
} from "../types";
import {
  MIN_CLIP_MS,
  MIN_ZOOM_DURATION_MS,
  applyRate,
  clampAudioFadeMs,
  clampVideoFadeMs,
  clampTransitionMs,
  clampCropX,
  clampVolume,
  applyTrim,
  clipDurationMs,
  clipEndMs,
  clipsOnTrack,
  closeGaps,
  compactTrackIndices,
  firstFreeTrack,
  migrateProject,
  normalizeTextOverlay,
  normalizeZoomRegion,
  neighbourLimits,
  resolveOverlaps,
  sortClips,
  timelineTimeToSourceTime,
  topClipAt,
  trackCount,
  timelineDurationMs,
} from "../types";

const HISTORY_LIMIT = 100;

export interface EditorState {
  project: Project | null;
  /** Vérité committée (celle qu'on sauvegarde et exporte). */
  clips: Clip[];
  textOverlays: TextOverlay[];
  /** Zooms animés posés sur la timeline. */
  zooms: ZoomRegion[];
  /** Clips pendant un geste en cours (trim, déplacement), sinon null. */
  transientClips: Clip[] | null;
  /** Titres pendant un geste de timeline, sinon null. */
  transientTextOverlays: TextOverlay[] | null;
  /** Zooms pendant un geste de timeline, sinon null. */
  transientZooms: ZoomRegion[] | null;
  selectedClipId: string | null;
  selectedTextOverlayId: string | null;
  selectedZoomId: string | null;
  /**
   * Pistes masquées par leur en-tête. Un masquage retire la piste des DEUX
   * plans (image et son) : c'est un interrupteur de piste, pas un réglage
   * d'opacité — et l'export doit montrer exactement ce que l'aperçu montre.
   *
   * État de session, non enregistré : masquer une piste sert à travailler, pas
   * à décrire le montage.
   */
  hiddenTracks: number[];
  /** Pistes verrouillées : aucun geste de timeline n'y touche. */
  lockedTracks: number[];
  /**
   * Clip copié, en attente de collage. C'est de l'état de SESSION, comme le
   * masquage et le verrouillage : il décrit ce que l'utilisateur est en train
   * de faire, pas le montage, et n'est donc pas enregistré dans le projet.
   */
  clipboard: Clip | null;
  past: EditSnapshot[];
  future: EditSnapshot[];
}

interface EditSnapshot {
  clips: Clip[];
  textOverlays: TextOverlay[];
  zooms: ZoomRegion[];
}

export const initialEditorState: EditorState = {
  project: null,
  clips: [],
  textOverlays: [],
  zooms: [],
  transientClips: null,
  transientTextOverlays: null,
  transientZooms: null,
  selectedClipId: null,
  selectedTextOverlayId: null,
  selectedZoomId: null,
  hiddenTracks: [],
  lockedTracks: [],
  clipboard: null,
  past: [],
  future: [],
};

/**
 * Prépare la copie d'un clip à poser à `atMs`.
 *
 * La piste est cherchée à partir de celle de l'original : on ne crée une piste
 * neuve qu'en dernier recours, sinon dupliquer trois fois ferait trois pistes.
 * Une copie qui atterrit sur une surcouche arrive muette, comme tout ce qui se
 * pose au-dessus de la piste principale.
 */
const placeCopy = (clips: Clip[], origin: Clip, atMs: number): Clip => {
  const startMs = Math.max(0, atMs);
  const endMs = startMs + clipDurationMs(origin);
  const track = firstFreeTrack(clips, startMs, endMs, origin.track);
  return {
    ...origin,
    id: newClipId(),
    track,
    timelineStartMs: startMs,
    audioEnabled: track === 0 ? origin.audioEnabled : false,
    // La transition décrit une jonction avec le clip précédent : elle ne suit
    // pas la copie ailleurs sur la timeline.
    transitionInMs: 0,
  };
};

/**
 * Ramène la sélection dans le montage donné.
 *
 * Annuler une duplication, un collage ou une découpe fait disparaître le clip
 * qui venait d'être sélectionné : la sélection désignait alors un identifiant
 * qui n'existe plus. L'inspecteur affichait « aucun clip sélectionné » pendant
 * que la timeline n'en surlignait aucun, et Suppr comme M ne faisaient plus
 * rien — sans que rien n'explique pourquoi.
 */
const keepSelection = (
  clips: Clip[],
  textOverlays: TextOverlay[],
  zooms: ZoomRegion[],
  state: EditorState,
): Pick<EditorState, "selectedClipId" | "selectedTextOverlayId" | "selectedZoomId"> => ({
  selectedClipId: clips.some((clip) => clip.id === state.selectedClipId)
    ? state.selectedClipId
    : null,
  selectedTextOverlayId: textOverlays.some(
    (overlay) => overlay.id === state.selectedTextOverlayId,
  )
    ? state.selectedTextOverlayId
    : null,
  selectedZoomId: zooms.some((zoom) => zoom.id === state.selectedZoomId)
    ? state.selectedZoomId
    : null,
});

const clampClipFades = (clip: Clip): Clip => {
  const durationMs = clipDurationMs(clip);
  return {
    ...clip,
    audioFadeInMs: clampAudioFadeMs(clip.audioFadeInMs, durationMs),
    audioFadeOutMs: clampAudioFadeMs(clip.audioFadeOutMs, durationMs),
    videoFadeInMs: clampVideoFadeMs(clip.videoFadeInMs, durationMs),
    videoFadeOutMs: clampVideoFadeMs(clip.videoFadeOutMs, durationMs),
    transitionInMs: clampTransitionMs(clip.transitionInMs, durationMs),
  };
};

export type EditorAction =
  | { type: "LOAD"; project: StoredProject }
  /** Fichiers dérivés régénérés : on remplace le rush, jamais le montage. */
  | { type: "REFRESH_SOURCE"; source: SourceInfo }
  /**
   * Nouveau rush ajouté au projet. Sans `track`, il cherche la première piste
   * libre ; avec, il se pose exactement là — c'est le cas du dépôt à la souris.
   */
  | { type: "ADD_SOURCE"; source: SourceInfo; atMs: number; track?: number }
  /**
   * Rush retrouvé après un déplacement sur le disque : son empreinte a changé,
   * donc les clips doivent être rattachés au nouvel identifiant.
   */
  | { type: "RELINK_SOURCE"; missingId: string; source: SourceInfo }
  | { type: "RENAME_PROJECT"; name: string }
  /** Cadrage vertical du projet : l'aperçu et l'export lisent la même valeur. */
  | { type: "SET_FRAMING"; framing: FramingMode }
  /** Décalage horizontal du cadrage d'un clip. */
  | { type: "SET_CLIP_CROP_X"; clipId: string; cropX: number }
  | { type: "SET_CLIP_VOLUME"; clipId: string; volume: number }
  | {
      type: "SET_CLIP_AUDIO_FADE";
      clipId: string;
      side: "in" | "out" | "both";
      fadeMs: number;
    }
  | {
      type: "SET_CLIP_VIDEO_FADE";
      clipId: string;
      side: "in" | "out" | "both";
      fadeMs: number;
    }
  | { type: "SET_CLIP_TRANSITION_IN"; clipId: string; durationMs: number }
  | { type: "TOGGLE_TRACK_HIDDEN"; track: number }
  | { type: "TOGGLE_TRACK_LOCKED"; track: number }
  /** Son de tous les clips d'une piste, d'un coup (bouton M de l'en-tête). */
  | { type: "SET_TRACK_AUDIO"; track: number; audioEnabled: boolean }
  | { type: "CLOSE" }
  | { type: "SELECT"; clipId: string | null }
  | { type: "SELECT_TEXT"; textOverlayId: string | null }
  | { type: "ADD_TEXT"; atMs: number }
  | {
      type: "UPDATE_TEXT";
      textOverlayId: string;
      patch: Partial<Pick<TextOverlay, "text" | "timelineStartMs" | "timelineEndMs" | "x" | "y" | "fontSizePx" | "style" | "fadeInMs" | "fadeOutMs">>;
    }
  | { type: "DELETE_TEXT"; textOverlayId: string }
  | {
      type: "TEXT_TRANSIENT";
      textOverlayId: string;
      timelineStartMs: number;
      timelineEndMs: number;
    }
  | { type: "TEXT_GESTURE_COMMIT" }
  | { type: "TEXT_GESTURE_CANCEL" }
  /** Déplacement ou rognage d'un zoom en cours : aucune entrée d'historique. */
  | {
      type: "ZOOM_TRANSIENT";
      zoomId: string;
      timelineStartMs: number;
      timelineEndMs: number;
    }
  | { type: "ZOOM_GESTURE_COMMIT" }
  | { type: "ZOOM_GESTURE_CANCEL" }
  | { type: "SELECT_ZOOM"; zoomId: string | null }
  /** Nouveau zoom posé au playhead, visant le centre par défaut. */
  | { type: "ADD_ZOOM"; atMs: number }
  | {
      type: "UPDATE_ZOOM";
      zoomId: string;
      patch: Partial<Pick<ZoomRegion, "timelineStartMs" | "timelineEndMs" | "scale" | "x" | "y" | "rampInMs" | "rampOutMs">>;
    }
  | { type: "DELETE_ZOOM"; zoomId: string }
  | { type: "SPLIT_AT"; timelineMs: number }
  | { type: "DELETE_CLIP"; clipId: string }
  | { type: "DUPLICATE_CLIP"; clipId: string }
  | { type: "CLIP_TO_NEW_TRACK"; clipId: string }
  | { type: "COPY_CLIP"; clipId: string }
  | { type: "PASTE_CLIP"; atMs: number }
  /** Trim en cours : aucune entrée d'historique. */
  | { type: "TRIM_TRANSIENT"; clipId: string; side: "left" | "right"; edgeSrcMs: number }
  /** Déplacement en cours : aucune entrée d'historique. */
  | { type: "MOVE_TRANSIENT"; clipId: string; timelineStartMs: number; track: number }
  | { type: "GESTURE_COMMIT" }
  | { type: "GESTURE_CANCEL" }
  /** Trim committé d'un coup (clavier) : une seule entrée d'historique. */
  | { type: "TRIM_EDGE"; clipId: string; side: "left" | "right"; edgeSrcMs: number }
  /** Fait entrer ou sortir un clip du montage sonore. */
  | { type: "TOGGLE_CLIP_AUDIO"; clipId: string }
  /** Vitesse constante du clip. Une seule entrée d'historique. */
  | { type: "SET_CLIP_RATE"; clipId: string; rate: number }
  | { type: "CLOSE_GAPS" }
  | { type: "UNDO" }
  | { type: "REDO" };

/** Clips effectivement affichés (transitoires si un geste est en cours). */
export const effectiveClips = (state: EditorState): Clip[] =>
  state.transientClips ?? state.clips;

export const effectiveTextOverlays = (state: EditorState): TextOverlay[] =>
  state.transientTextOverlays ?? state.textOverlays;

export const effectiveZooms = (state: EditorState): ZoomRegion[] =>
  state.transientZooms ?? state.zooms;

// Compacté à CHAQUE commit, jamais sur l'état transitoire : c'est le même
// principe que la borne de piste posée pendant un geste, appliqué une image
// plus tard. Idempotent sur des indices déjà compacts, donc sans coût quand
// il n'y a rien à faire.
const snapshot = (state: EditorState): EditSnapshot => ({
  clips: state.clips,
  textOverlays: state.textOverlays,
  zooms: state.zooms,
});

/**
 * Impose que deux zooms ne se chevauchent jamais.
 *
 * C'est ce qui permet à la lecture comme à l'export de n'en retenir qu'UN à un
 * instant donné, sans avoir à composer deux agrandissements — et donc de garder
 * une seule expression FFmpeg. Un zoom qui empiète sur le précédent est repoussé
 * derrière lui ; s'il n'a plus la place de durer, il disparaît.
 */
const resolveZoomOverlaps = (zooms: ZoomRegion[], durationMs: number): ZoomRegion[] => {
  const sorted = [...zooms].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const kept: ZoomRegion[] = [];
  let cursor = 0;
  for (const zoom of sorted) {
    const startMs = Math.max(zoom.timelineStartMs, cursor);
    const endMs = Math.max(zoom.timelineEndMs, startMs);
    if (endMs - startMs < MIN_ZOOM_DURATION_MS) continue;
    const placed = normalizeZoomRegion(
      { ...zoom, timelineStartMs: startMs, timelineEndMs: endMs },
      durationMs,
    );
    if (placed.timelineEndMs - placed.timelineStartMs < MIN_ZOOM_DURATION_MS) continue;
    kept.push(placed);
    cursor = placed.timelineEndMs;
  }
  return kept;
};

const pushHistory = (
  state: EditorState,
  nextClips: Clip[],
  nextTextOverlays = state.textOverlays,
  nextZooms = state.zooms,
): EditorState => {
  const clips = compactTrackIndices(nextClips);
  const durationMs = timelineDurationMs(clips);
  const textOverlays = nextTextOverlays
    .map((overlay) => normalizeTextOverlay(overlay, durationMs))
    .filter((overlay) => overlay.timelineEndMs > overlay.timelineStartMs);
  const zooms = resolveZoomOverlaps(nextZooms, durationMs);
  return {
    ...state,
    clips,
    textOverlays,
    zooms,
    transientClips: null,
    transientTextOverlays: null,
    transientZooms: null,
    past: [...state.past.slice(-(HISTORY_LIMIT - 1)), snapshot(state)],
    future: [],
  };
};

let zoomCounter = 0;
const newZoomId = (): string => {
  zoomCounter += 1;
  return `zoom-${zoomCounter}-${Math.random().toString(36).slice(2, 8)}`;
};

let clipCounter = 0;
export const newClipId = (): string => {
  clipCounter += 1;
  return `clip-${Date.now().toString(36)}-${clipCounter}`;
};

let textCounter = 0;
const newTextOverlayId = (): string => {
  textCounter += 1;
  return `text-${Date.now().toString(36)}-${textCounter}`;
};

/** Ajoute ou retire une valeur d'une liste d'indices de pistes. */
const toggleTrack = (tracks: number[], track: number): number[] =>
  tracks.includes(track) ? tracks.filter((t) => t !== track) : [...tracks, track];

// Compare aussi playbackRate : sans lui, changer la vitesse d'un clip qui a
// la place de s'étendre (le cas courant) ne modifie ni les bornes timeline ni
// les bornes source, donc withGesture le prenait pour un geste sans effet et
// l'ignorait — SET_CLIP_RATE ne faisait alors littéralement rien.
const sameBounds = (a: Clip, b: Clip): boolean =>
  a.timelineStartMs === b.timelineStartMs &&
  a.srcInMs === b.srcInMs &&
  a.srcOutMs === b.srcOutMs &&
  a.playbackRate === b.playbackRate;

/** Applique un geste sur un clip et renvoie la liste complète, ou null si rien ne change. */
function withGesture(
  clips: Clip[],
  clipId: string,
  transform: (clip: Clip, limits: { minStartMs: number; maxEndMs: number }) => Clip,
): Clip[] | null {
  const target = clips.find((clip) => clip.id === clipId);
  if (!target) return null;
  // Les butées viennent des voisins de la MÊME piste : entre pistes, le
  // chevauchement est le comportement recherché.
  const sorted = sortClips(clipsOnTrack(clips, target.track));
  const index = sorted.findIndex((clip) => clip.id === clipId);
  if (index === -1) return null;
  const updated = transform(sorted[index], neighbourLimits(sorted, index));
  if (sameBounds(updated, sorted[index])) return null;
  return clips.map((clip) => (clip.id === clipId ? updated : clip));
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  // La borne de trim dépend du rush du clip, pas du projet : chaque rush a sa
  // propre durée.
  const durationOf = (clip: Clip): number =>
    state.project?.sources[clip.sourceId]?.probe.durationMs ?? Number.MAX_SAFE_INTEGER;

  switch (action.type) {
    case "LOAD": {
      const project = migrateProject(action.project);
      return {
        ...initialEditorState,
        project,
        clips: project.clips,
        textOverlays: project.textOverlays,
        zooms: project.zooms,
      };
    }

    case "REFRESH_SOURCE": {
      if (!state.project) return state;
      const sources = { ...state.project.sources, [action.source.id]: action.source };
      return { ...state, project: { ...state.project, sources } };
    }

    case "ADD_SOURCE": {
      if (!state.project) return state;
      const sources = { ...state.project.sources, [action.source.id]: action.source };
      // Un rush ajouté se pose au playhead, sur la première piste où la place
      // est libre en partant de celle du clip sélectionné. On ne crée une piste
      // neuve qu'en dernier recours : sinon dix rushs feraient dix pistes.
      const startMs = Math.max(0, action.atMs);
      const endMs = startMs + action.source.probe.durationMs;
      const fromTrack = state.clips.find((c) => c.id === state.selectedClipId)?.track ?? 0;
      const track =
        action.track !== undefined
          ? Math.max(0, Math.floor(action.track))
          : firstFreeTrack(state.clips, startMs, endMs, fromTrack);
      const clip: Clip = {
        id: newClipId(),
        sourceId: action.source.id,
        cropX: 0,
        track,
        timelineStartMs: startMs,
        srcInMs: 0,
        srcOutMs: action.source.probe.durationMs,
        // Une surcouche arrive muette : elle ne doit pas couper le son du dessous.
        audioEnabled: track === 0,
        volume: 1,
        audioFadeInMs: 0,
        audioFadeOutMs: 0,
        videoFadeInMs: 0,
        videoFadeOutMs: 0,
        transitionInMs: 0,
        playbackRate: 1,
      };
      // Piste imposée (dépôt à la souris) : les clips déjà présents s'écartent,
      // comme lors d'un déplacement, plutôt que de créer un chevauchement.
      const next =
        action.track === undefined
          ? [...state.clips, clip]
          : resolveOverlaps([...state.clips, clip], clip.id);
      return {
        ...pushHistory(state, next),
        project: { ...state.project, sources },
        selectedClipId: clip.id,
      };
    }

    case "RELINK_SOURCE": {
      if (!state.project) return state;
      const sources = { ...state.project.sources };
      delete sources[action.missingId];
      sources[action.source.id] = action.source;
      // Le rush retrouvé peut être plus court que l'original : on borne les
      // clips plutôt que de laisser un srcOutMs pointer dans le vide.
      const limit = action.source.probe.durationMs;
      const clips = state.clips.map((clip) =>
        clip.sourceId === action.missingId
          ? clampClipFades({
              ...clip,
              sourceId: action.source.id,
              srcInMs: Math.min(clip.srcInMs, Math.max(0, limit - MIN_CLIP_MS)),
              srcOutMs: Math.min(clip.srcOutMs, limit),
            })
          : clip,
      );
      return { ...pushHistory(state, clips), project: { ...state.project, sources } };
    }

    case "RENAME_PROJECT": {
      if (!state.project) return state;
      const name = action.name.trim();
      if (!name || name === state.project.name) return state;
      return { ...state, project: { ...state.project, name } };
    }

    case "SET_FRAMING": {
      if (!state.project || state.project.framing === action.framing) return state;
      return { ...state, project: { ...state.project, framing: action.framing } };
    }

    case "SET_CLIP_CROP_X": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      const cropX = clampCropX(action.cropX);
      if (!target || target.cropX === cropX) return state;
      const clips = state.clips.map((clip) =>
        clip.id === action.clipId ? { ...clip, cropX } : clip,
      );
      return pushHistory(state, clips);
    }

    case "SET_CLIP_VOLUME": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      const volume = clampVolume(action.volume);
      if (!target || target.volume === volume) return state;
      return pushHistory(
        state,
        state.clips.map((clip) =>
          clip.id === action.clipId ? { ...clip, volume } : clip,
        ),
      );
    }

    case "SET_CLIP_AUDIO_FADE": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      if (!target) return state;
      const fadeMs = clampAudioFadeMs(action.fadeMs, clipDurationMs(target));
      if (action.side === "both") {
        if (target.audioFadeInMs === fadeMs && target.audioFadeOutMs === fadeMs) return state;
        return pushHistory(
          state,
          state.clips.map((clip) =>
            clip.id === action.clipId
              ? { ...clip, audioFadeInMs: fadeMs, audioFadeOutMs: fadeMs }
              : clip,
          ),
        );
      }
      const key = action.side === "in" ? "audioFadeInMs" : "audioFadeOutMs";
      if (target[key] === fadeMs) return state;
      return pushHistory(
        state,
        state.clips.map((clip) =>
          clip.id === action.clipId ? { ...clip, [key]: fadeMs } : clip,
        ),
      );
    }

    case "SET_CLIP_VIDEO_FADE": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      if (!target) return state;
      const fadeMs = clampVideoFadeMs(action.fadeMs, clipDurationMs(target));
      if (action.side === "both") {
        if (target.videoFadeInMs === fadeMs && target.videoFadeOutMs === fadeMs) return state;
        return pushHistory(
          state,
          state.clips.map((clip) =>
            clip.id === action.clipId
              ? { ...clip, videoFadeInMs: fadeMs, videoFadeOutMs: fadeMs }
              : clip,
          ),
        );
      }
      const key = action.side === "in" ? "videoFadeInMs" : "videoFadeOutMs";
      if (target[key] === fadeMs) return state;
      return pushHistory(
        state,
        state.clips.map((clip) =>
          clip.id === action.clipId ? { ...clip, [key]: fadeMs } : clip,
        ),
      );
    }

    case "SET_CLIP_TRANSITION_IN": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      if (!target) return state;
      const durationMs = clampTransitionMs(action.durationMs, clipDurationMs(target));
      if (target.transitionInMs === durationMs) return state;
      return pushHistory(
        state,
        state.clips.map((clip) =>
          clip.id === action.clipId ? { ...clip, transitionInMs: durationMs } : clip,
        ),
      );
    }

    case "TOGGLE_TRACK_HIDDEN":
      return { ...state, hiddenTracks: toggleTrack(state.hiddenTracks, action.track) };

    case "TOGGLE_TRACK_LOCKED":
      return { ...state, lockedTracks: toggleTrack(state.lockedTracks, action.track) };

    case "SET_TRACK_AUDIO": {
      const concerned = state.clips.filter((clip) => clip.track === action.track);
      if (concerned.every((clip) => clip.audioEnabled === action.audioEnabled)) return state;
      const clips = state.clips.map((clip) =>
        clip.track === action.track ? { ...clip, audioEnabled: action.audioEnabled } : clip,
      );
      return pushHistory(state, clips);
    }

    case "CLOSE":
      return initialEditorState;

    case "SELECT":
      return { ...state, selectedClipId: action.clipId, selectedTextOverlayId: null };

    case "SELECT_TEXT":
      return { ...state, selectedClipId: null, selectedTextOverlayId: action.textOverlayId };

    case "ADD_TEXT": {
      const durationMs = timelineDurationMs(state.clips);
      if (durationMs < MIN_CLIP_MS) return state;
      const startMs = Math.max(0, Math.min(durationMs - MIN_CLIP_MS, action.atMs));
      const overlay = normalizeTextOverlay(
        {
          id: newTextOverlayId(),
          text: "Nouveau titre",
          timelineStartMs: startMs,
          timelineEndMs: Math.min(durationMs, startMs + 3000),
          x: 0.5,
          y: 0.72,
          fontSizePx: 88,
          style: "impact",
          fadeInMs: 0,
          fadeOutMs: 0,
        },
        durationMs,
      );
      return {
        ...pushHistory(state, state.clips, [...state.textOverlays, overlay]),
        selectedClipId: null,
        selectedTextOverlayId: overlay.id,
      };
    }

    case "UPDATE_TEXT": {
      const target = state.textOverlays.find((overlay) => overlay.id === action.textOverlayId);
      if (!target) return state;
      const next = normalizeTextOverlay(
        { ...target, ...action.patch },
        timelineDurationMs(state.clips),
      );
      if (
        next.text === target.text &&
        next.timelineStartMs === target.timelineStartMs &&
        next.timelineEndMs === target.timelineEndMs &&
        next.x === target.x &&
        next.y === target.y &&
        next.fontSizePx === target.fontSizePx &&
        next.style === target.style &&
        next.fadeInMs === target.fadeInMs &&
        next.fadeOutMs === target.fadeOutMs
      ) {
        return state;
      }
      return pushHistory(
        state,
        state.clips,
        state.textOverlays.map((overlay) => overlay.id === target.id ? next : overlay),
      );
    }

    case "DELETE_TEXT": {
      if (!state.textOverlays.some((overlay) => overlay.id === action.textOverlayId)) return state;
      return {
        ...pushHistory(
          state,
          state.clips,
          state.textOverlays.filter((overlay) => overlay.id !== action.textOverlayId),
        ),
        selectedTextOverlayId:
          state.selectedTextOverlayId === action.textOverlayId ? null : state.selectedTextOverlayId,
      };
    }

    case "TEXT_TRANSIENT": {
      const target = state.textOverlays.find((overlay) => overlay.id === action.textOverlayId);
      if (!target) return state;
      const next = normalizeTextOverlay(
        {
          ...target,
          timelineStartMs: action.timelineStartMs,
          timelineEndMs: action.timelineEndMs,
        },
        timelineDurationMs(state.clips),
      );
      const transientTextOverlays = state.textOverlays.map((overlay) =>
        overlay.id === target.id ? next : overlay,
      );
      return { ...state, transientTextOverlays };
    }

    case "TEXT_GESTURE_COMMIT":
      if (!state.transientTextOverlays) return state;
      return pushHistory(state, state.clips, state.transientTextOverlays);

    case "TEXT_GESTURE_CANCEL":
      return state.transientTextOverlays ? { ...state, transientTextOverlays: null } : state;

    /**
     * Zoom déplacé ou rogné à la souris.
     *
     * Le geste ne passe PAS par `resolveZoomOverlaps` : cette fonction repousse
     * les zooms les uns derrière les autres et en supprime, ce qui, image par
     * image, ferait fuir le voisin devant le pointeur puis disparaître. Pendant
     * le geste, le zoom est simplement borné par ses voisins COMMITTÉS — il
     * bute contre eux et s'arrête, ce qui est lisible. La normalisation
     * complète n'intervient qu'au commit.
     */
    case "ZOOM_TRANSIENT": {
      const target = state.zooms.find((zoom) => zoom.id === action.zoomId);
      if (!target) return state;
      const others = state.zooms.filter((zoom) => zoom.id !== target.id);
      const lowerMs = others
        .filter((zoom) => zoom.timelineEndMs <= target.timelineStartMs)
        .reduce((bound, zoom) => Math.max(bound, zoom.timelineEndMs), 0);
      const upperMs = others
        .filter((zoom) => zoom.timelineStartMs >= target.timelineEndMs)
        .reduce(
          (bound, zoom) => Math.min(bound, zoom.timelineStartMs),
          timelineDurationMs(state.clips),
        );
      const startMs = Math.max(lowerMs, action.timelineStartMs);
      const endMs = Math.min(upperMs, action.timelineEndMs);
      if (endMs - startMs < MIN_ZOOM_DURATION_MS) return state;
      const next = normalizeZoomRegion(
        { ...target, timelineStartMs: startMs, timelineEndMs: endMs },
        timelineDurationMs(state.clips),
      );
      return {
        ...state,
        transientZooms: state.zooms.map((zoom) => (zoom.id === target.id ? next : zoom)),
      };
    }

    case "ZOOM_GESTURE_COMMIT":
      if (!state.transientZooms) return state;
      return pushHistory(state, state.clips, state.textOverlays, state.transientZooms);

    case "ZOOM_GESTURE_CANCEL":
      return state.transientZooms ? { ...state, transientZooms: null } : state;

    case "SELECT_ZOOM":
      return { ...state, selectedZoomId: action.zoomId, selectedTextOverlayId: null };

    case "ADD_ZOOM": {
      const durationMs = timelineDurationMs(state.clips);
      if (durationMs < MIN_ZOOM_DURATION_MS) return state;
      // Le zoom se pose au playhead, sur la première fenêtre libre : le poser
      // par-dessus un zoom existant le ferait disparaître au passage par
      // `resolveZoomOverlaps`, sans que l'utilisateur comprenne pourquoi.
      const wantedMs = Math.max(0, Math.min(durationMs - MIN_ZOOM_DURATION_MS, action.atMs));
      const startMs = state.zooms.reduce(
        (cursor, zoom) =>
          cursor < zoom.timelineEndMs && zoom.timelineStartMs <= cursor
            ? zoom.timelineEndMs
            : cursor,
        wantedMs,
      );
      if (durationMs - startMs < MIN_ZOOM_DURATION_MS) return state;
      const zoom = normalizeZoomRegion(
        {
          id: newZoomId(),
          timelineStartMs: startMs,
          timelineEndMs: Math.min(durationMs, startMs + 2000),
          // Un zoom par défaut se voit sans déformer : 1,6× cadre bien la
          // mini-carte d'un rush 1080p sans que l'image devienne molle.
          scale: 1.6,
          x: 0.5,
          y: 0.5,
          rampInMs: 400,
          rampOutMs: 400,
        },
        durationMs,
      );
      return {
        ...pushHistory(state, state.clips, state.textOverlays, [...state.zooms, zoom]),
        selectedClipId: null,
        selectedTextOverlayId: null,
        selectedZoomId: zoom.id,
      };
    }

    case "UPDATE_ZOOM": {
      if (!state.zooms.some((zoom) => zoom.id === action.zoomId)) return state;
      const zooms = state.zooms.map((zoom) =>
        zoom.id === action.zoomId ? { ...zoom, ...action.patch } : zoom,
      );
      return {
        ...pushHistory(state, state.clips, state.textOverlays, zooms),
        selectedZoomId: state.selectedZoomId,
      };
    }

    case "DELETE_ZOOM": {
      if (!state.zooms.some((zoom) => zoom.id === action.zoomId)) return state;
      return {
        ...pushHistory(
          state,
          state.clips,
          state.textOverlays,
          state.zooms.filter((zoom) => zoom.id !== action.zoomId),
        ),
        selectedZoomId: state.selectedZoomId === action.zoomId ? null : state.selectedZoomId,
      };
    }

    case "SPLIT_AT": {
      // Un clip explicitement sélectionné prime, même s'il est recouvert :
      // sinon un clip de la piste du dessous deviendrait inéditable.
      // Sans sélection, on coupe le clip visible, donc celui du dessus.
      const selected = state.clips.find((c) => c.id === state.selectedClipId);
      const clip =
        selected &&
        action.timelineMs > selected.timelineStartMs &&
        action.timelineMs < clipEndMs(selected)
          ? selected
          : topClipAt(state.clips, action.timelineMs);
      if (!clip) return state; // playhead dans un trou : rien à couper
      const offsetMs = action.timelineMs - clip.timelineStartMs;
      if (offsetMs <= MIN_CLIP_MS || offsetMs >= clipDurationMs(clip) - MIN_CLIP_MS) {
        return state;
      }
      // Le point de coupe dans le RUSH passe par la conversion canonique :
      // avec une vitesse de 2, une seconde de montage vaut deux secondes de rush.
      const cutSrc = timelineTimeToSourceTime(clip, action.timelineMs);
      const left = clampClipFades({
        ...clip,
        srcOutMs: cutSrc,
        // Une coupe franche ne crée pas un fondu au nouveau bord.
        audioFadeOutMs: 0,
        videoFadeOutMs: 0,
      });
      const right: Clip = {
        id: newClipId(),
        sourceId: clip.sourceId,
        cropX: clip.cropX,
        track: clip.track,
        timelineStartMs: action.timelineMs,
        srcInMs: cutSrc,
        srcOutMs: clip.srcOutMs,
        audioEnabled: clip.audioEnabled,
        volume: clip.volume,
        audioFadeInMs: 0,
        audioFadeOutMs: clampAudioFadeMs(
          clip.audioFadeOutMs,
          (clip.srcOutMs - cutSrc) / clip.playbackRate,
        ),
        videoFadeInMs: 0,
        videoFadeOutMs: clampVideoFadeMs(
          clip.videoFadeOutMs,
          (clip.srcOutMs - cutSrc) / clip.playbackRate,
        ),
        transitionInMs: 0,
        playbackRate: clip.playbackRate,
      };
      const next = state.clips.map((c) => (c.id === clip.id ? left : c));
      next.push(right);
      return { ...pushHistory(state, next), selectedClipId: right.id };
    }

    case "DELETE_CLIP": {
      if (state.clips.length <= 1) return state; // toujours garder au moins un clip
      const index = state.clips.findIndex((c) => c.id === action.clipId);
      if (index === -1) return state;
      const next = state.clips.filter((c) => c.id !== action.clipId);
      const sorted = sortClips(next);
      const fallback = sorted[Math.min(index, sorted.length - 1)];
      return { ...pushHistory(state, next), selectedClipId: fallback ? fallback.id : null };
    }

    /**
     * Duplication et collage posent une COPIE, jamais la même référence : deux
     * clips qui partageraient un identifiant se sélectionneraient et se
     * déplaceraient ensemble. La copie garde tous les réglages (bornes source,
     * vitesse, volume, fondus, cadrage) — c'est ce qui les rend utiles — sauf
     * la transition d'entrée, qui décrit une jonction précise avec le clip
     * précédent et n'a aucun sens ailleurs.
     */
    case "DUPLICATE_CLIP": {
      const clip = state.clips.find((c) => c.id === action.clipId);
      if (!clip) return state;
      const copy = placeCopy(state.clips, clip, clipEndMs(clip));
      return {
        ...pushHistory(state, resolveOverlaps([...state.clips, copy], copy.id)),
        selectedClipId: copy.id,
      };
    }

    /**
     * Monte le clip sur une piste neuve, au-dessus de toutes les autres.
     *
     * C'est le remplaçant explicite de la rangée fantôme qui s'affichait
     * pendant les déplacements : une action nommée, invoquée quand on la veut,
     * plutôt qu'une rangée qui décalait la vue à chaque prise de clip.
     *
     * `pushHistory` recompacte les indices de piste : si le clip était déjà
     * seul sur la piste du haut, l'opération se referme sur elle-même et ne
     * laisse pas de piste vide derrière elle.
     */
    case "CLIP_TO_NEW_TRACK": {
      const clip = state.clips.find((c) => c.id === action.clipId);
      if (!clip) return state;
      const track = trackCount(state.clips);
      if (clip.track === track - 1 && clipsOnTrack(state.clips, clip.track).length === 1) {
        return state;
      }
      const next = state.clips.map((c) =>
        c.id === clip.id
          ? // Une surcouche arrive muette : elle ne doit pas couper le son du dessous.
            { ...c, track, audioEnabled: false }
          : c,
      );
      return { ...pushHistory(state, next), selectedClipId: clip.id };
    }

    // Copier ne touche pas au montage : pas d'entrée d'historique.
    case "COPY_CLIP": {
      const clip = state.clips.find((c) => c.id === action.clipId);
      if (!clip) return state;
      return { ...state, clipboard: { ...clip } };
    }

    case "PASTE_CLIP": {
      if (!state.clipboard) return state;
      const copy = placeCopy(state.clips, state.clipboard, Math.max(0, action.atMs));
      return {
        ...pushHistory(state, resolveOverlaps([...state.clips, copy], copy.id)),
        selectedClipId: copy.id,
      };
    }

    // Un geste repart toujours des clips COMMITTÉS : appliquer le delta sur l'état
    // transitoire ferait dériver le bord par accumulation d'arrondis.
    case "TRIM_TRANSIENT": {
      const next = withGesture(state.clips, action.clipId, (clip, limits) =>
        clampClipFades(
          applyTrim(clip, action.side, action.edgeSrcMs, {
            ...limits,
            sourceDurationMs: durationOf(clip),
          }),
        ),
      );
      if (!next) return state.transientClips ? { ...state, transientClips: null } : state;
      return { ...state, transientClips: next };
    }

    // Le clip suit le curseur sans être bloqué par ses voisins : ce sont eux qui
    // s'écartent, en direct, pour que le résultat au relâchement soit sans surprise.
    case "MOVE_TRANSIENT": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      if (!target) return state;
      const timelineStartMs = Math.max(0, action.timelineStartMs);
      // Borné à au plus UNE piste neuve au-dessus des pistes committées : sans
      // cette borne, un pointeur qui reste au-dessus de la rangée fantôme
      // pendant le geste crée une piste par image (la rangée fantôme remonte
      // d'autant, le pointeur se retrouve de nouveau au-dessus) — un montage
      // s'est ainsi retrouvé avec 76 pistes après moins de deux secondes.
      // Cette borne est la garantie ; celle posée côté Timeline n'est qu'un
      // confort visuel pour ne pas laisser la rangée fantôme s'emballer à l'œil.
      const ceiling = trackCount(state.clips);
      const wanted = Math.min(ceiling, Math.max(0, Math.floor(action.track)));
      // Une piste verrouillée n'accepte rien : le clip reste sur la sienne.
      const track = state.lockedTracks.includes(wanted) ? target.track : wanted;
      const moved = { ...target, timelineStartMs, track };
      const next = resolveOverlaps(
        state.clips.map((clip) => (clip.id === action.clipId ? moved : clip)),
        action.clipId,
      );
      const sortedNext = sortClips(next);
      const sortedBefore = sortClips(state.clips);
      const unchanged =
        sortedNext.length === sortedBefore.length &&
        sortedNext.every((clip, i) => sameBounds(clip, sortedBefore[i]) && clip.track === sortedBefore[i].track);
      if (unchanged) {
        return state.transientClips ? { ...state, transientClips: null } : state;
      }
      return { ...state, transientClips: next };
    }

    case "GESTURE_COMMIT": {
      if (!state.transientClips) return state;
      return pushHistory(state, state.transientClips);
    }

    case "GESTURE_CANCEL":
      return { ...state, transientClips: null };

    case "TRIM_EDGE": {
      const next = withGesture(state.clips, action.clipId, (clip, limits) =>
        clampClipFades(
          applyTrim(clip, action.side, action.edgeSrcMs, {
            ...limits,
            sourceDurationMs: durationOf(clip),
          }),
        ),
      );
      if (!next) return state;
      return pushHistory(state, next);
    }

    case "SET_CLIP_RATE": {
      const next = withGesture(state.clips, action.clipId, (clip, limits) =>
        clampClipFades(applyRate(clip, action.rate, limits)),
      );
      if (!next) return state;
      return pushHistory(state, next);
    }

    case "TOGGLE_CLIP_AUDIO": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      if (!target) return state;
      const next = state.clips.map((clip) =>
        clip.id === action.clipId ? { ...clip, audioEnabled: !clip.audioEnabled } : clip,
      );
      return pushHistory(state, next);
    }

    case "CLOSE_GAPS": {
      const before = sortClips(state.clips);
      const next = closeGaps(state.clips);
      if (next.every((clip, i) => sameBounds(clip, before[i]))) return state;
      return pushHistory(state, next);
    }

    case "UNDO": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ...state,
        clips: previous.clips,
        textOverlays: previous.textOverlays,
        zooms: previous.zooms,
        transientZooms: null,
        ...keepSelection(previous.clips, previous.textOverlays, previous.zooms, state),
        transientClips: null,
        transientTextOverlays: null,
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future],
      };
    }

    case "REDO": {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return {
        ...state,
        clips: next.clips,
        textOverlays: next.textOverlays,
        zooms: next.zooms,
        transientZooms: null,
        ...keepSelection(next.clips, next.textOverlays, next.zooms, state),
        transientClips: null,
        transientTextOverlays: null,
        past: [...state.past, snapshot(state)],
        future: rest,
      };
    }
  }
}
