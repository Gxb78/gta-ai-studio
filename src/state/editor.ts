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
} from "../types";
import {
  MIN_CLIP_MS,
  applyRate,
  clampAudioFadeMs,
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
  /** Clips pendant un geste en cours (trim, déplacement), sinon null. */
  transientClips: Clip[] | null;
  selectedClipId: string | null;
  selectedTextOverlayId: string | null;
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
  past: EditSnapshot[];
  future: EditSnapshot[];
}

interface EditSnapshot {
  clips: Clip[];
  textOverlays: TextOverlay[];
}

export const initialEditorState: EditorState = {
  project: null,
  clips: [],
  textOverlays: [],
  transientClips: null,
  selectedClipId: null,
  selectedTextOverlayId: null,
  hiddenTracks: [],
  lockedTracks: [],
  past: [],
  future: [],
};

const clampClipFades = (clip: Clip): Clip => {
  const durationMs = clipDurationMs(clip);
  return {
    ...clip,
    audioFadeInMs: clampAudioFadeMs(clip.audioFadeInMs, durationMs),
    audioFadeOutMs: clampAudioFadeMs(clip.audioFadeOutMs, durationMs),
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
      patch: Partial<Pick<TextOverlay, "text" | "timelineStartMs" | "timelineEndMs" | "x" | "y" | "fontSizePx" | "style">>;
    }
  | { type: "DELETE_TEXT"; textOverlayId: string }
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

// Compacté à CHAQUE commit, jamais sur l'état transitoire : c'est le même
// principe que la borne de piste posée pendant un geste, appliqué une image
// plus tard. Idempotent sur des indices déjà compacts, donc sans coût quand
// il n'y a rien à faire.
const snapshot = (state: EditorState): EditSnapshot => ({
  clips: state.clips,
  textOverlays: state.textOverlays,
});

const pushHistory = (
  state: EditorState,
  nextClips: Clip[],
  nextTextOverlays = state.textOverlays,
): EditorState => {
  const clips = compactTrackIndices(nextClips);
  const durationMs = timelineDurationMs(clips);
  const textOverlays = nextTextOverlays
    .map((overlay) => normalizeTextOverlay(overlay, durationMs))
    .filter((overlay) => overlay.timelineEndMs > overlay.timelineStartMs);
  return {
    ...state,
    clips,
    textOverlays,
    transientClips: null,
    past: [...state.past.slice(-(HISTORY_LIMIT - 1)), snapshot(state)],
    future: [],
  };
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
        next.style === target.style
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
        transientClips: null,
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
        transientClips: null,
        past: [...state.past, snapshot(state)],
        future: rest,
      };
    }
  }
}
