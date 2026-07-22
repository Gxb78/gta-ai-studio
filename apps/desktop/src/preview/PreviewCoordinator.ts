/**
 * PreviewCoordinator - Gestion centralisée des requêtes de prévisualisation
 *
 * Responsabilités :
 * - Debounce 300ms sur les interactions utilisateur
 * - Latest-request-wins via clientRequestId monotone
 * - State machine preview (interactive → dirty → debouncing → queued → rendering → ready/stale/failed)
 * - Annulation de jobs obsolètes
 * - Prefetch automatique des clips adjacents
 */

import type {
  PreviewStatus,
  PreviewRenderProfile,
  PreviewWindow,
  PreviewResponse,
  AdvancedEditingClip,
} from '../types';

/**
 * Generate a monotonically increasing UUID-like ID using timestamp + random
 */
function generateClientRequestId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `${timestamp}-${random}`;
}

export interface PreviewState {
  status: PreviewStatus;
  clientRequestId: string | null;
  jobRunId: string | null;
  cacheKey: string | null;
  artifactUrl: string | null;
  error: string | null;
  lastInteractionMs: number;
}

export interface ClipPreviewRequest {
  client_request_id: string;
  edit_project_id: string;
  clip_id: string;
  timeline_revision: number;
  clip_revision: number;
  render_profile: PreviewRenderProfile;
  preview_window: PreviewWindow | null;
  origin?: "user" | "prefetch";
}

interface PendingRequest {
  requestId: string;
  clipId: string;
  params: Omit<ClipPreviewRequest, 'client_request_id'>;
  timeoutId: number;
}

export type PreviewStateChangeCallback = (clipId: string, state: PreviewState) => void;

export class PreviewCoordinator {
  private states: Map<string, PreviewState> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private listeners: Set<PreviewStateChangeCallback> = new Set();
  private debounceMs: number;
  private apiBaseUrl: string;

  constructor(apiBaseUrl: string = 'http://localhost:8765', debounceMs: number = 300) {
    this.apiBaseUrl = apiBaseUrl;
    this.debounceMs = debounceMs;
  }

  /**
   * Abonnement aux changements d'état
   */
  subscribe(callback: PreviewStateChangeCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notifyListeners(clipId: string, state: PreviewState): void {
    this.listeners.forEach(cb => cb(clipId, state));
  }

  /**
   * Obtenir l'état actuel d'un clip
   */
  getState(clipId: string): PreviewState {
    return this.states.get(clipId) || {
      status: 'interactive',
      clientRequestId: null,
      jobRunId: null,
      cacheKey: null,
      artifactUrl: null,
      error: null,
      lastInteractionMs: 0,
    };
  }

  private setState(clipId: string, updates: Partial<PreviewState>): void {
    const current = this.getState(clipId);
    const newState: PreviewState = { ...current, ...updates };
    this.states.set(clipId, newState);
    this.notifyListeners(clipId, newState);
  }

  /**
   * Demander une preview avec debounce
   * Niveau A (interactive) pendant le debounce, puis lance le rendu
   */
  requestPreview(
    projectId: string,
    editProjectId: string,
    clip: AdvancedEditingClip,
    timelineRevision: number,
    renderProfile: PreviewRenderProfile = 'draft',
    previewWindow: PreviewWindow | null = null,
  ): void {
    const clipId = clip.id;
    const now = Date.now();

    // Annuler toute requête en attente pour ce clip
    this.cancelPending(clipId);

    // Marquer comme dirty puis debouncing
    this.setState(clipId, {
      status: 'dirty',
      lastInteractionMs: now,
    });

    const requestId = generateClientRequestId();
    const params: Omit<ClipPreviewRequest, 'client_request_id'> = {
      edit_project_id: editProjectId,
      clip_id: clipId,
      timeline_revision: timelineRevision,
      clip_revision: 0, // Pour l'instant pas de révision de clip
      render_profile: renderProfile,
      preview_window: previewWindow,
      origin: 'user', // Requête utilisateur, déclenche prefetch
    };

    // Lancer le debounce
    const timeoutId = window.setTimeout(() => {
      this.pendingRequests.delete(clipId);
      this.executePreviewRequest(projectId, clipId, requestId, params);
    }, this.debounceMs);

    this.pendingRequests.set(clipId, {
      requestId,
      clipId,
      params,
      timeoutId,
    });

    this.setState(clipId, {
      status: 'debouncing',
      clientRequestId: requestId,
    });
  }

  /**
   * Exécuter immédiatement une preview sans debounce
   * Utilisé pour le prefetch ou forcer un rendu
   */
  requestPreviewImmediate(
    projectId: string,
    editProjectId: string,
    clip: AdvancedEditingClip,
    timelineRevision: number,
    renderProfile: PreviewRenderProfile = 'draft',
    previewWindow: PreviewWindow | null = null,
  ): void {
    const clipId = clip.id;
    const requestId = generateClientRequestId();

    this.cancelPending(clipId);

    const params: Omit<ClipPreviewRequest, 'client_request_id'> = {
      edit_project_id: editProjectId,
      clip_id: clipId,
      timeline_revision: timelineRevision,
      clip_revision: 0,
      render_profile: renderProfile,
      preview_window: previewWindow,
    };

    this.setState(clipId, {
      status: 'queued',
      clientRequestId: requestId,
    });

    this.executePreviewRequest(projectId, clipId, requestId, params);
  }

  /**
   * Annuler une requête en debounce
   */
  private cancelPending(clipId: string): void {
    const pending = this.pendingRequests.get(clipId);
    if (pending) {
      window.clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(clipId);
    }
  }

  /**
   * Annuler un job en cours de rendu
   */
  async cancelJob(clipId: string): Promise<void> {
    const state = this.getState(clipId);
    if (state.jobRunId && (state.status === 'queued' || state.status === 'rendering')) {
      try {
        // TODO: implémenter l'endpoint /jobs/{jobRunId}/cancel
        // await fetch(`${this.apiBaseUrl}/api/v1/jobs/${state.jobRunId}/cancel`, { method: 'POST' });
        this.setState(clipId, {
          status: 'interactive',
          jobRunId: null,
        });
      } catch (err) {
        console.error('Failed to cancel job:', err);
      }
    }
  }

  /**
   * Exécuter la requête HTTP vers l'API
   */
  private async executePreviewRequest(
    projectId: string,
    clipId: string,
    requestId: string,
    params: Omit<ClipPreviewRequest, 'client_request_id'>,
  ): Promise<void> {
    const state = this.getState(clipId);

    // Latest-request-wins: ignorer si une requête plus récente existe
    if (state.clientRequestId && state.clientRequestId > requestId) {
      console.log(`[PreviewCoordinator] Ignoring stale request ${requestId} for clip ${clipId}`);
      return;
    }

    this.setState(clipId, { status: 'queued' });

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/v1/projects/${projectId}/timeline/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_request_id: requestId,
          ...params,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
      }

      const data: PreviewResponse = await response.json();

      // Latest-request-wins: vérifier que c'est toujours la dernière requête
      const currentState = this.getState(clipId);
      if (currentState.clientRequestId && currentState.clientRequestId > requestId) {
        console.log(`[PreviewCoordinator] Response for stale request ${requestId}, ignoring`);
        return;
      }

      if (data.cache_hit && data.artifact_url) {
        // Cache hit immédiat
        this.setState(clipId, {
          status: 'ready',
          clientRequestId: requestId,
          jobRunId: null,
          cacheKey: data.cache_key,
          artifactUrl: data.artifact_url,
          error: null,
        });
      } else if (data.job_run_id) {
        // Job lancé, polling nécessaire
        this.setState(clipId, {
          status: 'rendering',
          clientRequestId: requestId,
          jobRunId: data.job_run_id,
          cacheKey: data.cache_key,
          error: null,
        });
        this.pollJobStatus(projectId, clipId, requestId, data.job_run_id);
      } else {
        throw new Error('Invalid response: no artifact_url and no job_run_id');
      }
    } catch (err) {
      const currentState = this.getState(clipId);
      if (currentState.clientRequestId && currentState.clientRequestId > requestId) {
        return; // Ignorer l'erreur si requête obsolète
      }

      this.setState(clipId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Polling du statut d'un job
   */
  private async pollJobStatus(
    projectId: string,
    clipId: string,
    requestId: string,
    jobRunId: string,
  ): Promise<void> {
    const maxAttempts = 60; // 60 * 2s = 2 minutes max
    let attempts = 0;

    const poll = async (): Promise<void> => {
      attempts++;

      // Latest-request-wins
      const currentState = this.getState(clipId);
      if (currentState.clientRequestId && currentState.clientRequestId > requestId) {
        console.log(`[PreviewCoordinator] Stopping poll for stale request ${requestId}`);
        return;
      }

      try {
        const response = await fetch(`${this.apiBaseUrl}/api/v1/jobs/${jobRunId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const job = await response.json();

        if (job.status === 'completed') {
          // Job terminé, récupérer l'artifact
          const previewResponse = await fetch(
            `${this.apiBaseUrl}/api/v1/projects/${projectId}/timeline/preview/${clipId}`,
          );
          if (!previewResponse.ok) throw new Error('Failed to fetch artifact after job completion');

          const previewData: PreviewResponse = await previewResponse.json();

          // Latest-request-wins final check
          const finalState = this.getState(clipId);
          if (finalState.clientRequestId && finalState.clientRequestId > requestId) {
            return;
          }

          this.setState(clipId, {
            status: 'ready',
            artifactUrl: previewData.artifact_url,
            error: null,
          });
        } else if (job.status === 'failed') {
          this.setState(clipId, {
            status: 'failed',
            error: job.error_message || 'Job failed',
          });
        } else if (attempts >= maxAttempts) {
          this.setState(clipId, {
            status: 'failed',
            error: 'Timeout waiting for preview render',
          });
        } else {
          // Continue polling
          setTimeout(poll, 2000);
        }
      } catch (err) {
        const finalState = this.getState(clipId);
        if (finalState.clientRequestId && finalState.clientRequestId > requestId) {
          return;
        }

        this.setState(clipId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    setTimeout(poll, 2000); // Premier poll après 2s
  }

  /**
   * Marquer un clip comme stale (timeline modifiée)
   */
  markStale(clipId: string): void {
    const state = this.getState(clipId);
    if (state.status === 'ready') {
      this.setState(clipId, { status: 'stale' });
    }
  }

  /**
   * Marquer tous les clips comme stale
   */
  markAllStale(): void {
    this.states.forEach((state, clipId) => {
      if (state.status === 'ready') {
        this.setState(clipId, { status: 'stale' });
      }
    });
  }

  /**
   * Nettoyer l'état d'un clip
   */
  clear(clipId: string): void {
    this.cancelPending(clipId);
    this.states.delete(clipId);
  }

  /**
   * Nettoyer tous les états
   */
  clearAll(): void {
    this.pendingRequests.forEach(pending => window.clearTimeout(pending.timeoutId));
    this.pendingRequests.clear();
    this.states.clear();
  }
}
