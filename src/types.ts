// Types partagés de l'éditeur. Toutes les durées sont en millisecondes.

export interface ProbeInfo {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
}

export interface SourceInfo {
  /** Empreinte rapide du fichier source (clé de cache locale). */
  id: string;
  /** Rush d'origine — jamais modifié par l'application. */
  originalPath: string;
  /** Proxy 720p à GOP courtes : c'est lui qu'on lit et qu'on scrubbe. */
  proxyPath: string;
  /** Vignettes du rush, une toutes les `thumbIntervalMs`. */
  thumbPaths: string[];
  thumbIntervalMs: number;
  /** Image de la forme d'onde du rush complet (null si pas d'audio). */
  waveformPath: string | null;
  /** Version des fichiers dérivés sur disque (voir ASSET_VERSION). */
  assetVersion: number;
  probe: ProbeInfo;
}

/**
 * Version attendue des vignettes et de la waveform. Doit rester alignée sur
 * ASSET_VERSION dans src-tauri/src/media.rs : en dessous, les fichiers dérivés
 * du disque sont périmés et l'application les régénère.
 */
export const ASSET_VERSION = 4;

/** Ratio largeur/hauteur du rush, borné contre des métadonnées aberrantes. */
export const sourceAspect = (probe: ProbeInfo): number => {
  const ratio = probe.height > 0 ? probe.width / probe.height : 16 / 9;
  return Math.min(Math.max(ratio, 0.5), 3);
};

/**
 * Un clip = un segment virtuel du rush, posé à une position explicite sur la
 * timeline. Rien n'est réencodé avant l'export.
 *
 * Positions libres : deux clips ne se chevauchent jamais, mais ils peuvent être
 * disjoints. Un intervalle vide est un « trou », rendu noir à la lecture comme
 * à l'export.
 */
export interface Clip {
  id: string;
  /** Rush dont ce clip est extrait (clé dans `Project.sources`). */
  sourceId: string;
  /**
   * Décalage horizontal du cadrage 9:16, de −1 (bord gauche du rush) à +1 (bord
   * droit), 0 = centré. N'a d'effet qu'en cadrage « recadrage » : le fond flou
   * conserve l'image entière, il n'y a rien à décaler.
   */
  cropX: number;
  /**
   * Piste vidéo. 0 = piste principale, en bas. Plus l'indice est élevé, plus la
   * piste est haute et prioritaire visuellement.
   */
  track: number;
  /** Début du clip sur la timeline. */
  timelineStartMs: number;
  srcInMs: number;
  srcOutMs: number;
  /**
   * Le son de ce clip participe-t-il au montage ?
   *
   * Par défaut vrai sur la piste principale et faux sur les surcouches : poser
   * un plan de coupe ne doit pas couper le son de ce qui se joue en dessous.
   */
  audioEnabled: boolean;
  /**
   * Vitesse de lecture constante. 1 = temps réel, 2 = deux fois plus rapide.
   *
   * `srcInMs`/`srcOutMs` restent exprimés dans le temps du RUSH ; la vitesse ne
   * change que la durée occupée sur la timeline.
   */
  playbackRate: number;
}

/** Bornes de vitesse. Au-delà, le décodage et `atempo` deviennent hasardeux. */
export const MIN_RATE = 0.25;
export const MAX_RATE = 4;

export const clampRate = (rate: number): number =>
  Number.isFinite(rate) && rate > 0 ? Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) : 1;

/**
 * Passage du rush au format vertical. C'est un réglage du PROJET, pas de la
 * fenêtre d'export : l'aperçu affiche exactement ce que l'export produira, donc
 * les deux doivent lire la même valeur.
 */
export type FramingMode = "crop" | "blur";

/** Format de sortie, imposé : c'est le format TikTok/Reels/Shorts. */
export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;

export const clampCropX = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;

/**
 * Position du cadrage exprimée en pourcentage, telle que l'attend
 * `object-position` dans l'aperçu. −1 → 0 % (bord gauche), +1 → 100 %.
 */
export const cropXPercent = (cropX: number): number => 50 + clampCropX(cropX) * 50;

/**
 * Conversion canonique temps timeline → temps source.
 *
 * TOUT ce qui doit savoir « quelle image du rush à cet instant du montage »
 * passe par ici : lecture, aplatissement, découpe, export. Dupliquer ce calcul
 * ailleurs, c'est garantir une divergence entre l'aperçu et le rendu final.
 */
export const timelineTimeToSourceTime = (clip: Clip, timelineMs: number): number =>
  clip.srcInMs + (timelineMs - clip.timelineStartMs) * clip.playbackRate;

/** Durée du morceau de rush consommé, indépendamment de la vitesse. */
export const clipSourceDurationMs = (clip: Clip): number => clip.srcOutMs - clip.srcInMs;

/** Nombre de pistes à afficher : la plus haute occupée, plus une vide au-dessus. */
export const trackCount = (clips: Clip[]): number =>
  clips.reduce((max, clip) => Math.max(max, clip.track + 1), 1);

/** Clips d'une piste donnée. Les règles de non-chevauchement s'appliquent PAR piste. */
export const clipsOnTrack = (clips: Clip[], track: number): Clip[] =>
  clips.filter((clip) => clip.track === track);

/**
 * Aplatit les pistes en un montage lisible et exportable.
 *
 * À chaque instant, l'image visible est celle du clip de la piste la plus haute
 * qui couvre cet instant ; quand ce clip se termine, on retombe automatiquement
 * sur la piste active en dessous. Le résultat est une liste de segments qui ne
 * se chevauchent jamais — exactement ce que consomment déjà le lecteur et
 * l'export, qui n'ont donc pas à connaître la notion de piste.
 */
export function flattenTracks(
  clips: Clip[],
  hiddenTracks?: ReadonlySet<number>,
  keep?: (clip: Clip) => boolean,
): Clip[] {
  let visible = hiddenTracks ? clips.filter((clip) => !hiddenTracks.has(clip.track)) : clips;
  if (keep) visible = visible.filter(keep);
  if (visible.length === 0) return [];

  const edges = new Set<number>();
  for (const clip of visible) {
    edges.add(clip.timelineStartMs);
    edges.add(clipEndMs(clip));
  }
  const points = [...edges].sort((a, b) => a - b);

  const flat: Clip[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (to - from <= GAP_EPSILON_MS) continue;

    let top: Clip | null = null;
    for (const clip of visible) {
      if (clip.timelineStartMs <= from && clipEndMs(clip) >= to) {
        if (!top || clip.track > top.track) top = clip;
      }
    }
    if (!top) continue;

    // Les bornes source passent par la conversion canonique : avec une vitesse
    // différente de 1, un décalage de timeline ne vaut pas le même décalage de rush.
    const segment: Clip = {
      id: `${top.id}@${Math.round(from)}`,
      sourceId: top.sourceId,
      cropX: top.cropX,
      track: top.track,
      timelineStartMs: from,
      srcInMs: timelineTimeToSourceTime(top, from),
      srcOutMs: timelineTimeToSourceTime(top, to),
      audioEnabled: top.audioEnabled,
      playbackRate: top.playbackRate,
    };

    // Deux tronçons consécutifs du même rush qui se suivent aussi dans le temps
    // source ne forment qu'un seul segment : inutile de couper pour rien.
    const previous = flat[flat.length - 1];
    if (
      previous &&
      previous.sourceId === segment.sourceId &&
      previous.playbackRate === segment.playbackRate &&
      // Deux cadrages différents doivent rester deux segments : ils ne
      // produisent pas la même image à l'export.
      previous.cropX === segment.cropX &&
      Math.abs(clipEndMs(previous) - segment.timelineStartMs) < 0.001 &&
      Math.abs(previous.srcOutMs - segment.srcInMs) < 0.001
    ) {
      previous.srcOutMs = segment.srcOutMs;
    } else {
      flat.push(segment);
    }
  }
  return flat;
}

export interface Project {
  version: 4;
  id: string;
  name: string;
  /** Rushs du projet, indexés par leur empreinte. */
  sources: Record<string, SourceInfo>;
  clips: Clip[];
  /** Passage au format vertical, partagé par l'aperçu et l'export. */
  framing: FramingMode;
  createdAt: string;
  updatedAt: string;
}

/** Fiche d'un projet enregistré, telle qu'affichée dans « Projets récents ». */
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  clipCount: number;
  /** Vignette du premier rush, si elle est encore sur le disque. */
  thumbPath: string | null;
}

/** Rush d'un clip. Ne doit jamais manquer : la migration garantit la cohérence. */
export const clipSource = (sources: Record<string, SourceInfo>, clip: Clip): SourceInfo | null =>
  sources[clip.sourceId] ?? null;

/** Rushs réellement utilisés par au moins un clip, dans l'ordre d'apparition. */
export function usedSources(sources: Record<string, SourceInfo>, clips: Clip[]): SourceInfo[] {
  const seen = new Set<string>();
  const list: SourceInfo[] = [];
  for (const clip of sortClips(clips)) {
    const source = sources[clip.sourceId];
    if (source && !seen.has(source.id)) {
      seen.add(source.id);
      list.push(source);
    }
  }
  return list;
}

export interface ExportSource {
  path: string;
  hasAudio: boolean;
}

export interface ExportSegment {
  /** Index dans `ExportRequest.sources`. */
  sourceIndex: number;
  srcInMs: number;
  srcOutMs: number;
  /** Vitesse constante appliquée au segment. */
  playbackRate: number;
  /** Durée de noir à insérer avant ce segment (trou de la timeline). */
  gapBeforeMs: number;
  /** Décalage du cadrage 9:16 de ce segment (voir `Clip.cropX`). */
  cropX: number;
}

export interface ExportRequest {
  sources: ExportSource[];
  /** Plan vidéo : ce qui se voit. */
  segments: ExportSegment[];
  /** Plan audio : ce qui s'entend. Indépendant du plan vidéo. */
  audioSegments: ExportSegment[];
  mode: FramingMode;
  fileName: string;
  /** Vrai si au moins un rush a du son : les autres reçoivent du silence. */
  hasAudio: boolean;
  /** Cadence de sortie. La définition, elle, est imposée (1080×1920). */
  frameFps: number;
}

export interface ImportProgress {
  stage: "hash" | "probe" | "proxy" | "thumbs" | "waveform" | "done";
  percent: number;
}

export interface ExportProgress {
  percent: number;
  done: boolean;
  outputPath: string | null;
}

/** Durée minimale d'un clip (≈ 2 images à 30 i/s). */
export const MIN_CLIP_MS = 66;

/** En dessous, un intervalle entre deux clips est un artefact d'arrondi, pas un trou. */
export const GAP_EPSILON_MS = 1;

/**
 * Durée occupée sur la TIMELINE. C'est le sens attendu partout : positions,
 * chevauchements, trous, largeur à l'écran. Avec une vitesse de 2, un clip de
 * 10 s de rush n'occupe que 5 s de montage.
 */
export const clipDurationMs = (clip: Clip): number =>
  (clip.srcOutMs - clip.srcInMs) / clip.playbackRate;

export const clipEndMs = (clip: Clip): number => clip.timelineStartMs + clipDurationMs(clip);

/** Copie triée par position. L'ordre de stockage n'a aucune signification. */
export const sortClips = (clips: Clip[]): Clip[] =>
  [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);

export const timelineDurationMs = (clips: Clip[]): number =>
  clips.reduce((max, clip) => Math.max(max, clipEndMs(clip)), 0);

/** Durée d'une image, en ms. */
export const frameMs = (fps: number): number => 1000 / (fps > 0 ? fps : 30);

/** Cale un temps sur la grille d'images : indispensable pour un trim net. */
export const quantizeToFrame = (ms: number, fps: number): number => {
  const step = frameMs(fps);
  return Math.round(ms / step) * step;
};

export interface TimelinePosition {
  /** Index dans la liste TRIÉE passée en argument. */
  clipIndex: number;
  /** Décalage dans le clip, en ms. */
  offsetMs: number;
}

/** Clip couvrant `timelineMs`, ou null si le playhead est dans un trou. */
export function clipAt(sorted: Clip[], timelineMs: number): TimelinePosition | null {
  for (let i = 0; i < sorted.length; i++) {
    const clip = sorted[i];
    if (timelineMs >= clip.timelineStartMs && timelineMs < clipEndMs(clip)) {
      return { clipIndex: i, offsetMs: timelineMs - clip.timelineStartMs };
    }
  }
  return null;
}

/**
 * Les deux plans dérivés du montage. Ils ont des sémantiques différentes et ne
 * doivent surtout pas être confondus :
 *
 *   VIDÉO = sélection — un seul clip visible à la fois, celui de la piste la
 *   plus haute qui couvre l'instant.
 *   AUDIO = ce qui s'entend — indépendant de ce qui se voit, pour qu'une
 *   surcouche muette laisse passer le son de la piste du dessous.
 *
 * À ce palier, l'audio est encore résolu par priorité de piste parmi les seuls
 * clips sonores. Le mixage de plusieurs sources simultanées viendra ensuite et
 * ne touchera QUE `resolveAudioPlan`.
 */
export const resolveVideoPlan = (clips: Clip[], hiddenTracks?: ReadonlySet<number>): Clip[] =>
  flattenTracks(clips, hiddenTracks);

export const resolveAudioPlan = (clips: Clip[], hiddenTracks?: ReadonlySet<number>): Clip[] =>
  flattenTracks(clips, hiddenTracks, (clip) => clip.audioEnabled);

/** Vrai si l'intervalle est libre sur cette piste. */
export function trackIsFree(clips: Clip[], track: number, startMs: number, endMs: number): boolean {
  return !clips.some(
    (clip) =>
      clip.track === track && clip.timelineStartMs < endMs && clipEndMs(clip) > startMs,
  );
}

/**
 * Première piste pouvant accueillir l'intervalle, en partant de `fromTrack` et
 * en montant. Évite d'empiler une piste neuve par rush importé.
 */
export function firstFreeTrack(clips: Clip[], startMs: number, endMs: number, fromTrack = 0): number {
  const ceiling = trackCount(clips);
  for (let track = Math.max(0, fromTrack); track <= ceiling; track++) {
    if (trackIsFree(clips, track, startMs, endMs)) return track;
  }
  return ceiling;
}

/** Clip visible à cet instant : celui de la piste la plus haute qui le couvre. */
export function topClipAt(clips: Clip[], timelineMs: number): Clip | null {
  let top: Clip | null = null;
  for (const clip of clips) {
    if (timelineMs >= clip.timelineStartMs && timelineMs < clipEndMs(clip)) {
      if (!top || clip.track > top.track) top = clip;
    }
  }
  return top;
}

/** Index du premier clip commençant à `timelineMs` ou après, sinon -1. */
export function nextClipIndex(sorted: Clip[], timelineMs: number): number {
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].timelineStartMs >= timelineMs) return i;
  }
  return -1;
}

export interface Gap {
  startMs: number;
  endMs: number;
}

/** Trous de la timeline, y compris celui qui précède le premier clip. */
export function timelineGaps(clips: Clip[]): Gap[] {
  const sorted = sortClips(clips);
  const gaps: Gap[] = [];
  let cursor = 0;
  for (const clip of sorted) {
    if (clip.timelineStartMs - cursor > GAP_EPSILON_MS) {
      gaps.push({ startMs: cursor, endMs: clip.timelineStartMs });
    }
    cursor = Math.max(cursor, clipEndMs(clip));
  }
  return gaps;
}

/** Marge de manœuvre d'un clip : bornes imposées par ses voisins immédiats. */
export function neighbourLimits(sorted: Clip[], index: number): { minStartMs: number; maxEndMs: number } {
  const previous = sorted[index - 1];
  const next = sorted[index + 1];
  return {
    minStartMs: previous ? clipEndMs(previous) : 0,
    maxEndMs: next ? next.timelineStartMs : Number.MAX_SAFE_INTEGER,
  };
}

export interface TrimLimits {
  sourceDurationMs: number;
  minStartMs: number;
  maxEndMs: number;
}

/**
 * Déplace un bord du clip vers `edgeSrcMs` (temps dans le rush).
 *
 * Bord gauche : la position sur la timeline suit le bord, de sorte que celui-ci
 * reste sous le curseur. Bord droit : la position ne bouge pas.
 * Le résultat respecte toujours le rush, la durée minimale et les voisins.
 */
export function applyTrim(clip: Clip, side: "left" | "right", edgeSrcMs: number, limits: TrimLimits): Clip {
  const rate = clip.playbackRate;
  // Durée SOURCE minimale correspondant à la durée timeline minimale.
  const minSource = MIN_CLIP_MS * rate;

  if (side === "left") {
    let srcInMs = Math.max(0, Math.min(edgeSrcMs, clip.srcOutMs - minSource));
    // Un décalage de rush se traduit en décalage de timeline divisé par la vitesse.
    let timelineStartMs = clip.timelineStartMs + (srcInMs - clip.srcInMs) / rate;
    if (timelineStartMs < limits.minStartMs) {
      // On bute sur le clip précédent (ou sur zéro) : le bord s'arrête là.
      srcInMs += (limits.minStartMs - timelineStartMs) * rate;
      srcInMs = Math.max(0, Math.min(srcInMs, clip.srcOutMs - minSource));
      timelineStartMs = clip.timelineStartMs + (srcInMs - clip.srcInMs) / rate;
    }
    return { ...clip, srcInMs, timelineStartMs };
  }

  let srcOutMs = Math.min(limits.sourceDurationMs, Math.max(edgeSrcMs, clip.srcInMs + minSource));
  const maxTimelineDuration = limits.maxEndMs - clip.timelineStartMs;
  if ((srcOutMs - clip.srcInMs) / rate > maxTimelineDuration) {
    srcOutMs = Math.max(clip.srcInMs + minSource, clip.srcInMs + maxTimelineDuration * rate);
  }
  return { ...clip, srcOutMs };
}

/**
 * Change la vitesse d'un clip en gardant son point d'entrée.
 *
 * La durée sur la timeline change donc, et peut empiéter sur le voisin : on la
 * borne, quitte à raccourcir la portion de rush utilisée.
 */
export function applyRate(clip: Clip, rate: number, limits: { maxEndMs: number }): Clip {
  const playbackRate = clampRate(rate);
  const maxTimelineDuration = limits.maxEndMs - clip.timelineStartMs;
  let srcOutMs = clip.srcOutMs;
  if (clipSourceDurationMs(clip) / playbackRate > maxTimelineDuration) {
    srcOutMs = clip.srcInMs + maxTimelineDuration * playbackRate;
  }
  return { ...clip, playbackRate, srcOutMs };
}

/**
 * Repose les clips autour de `priorityId`, qui garde la position voulue.
 *
 * Un clip qui se termine avant lui ne bouge pas. Tout clip qui le chevauche est
 * repoussé juste après, en cascade — c'est ce qui permet de réordonner en
 * traînant un clip par-dessus un autre, sans jamais produire de chevauchement.
 */
export function resolveOverlaps(clips: Clip[], priorityId: string): Clip[] {
  const moved = clips.find((clip) => clip.id === priorityId);
  if (!moved) return clips;
  // Le chevauchement n'est interdit qu'à l'intérieur d'une même piste : entre
  // pistes, c'est justement le principe de la surcouche.
  const others = clips.filter((c) => c.track !== moved.track);
  const placed: Clip[] = [moved, ...others];
  let cursor = clipEndMs(moved);
  for (const clip of sortClips(clips.filter((c) => c.id !== priorityId && c.track === moved.track))) {
    if (clipEndMs(clip) <= moved.timelineStartMs) {
      placed.push(clip);
      continue;
    }
    const timelineStartMs = Math.max(clip.timelineStartMs, cursor);
    placed.push({ ...clip, timelineStartMs });
    cursor = timelineStartMs + clipDurationMs(clip);
  }
  return placed;
}

/**
 * Recolle la PISTE PRINCIPALE bout à bout depuis zéro.
 *
 * Les surcouches ne bougent pas : les décaler aussi les désynchroniserait de
 * l'image qu'elles sont censées recouvrir.
 */
export function closeGaps(clips: Clip[]): Clip[] {
  let cursor = 0;
  const placed = new Map<string, number>();
  for (const clip of sortClips(clipsOnTrack(clips, 0))) {
    placed.set(clip.id, cursor);
    cursor += clipDurationMs(clip);
  }
  return clips.map((clip) =>
    placed.has(clip.id) ? { ...clip, timelineStartMs: placed.get(clip.id)! } : clip,
  );
}

/** Forme d'un clip tel qu'il peut sortir du disque, tous formats confondus. */
export type StoredClip = Omit<
  Clip,
  "timelineStartMs" | "sourceId" | "track" | "audioEnabled" | "cropX"
> & {
  timelineStartMs?: number | null;
  sourceId?: string | null;
  track?: number | null;
  audioEnabled?: boolean | null;
  playbackRate?: number | null;
  cropX?: number | null;
};

/** Forme d'un projet tel qu'il peut sortir du disque, tous formats confondus. */
export type StoredProject = Omit<Project, "version" | "sources" | "clips" | "framing"> & {
  version: number;
  /** Format 1 et 2 : un seul rush, porté par le projet. */
  source?: SourceInfo | null;
  /** Format 3 : plusieurs rushs indexés par empreinte. */
  sources?: Record<string, SourceInfo> | null;
  /** Format 4 : le cadrage vertical appartient au projet. */
  framing?: FramingMode | null;
  clips: StoredClip[];
};

/**
 * Ramène un projet du disque au format courant.
 *
 * Format 1 : clips enchaînés sans trou, position déduite du cumul des durées.
 * Format 2 : positions explicites, mais un seul rush pour tout le projet.
 * Format 3 : multi-rush, mais le cadrage vertical était choisi à l'export.
 * Les clips orphelins (rush absent) sont écartés plutôt que de faire planter
 * la lecture sur une source introuvable.
 */
export function migrateProject(stored: StoredProject): Project {
  const sources: Record<string, SourceInfo> = { ...(stored.sources ?? {}) };
  if (stored.source) sources[stored.source.id] = stored.source;
  const fallbackId = stored.source?.id ?? Object.keys(sources)[0] ?? "";

  let cursor = 0;
  const clips: Clip[] = [];
  for (const clip of stored.clips) {
    const timelineStartMs =
      typeof clip.timelineStartMs === "number" && Number.isFinite(clip.timelineStartMs)
        ? clip.timelineStartMs
        : cursor;
    cursor = timelineStartMs + (clip.srcOutMs - clip.srcInMs);
    const sourceId = clip.sourceId ?? fallbackId;
    if (!sources[sourceId]) continue;
    const track = typeof clip.track === "number" && clip.track >= 0 ? Math.floor(clip.track) : 0;
    clips.push({
      id: clip.id,
      sourceId,
      track,
      timelineStartMs,
      srcInMs: clip.srcInMs,
      srcOutMs: clip.srcOutMs,
      // Projets antérieurs au son par clip : la piste principale s'entend,
      // les surcouches sont muettes, ce qui reconduit leur comportement.
      audioEnabled: typeof clip.audioEnabled === "boolean" ? clip.audioEnabled : track === 0,
      // Projets antérieurs à la vitesse par clip : temps réel.
      playbackRate: clampRate(clip.playbackRate ?? 1),
      // Projets antérieurs au cadrage par clip : recadrage centré.
      cropX: clampCropX(clip.cropX ?? 0),
    });
  }

  return {
    version: 4,
    id: stored.id,
    name: stored.name,
    sources,
    clips,
    // Projets antérieurs au cadrage porté par le projet : c'est le recadrage
    // centré qui était proposé par défaut dans la fenêtre d'export.
    framing: stored.framing === "blur" ? "blur" : "crop",
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export const formatTime = (ms: number): string => {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centis = Math.floor((totalSeconds % 1) * 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
};
