import type { ContentPlan, NarrativeBeatStatus, Project } from "./types";


const STATUS_LABELS: Record<NarrativeBeatStatus, string> = {
  found: "Trouvé",
  partially_found: "Partiel",
  ambiguous: "Ambigu",
  missing: "Manquant",
  contradicted: "Contredit",
  unusable: "Inexploitable",
};

const CONTENT_LABELS: Record<string, string> = {
  vehicle_showcase: "Présentation véhicule",
  vehicle_customization: "Customisation véhicule",
  mission_showcase: "Présentation mission",
  mission_guide: "Guide mission",
  tip: "Astuce",
  comparison: "Comparaison",
  myth_test: "Test de mythe",
  other: "Structure adaptable",
};

const VARIANT_LABELS: Record<ContentPlan["variant"], string> = {
  direct: "Direct",
  storytelling: "Storytelling",
  very_dynamic: "Très dynamique",
};

function timecode(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function NarrativeStudio({ project }: { project: Project }) {
  const narrative = project.production.narrative;
  if (!narrative) return null;
  const map = narrative.map;
  const coverage = narrative.coverage;
  const requiredPercent = Math.round(map.required_coverage * 100);
  const overallPercent = Math.round(map.overall_coverage * 100);

  return (
    <section className="narrative-studio">
      <div className="narrative-heading">
        <div>
          <span className="phase-kicker">NARRATIVE MAP · RÉVISION {map.version}</span>
          <h3>Le brief relié au rush.<br /><em>Chaque choix reste inspectable.</em></h3>
        </div>
        <div className={`coverage-orbit ${requiredPercent < 40 ? "danger" : requiredPercent < 80 ? "warning" : "good"}`} style={{ "--coverage": `${requiredPercent * 3.6}deg` } as React.CSSProperties}>
          <strong>{requiredPercent}%</strong><span>OBLIGATOIRE</span>
        </div>
      </div>

      <div className="narrative-summary-grid">
        <article className="brief-understanding-card">
          <span>COMPRÉHENSION DU BRIEF</span>
          <strong>{CONTENT_LABELS[map.content_type] ?? map.content_type.replaceAll("_", " ")}</strong>
          <p>{String(project.production.brief?.structured["subject"] ?? project.production.brief?.raw_instruction ?? "")}</p>
          <div className="coverage-bars">
            <label><span>Éléments obligatoires</span><b>{requiredPercent}%</b><i><u style={{ width: `${requiredPercent}%` }} /></i></label>
            <label><span>Couverture globale</span><b>{overallPercent}%</b><i><u style={{ width: `${overallPercent}%` }} /></i></label>
          </div>
          <small className="fact-boundary">{map.fact_boundary}</small>
        </article>

        <article className="coverage-decision-card">
          <span>DÉCISION DE MONTAGE</span>
          <strong>{decisionLabel(coverage?.editing_decision)}</strong>
          <div className="coverage-kpis">
            <div><b>{coverage?.mandatory_found ?? 0}/{coverage?.mandatory_total ?? 0}</b><small>trouvés</small></div>
            <div><b>{coverage?.ambiguous_items.length ?? 0}</b><small>à confirmer</small></div>
            <div><b>{coverage?.complementary_footage.length ?? 0}</b><small>rushs conseillés</small></div>
          </div>
          {(coverage?.requested_facts.length ?? 0) > 0 && (
            <div className="fact-gate"><b>{project.production.evidence ? "Vérification Phase 5 terminée" : "Vérification Phase 5 en attente"}</b><p>{coverage?.requested_facts.map((fact) => fact.request).join(" · ")}</p></div>
          )}
        </article>
      </div>

      <div className="narrative-map-panel">
        <div className="panel-heading"><div><span>BEATS ÉDITORIAUX</span><h3>{map.beats.length} intentions analysées</h3></div><small>Les candidats viennent uniquement des observations Phase 3.</small></div>
        <div className="beat-list">
          {map.beats.map((beat) => (
            <article className={`narrative-beat ${beat.status}`} key={beat.id}>
              <div className="beat-order">{String(beat.order + 1).padStart(2, "0")}</div>
              <div className="beat-main">
                <div><strong>{beat.intent}</strong>{beat.required && <span className="required-chip">OBLIGATOIRE</span>}{beat.explicitly_requested && <span className="request-chip">DEMANDÉ</span>}</div>
                <p>{beat.decision_reason}</p>
                {beat.candidate_segments.length > 0 && <div className="candidate-row">{beat.candidate_segments.map((candidate) => <span key={candidate.segment_id}><b>{timecode(candidate.start_ms)}–{timecode(candidate.end_ms)}</b> {Math.round(candidate.score * 100)} % · {candidate.rationale}</span>)}</div>}
              </div>
              <span className={`beat-status ${beat.status}`}>{STATUS_LABELS[beat.status]}</span>
            </article>
          ))}
        </div>
      </div>

      {(coverage?.complementary_footage.length ?? 0) > 0 && (
        <div className="footage-panel">
          <div className="panel-heading"><div><span>SÉQUENCES MANQUANTES</span><h3>Demandes prêtes à tourner</h3></div><small>Instructions précises, jamais de séquence inventée.</small></div>
          <div className="footage-grid">{coverage?.complementary_footage.map((item, index) => <article key={item.beat_id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.intent}</strong><p>{item.request}</p><small>{item.proof_goal}</small></div></article>)}</div>
        </div>
      )}

      {narrative.plans.length > 0 && (
        <div className="variant-panel">
          <div className="panel-heading"><div><span>VARIANT SELECTOR</span><h3>3 structures comparées</h3></div><small>Rush + sujet + durée + style. Historique de performance réservé à une phase future.</small></div>
          <div className="variant-grid">{narrative.plans.map((plan) => <article key={plan.id} className={plan.selected ? "selected" : ""}><div className="variant-score"><strong>{Math.round(plan.score * 100)}</strong><span>/100</span></div><div><span>{plan.selected ? "SÉLECTIONNÉE" : "VARIANTE"}</span><h4>{VARIANT_LABELS[plan.variant]}</h4><p>{plan.description}</p><small>{plan.selection_reason}</small></div><div className="variant-beats">{plan.beats.map((beat) => <span key={beat.beat_id}>{beat.intent}</span>)}</div></article>)}</div>
        </div>
      )}
    </section>
  );
}

function decisionLabel(decision: string | undefined): string {
  const labels: Record<string, string> = {
    ready_with_prudent_narration: "Prêt avec narration prudente",
    continue_adapted_with_warning: "Montage adapté avec avertissement",
    continue_partial_and_request_footage: "Version partielle + rush complémentaire",
  };
  return decision ? labels[decision] ?? decision : "Analyse de couverture en cours";
}
