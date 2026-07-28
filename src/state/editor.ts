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
  MIN_TEXT_DURATION_MS,
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
  remapTrackIndices,
  remapTrackKeyedRecord,
  resolveOverlaps,
  resolveSelfOverlap,
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
  /**
   * Id du zoom en cours de geste, sinon null. Porté séparément de
   * `selectedZoomId` : le réducteur ne doit jamais dépendre, pour une garantie
   * qu'il impose lui-même (deux zooms qui ne se chevauchent jamais), de ce
   * que l'appelant a bien fait avant — même si l'UI le fait systématiquement
   * (voir `beginZoomGesture` dans Timeline.tsx).
   */
  transientZoomId: string | null;
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
  /**
   * Par piste dont le bouton son a coupé le son : les clips qui étaient
   * réellement audibles juste avant, pour les seuls réactiver au bouton
   * suivant — les autres, muets par un choix par-clip antérieur à la coupe,
   * doivent le rester. Sans cette mémoire, réactiver le son de la piste
   * réécrivait `audioEnabled: true` pour tous ses clips, y compris ceux qu'on
   * avait volontairement rendus muets un par un.
   *
   * État de SESSION comme `clipboard` : un indice pour le prochain clic, pas
   * une donnée de montage.
   */
  trackAudioMemory: Record<number, string[]>;
  past: EditSnapshot[];
  future: EditSnapshot[];
}

interface EditSnapshot {
  clips: Clip[];
  textOverlays: TextOverlay[];
  zooms: ZoomRegion[];
  /**
   * Sans ça, annuler une relocalisation de rush restaure des clips pointant
   * vers l'ancien id de source alors que seule la source relocalisée existe
   * encore dans le projet : des clips orphelins.
   */
  sources: Record<string, SourceInfo>;
  /**
   * `pushHistory` recale ces trois champs sur les indices de piste à CHAQUE
   * commit (une piste qui perd son dernier clip sort de `hiddenTracks` et
   * `lockedTracks`) : sans les figer ici aussi, annuler restaure les clips
   * mais pas le masquage/verrou/mémoire de coupe son qui allait avec, et une
   * piste verrouillée ressort déverrouillée après un annuler.
   */
  hiddenTracks: number[];
  lockedTracks: number[];
  trackAudioMemory: Record<number, string[]>;
}

export const initialEditorState: EditorState = {
  project: null,
  clips: [],
  textOverlays: [],
  zooms: [],
  transientClips: null,
  transientTextOverlays: null,
  transientZooms: null,
  transientZoomId: null,
  selectedClipId: null,
  selectedTextOverlayId: null,
  selectedZoomId: null,
  hiddenTracks: [],
  lockedTracks: [],
  clipboard: null,
  trackAudioMemory: {},
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
const placeCopy = (
  clips: Clip[],
  origin: Clip,
  atMs: number,
  lockedTracks: readonly number[],
): Clip => {
  const startMs = Math.max(0, atMs);
  const endMs = startMs + clipDurationMs(origin);
  const track = firstFreeTrack(clips, startMs, endMs, origin.track, lockedTracks);
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

/**
 * Vrai si ce clip vit sur une piste verrouillée.
 *
 * Bug réel corrigé : le verrou n'était vérifié qu'à la souris, dans
 * Timeline.tsx, avant même de dispatcher un geste — Suppr, Split, M, I/O, le
 * changement de vitesse et chaque curseur de l'inspecteur ciblaient un clip
 * par id sans jamais consulter `lockedTracks`, donc continuaient d'agir sur un
 * clip déjà sélectionné avant que sa piste soit verrouillée. Chaque action qui
 * cible un clip par id doit vérifier ceci elle-même : la sûreté des données ne
 * doit jamais dépendre de la seule interface.
 */
const clipIsLocked = (state: EditorState, clip: Clip): boolean =>
  state.lockedTracks.includes(clip.track);

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

/**
 * Coupe un clip en deux à `timelineMs`, ou `null` si le point ne laisse pas au
 * moins `MIN_CLIP_MS` de part et d'autre. Partagé par `SPLIT_AT` (une coupe) et
 * `SPLIT_MANY_AT` (plusieurs coupes en une seule entrée d'historique) : les deux
 * doivent produire EXACTEMENT le même clip coupé seul, jamais deux calculs qui
 * pourraient diverger.
 */
const splitClip = (clip: Clip, timelineMs: number): { left: Clip; right: Clip } | null => {
  const offsetMs = timelineMs - clip.timelineStartMs;
  if (offsetMs <= MIN_CLIP_MS || offsetMs >= clipDurationMs(clip) - MIN_CLIP_MS) return null;
  // Le point de coupe dans le RUSH passe par la conversion canonique : avec
  // une vitesse de 2, une seconde de montage vaut deux secondes de rush.
  const cutSrc = timelineTimeToSourceTime(clip, timelineMs);
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
    timelineStartMs: timelineMs,
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
  return { left, right };
};

/**
 * Coupe un titre en deux à `timelineMs`, ou `null` si le point ne laisse pas
 * au moins `MIN_TEXT_DURATION_MS` de part et d'autre. Les fondus du nouveau
 * bord sont remis à zéro comme pour un clip : `pushHistory` reclampe ensuite
 * les fondus restants sur la durée propre de chaque moitié (`normalizeTextOverlay`).
 */
const splitTextOverlay = (
  overlay: TextOverlay,
  timelineMs: number,
): { left: TextOverlay; right: TextOverlay } | null => {
  const offsetMs = timelineMs - overlay.timelineStartMs;
  const durationMs = overlay.timelineEndMs - overlay.timelineStartMs;
  if (offsetMs <= MIN_TEXT_DURATION_MS || offsetMs >= durationMs - MIN_TEXT_DURATION_MS) return null;
  const left: TextOverlay = { ...overlay, timelineEndMs: timelineMs, fadeOutMs: 0 };
  const right: TextOverlay = {
    ...overlay,
    id: newTextOverlayId(),
    timelineStartMs: timelineMs,
    fadeInMs: 0,
  };
  return { left, right };
};

/**
 * Coupe un zoom en deux à `timelineMs`, ou `null` si le point ne laisse pas au
 * moins `MIN_ZOOM_DURATION_MS` de part et d'autre. Même remise à zéro des
 * rampes du nouveau bord, reclampées ensuite par `pushHistory`
 * (`clampZoomsToDuration` → `normalizeZoomRegion`).
 */
const splitZoomRegion = (
  zoom: ZoomRegion,
  timelineMs: number,
): { left: ZoomRegion; right: ZoomRegion } | null => {
  const offsetMs = timelineMs - zoom.timelineStartMs;
  const durationMs = zoom.timelineEndMs - zoom.timelineStartMs;
  if (offsetMs <= MIN_ZOOM_DURATION_MS || offsetMs >= durationMs - MIN_ZOOM_DURATION_MS) return null;
  const left: ZoomRegion = { ...zoom, timelineEndMs: timelineMs, rampOutMs: 0 };
  const right: ZoomRegion = {
    ...zoom,
    id: newZoomId(),
    timelineStartMs: timelineMs,
    rampInMs: 0,
  };
  return { left, right };
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
      patch: Partial<
        Pick<
          ZoomRegion,
          | "timelineStartMs"
          | "timelineEndMs"
          | "scale"
          | "x"
          | "y"
          | "rampInMs"
          | "rampOutMs"
          | "direction"
          | "easing"
        >
      >;
    }
  | { type: "DELETE_ZOOM"; zoomId: string }
  | { type: "SPLIT_AT"; timelineMs: number }
  /**
   * Coupe plusieurs éléments à LA MÊME position, en une seule entrée
   * d'historique : c'est le menu contextuel « Couper ici et étendre » qui
   * pose cette action, avec les identifiants cochés par l'utilisateur. Un
   * identifiant absent, verrouillé ou trop près d'un bord est ignoré en
   * silence plutôt que de faire échouer les autres coupes.
   */
  | {
      type: "SPLIT_MANY_AT";
      timelineMs: number;
      clipIds: string[];
      textOverlayIds: string[];
      zoomIds: string[];
    }
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
  sources: state.project?.sources ?? {},
  hiddenTracks: state.hiddenTracks,
  lockedTracks: state.lockedTracks,
  trackAudioMemory: state.trackAudioMemory,
});

/**
 * Recale chaque zoom dans la durée courante, SANS repositionner personne par
 * rapport à un autre.
 *
 * C'est le mode utilisé quand ce n'est PAS un zoom qui vient d'être touché —
 * une découpe ou une suppression de clip, par exemple, qui ne fait que
 * raccourcir `durationMs`. Les zooms entre eux étaient déjà valides ; il n'y a
 * qu'un plafond à faire respecter à chacun, indépendamment. Un zoom qui déborde
 * désormais la fin du montage est raccourci ; s'il n'a plus la place minimale,
 * il disparaît — mais SEUL lui, jamais un voisin resté parfaitement valide.
 */
const clampZoomsToDuration = (zooms: ZoomRegion[], durationMs: number): ZoomRegion[] =>
  zooms
    .map((zoom) => normalizeZoomRegion(zoom, durationMs))
    .filter((zoom) => zoom.timelineEndMs - zoom.timelineStartMs >= MIN_ZOOM_DURATION_MS);

/**
 * Repose les zooms autour de `priorityId`, qui garde EXACTEMENT la position et
 * la durée demandées — jamais tronqué, jamais supprimé tant qu'il tient dans
 * le montage. Un zoom qui se termine avant lui ne bouge pas. Tout zoom qui le
 * chevauche est repoussé juste après, en cascade — même principe que
 * `resolveOverlaps` pour les clips : c'est TOUJOURS celui que l'utilisateur
 * vient de manipuler qui gagne intact, ce sont les AUTRES qui cèdent la place,
 * en conservant leur propre durée. S'il ne reste plus de place jusqu'à la fin
 * du montage, un zoom repoussé disparaît — lui, et lui seul.
 *
 * Impose au passage que deux zooms ne se chevauchent jamais : c'est ce qui
 * permet à la lecture comme à l'export de n'en retenir qu'UN à un instant
 * donné, sans avoir à composer deux agrandissements — et donc de garder une
 * seule expression FFmpeg.
 *
 * Bug réel corrigé : l'ancienne version triait TOUS les zooms par position et
 * cascadait aveuglément de gauche à droite, sans aucune idée de lequel venait
 * d'être touché — celui qui commençait le plus tôt gagnait toujours, entier,
 * quel qu'il soit.
 *   - Ajouter un zoom AVANT un zoom existant supprimait ce dernier : le
 *     nouveau, trié en premier, poussait le cursor au-delà de la fin de
 *     l'ancien, qui tombait alors sous la durée minimale et disparaissait.
 *   - Modifier un zoom pouvait raccourcir ou supprimer son voisin, pour la
 *     même raison, dès que le voisin se retrouvait trié après lui.
 *   - Déplacer un zoom en arrière, par-dessus un zoom antérieur, le faisait
 *     LUI-MÊME tronquer par ce qui le précédait — une simple translation
 *     devenait un rognage du bord de tête.
 *   - Le zoom ainsi supprimé pouvait rester sélectionné par un id fantôme,
 *     `selectedZoomId` n'étant jamais revérifié après coup (voir
 *     `keepSelection`, maintenant utilisé pour ADD_ZOOM/UPDATE_ZOOM/
 *     ZOOM_GESTURE_COMMIT plutôt qu'une réaffectation aveugle).
 */
const resolveZoomOverlaps = (
  zooms: ZoomRegion[],
  durationMs: number,
  priorityId: string,
): ZoomRegion[] => {
  const priority = zooms.find((zoom) => zoom.id === priorityId);
  if (!priority) return clampZoomsToDuration(zooms, durationMs);
  const placedPriority = normalizeZoomRegion(priority, durationMs);
  const kept: ZoomRegion[] = [placedPriority];
  let cursor = placedPriority.timelineEndMs;
  const others = zooms
    .filter((zoom) => zoom.id !== priority.id)
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  for (const zoom of others) {
    if (zoom.timelineEndMs <= placedPriority.timelineStartMs) {
      // Se termine avant le zoom prioritaire : hors de son chemin, ne bouge pas.
      const untouched = normalizeZoomRegion(zoom, durationMs);
      if (untouched.timelineEndMs - untouched.timelineStartMs >= MIN_ZOOM_DURATION_MS) {
        kept.push(untouched);
      }
      continue;
    }
    // Repoussé juste après le curseur, EN GARDANT sa propre durée demandée —
    // jamais raccourci pour la seule raison qu'il chevauchait quelqu'un.
    const wantedDurationMs = zoom.timelineEndMs - zoom.timelineStartMs;
    const startMs = Math.max(zoom.timelineStartMs, cursor);
    const endMs = Math.min(durationMs, startMs + wantedDurationMs);
    if (endMs - startMs < MIN_ZOOM_DURATION_MS) continue;
    const placed = normalizeZoomRegion(
      { ...zoom, timelineStartMs: startMs, timelineEndMs: endMs },
      durationMs,
    );
    kept.push(placed);
    cursor = placed.timelineEndMs;
  }
  return kept.sort((a, b) => a.timelineStartMs - b.timelineStartMs);
};

const pushHistory = (
  state: EditorState,
  nextClips: Clip[],
  nextTextOverlays = state.textOverlays,
  nextZooms = state.zooms,
  // Zoom qui vient d'être ajouté/modifié/déplacé, à protéger intact — null
  // pour tout ce qui ne touche pas aux zooms (les zooms sont alors seulement
  // recalés dans la durée courante, jamais repositionnés entre eux).
  zoomPriorityId: string | null = null,
): EditorState => {
  const clips = compactTrackIndices(nextClips);
  const durationMs = timelineDurationMs(clips);
  const textOverlays = nextTextOverlays
    .map((overlay) => normalizeTextOverlay(overlay, durationMs))
    .filter((overlay) => overlay.timelineEndMs > overlay.timelineStartMs);
  const zooms = zoomPriorityId
    ? resolveZoomOverlaps(nextZooms, durationMs, zoomPriorityId)
    : clampZoomsToDuration(nextZooms, durationMs);
  return {
    ...state,
    clips,
    textOverlays,
    zooms,
    // Recalés sur le même décalage que les clips, sinon un masquage, un
    // verrou ou une mémoire de coupe son reste sur un numéro de piste que la
    // compaction vient de libérer.
    hiddenTracks: remapTrackIndices(state.hiddenTracks, nextClips),
    lockedTracks: remapTrackIndices(state.lockedTracks, nextClips),
    trackAudioMemory: remapTrackKeyedRecord(state.trackAudioMemory, nextClips),
    transientClips: null,
    transientTextOverlays: null,
    transientZooms: null,
    transientZoomId: null,
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

/**
 * Applique un geste sur un clip et renvoie la liste complète, ou null si rien
 * ne change — y compris si le clip vit sur une piste verrouillée.
 *
 * Bug réel corrigé : ce garde-fou n'existait qu'à la souris (`Timeline.tsx`
 * vérifiait `lockedTracks` avant même de dispatcher un geste). Rien n'empêchait
 * TRIM_EDGE (I/O clavier) ni SET_CLIP_RATE d'agir sur un clip déjà sélectionné
 * avant que sa piste soit verrouillée — le réducteur ne connaissait tout
 * simplement pas la notion de verrou. La sûreté des données ne doit jamais
 * reposer sur la seule interface.
 */
function withGesture(
  clips: Clip[],
  clipId: string,
  lockedTracks: readonly number[],
  transform: (clip: Clip, limits: { minStartMs: number; maxEndMs: number }) => Clip,
): Clip[] | null {
  const target = clips.find((clip) => clip.id === clipId);
  if (!target || lockedTracks.includes(target.track)) return null;
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
      // Une piste verrouillée n'accepte rien, même déposée explicitement à la
      // souris : on retombe sur le placement automatique plutôt que de garer
      // le clip dessus (ou pire, d'en écarter les clips déjà présents).
      const requestedTrack =
        action.track !== undefined ? Math.max(0, Math.floor(action.track)) : undefined;
      const track =
        requestedTrack !== undefined && !state.lockedTracks.includes(requestedTrack)
          ? requestedTrack
          : firstFreeTrack(state.clips, startMs, endMs, fromTrack, state.lockedTracks);
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
      // Si la piste demandée était verrouillée, `track` vient de l'auto-placement
      // (piste déjà libre) : pas de repoussée à faire dans ce cas.
      const next =
        requestedTrack === undefined || requestedTrack !== track
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
      const relink = (clip: Clip): Clip =>
        clampClipFades({
          ...clip,
          sourceId: action.source.id,
          srcInMs: Math.min(clip.srcInMs, Math.max(0, limit - MIN_CLIP_MS)),
          srcOutMs: Math.min(clip.srcOutMs, limit),
        });
      const clips = state.clips.map((clip) => (clip.sourceId === action.missingId ? relink(clip) : clip));
      // Le presse-papiers pointe vers un clip copié avant la relocalisation :
      // sans ce recalage, un collage après coup fait un clip orphelin, comme
      // le ferait un Undo sans l'historique des sources.
      const clipboard =
        state.clipboard && state.clipboard.sourceId === action.missingId
          ? relink(state.clipboard)
          : state.clipboard;
      return { ...pushHistory(state, clips), project: { ...state.project, sources }, clipboard };
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
      if (!target || clipIsLocked(state, target) || target.cropX === cropX) return state;
      const clips = state.clips.map((clip) =>
        clip.id === action.clipId ? { ...clip, cropX } : clip,
      );
      return pushHistory(state, clips);
    }

    case "SET_CLIP_VOLUME": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      const volume = clampVolume(action.volume);
      if (!target || clipIsLocked(state, target) || target.volume === volume) return state;
      return pushHistory(
        state,
        state.clips.map((clip) =>
          clip.id === action.clipId ? { ...clip, volume } : clip,
        ),
      );
    }

    case "SET_CLIP_AUDIO_FADE": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      if (!target || clipIsLocked(state, target)) return state;
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
      if (!target || clipIsLocked(state, target)) return state;
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
      if (!target || clipIsLocked(state, target)) return state;
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
      if (state.lockedTracks.includes(action.track)) return state;
      const concerned = state.clips.filter((clip) => clip.track === action.track);
      if (concerned.every((clip) => clip.audioEnabled === action.audioEnabled)) return state;
      let trackAudioMemory = state.trackAudioMemory;
      let clips: Clip[];
      if (!action.audioEnabled) {
        // Coupe : on retient qui était RÉELLEMENT audible avant, pour ne
        // réactiver que ceux-là si la piste redevient sonore.
        const audibleIds = concerned.filter((clip) => clip.audioEnabled).map((clip) => clip.id);
        trackAudioMemory = { ...trackAudioMemory, [action.track]: audibleIds };
        clips = state.clips.map((clip) =>
          clip.track === action.track ? { ...clip, audioEnabled: false } : clip,
        );
      } else {
        // Réactivation : seuls les clips de la mémoire retrouvent leur son.
        // Sans mémoire (piste déjà muette au chargement, jamais coupée cette
        // session), on retombe sur l'ancien comportement : tout réactiver.
        const remembered = new Set(
          trackAudioMemory[action.track] ?? concerned.map((clip) => clip.id),
        );
        clips = state.clips.map((clip) =>
          clip.track === action.track
            ? { ...clip, audioEnabled: remembered.has(clip.id) }
            : clip,
        );
        const { [action.track]: _forgotten, ...rest } = trackAudioMemory;
        trackAudioMemory = rest;
      }
      return { ...pushHistory(state, clips), trackAudioMemory };
    }

    case "CLOSE":
      return initialEditorState;

    // Les trois sélections (clip, titre, zoom) sont MUTUELLEMENT EXCLUSIVES :
    // un seul inspecteur peut être affiché à la fois (voir App.tsx), donc un
    // seul type sélectionné à la fois, sinon un raccourci comme Suppr agit sur
    // une sélection différente de celle que l'utilisateur voit à l'écran. Bug
    // réel : SELECT_ZOOM ne vidait pas selectedClipId, donc sélectionner un
    // zoom laissait un clip « sélectionné » en silence — Suppr le supprimait
    // à la place du zoom visiblement affiché dans l'inspecteur.
    case "SELECT":
      return {
        ...state,
        selectedClipId: action.clipId,
        selectedTextOverlayId: null,
        selectedZoomId: null,
      };

    case "SELECT_TEXT":
      return {
        ...state,
        selectedClipId: null,
        selectedTextOverlayId: action.textOverlayId,
        selectedZoomId: null,
      };

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
        transientZoomId: target.id,
      };
    }

    case "ZOOM_GESTURE_COMMIT": {
      if (!state.transientZooms) return state;
      // Porté par le geste lui-même (`transientZoomId`), pas déduit de
      // `selectedZoomId` : une garantie que le réducteur impose (deux zooms ne
      // se chevauchent jamais) ne doit jamais dépendre de ce que l'appelant a
      // pris soin de faire avant, même si l'UI le fait systématiquement.
      const next = pushHistory(
        state,
        state.clips,
        state.textOverlays,
        state.transientZooms,
        state.transientZoomId,
      );
      return { ...next, ...keepSelection(next.clips, next.textOverlays, next.zooms, state) };
    }

    case "ZOOM_GESTURE_CANCEL":
      return state.transientZooms
        ? { ...state, transientZooms: null, transientZoomId: null }
        : state;

    case "SELECT_ZOOM":
      return {
        ...state,
        selectedClipId: null,
        selectedTextOverlayId: null,
        selectedZoomId: action.zoomId,
      };

    case "ADD_ZOOM": {
      const durationMs = timelineDurationMs(state.clips);
      if (durationMs < MIN_ZOOM_DURATION_MS) return state;
      // Le zoom se pose au playhead, sur la première fenêtre libre : le poser
      // par-dessus un zoom existant le ferait disparaître au passage par
      // `resolveZoomOverlaps`, sans que l'utilisateur comprenne pourquoi.
      const wantedMs = Math.max(0, Math.min(durationMs - MIN_ZOOM_DURATION_MS, action.atMs));
      // Cette passe ne saute correctement par-dessus une CHAÎNE de zooms
      // adjacents que si elle les rencontre dans l'ordre chronologique. Tout
      // commit passe par `resolveZoomOverlaps`/`clampZoomsToDuration`, qui
      // trient déjà — mais un projet chargé depuis un fichier (migré sans tri,
      // voir `migrateProject`) peut arriver ici avant le premier commit.
      const chronological = [...state.zooms].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
      const startMs = chronological.reduce(
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
          direction: "in",
          easing: "linear",
        },
        durationMs,
      );
      return {
        ...pushHistory(state, state.clips, state.textOverlays, [...state.zooms, zoom], zoom.id),
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
      const next = pushHistory(state, state.clips, state.textOverlays, zooms, action.zoomId);
      // Ne jamais réaffecter l'ancien `selectedZoomId` en aveugle : c'est
      // exactement ça qui laissait un id fantôme sélectionné quand le zoom visé
      // avait disparu au passage par la résolution des chevauchements.
      return { ...next, ...keepSelection(next.clips, next.textOverlays, next.zooms, state) };
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
      if (clipIsLocked(state, clip)) return state;
      const halves = splitClip(clip, action.timelineMs);
      if (!halves) return state;
      const next = state.clips.map((c) => (c.id === clip.id ? halves.left : c));
      next.push(halves.right);
      return { ...pushHistory(state, next), selectedClipId: halves.right.id };
    }

    case "SPLIT_MANY_AT": {
      let nextClips = state.clips;
      let selectedClipId = state.selectedClipId;
      for (const clipId of action.clipIds) {
        const clip = nextClips.find((c) => c.id === clipId);
        if (!clip || clipIsLocked(state, clip)) continue;
        const halves = splitClip(clip, action.timelineMs);
        if (!halves) continue;
        nextClips = [
          ...nextClips.map((c) => (c.id === clip.id ? halves.left : c)),
          halves.right,
        ];
        selectedClipId = halves.right.id;
      }

      let nextTextOverlays = state.textOverlays;
      for (const textOverlayId of action.textOverlayIds) {
        const overlay = nextTextOverlays.find((o) => o.id === textOverlayId);
        if (!overlay) continue;
        const halves = splitTextOverlay(overlay, action.timelineMs);
        if (!halves) continue;
        nextTextOverlays = [
          ...nextTextOverlays.map((o) => (o.id === overlay.id ? halves.left : o)),
          halves.right,
        ];
      }

      let nextZooms = state.zooms;
      for (const zoomId of action.zoomIds) {
        const zoom = nextZooms.find((z) => z.id === zoomId);
        if (!zoom) continue;
        const halves = splitZoomRegion(zoom, action.timelineMs);
        if (!halves) continue;
        nextZooms = [
          ...nextZooms.map((z) => (z.id === zoom.id ? halves.left : z)),
          halves.right,
        ];
      }

      // Aucun des éléments cochés n'a pu être coupé (bord trop proche,
      // identifiant disparu entre l'ouverture du menu et le clic) : pas
      // d'entrée d'historique pour une action qui n'a rien changé.
      if (
        nextClips === state.clips &&
        nextTextOverlays === state.textOverlays &&
        nextZooms === state.zooms
      ) {
        return state;
      }
      return {
        ...pushHistory(state, nextClips, nextTextOverlays, nextZooms),
        selectedClipId,
      };
    }

    case "DELETE_CLIP": {
      if (state.clips.length <= 1) return state; // toujours garder au moins un clip
      const target = state.clips.find((c) => c.id === action.clipId);
      if (!target || clipIsLocked(state, target)) return state;
      // Index dans l'ordre CHRONOLOGIQUE, pas dans `state.clips` (ordre
      // d'insertion) : un clip issu d'un split ou d'un collage est ajouté en
      // fin de tableau même si sa place sur la timeline est plus tôt, ce qui
      // faisait retomber la sélection de repli sur un clip sans rapport.
      const index = sortClips(state.clips).findIndex((c) => c.id === action.clipId);
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
      const copy = placeCopy(state.clips, clip, clipEndMs(clip), state.lockedTracks);
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
      if (!clip || clipIsLocked(state, clip)) return state;
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
      const copy = placeCopy(state.clips, state.clipboard, Math.max(0, action.atMs), state.lockedTracks);
      return {
        ...pushHistory(state, resolveOverlaps([...state.clips, copy], copy.id)),
        selectedClipId: copy.id,
      };
    }

    // Un geste repart toujours des clips COMMITTÉS : appliquer le delta sur l'état
    // transitoire ferait dériver le bord par accumulation d'arrondis.
    case "TRIM_TRANSIENT": {
      const next = withGesture(state.clips, action.clipId, state.lockedTracks, (clip, limits) =>
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

    // Le clip suit le curseur SEUL : ses voisins ne bougent jamais pendant le
    // geste, même chevauchés — les voir sauter au moment où on les effleure
    // n'informe de rien, ça surprend. Un chevauchement à l'arrivée se résout
    // au relâchement (voir GESTURE_COMMIT), en ne recollant que ce clip-ci.
    case "MOVE_TRANSIENT": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      // Le clip lui-même ne doit pas bouger si SA propre piste est verrouillée
      // — pas seulement la piste de destination, déjà vérifiée plus bas.
      // Timeline.tsx bloque déjà ce geste avant même de le dispatcher, mais le
      // réducteur doit imposer la même borne indépendamment de l'interface.
      if (!target || state.lockedTracks.includes(target.track)) return state;
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
      // La transition décrit une jonction précise avec le clip qui précède :
      // un déplacement change ce voisin (ou le rompt), donc comme lors d'une
      // copie, elle ne doit pas se retrouver héritée par la jonction suivante.
      const moved = { ...target, timelineStartMs, track, transitionInMs: 0 };
      if (track === target.track && sameBounds(moved, target)) {
        return state.transientClips ? { ...state, transientClips: null } : state;
      }
      const next = state.clips.map((clip) => (clip.id === action.clipId ? moved : clip));
      return { ...state, transientClips: next };
    }

    case "GESTURE_COMMIT": {
      if (!state.transientClips) return state;
      // Le geste transitoire ne touche jamais qu'UN clip (voir MOVE_TRANSIENT
      // / TRIM_TRANSIENT). Si un déplacement l'a laissé chevaucher un voisin,
      // c'est LUI qu'on recolle au relâchement — jamais le voisin.
      const changed = state.transientClips.find((clip) => {
        const before = state.clips.find((c) => c.id === clip.id);
        return !before || clip.track !== before.track || !sameBounds(clip, before);
      });
      const resolved = changed
        ? resolveSelfOverlap(state.transientClips, changed.id)
        : state.transientClips;
      return pushHistory(state, resolved);
    }

    case "GESTURE_CANCEL":
      return { ...state, transientClips: null };

    case "TRIM_EDGE": {
      const next = withGesture(state.clips, action.clipId, state.lockedTracks, (clip, limits) =>
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
      const next = withGesture(state.clips, action.clipId, state.lockedTracks, (clip, limits) =>
        clampClipFades(applyRate(clip, action.rate, limits)),
      );
      if (!next) return state;
      return pushHistory(state, next);
    }

    case "TOGGLE_CLIP_AUDIO": {
      const target = state.clips.find((clip) => clip.id === action.clipId);
      if (!target || clipIsLocked(state, target)) return state;
      const next = state.clips.map((clip) =>
        clip.id === action.clipId ? { ...clip, audioEnabled: !clip.audioEnabled } : clip,
      );
      return pushHistory(state, next);
    }

    case "CLOSE_GAPS": {
      // closeGaps ne recolle que la piste principale (0) : verrouillée, rien
      // ne doit bouger, comme pour tout autre geste sur une piste verrouillée.
      if (state.lockedTracks.includes(0)) return state;
      const before = sortClips(state.clips);
      // Une piste masquée ne recouvre rien à l'écran : un trou de la piste
      // principale qu'elle seule couvrirait reste un vrai trou aplati.
      const next = closeGaps(state.clips, new Set(state.hiddenTracks));
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
        project: state.project ? { ...state.project, sources: previous.sources } : state.project,
        hiddenTracks: previous.hiddenTracks,
        lockedTracks: previous.lockedTracks,
        trackAudioMemory: previous.trackAudioMemory,
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
        project: state.project ? { ...state.project, sources: next.sources } : state.project,
        hiddenTracks: next.hiddenTracks,
        lockedTracks: next.lockedTracks,
        trackAudioMemory: next.trackAudioMemory,
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
