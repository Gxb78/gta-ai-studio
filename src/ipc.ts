// Frontière unique avec le backend Rust. Aucune logique métier ici.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ExportProgress,
  ExportRequest,
  ImportProgress,
  Project,
  ProjectSummary,
  SourceInfo,
  StoredProject,
} from "./types";

/** Extensions acceptées à l'import, ici comme dans le sélecteur de fichiers. */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "m4v"] as const;

export const isVideoPath = (path: string): boolean => {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return (VIDEO_EXTENSIONS as readonly string[]).includes(extension);
};

/** URL lisible par la webview pour un fichier local (proxy, vignettes…). */
export const mediaUrl = (path: string): string => convertFileSrc(path);

export async function pickVideoFile(title = "Choisir un rush"): Promise<string | null> {
  const picked = await open({
    multiple: false,
    title,
    filters: [{ name: "Vidéo", extensions: [...VIDEO_EXTENSIONS] }],
  });
  return typeof picked === "string" ? picked : null;
}

export async function pickVideoFiles(): Promise<string[]> {
  const picked = await open({
    multiple: true,
    title: "Importer des médias",
    filters: [{ name: "Vidéo", extensions: [...VIDEO_EXTENSIONS] }],
  });
  if (Array.isArray(picked)) return picked;
  return typeof picked === "string" ? [picked] : [];
}

/**
 * Fichiers lâchés sur la fenêtre. C'est Tauri qui intercepte le dépôt système,
 * pas le DOM : sans cet abonnement, aucun `drop` HTML n'arrive à la webview.
 */
export async function onFilesDropped(
  callback: (paths: string[]) => void,
): Promise<UnlistenFn> {
  try {
    return await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        callback(event.payload.paths.filter(isVideoPath));
      }
    });
  } catch (error) {
    // Hors de la webview Tauri (aperçu dans un navigateur), la capacité n'existe
    // pas. On le dit clairement et on rend un abonnement vide : perdre le
    // glisser-déposer ne doit pas emporter toute l'interface avec lui.
    console.warn("Glisser-déposer indisponible hors de l'application :", error);
    return () => undefined;
  }
}

export const importSource = (path: string): Promise<SourceInfo> =>
  invoke<SourceInfo>("import_source", { path });

export const saveProject = (project: Project): Promise<void> =>
  invoke<void>("save_project", { project });

/** Le disque peut contenir d'anciens formats : c'est `migrateProject` qui tranche. */
export const loadLastProject = (): Promise<StoredProject | null> =>
  invoke<StoredProject | null>("load_last_project");

/** Projets enregistrés, du plus récemment modifié au plus ancien. */
export const listProjects = (): Promise<ProjectSummary[]> =>
  invoke<ProjectSummary[]>("list_projects");

export const loadProject = (id: string): Promise<StoredProject | null> =>
  invoke<StoredProject | null>("load_project", { id });

/** Existence des fichiers indiqués : sert à repérer un rush déplacé. */
export const pathsExist = (paths: string[]): Promise<boolean[]> =>
  invoke<boolean[]>("paths_exist", { paths });

/** Lance l'export et retourne le chemin du fichier produit. */
export const exportTimeline = (request: ExportRequest): Promise<string> =>
  invoke<string>("export_timeline", { request });

export const revealPath = (path: string): Promise<void> =>
  invoke<void>("reveal_path", { path });

export const onImportProgress = (
  callback: (progress: ImportProgress) => void,
): Promise<UnlistenFn> =>
  listen<ImportProgress>("import://progress", (event) => callback(event.payload));

export const onExportProgress = (
  callback: (progress: ExportProgress) => void,
): Promise<UnlistenFn> =>
  listen<ExportProgress>("export://progress", (event) => callback(event.payload));
