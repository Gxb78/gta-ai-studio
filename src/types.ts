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
   * Piste vidéo. 0 = piste principale, en bas. Plus l'indice est élevé, plus la
   * piste est haute et prioritaire visuellement.
   */
  track: number;
  /** Début du clip sur la timeline. */
  timelineStartMs: number;
  srcInMs: number;
  srcOutMs: number;
}

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
export function flattenTracks(clips: Clip[], hiddenTracks?: ReadonlySet<number>): Clip[] {
  const visible = hiddenTracks ? clips.filter((clip) => !hiddenTracks.has(clip.track)) : clips;
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

    const offset = from - top.timelineStartMs;
    const segment: Clip = {
      id: `${top.id}@${Math.round(from)}`,
      sourceId: top.sourceId,
      track: top.track,
      timelineStartMs: from,
      srcInMs: top.srcInMs + offset,
      srcOutMs: top.srcInMs + offset + (to - from),
    };

    // Deux tronçons consécutifs du même rush qui se suivent aussi dans le temps
    // source ne forment qu'un seul segment : inutile de couper pour rien.
    const previous = flat[flat.length - 1];
    if (
      previous &&
      previous.sourceId === segment.sourceId &&
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
  version: 3;
  id: string;
  name: string;
  /** Rushs du projet, indexés par leur empreinte. */
  sources: Record<string, SourceInfo>;
  clips: Clip[];
  createdAt: string;
  updatedAt: string;
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

export type ExportMode = "crop" | "blur";

export interface ExportSource {
  path: string;
  hasAudio: boolean;
}

export interface ExportSegment {
  /** Index dans `ExportRequest.sources`. */
  sourceIndex: number;
  srcInMs: number;
  srcOutMs: number;
  /** Durée de noir à insérer avant ce segment (trou de la timeline). */
  gapBeforeMs: number;
}

export interface ExportRequest {
  sources: ExportSource[];
  segments: ExportSegment[];
  mode: ExportMode;
  fileName: string;
  /** Vrai si au moins un rush a du son : les autres reçoivent du silence. */
  hasAudio: boolean;
  /** Format de sortie du montage, imposé à tous les rushs avant concaténation. */
  frameWidth: number;
  frameHeight: number;
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

export const clipDurationMs = (clip: Clip): number => clip.srcOutMs - clip.srcInMs;

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
  if (side === "left") {
    let srcInMs = Math.max(0, Math.min(edgeSrcMs, clip.srcOutMs - MIN_CLIP_MS));
    let timelineStartMs = clip.timelineStartMs + (srcInMs - clip.srcInMs);
    if (timelineStartMs < limits.minStartMs) {
      // On bute sur le clip précédent (ou sur zéro) : le bord s'arrête là.
      srcInMs += limits.minStartMs - timelineStartMs;
      srcInMs = Math.max(0, Math.min(srcInMs, clip.srcOutMs - MIN_CLIP_MS));
      timelineStartMs = clip.timelineStartMs + (srcInMs - clip.srcInMs);
    }
    return { ...clip, srcInMs, timelineStartMs };
  }

  let srcOutMs = Math.min(
    limits.sourceDurationMs,
    Math.max(edgeSrcMs, clip.srcInMs + MIN_CLIP_MS),
  );
  const maxDuration = limits.maxEndMs - clip.timelineStartMs;
  if (srcOutMs - clip.srcInMs > maxDuration) {
    srcOutMs = Math.max(clip.srcInMs + MIN_CLIP_MS, clip.srcInMs + maxDuration);
  }
  return { ...clip, srcOutMs };
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
export type StoredClip = Omit<Clip, "timelineStartMs" | "sourceId" | "track"> & {
  timelineStartMs?: number | null;
  sourceId?: string | null;
  track?: number | null;
};

/** Forme d'un projet tel qu'il peut sortir du disque, tous formats confondus. */
export type StoredProject = Omit<Project, "version" | "sources" | "clips"> & {
  version: number;
  /** Format 1 et 2 : un seul rush, porté par le projet. */
  source?: SourceInfo | null;
  /** Format 3 : plusieurs rushs indexés par empreinte. */
  sources?: Record<string, SourceInfo> | null;
  clips: StoredClip[];
};

/**
 * Ramène un projet du disque au format courant.
 *
 * Format 1 : clips enchaînés sans trou, position déduite du cumul des durées.
 * Format 2 : positions explicites, mais un seul rush pour tout le projet.
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
    clips.push({
      id: clip.id,
      sourceId,
      track: typeof clip.track === "number" && clip.track >= 0 ? Math.floor(clip.track) : 0,
      timelineStartMs,
      srcInMs: clip.srcInMs,
      srcOutMs: clip.srcOutMs,
    });
  }

  return {
    version: 3,
    id: stored.id,
    name: stored.name,
    sources,
    clips,
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
