import { useMemo, useState } from "react";

import { api, ApiError } from "./api";
import type { CreativeMetadataVariant, JobRun, Project } from "./types";


const PLATFORM_LABELS = {
  youtube_shorts: "YouTube Shorts",
  tiktok: "TikTok",
  instagram_reels: "Instagram Reels",
} as const;

const CATEGORY_LABELS: Record<CreativeMetadataVariant["category"], string> = {
  direct: "Direct",
  curiosity: "Curiosité",
  question: "Question",
  comparison: "Comparaison",
  result: "Résultat",
  advice: "Conseil",
};


export function CreativeStudio({ project, activeJob, onProject }: {
  project: Project;
  activeJob: JobRun | undefined;
  onProject: (project: Project) => void;
}) {
  const creative = project.production.creative_package;
  const [platform, setPlatform] = useState<keyof typeof PLATFORM_LABELS>("youtube_shorts");
  const [manualSelections, setManualSelections] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const platformVariants = useMemo(
    () => creative?.metadata.variants.filter((variant) => variant.platform === platform) ?? [],
    [creative, platform],
  );
  const selectedId = manualSelections[platform] ?? creative?.metadata.selected_by_platform[platform];
  const selected = platformVariants.find((variant) => variant.id === selectedId) ?? platformVariants[0];

  const copy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => current === key ? null : current), 1400);
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      onProject(await api.generateCreativePackage(project.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code} — ${caught.message}` : "Le pack créatif n’a pas pu démarrer.");
    } finally {
      setGenerating(false);
    }
  };

  if (!creative) {
    if (!project.production.render_url) return null;
    const running = activeJob?.kind === "GENERATE_CREATIVE_PACKAGE";
    return (
      <section className="creative-studio creative-empty">
        <div>
          <span>PHASE 7 · CREATIVE PACKAGE</span>
          <h3>{running ? "Le studio compose les miniatures." : "Le rendu est prêt. Le pack créatif peut être construit."}</h3>
          <p>Sélection d’images, trois compositions 1280×720 et métadonnées scorées pour Shorts, TikTok et Reels.</p>
        </div>
        {!running && <button disabled={generating} onClick={() => void generate()}>{generating ? "Lancement…" : "Générer le pack créatif"}</button>}
        {error && <div className="error-banner">{error}</div>}
      </section>
    );
  }

  return (
    <section className="creative-studio">
      <div className="creative-heading">
        <div><span>PHASE 7 · THUMBNAIL & METADATA ENGINE</span><h3>Un pack éditorial complet.<br /><em>Sans visuel inventé.</em></h3><p>{creative.safety.source_policy}</p></div>
        <div className={`creative-status ${creative.status.toLowerCase()}`}><strong>{creative.status.replaceAll("_", " ")}</strong><small>{creative.summary.thumbnail_count} miniatures · {creative.summary.metadata_variant_count} propositions</small><b>{creative.safety.factual_anchor}</b></div>
      </div>

      <div className="creative-kpis">
        <article><strong>{creative.summary.candidate_frame_count}</strong><span>images classées</span></article>
        <article><strong>{creative.summary.thumbnail_count}</strong><span>compositions HD</span></article>
        <article><strong>{creative.summary.metadata_variant_count}</strong><span>packs scorés</span></article>
        <article><strong>{creative.summary.platform_count}</strong><span>plateformes</span></article>
      </div>

      <div className="thumbnail-panel">
        <div className="panel-heading"><div><span>MINIATURES 1280×720</span><h3>Images réellement observées</h3></div><small>Le score combine qualité source, lisibilité mobile, composition, fidélité et risque clickbait.</small></div>
        <div className="thumbnail-grid">
          {creative.thumbnails.map((thumbnail) => (
            <article key={thumbnail.id} className={thumbnail.selected ? "selected" : ""}>
              <div className="thumbnail-image"><img src={`${api.thumbnailUrl(project.id, thumbnail.id)}?v=${thumbnail.artifact_id}`} alt={`Miniature ${thumbnail.template_key}`} /><span>{Math.round(thumbnail.score * 100)}</span></div>
              <div className="thumbnail-copy"><div><strong>{thumbnail.template_key}</strong>{thumbnail.selected && <b>SÉLECTION AUTO</b>}</div><p>{thumbnail.headline}</p><small>{thumbnail.source_frame_ids.length} image(s) source · fidélité {Math.round((thumbnail.score_breakdown["visual_fidelity"] ?? 0) * 100)}%</small></div>
              <a href={api.thumbnailUrl(project.id, thumbnail.id)} download={`thumbnail-${thumbnail.template_key}.jpg`}>↓ JPG</a>
            </article>
          ))}
        </div>
      </div>

      <div className="metadata-engine-panel">
        <div className="panel-heading"><div><span>METADATA ENGINE</span><h3>Six angles par plateforme</h3></div><a href={api.creativePackageUrl(project.id)} download>↓ Pack JSON</a></div>
        <div className="platform-tabs">
          {(Object.keys(PLATFORM_LABELS) as Array<keyof typeof PLATFORM_LABELS>).map((key) => <button key={key} className={platform === key ? "selected" : ""} onClick={() => setPlatform(key)}>{PLATFORM_LABELS[key]}</button>)}
        </div>
        <div className="metadata-workbench">
          <div className="title-variants">
            {platformVariants.map((variant) => (
              <button key={variant.id} className={selected?.id === variant.id ? "selected" : ""} onClick={() => setManualSelections((current) => ({ ...current, [platform]: variant.id }))}>
                <span>{CATEGORY_LABELS[variant.category]}</span><strong>{variant.title}</strong><b>{Math.round(variant.score * 100)}</b><small>Précision {Math.round((variant.score_breakdown["precision"] ?? 0) * 100)} · cohérence {Math.round((variant.score_breakdown["video_coherence"] ?? 0) * 100)}</small>
              </button>
            ))}
          </div>
          {selected && (
            <div className="metadata-preview">
              <div className="metadata-preview-heading"><span>PACK SÉLECTIONNÉ</span><strong>{selected.platform_label}</strong></div>
              <Field label="Titre" value={selected.title} action={copied === "title" ? "Copié" : "Copier"} onCopy={() => void copy("title", selected.title)} />
              <Field label="Description" value={selected.description} action={copied === "description" ? "Copiée" : "Copier"} onCopy={() => void copy("description", selected.description)} />
              <Field label="Hashtags" value={selected.hashtags.join(" ")} action={copied === "hashtags" ? "Copiés" : "Copier"} onCopy={() => void copy("hashtags", selected.hashtags.join(" "))} />
              <Field label="Commentaire épinglé" value={selected.pinned_comment} action={copied === "comment" ? "Copié" : "Copier"} onCopy={() => void copy("comment", selected.pinned_comment)} />
              <button className="copy-package" onClick={() => void copy("package", `${selected.title}\n\n${selected.description}\n\n${selected.hashtags.join(" ")}`)}>{copied === "package" ? "Pack copié ✓" : "Copier le pack publication"}</button>
              <small className="history-note">Historique de compte non scoré : il sera alimenté par les analytics de la Phase 9.</small>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}


function Field({ label, value, action, onCopy }: { label: string; value: string; action: string; onCopy: () => void }) {
  return <div className="metadata-field"><div><span>{label}</span><button onClick={onCopy}>{action}</button></div><p>{value}</p></div>;
}
