import { useMemo } from "react";

import { api } from "./api";
import type { Project } from "./types";


export function AnalysisStudio({ project }: { project: Project }) {
  const analysis = project.analysis;
  const screenDistribution = useMemo(
    () => Object.entries(analysis.summary?.screen_distribution ?? {}).sort((left, right) => right[1] - left[1]),
    [analysis.summary],
  );
  if (!analysis.run) return null;

  const maxDistribution = Math.max(1, ...screenDistribution.map(([, count]) => count));
  const hits = analysis.guided_search?.hits.slice(0, 5) ?? [];
  const observations = analysis.texts.slice(0, 12);
  const events = analysis.events.slice(0, 10);
  const entities = analysis.entities.slice(0, 8);
  const frames = analysis.frames.slice(0, 12);

  return (
    <section className="analysis-studio">
      <header className="analysis-header">
        <div>
          <span className="phase-kicker">PHASE 3 / COMPUTER VISION CPU</span>
          <h3>Ce que le studio <em>voit</em> réellement.</h3>
          <p>Images horodatées, OCR local, segmentation visuelle et adaptateur {project.game_id === "gta5" ? "GTA V" : "générique"}. Le brief classe les résultats sans devenir une preuve.</p>
        </div>
        <div className={`analysis-status ${analysis.run.status.toLowerCase()}`}><span />{analysis.run.status === "SUCCEEDED" ? "ANALYSE PRÊTE" : "ANALYSE EN COURS"}</div>
      </header>

      <div className="evidence-legend">
        <span><i className="observed" />OBSERVÉ — pixels ou OCR</span>
        <span><i className="inferred" />INFÉRÉ — candidat scoré</span>
        <span><i className="unverified" />NON VÉRIFIÉ — aucune assertion GTA</span>
      </div>

      <div className="analysis-stats">
        <Metric value={analysis.summary?.frame_count ?? frames.length} label="images clés" />
        <Metric value={analysis.summary?.text_count ?? analysis.texts.length} label="textes observés" />
        <Metric value={analysis.summary?.event_count ?? analysis.events.length} label="événements candidats" />
        <Metric value={hits.length} label="plans guidés" />
      </div>

      <div className="analysis-grid">
        <article className="analysis-card screen-card">
          <CardTitle eyebrow="SEGMENTATION" title="Écrans détectés" />
          {screenDistribution.length ? screenDistribution.map(([label, count]) => (
            <div className="distribution-row" key={label}>
              <span>{humanize(label)}</span><div><i style={{ width: `${Math.max(8, count / maxDistribution * 100)}%` }} /></div><b>{count}</b>
            </div>
          )) : <Empty label="Les classes apparaîtront après l’analyse gameplay." />}
        </article>

        <article className="analysis-card guided-card">
          <CardTitle eyebrow="BRIEF-AWARE SEARCH" title="Meilleurs plans pour l’intention" />
          {hits.length ? hits.map((hit, index) => (
            <div className="search-hit" key={hit.segment_id}>
              <strong>#{index + 1}</strong>
              <div><span>{formatTime(hit.start_ms)} — {formatTime(hit.end_ms)}</span><p>{hit.summary}</p><small>{[...hit.matched_terms, ...hit.matched_detections].join(" · ") || "score visuel générique"}</small></div>
              <b>{Math.round(hit.score * 100)}</b>
            </div>
          )) : <Empty label="La recherche guidée attend les observations." />}
          {analysis.guided_search?.notice && <p className="analysis-notice">{analysis.guided_search.notice}</p>}
        </article>
      </div>

      {frames.length > 0 && (
        <article className="analysis-card frame-evidence">
          <CardTitle eyebrow="PREUVES VISUELLES" title="Galerie horodatée" />
          <div className="frame-strip">
            {frames.map((frame) => (
              <figure key={frame.id}>
                <img loading="lazy" src={api.analysisFrameUrl(project.id, frame.id)} alt={`Image à ${formatTime(frame.timestamp_ms)}`} />
                <figcaption><span>{formatTime(frame.timestamp_ms)}</span><strong>{humanize(frame.detections.screen_label ?? "observation")}</strong><small>{Math.round((frame.detections.confidence ?? 1) * 100)} %</small></figcaption>
              </figure>
            ))}
          </div>
        </article>
      )}

      <div className="analysis-grid analysis-lists">
        <article className="analysis-card">
          <CardTitle eyebrow="OCR LOCAL" title="Textes observés" />
          <div className="observation-list">
            {observations.length ? observations.map((item) => <div key={item.id}><span>{formatTime(item.start_ms)}</span><strong>{item.text}</strong><b>{Math.round(item.confidence * 100)} %</b></div>) : <Empty label="Aucun texte assez fiable sur les images échantillonnées." />}
          </div>
        </article>
        <article className="analysis-card">
          <CardTitle eyebrow="TIMELINE SÉMANTIQUE" title="Événements candidats" />
          <div className="event-list">
            {events.length ? events.map((event) => <div key={event.id}><span>{formatTime(event.start_ms)}</span><strong>{humanize(event.event_type)}</strong><small>CANDIDAT</small><b>{Math.round(event.confidence * 100)} %</b></div>) : <Empty label="Aucun événement candidat assez saillant." />}
            {entities.map((entity) => <div key={entity.id}><span>{formatTime(entity.start_ms)}</span><strong>{entity.label}</strong><small>OCR OBSERVÉ</small><b>{Math.round(entity.confidence * 100)} %</b></div>)}
          </div>
        </article>
      </div>

      {analysis.adapter && (
        <footer className="adapter-footer"><span>{analysis.adapter.id} · v{analysis.adapter.version}</span><p>{analysis.adapter.limitations.join(" ")}</p></footer>
      )}
    </section>
  );
}


function Metric({ value, label }: { value: number; label: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function CardTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="analysis-card-title"><span>{eyebrow}</span><h4>{title}</h4></div>;
}

function Empty({ label }: { label: string }) {
  return <p className="analysis-empty">{label}</p>;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " · ");
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
