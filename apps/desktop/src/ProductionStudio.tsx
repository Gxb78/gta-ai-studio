import { useMemo, useState } from "react";

import { api, ApiError } from "./api";
import type { JobRun, ProductionRequest, Project, Voice } from "./types";


const JOB_LABELS: Record<JobRun["kind"], string> = {
  INGEST_SOURCE: "Copie et vérification du rush",
  GENERATE_PROXY: "Création du proxy",
  ANALYZE_SCENES: "Détection des changements de scène",
  EXTRACT_KEYFRAMES: "Extraction des images clés",
  OCR_FRAMES: "Lecture OCR locale des écrans",
  ANALYZE_GAMEPLAY: "Détection des écrans et événements",
  BUILD_NARRATIVE_MAP: "Construction de la Narrative Map",
  PLAN_CONTENT: "Scoring des variantes éditoriales",
  VERIFY_FACTS: "Vérification des faits et preuves",
  GENERATE_SCRIPT: "Construction du script sûr",
  SYNTHESIZE_VOICE: "Synthèse de la voix locale",
  PLAN_ADVANCED_EDIT: "Suivi du sujet et mise en scène automatique",
  BUILD_TIMELINE: "Assemblage de la timeline",
  RENDER_VERTICAL: "Rendu vertical final",
  GENERATE_CREATIVE_PACKAGE: "Miniatures et métadonnées plateforme",
  RENDER_CLIP_PREVIEW: "Régénération du plan sélectionné",
};


export function ProductionStudio({ project, voices, activeJob, onProject }: {
  project: Project;
  voices: Voice[];
  activeJob: JobRun | undefined;
  onProject: (project: Project) => void;
}) {
  const [creatingVariant, setCreatingVariant] = useState(false);
  if (!project.production.brief || creatingVariant) {
    return <ProductionComposer project={project} voices={voices} variant={creatingVariant} onProject={(updated) => {
      setCreatingVariant(false);
      onProject(updated);
    }} />;
  }
  return <ProductionDashboard project={project} activeJob={activeJob} onVariant={() => setCreatingVariant(true)} />;
}


function ProductionComposer({ project, voices, variant, onProject }: { project: Project; voices: Voice[]; variant: boolean; onProject: (project: Project) => void }) {
  const preferredVoice = voices.find((voice) => voice.culture.toLowerCase().startsWith("fr")) ?? voices[0];
  const [brief, setBrief] = useState(project.production.brief?.raw_instruction ?? "Créer une présentation courte et rythmée de ce rush, sans inventer ce qui n’est pas visible.");
  const [duration, setDuration] = useState(Math.max(3, Math.round((project.production.edit?.duration ?? 30_000) / 1000)));
  const [style, setStyle] = useState<ProductionRequest["editorial_style"]>("dynamic");
  const [voiceId, setVoiceId] = useState<string | null>(preferredVoice?.id ?? null);
  const [voiceRate, setVoiceRate] = useState(1);
  const [captionStyle, setCaptionStyle] = useState<ProductionRequest["caption_style"]>("impact");
  const [composition, setComposition] = useState<ProductionRequest["composition"]>("smart_blur");
  const [sourceAudio, setSourceAudio] = useState(16);
  const [includeHook, setIncludeHook] = useState(true);
  const [includeCta, setIncludeCta] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceSeconds = Math.max(1, Math.round((project.media[0]?.duration_ms ?? 0) / 1000));

  const launch = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const produced = await api.produceProject(project.id, {
        brief: brief.trim(),
        target_duration_seconds: duration,
        editorial_style: style,
        voice_id: voiceId,
        voice_rate: voiceRate,
        caption_style: captionStyle,
        composition,
        source_audio_level: sourceAudio / 100,
        include_hook: includeHook,
        include_cta: includeCta,
      });
      onProject(produced);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code} — ${caught.message}` : "La production n’a pas pu démarrer.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="production-composer">
      <div className="production-intro">
        <span className="phase-kicker">{variant ? "NOUVELLE VARIANTE" : "PHASE 7 / END-TO-END CREATIVE PACKAGE"}</span>
        <h3>{variant ? "Change l’intention." : "Donne une intention."}<br /><em>Le studio fabrique le montage.</em></h3>
        <p>Le brief pilote le rythme et la narration. Il n’est jamais traité comme une preuve de ce que contient le rush.</p>
        <div className="production-promises"><span>✓ Suivi du sujet</span><span>✓ Overlays intelligents</span><span>✓ Miniatures scorées</span><span>✓ Metadata plateforme</span></div>
      </div>

      <div className="production-form">
        <label className="field brief-field"><span>BRIEF ÉDITORIAL</span><textarea value={brief} maxLength={2000} onChange={(event) => setBrief(event.target.value)} /></label>

        <div className="preset-row">
          <span>Durée cible</span>
          {[15, 30, 45, 60].map((value) => <button key={value} className={duration === value ? "selected" : ""} onClick={() => setDuration(value)}>{value}s</button>)}
          <label><input type="number" min={3} max={180} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /> s</label>
        </div>
        {duration > sourceSeconds && <p className="duration-note">Le rush dure {sourceSeconds}s : le rendu sera plafonné à la matière réellement disponible.</p>}

        <div className="style-picker">
          {([
            ["dynamic", "Impact", "Cuts courts, accroche directe"],
            ["cinematic", "Cinématique", "Respiration et mise en scène"],
            ["tutorial", "Guide", "Structure claire et pédagogique"],
          ] as const).map(([value, title, description]) => (
            <button key={value} className={style === value ? "selected" : ""} onClick={() => setStyle(value)}><strong>{title}</strong><small>{description}</small></button>
          ))}
        </div>

        <div className="advanced-grid">
          <label className="field"><span>VOIX WINDOWS</span><select value={voiceId ?? ""} onChange={(event) => setVoiceId(event.target.value || null)}>{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.culture}</option>)}</select></label>
          <label className="field"><span>CADRAGE VERTICAL</span><select value={composition} onChange={(event) => setComposition(event.target.value as ProductionRequest["composition"])}><option value="smart_blur">Rush entier + fond immersif</option><option value="center_crop">Crop central plein écran</option></select></label>
          <label className="field"><span>SOUS-TITRES</span><select value={captionStyle} onChange={(event) => setCaptionStyle(event.target.value as ProductionRequest["caption_style"])}><option value="impact">Impact — grands et gras</option><option value="minimal">Minimal — discret</option></select></label>
          <label className="range-field"><span>VITESSE VOIX <b>{voiceRate > 0 ? `+${voiceRate}` : voiceRate}</b></span><input type="range" min={-4} max={4} value={voiceRate} onChange={(event) => setVoiceRate(Number(event.target.value))} /></label>
          <label className="range-field"><span>AUDIO DU RUSH <b>{sourceAudio}%</b></span><input type="range" min={0} max={45} value={sourceAudio} onChange={(event) => setSourceAudio(Number(event.target.value))} /></label>
          <div className="switches">
            <label><input type="checkbox" checked={includeHook} onChange={(event) => setIncludeHook(event.target.checked)} /><span />Accroche</label>
            <label><input type="checkbox" checked={includeCta} onChange={(event) => setIncludeCta(event.target.checked)} /><span />Conclusion</label>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        <button className="launch-production" disabled={submitting || brief.trim().length < 3 || voices.length === 0} onClick={() => void launch()}>
          <span>{submitting ? "Lancement…" : "Analyser et générer le contenu"}</span><small>SCÈNES → PREUVES → MONTAGE → MP4 → MINIATURES → METADATA</small><b>→</b>
        </button>
      </div>
    </section>
  );
}


function ProductionDashboard({ project, activeJob, onVariant }: { project: Project; activeJob: JobRun | undefined; onVariant: () => void }) {
  const production = project.production;
  const timeline = production.edit?.timeline;
  const renderMetadata = production.render?.artifact_metadata;
  const clipCount = useMemo(() => {
    const tracks = timeline?.tracks;
    if (!Array.isArray(tracks)) return 0;
    const video = tracks.find((track) => typeof track === "object" && track !== null && (track as { kind?: string }).kind === "video") as { clips?: unknown[] } | undefined;
    return video?.clips?.length ?? 0;
  }, [timeline]);

  if (project.run_status === "ACTIVE" || !production.render_url) {
    return (
      <section className="production-running">
        <div className="render-orbit"><span>{Math.round((activeJob?.progress ?? 0) * 100)}%</span></div>
        <div><span className="phase-kicker">PRODUCTION LOCALE EN COURS</span><h3>{activeJob ? JOB_LABELS[activeJob.kind] : "Préparation du prochain job…"}</h3><p>Chaque artefact est persisté. Tu peux fermer le studio : la reprise se fera à la prochaine ouverture.</p></div>
        <div className="running-rail"><span style={{ width: `${Math.round((activeJob?.progress ?? 0) * 100)}%` }} /></div>
      </section>
    );
  }

  return (
    <section className="production-result">
      <div className="vertical-preview-panel">
        <div className="panel-heading"><div><span>RENDU FINAL 9:16</span><h3>Prêt à publier</h3></div><span className="ready-chip">FINAL</span></div>
        <video className="vertical-video" controls preload="metadata" src={`${api.renderUrl(project.id)}?v=${production.render?.artifact_id ?? "final"}`} />
        <div className="export-row"><a className="export-primary" href={api.renderUrl(project.id)} download>↓ Télécharger le MP4</a><a href={api.subtitlesUrl(project.id)} download>Exporter le SRT</a><button type="button" onClick={onVariant}>Créer une variante</button><span>{formatBytes(production.render?.artifact_size_bytes ?? 0)}</span></div>
      </div>

      <div className="production-insights">
        <div className="result-card script-card"><span className="card-label">SCRIPT FINAL</span><blockquote>{production.script?.full_text}</blockquote><div className="script-blocks">{production.script?.blocks.map((block) => <span key={block.id}>{block.purpose.replaceAll("_", " ")}</span>)}</div></div>
        <div className="result-card voice-card"><span className="card-label">VOIX LOCALE</span><strong>{production.voice?.voice_id}</strong><small>{((production.voice?.duration_ms ?? 0) / 1000).toFixed(1)} s · Windows SAPI</small><audio controls preload="metadata" src={api.voiceUrl(project.id)} /></div>
        <div className="result-card timeline-card"><span className="card-label">TIMELINE</span><div className="stat-line"><strong>{clipCount}</strong><span>plans retenus</span></div><div className="stat-line"><strong>{production.segments.length}</strong><span>scènes détectées</span></div><div className="stat-line"><strong>{String(renderMetadata?.["width"] ?? 1080)}×{String(renderMetadata?.["height"] ?? 1920)}</strong><span>sortie H.264</span></div></div>
        <div className="result-card qc-card"><span className="card-label">QUALITY GATE</span>{production.quality_checks.map((check) => <div key={check.check_id} className={`qc-line ${check.status}`}><span>{check.status === "pass" ? "✓" : "!"}</span><p><strong>{check.dimension}</strong><small>{check.message}</small></p></div>)}</div>
      </div>
    </section>
  );
}


function formatBytes(value: number): string {
  if (!value) return "—";
  return value < 1024 ** 2 ? `${Math.round(value / 1024)} Ko` : `${(value / 1024 ** 2).toFixed(1)} Mo`;
}
