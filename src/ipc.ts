// Frontière unique avec le backend Rust. Aucune logique métier ici.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ExportProgress,
  ExportRequest,
  ImportProgress,
  Project,
  SourceInfo,
  StoredProject,
} from "./types";

/** URL lisible par la webview pour un fichier local (proxy, vignettes…). */
export const mediaUrl = (path: string): string => convertFileSrc(path);

export async function pickVideoFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    title: "Choisir un rush",
    filters: [{ name: "Vidéo", extensions: ["mp4", "mov", "mkv", "m4v"] }],
  });
  return typeof picked === "string" ? picked : null;
}

export const importSource = (path: string): Promise<SourceInfo> =>
  invoke<SourceInfo>("import_source", { path });

export const saveProject = (project: Project): Promise<void> =>
  invoke<void>("save_project", { project });

/** Le disque peut contenir d'anciens formats : c'est `migrateProject` qui tranche. */
export const loadLastProject = (): Promise<StoredProject | null> =>
  invoke<StoredProject | null>("load_last_project");

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
