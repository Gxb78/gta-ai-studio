import type { ApiErrorBody, AudioWaveform, HardwareDiagnostics, Health, ProductionRequest, Project, ProjectSummary, TimelineRevisionRequest, Voice, PreviewResponse, PreviewWindow } from "./types";

export const API_ORIGIN = import.meta.env["VITE_API_ORIGIN"] ?? "http://127.0.0.1:8765";

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.retryable = body.retryable;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let body: ApiErrorBody;
    try {
      body = await response.json() as ApiErrorBody;
    } catch {
      body = { code: "API_UNEXPECTED_RESPONSE", message: `Erreur HTTP ${response.status}`, retryable: false, details: {} };
    }
    throw new ApiError(body);
  }
  return await response.json() as T;
}

export const api = {
  health: (): Promise<Health> => request("/api/v1/health"),
  hardware: (): Promise<HardwareDiagnostics> => request("/api/v1/system/hardware"),
  projects: (): Promise<ProjectSummary[]> => request("/api/v1/projects"),
  project: (id: string): Promise<Project> => request(`/api/v1/projects/${id}`),
  voices: (): Promise<Voice[]> => request("/api/v1/voices"),
  importProject: (payload: { source_path: string; title?: string; game_id: "gta5" | "gta6" | "unknown" }): Promise<Project> =>
    request("/api/v1/projects/import", { method: "POST", body: JSON.stringify({ ...payload, copy_mode: "managed" }) }),
  retryProject: (id: string): Promise<Project> => request(`/api/v1/projects/${id}/retry`, { method: "POST" }),
  produceProject: (id: string, payload: ProductionRequest): Promise<Project> =>
    request(`/api/v1/projects/${id}/produce`, { method: "POST", body: JSON.stringify(payload) }),
  generateCreativePackage: (id: string): Promise<Project> =>
    request(`/api/v1/projects/${id}/creative-package/generate`, { method: "POST" }),
  saveTimelineRevision: (id: string, payload: TimelineRevisionRequest): Promise<Project> =>
    request(`/api/v1/projects/${id}/timeline/revisions`, { method: "POST", body: JSON.stringify(payload) }),
  renderClipPreview: (
    projectId: string,
    params: {
      clientRequestId: string;
      editProjectId: string;
      clipId: string;
      timelineRevision: number;
      clipRevision: number;
      renderProfile: "draft" | "fidelity";
      previewWindow: { playheadMs: number; startMs: number; durationMs: number } | null;
    },
  ): Promise<PreviewResponse> =>
    request(`/api/v1/projects/${projectId}/timeline/preview`, {
      method: "POST",
      body: JSON.stringify({
        client_request_id: params.clientRequestId,
        edit_project_id: params.editProjectId,
        clip_id: params.clipId,
        timeline_revision: params.timelineRevision,
        clip_revision: params.clipRevision,
        render_profile: params.renderProfile,
        preview_window: params.previewWindow
          ? { playhead_ms: params.previewWindow.playheadMs, start_ms: params.previewWindow.startMs, duration_ms: params.previewWindow.durationMs }
          : null,
      }),
    }),
  cancelJob: (id: string): Promise<{ accepted: boolean }> => request(`/api/v1/jobs/${id}/cancel`, { method: "POST" }),
  proxyUrl: (projectId: string): string => `${API_ORIGIN}/api/v1/projects/${projectId}/proxy`,
  analysisFrameUrl: (projectId: string, frameId: string): string => `${API_ORIGIN}/api/v1/projects/${projectId}/analysis/frames/${frameId}`,
  renderUrl: (projectId: string): string => `${API_ORIGIN}/api/v1/projects/${projectId}/render`,
  voiceUrl: (projectId: string): string => `${API_ORIGIN}/api/v1/projects/${projectId}/voice`,
  waveform: (projectId: string, track: "voice" | "source"): Promise<AudioWaveform> => request(`/api/v1/projects/${projectId}/waveform?track=${track}`),
  clipPreviewUrl: (projectId: string, editProjectId: string, clipIndex: number): string =>
    `${API_ORIGIN}/api/v1/projects/${projectId}/timeline/${editProjectId}/clips/${clipIndex}/preview`,
  subtitlesUrl: (projectId: string): string => `${API_ORIGIN}/api/v1/projects/${projectId}/subtitles`,
  thumbnailUrl: (projectId: string, variantId: string): string => `${API_ORIGIN}/api/v1/projects/${projectId}/thumbnails/${variantId}`,
  creativePackageUrl: (projectId: string): string => `${API_ORIGIN}/api/v1/projects/${projectId}/creative-package`,
  eventsUrl: (projectId: string): string => `${API_ORIGIN}/api/v1/projects/${projectId}/events`,
};
