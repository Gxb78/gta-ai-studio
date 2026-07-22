import { api } from "./api";
import type { AdvancedEditingClip, PreviewResponse, PreviewRenderProfile, PreviewStatus, PreviewWindow } from "./types";
import { computePreviewWindow } from "./reframe";

interface PreviewState {
  status: PreviewStatus;
  activeClientRequestId: string | null;
  activeJobRunId: string | null;
  activeCacheKey: string | null;
  lastReadyUrl: string | null;
  lastReadyCacheKey: string | null;
  error: string | null;
}

type StateChangeCallback = (state: PreviewState) => void;

/** Generate a monotonic UUID v7-like string for request ordering. */
function generateRequestId(): string {
  // Use crypto.randomUUID for a unique ID
  return crypto.randomUUID();
}

export class PreviewCoordinator {
  private state: PreviewState = {
    status: "interactive",
    activeClientRequestId: null,
    activeJobRunId: null,
    activeCacheKey: null,
    lastReadyUrl: null,
    lastReadyCacheKey: null,
    error: null,
  };

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs = 300;
  private readonly listeners: Set<StateChangeCallback> = new Set();
  private projectId: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  /** Subscribe to state changes. Returns unsubscribe function. */
  subscribe(callback: StateChangeCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Get current state snapshot. */
  getState(): Readonly<PreviewState> {
    return { ...this.state };
  }

  /** Notify that a parameter changed (drag started or value updated). */
  onParameterChange(): void {
    this.cancelDebounce();
    this.updateState({ status: "dirty", error: null });
  }

  /** Notify that interactive drag is active (Level A only). */
  onDragActive(): void {
    this.cancelDebounce();
    this.updateState({ status: "interactive" });
  }

  /** Notify that drag ended — starts debounce for Level B/C. */
  onDragEnd(
    clip: AdvancedEditingClip,
    editProjectId: string,
    timelineRevision: number,
    playheadMs: number,
    renderProfile: PreviewRenderProfile = "draft",
  ): void {
    this.cancelDebounce();
    this.updateState({ status: "debouncing" });

    this.debounceTimer = setTimeout(() => {
      this.requestPreview(
        clip, editProjectId, timelineRevision, playheadMs, renderProfile,
      );
    }, this.debounceMs);
  }

  /** Explicitly request a preview render (e.g. button click). */
  async requestPreview(
    clip: AdvancedEditingClip,
    editProjectId: string,
    timelineRevision: number,
    playheadMs: number,
    renderProfile: PreviewRenderProfile = "draft",
  ): Promise<void> {
    this.cancelDebounce();

    // Cancel previous job if still running
    if (this.state.activeJobRunId) {
      try {
        await api.cancelJob(this.state.activeJobRunId);
      } catch {
        // Best effort cancellation
      }
    }

    const clientRequestId = generateRequestId();
    const previewWindow = computePreviewWindow(
      playheadMs, clip.duration_ms, renderProfile,
    );

    this.updateState({
      status: "queued",
      activeClientRequestId: clientRequestId,
      activeJobRunId: null,
      error: null,
    });

    try {
      const response = await api.renderClipPreview(this.projectId, {
        clientRequestId,
        editProjectId,
        clipId: clip.id,
        timelineRevision,
        clipRevision: 0,
        renderProfile,
        previewWindow,
      });

      // Latest-request-wins: ignore if a newer request was made
      if (clientRequestId !== this.state.activeClientRequestId) {
        return;
      }

      this.handleResponse(response, clientRequestId);
    } catch (error) {
      if (clientRequestId !== this.state.activeClientRequestId) {
        return;
      }
      this.updateState({
        status: "failed",
        error: error instanceof Error ? error.message : "Preview request failed",
      });
    }
  }

  /** Handle the preview response. */
  private handleResponse(
    response: PreviewResponse,
    clientRequestId: string,
  ): void {
    if (response.cache_hit && response.status === "ready" && response.artifact_url) {
      this.updateState({
        status: "ready",
        activeJobRunId: null,
        activeCacheKey: response.cache_key,
        lastReadyUrl: response.artifact_url,
        lastReadyCacheKey: response.cache_key,
      });
      return;
    }

    this.updateState({
      status: "rendering",
      activeJobRunId: response.job_run_id,
      activeCacheKey: response.cache_key,
    });

    // Start polling for completion
    this.startPolling(clientRequestId);
  }

  /** Poll for job completion via project events. */
  private startPolling(clientRequestId: string): void {
    this.stopPolling();
    this.pollTimer = setInterval(async () => {
      if (clientRequestId !== this.state.activeClientRequestId) {
        this.stopPolling();
        return;
      }

      try {
        const project = await api.project(this.projectId);
        const editor = project.production?.timeline_editor;
        if (!editor) return;

        const preview = editor.previews?.find(
          (p: { clip_index: number; artifact_id: string }) =>
            p.artifact_id && this.state.activeCacheKey,
        );

        if (preview) {
          this.stopPolling();
          if (clientRequestId !== this.state.activeClientRequestId) return;

          // Construct the artifact URL
          const artifactUrl = `${api.clipPreviewUrl(
            this.projectId,
            editor.edit_project_id,
            preview.clip_index,
          )}`;

          this.updateState({
            status: "ready",
            activeJobRunId: null,
            lastReadyUrl: artifactUrl,
            lastReadyCacheKey: this.state.activeCacheKey,
          });
        }

        // Check for failure
        const failedJob = project.jobs?.find(
          (j) => j.kind === "RENDER_CLIP_PREVIEW" && j.status === "FAILED",
        );
        if (failedJob) {
          this.stopPolling();
          if (clientRequestId !== this.state.activeClientRequestId) return;
          this.updateState({
            status: "failed",
            error: failedJob.error_message ?? "Preview render failed",
          });
        }
      } catch {
        // Network error during polling — keep trying
      }
    }, 750);
  }

  /** Mark the current preview as stale (parameters changed since last ready). */
  markStale(): void {
    if (this.state.status === "ready") {
      this.updateState({ status: "stale" });
    }
  }

  /** Clean up timers. */
  destroy(): void {
    this.cancelDebounce();
    this.stopPolling();
    this.listeners.clear();
  }

  private cancelDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private updateState(partial: Partial<PreviewState>): void {
    this.state = { ...this.state, ...partial };
    const snapshot = { ...this.state };
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
