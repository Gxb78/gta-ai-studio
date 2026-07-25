import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";

import { api, ApiError } from "./api";
import { AnalysisStudio } from "./AnalysisStudio";
import { CreativeStudio } from "./CreativeStudio";
import { EvidenceStudio } from "./EvidenceStudio";
import { EditingStudio } from "./EditingStudio";
import { NarrativeStudio } from "./NarrativeStudio";
import { ProductionStudio } from "./ProductionStudio";
import type { HardwareDiagnostics, Health, JobRun, Project, ProjectSummary, Voice } from "./types";

const STEPS = [
  { stage: "PROXIED", label: "Rush" },
  { stage: "SEGMENTED", label: "Analyse" },
  { stage: "CONTENT_PLANNED", label: "Narration" },
  { stage: "FACTS_VERIFIED", label: "Preuves" },
  { stage: "SCRIPTED", label: "Script" },
  { stage: "VOICED", label: "Voix" },
  { stage: "TIMELINE_BUILT", label: "Timeline" },
  { stage: "FINAL_RENDERED", label: "Final" },
  { stage: "READY_TO_PUBLISH", label: "Pack" },
] as const;

const STAGE_INDEX: Record<string, number> = {
  CREATED: -1, SOURCE_SELECTED: -1, INGESTED: -1,
  PROXIED: 0, ANALYZED: 1, SEGMENTED: 1, NARRATIVE_MAPPED: 2, COVERAGE_CHECKED: 2,
  CONTENT_PLANNED: 2, FACTS_VERIFIED: 3, SCRIPTED: 4, VOICED: 5,
  TIMELINE_BUILT: 6, DRAFT_RENDERED: 6, QC_ANALYZED: 6, CORRECTED: 6, FINAL_RENDERED: 7, READY_TO_PUBLISH: 8,
};

const JOB_COPY: Record<JobRun["kind"], string> = {
  INGEST_SOURCE: "Copie sécurisée, empreinte et lecture des métadonnées…",
  GENERATE_PROXY: "Encodage du proxy H.264 optimisé CPU…",
  ANALYZE_SCENES: "Détection locale des changements de scène…",
  EXTRACT_KEYFRAMES: "Extraction d’images clés représentatives…",
  OCR_FRAMES: "Lecture OCR locale des menus et textes visibles…",
  ANALYZE_GAMEPLAY: "Détection des écrans, menus et événements candidats…",
  BUILD_NARRATIVE_MAP: "Correspondance entre le brief et les séquences observées…",
  PLAN_CONTENT: "Comparaison de trois variantes éditoriales mesurées…",
  VERIFY_FACTS: "Vérification des claims, preuves et connaissances du jeu…",
  GENERATE_SCRIPT: "Construction du plan et du script sans ajout factuel…",
  SYNTHESIZE_VOICE: "Génération de la voix française hors ligne…",
  PLAN_ADVANCED_EDIT: "Suivi du sujet, recadrage intelligent et design des overlays…",
  BUILD_TIMELINE: "Assemblage des plans, sous-titres et pistes audio…",
  RENDER_VERTICAL: "Encodage du MP4 vertical final et contrôles qualité…",
  GENERATE_CREATIVE_PACKAGE: "Classement des images, miniatures et métadonnées par plateforme…",
  RENDER_CLIP_PREVIEW: "Régénération locale du plan sélectionné…",
};

function formatBytes(value: number): string {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} Ko`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} Mo`;
  return `${(value / 1024 ** 3).toFixed(2)} Go`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    ACTIVE: "En cours",
    COMPLETED: "Prêt",
    FAILED_RETRYABLE: "Nouvelle tentative",
    FAILED_FINAL: "Action requise",
    CANCELLED: "Annulé",
  };
  return labels[status] ?? status;
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [hardware, setHardware] = useState<HardwareDiagnostics | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [title, setTitle] = useState("");
  const [gameId, setGameId] = useState<"gta5" | "gta6">("gta5");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      const items = await api.projects();
      setProjects(items);
      if (!selectedId && items[0]) setSelectedId(items[0].id);
    } catch {
      // Health banner already communicates the disconnected state.
    }
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    const connect = async () => {
      try {
        const nextHealth = await api.health();
        if (!cancelled) {
          setHealth(nextHealth);
          void api.hardware().then((value) => !cancelled && setHardware(value)).catch(() => !cancelled && setHardware(null));
          setError(null);
          await refreshProjects();
        }
      } catch {
        if (!cancelled) setHealth(null);
      }
    };
    void connect();
    const interval = window.setInterval(() => void connect(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshProjects]);

  useEffect(() => {
    if (!health || voices.length > 0) return;
    void api.voices().then(setVoices).catch(() => setVoices([]));
  }, [health, voices.length]);

  useEffect(() => {
    if (!selectedId) {
      setProject(null);
      return;
    }
    let disposed = false;
    void api.project(selectedId).then((value) => !disposed && setProject(value)).catch(() => undefined);
    const events = new EventSource(api.eventsUrl(selectedId));
    events.addEventListener("project", (event) => {
      const value = JSON.parse((event as MessageEvent<string>).data) as Project;
      setProject(value);
      void refreshProjects();
    });
    return () => {
      disposed = true;
      events.close();
    };
  }, [refreshProjects, selectedId]);

  const chooseVideo = async () => {
    setError(null);
    if (!isTauriRuntime()) return;
    const selection = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Vidéo MP4", extensions: ["mp4"] }],
      title: "Choisir un rush GTA",
    });
    if (typeof selection === "string") {
      setSourcePath(selection);
      if (!title) setTitle(selection.split(/[\\/]/).pop()?.replace(/\.mp4$/i, "") ?? "");
    }
  };

  const createProject = async () => {
    if (!sourcePath.trim()) {
      setError("Choisis d’abord un fichier MP4.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const trimmedTitle = title.trim();
      const payload = {
        source_path: sourcePath.trim(),
        game_id: gameId,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
      };
      const created = await api.importProject(payload);
      setSelectedId(created.id);
      setProject(created);
      setSourcePath("");
      setTitle("");
      await refreshProjects();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code} — ${caught.message}` : "Impossible de créer le projet.");
    } finally {
      setSubmitting(false);
    }
  };

  const activeJob = project?.jobs.find((job) =>
    job.kind !== "RENDER_CLIP_PREVIEW" &&
    ["QUEUED", "BLOCKED", "LEASED", "RUNNING", "RETRY_WAIT"].includes(job.status)
  );
  const globalProgress = useMemo(() => {
    if (!project) return 0;
    if (project.run_status === "COMPLETED") return 100;
    const stagePosition = STAGE_INDEX[project.pipeline_stage] ?? -1;
    const base = Math.max(0, stagePosition + 1) / STEPS.length;
    const jobPart = (activeJob?.progress ?? 0) / STEPS.length;
    return Math.min(99, Math.round((base + jobPart) * 100));
  }, [activeJob?.progress, project]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">G</div>
          <div><strong>GTA AI</strong><span>STUDIO</span></div>
        </div>

        <button className="nav-create active" onClick={() => setSelectedId(null)}>
          <span>＋</span> Nouveau contenu
        </button>

        <div className="sidebar-heading"><span>Projets récents</span><span>{projects.length}</span></div>
        <div className="project-list">
          {projects.map((item) => (
            <button key={item.id} className={`project-item ${selectedId === item.id ? "selected" : ""}`} onClick={() => setSelectedId(item.id)}>
              <span className={`project-dot ${item.run_status.toLowerCase()}`} />
              <span className="project-copy"><strong>{item.title}</strong><small>{statusLabel(item.run_status)}</small></span>
              <span className="chevron">›</span>
            </button>
          ))}
          {projects.length === 0 && <p className="empty-sidebar">Ton premier projet apparaîtra ici.</p>}
        </div>

        <div className="system-card">
          <span className={`connection-dot ${health ? "online" : "offline"}`} />
          <div><strong>{health ? "Studio opérationnel" : "Connexion au studio…"}</strong><small>{health ? `API ${health.version} · Worker ${health.worker}` : "Le sidecar démarre"}</small></div>
        </div>
        {hardware && (
          <div className={`hardware-card ${hardware.active_mode}`}>
            <div><span>ACCÉLÉRATION</span><strong>{hardware.active_mode === "nvidia" ? "GPU ACTIF" : "CPU SÉCURISÉ"}</strong></div>
            <dl>
              <div><dt>Encodage</dt><dd>{hardware.video_encoder}</dd></div>
              <div><dt>OpenCV</dt><dd>{hardware.opencv_cuda ? `CUDA ×${hardware.opencv_cuda_devices}` : "CPU"}</dd></div>
              <div><dt>ONNX</dt><dd>{hardware.onnx_gpu ? "GPU" : "CPU"}</dd></div>
            </dl>
            <small title={hardware.diagnostics.join(" · ")}>{hardware.active_mode === "nvidia" ? hardware.gpu_name : "Fallback automatique vérifié"}</small>
          </div>
        )}
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><span className="eyebrow">PHASE 7 · CREATIVE PACKAGE ENGINE</span><h1>{selectedId && project ? project.title : "Créer un contenu"}</h1></div>
          <div className={`local-pill ${hardware?.active_mode === "nvidia" ? "gpu" : "cpu"}`} title={hardware?.diagnostics.join(" · ") ?? "Diagnostic matériel en cours"}>
            <span>●</span> {hardware?.active_mode === "nvidia" ? `${hardware.gpu_name} · NVENC` : "LOCAL · CPU FALLBACK"}
          </div>
        </header>

        {!selectedId ? (
          <section className="create-grid">
            <div className="hero-copy">
              <span className="section-index">01 / IMPORT</span>
              <h2>Transforme ton rush<br /><em>sans quitter ton PC.</em></h2>
              <p>Choisis un MP4 GTA. Le studio vérifie le fichier, extrait ses métadonnées et fabrique un proxy léger, reprenable même après un redémarrage.</p>
              <div className="promise-row"><span>✓ Empreinte SHA-256</span><span>✓ FFprobe</span><span>✓ Proxy H.264</span></div>
            </div>

            <div className="import-card">
              <div className="card-title"><span>Fichier source</span><small>MP4 · jusqu’à 150 Go</small></div>
              <button className={`drop-zone ${sourcePath ? "has-file" : ""}`} onClick={() => void chooseVideo()}>
                <span className="upload-icon">⇧</span>
                <strong>{sourcePath ? sourcePath.split(/[\\/]/).pop() : "Choisir un rush GTA"}</strong>
                <small>{sourcePath || (isTauriRuntime() ? "Le fichier sera copié dans la bibliothèque locale" : "Mode navigateur : colle le chemin ci-dessous")}</small>
              </button>
              {!isTauriRuntime() && (
                <label className="field"><span>Chemin du MP4</span><input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="C:\Vidéos\rush-gta.mp4" /></label>
              )}
              <div className="field-row">
                <label className="field grow"><span>Nom du projet</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex. Customisation Zentorno" /></label>
                <label className="field compact"><span>Jeu</span><select value={gameId} onChange={(event) => setGameId(event.target.value as "gta5" | "gta6")}><option value="gta5">GTA V</option><option value="gta6">GTA VI</option></select></label>
              </div>
              {error && <div className="error-banner">{error}</div>}
              <button className="primary-button" disabled={submitting || !health} onClick={() => void createProject()}>
                {submitting ? "Création…" : "Lancer l’import"}<span>→</span>
              </button>
            </div>
          </section>
        ) : project ? (
          <ProjectView
            project={project}
            globalProgress={globalProgress}
            activeJob={activeJob}
            voices={voices}
            onProject={setProject}
            onCancel={(job) => void api.cancelJob(job.id)}
            onRetry={() => void api.retryProject(project.id).then(setProject)}
          />
        ) : <div className="loading-panel">Chargement du projet…</div>}
      </main>
    </div>
  );
}

function ProjectView({ project, globalProgress, activeJob, voices, onProject, onCancel, onRetry }: {
  project: Project;
  globalProgress: number;
  activeJob: JobRun | undefined;
  voices: Voice[];
  onProject: (project: Project) => void;
  onCancel: (job: JobRun) => void;
  onRetry: () => void;
}) {
  const stageIndex = STAGE_INDEX[project.pipeline_stage] ?? -1;
  const media = project.media[0];
  return (
    <section className="project-view">
      <div className="status-hero">
        <div>
          <span className={`status-badge ${project.run_status.toLowerCase()}`}>{statusLabel(project.run_status)}</span>
          <h2>{project.run_status === "ACTIVE" && project.pipeline_stage === "FINAL_RENDERED" ? "Le pack créatif est en production."
            : project.run_status === "ACTIVE" && project.production.brief ? "Le studio produit ton montage."
              : project.run_status === "FAILED_FINAL" ? "Une étape demande ton attention."
                : project.pipeline_stage === "READY_TO_PUBLISH" ? "Vidéo et pack créatif prêts."
                  : project.pipeline_stage === "FINAL_RENDERED" ? "Vidéo verticale prête."
                  : project.run_status === "COMPLETED" ? "Proxy prêt. Lance le montage."
                    : "Le studio prépare ton rush."}</h2>
          <p>{activeJob ? JOB_COPY[activeJob.kind] : project.failure_message ?? (project.pipeline_stage === "READY_TO_PUBLISH" ? "MP4, miniatures, titres et packs plateforme sont disponibles." : project.pipeline_stage === "FINAL_RENDERED" ? "Rendu, voix, sous-titres et contrôles qualité sont disponibles." : "La fondation locale est prête pour ton brief.")}</p>
        </div>
        <div className="progress-orbit"><strong>{globalProgress}%</strong><span>GLOBAL</span></div>
      </div>

      <div className="stepper">
        {STEPS.map((step, index) => (
          <div key={step.stage} className={`step ${stageIndex >= index ? "done" : ""} ${stageIndex + 1 === index ? "current" : ""}`}>
            <span>{stageIndex >= index ? "✓" : index + 1}</span><div><strong>{step.label}</strong><small>{["Proxy vérifié", "OCR + GTA V", "Carte + couverture", "Claims sourcés", "Script filtré", "SAPI local", "JSON validée", "MP4 9:16", "Miniatures + metadata"][index]}</small></div>
          </div>
        ))}
      </div>

      {activeJob && (
        <div className="active-job-card">
          <div><span className="pulse" /><strong>{JOB_COPY[activeJob.kind]}</strong><small>Tentative {activeJob.attempt}/{activeJob.max_attempts} · {activeJob.status}</small></div>
          <div className="job-progress"><span style={{ width: `${Math.round(activeJob.progress * 100)}%` }} /></div>
          <button onClick={() => onCancel(activeJob)}>Annuler</button>
        </div>
      )}

      {project.run_status === "FAILED_FINAL" && (
        <div className="failure-card"><div><strong>{project.failure_code}</strong><p>{project.failure_message}</p></div><button onClick={onRetry}>Relancer</button></div>
      )}

      {stageIndex >= 0 && <ProductionStudio key={project.id} project={project} voices={voices} activeJob={activeJob} onProject={onProject} />}

      <AnalysisStudio project={project} />

      <NarrativeStudio project={project} />

      <EvidenceStudio project={project} />

      <EditingStudio project={project} onProject={onProject} />

      <CreativeStudio project={project} activeJob={activeJob} onProject={onProject} />

      <div className="detail-grid">
        <div className="media-panel">
          <div className="panel-heading"><div><span>APERÇU PROXY</span><h3>{project.proxy ? "Lecture locale" : "En attente du rendu"}</h3></div>{project.proxy && <span className="ready-chip">PRÊT</span>}</div>
          {project.proxy ? (
            <video controls preload="metadata" src={`${api.proxyUrl(project.id)}?v=${project.proxy.sha256}`} />
          ) : <div className="video-placeholder"><span>◫</span><p>Le proxy apparaîtra ici automatiquement.</p></div>}
        </div>

        <div className="metadata-panel">
          <div className="panel-heading"><div><span>RAPPORT D’IMPORT</span><h3>Données techniques</h3></div></div>
          {media ? (
            <dl>
              <div><dt>Résolution</dt><dd>{media.width} × {media.height}</dd></div>
              <div><dt>Fréquence</dt><dd>{(media.fps_numerator / media.fps_denominator).toFixed(2)} fps</dd></div>
              <div><dt>Durée</dt><dd>{formatDuration(media.duration_ms)}</dd></div>
              <div><dt>Codec vidéo</dt><dd>{media.video_codec.toUpperCase()}</dd></div>
              <div><dt>Audio</dt><dd>{media.audio_codec?.toUpperCase() ?? "Aucune piste"}</dd></div>
              <div><dt>Taille source</dt><dd>{formatBytes(media.size_bytes)}</dd></div>
              <div className="hash-row"><dt>SHA-256</dt><dd title={media.sha256}>{media.sha256.slice(0, 12)}…{media.sha256.slice(-8)}</dd></div>
            </dl>
          ) : <div className="metadata-skeleton"><span /><span /><span /><span /></div>}
        </div>
      </div>
    </section>
  );
}
