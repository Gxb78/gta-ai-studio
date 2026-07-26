// État de l'éditeur : clips committés + état transitoire pendant les drags.
// Règle : les interactions continues (trim, déplacement) passent par
// `transientClips` et ne créent AUCUNE entrée d'historique tant qu'elles ne
// sont pas commitées.
//
// Les clips ont une position explicite sur la timeline : ils ne se chevauchent
// jamais, mais ils peuvent être disjoints (« trous »).

import type { Clip, Project, SourceInfo, StoredProject } from "../types";
import {
  MIN_CLIP_MS,
  applyRate,
  applyTrim,
  clipDurationMs,
  clipEndMs,
  clipsOnTrack,
  closeGaps,
  firstFreeTrack,
  migrateProject,
  neighbourLimits,
  resolveOverlaps,
  sortClips,
  timelineTimeToSourceTime,
  topClipAt,
} from "../types";

const HISTORY_LIMIT = 100;

export interface EditorState {
  project: Project | null;
  /** Vérité committée (celle qu'on sauvegarde et exporte). */
  clips: Clip[];
  /** Clips pendant un geste en cours (trim, déplacement), sinon null. */
  transientClips: Clip[] | null;
  selectedClipId: string | null;
  past: Clip[][];
  future: Clip[][];
}

export const initialEditorState: EditorState = {
  project: null,
  clips: [],
  transientClips: null,
  selectedClipId: null,
  past: [],
  future: [],
};

export type EditorAction =
  | { type: "LOAD"; project: StoredProject }
  /** Fichiers dérivés régénérés : on remplace le rush, jamais le montage. */
  | { type: "REFRESH_SOURCE"; source: SourceInfo }
  /** Nouveau rush ajouté au projet : ses clips se posent à la suite. */
  | { type: "ADD_SOURCE"; source: SourceInfo; atMs: number }
  | { type: "CLOSE" }
  | { type: "SELECT"; clipId: string | null }
  | { type: "SPLIT_AT"; timelineMs: number }
  | { type: "DELETE_CLIP"; clipId: string }
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

const pushHistory = (state: EditorState, nextClips: Clip[]): EditorState => ({
  ...state,
  clips: nextClips,
  transientClips: null,
  past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.clips],
  future: [],
});

let clipCounter = 0;
export const newClipId = (): string => {
  clipCounter += 1;
  return `clip-${Date.now().toString(36)}-${clipCounter}`;
};

const sameBounds = (a: Clip, b: Clip): boolean =>
  a.timelineStartMs === b.timelineStartMs && a.srcInMs === b.srcInMs && a.srcOutMs === b.srcOutMs;

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
        project,
        clips: project.clips,
        transientClips: null,
        selectedClipId: null,
        past: [],
        future: [],
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
      const track = firstFreeTrack(state.clips, startMs, endMs, fromTrack);
      const clip: Clip = {
        id: newClipId(),
        sourceId: action.source.id,
        track,
        timelineStartMs: startMs,
        srcInMs: 0,
        srcOutMs: action.source.probe.durationMs,
        // Une surcouche arrive muette : elle ne doit pas couper le son du dessous.
        audioEnabled: track === 0,
        playbackRate: 1,
      };
      return {
        ...pushHistory(state, [...state.clips, clip]),
        project: { ...state.project, sources },
        selectedClipId: clip.id,
      };
    }

    case "CLOSE":
      return initialEditorState;

    case "SELECT":
      return { ...state, selectedClipId: action.clipId };

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
      const left: Clip = { ...clip, srcOutMs: cutSrc };
      const right: Clip = {
        id: newClipId(),
        sourceId: clip.sourceId,
        track: clip.track,
        timelineStartMs: action.timelineMs,
        srcInMs: cutSrc,
        srcOutMs: clip.srcOutMs,
        audioEnabled: clip.audioEnabled,
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

    // Un geste repart toujours des clips COMMITTÉS : appliquer le delta sur l'état
    // transitoire ferait dériver le bord par accumulation d'arrondis.
    case "TRIM_TRANSIENT": {
      const next = withGesture(state.clips, action.clipId, (clip, limits) =>
        applyTrim(clip, action.side, action.edgeSrcMs, { ...limits, sourceDurationMs: durationOf(clip) }),
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
      const track = Math.max(0, Math.floor(action.track));
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
        applyTrim(clip, action.side, action.edgeSrcMs, { ...limits, sourceDurationMs: durationOf(clip) }),
      );
      if (!next) return state;
      return pushHistory(state, next);
    }

    case "SET_CLIP_RATE": {
      const next = withGesture(state.clips, action.clipId, (clip, limits) =>
        applyRate(clip, action.rate, limits),
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
        clips: previous,
        transientClips: null,
        past: state.past.slice(0, -1),
        future: [state.clips, ...state.future],
      };
    }

    case "REDO": {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return {
        ...state,
        clips: next,
        transientClips: null,
        past: [...state.past, state.clips],
        future: rest,
      };
    }
  }
}
