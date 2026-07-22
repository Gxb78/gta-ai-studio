import type { ClaimEvidence, ClaimStatus, Project } from "./types";


const STATUS_LABELS: Record<ClaimStatus, string> = {
  hypothesis: "Hypothèse",
  observed_once: "Observé une fois",
  reproduced: "Reproduit",
  verified: "Vérifié",
  contradicted: "Contredit",
  outdated: "Obsolète",
  unknown: "Inconnu",
};

const SOURCE_LABELS: Record<ClaimEvidence["evidence_type"], string> = {
  segment: "Segment vidéo",
  media_frame: "Image du rush",
  ocr_text: "Texte OCR",
  detected_entity: "Élément détecté",
  detected_event: "Événement détecté",
  knowledge_item: "Base de connaissances",
  official_documentation: "Documentation officielle",
  repeated_test: "Test reproduit",
  user_library: "Rush antérieur",
};

function timecode(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function EvidenceStudio({ project }: { project: Project }) {
  const evidence = project.production.evidence;
  if (!evidence) return null;
  const coverage = Math.round(evidence.summary.requested_fact_coverage * 100);
  const usedClaimIds = new Set(project.production.script?.blocks.flatMap((block) => block.supporting_claim_ids) ?? []);

  return (
    <section className="evidence-studio">
      <div className="evidence-heading">
        <div>
          <span className="phase-kicker">EVIDENCE ENGINE · {evidence.run.algorithm_version}</span>
          <h3>Chaque affirmation a une trace.<br /><em>Le doute reste visible.</em></h3>
          <p>{evidence.gate.rule}</p>
        </div>
        <div className={`evidence-gate-status ${evidence.gate.status.toLowerCase()}`}><span>{evidence.gate.status === "PASSED" ? "✓" : "!"}</span><strong>{evidence.gate.status.replaceAll("_", " ")}</strong><small>{coverage}% des faits demandés couverts</small></div>
      </div>

      <div className="evidence-kpis">
        <article><strong>{evidence.summary.claim_count}</strong><span>claims tracés</span></article>
        <article className="admitted"><strong>{evidence.summary.admitted_claim_count}</strong><span>admis par le gate</span></article>
        <article className="blocked"><strong>{evidence.summary.blocked_claim_count}</strong><span>exclus du script</span></article>
        <article><strong>{evidence.summary.knowledge_items_used}/{evidence.summary.knowledge_items_available}</strong><span>connaissances utilisées</span></article>
        <article className={evidence.cross_game_item_count === 0 ? "isolated" : "blocked"}><strong>{evidence.cross_game_item_count}</strong><span>croisement inter-jeux</span></article>
      </div>

      {evidence.requested_facts.length > 0 && (
        <div className="requested-facts-panel">
          <div className="panel-heading"><div><span>FAITS DEMANDÉS</span><h3>Verdict avant écriture</h3></div><small>Une demande du brief n’est jamais une preuve.</small></div>
          <div className="requested-fact-grid">{evidence.requested_facts.map((fact) => <article key={fact.claim_id} className={fact.allowed_in_script ? "allowed" : "denied"}><span>{fact.allowed_in_script ? "ADMIS" : "EXCLU"}</span><strong>{fact.request}</strong><p>{fact.reason}</p><small>{STATUS_LABELS[fact.status]} · {Math.round(fact.confidence * 100)} %</small></article>)}</div>
        </div>
      )}

      <div className="claim-panel">
        <div className="panel-heading"><div><span>CLAIM LEDGER</span><h3>Provenance et niveau de certitude</h3></div><small>{usedClaimIds.size} claim(s) relié(s) aux blocs du script.</small></div>
        <div className="claim-list">{evidence.claims.map((claim) => (
          <article className={`evidence-claim ${claim.allowed_in_script ? "allowed" : "denied"}`} key={claim.id}>
            <div className="claim-verdict"><span className={`claim-status ${claim.status}`}>{STATUS_LABELS[claim.status]}</span><strong>{Math.round(claim.confidence * 100)}%</strong><small>{claim.allowed_in_script ? "admissible" : "bloqué"}{usedClaimIds.has(claim.id) ? " · cité" : ""}</small></div>
            <div className="claim-body"><span>{claim.claim_type.replaceAll("_", " ")} · {claim.certainty_language.replaceAll("_", " ")}</span><h4>{claim.statement}</h4><p>{claim.verification_reason}</p>{claim.safe_narration && <blockquote>Script sûr : « {claim.safe_narration} »</blockquote>}
              <div className="claim-evidence-list">{claim.evidence.length > 0 ? claim.evidence.map((item) => <div key={item.id}><span>{SOURCE_LABELS[item.evidence_type]}</span><strong>{timecode(item.start_ms)}{item.end_ms !== null ? `–${timecode(item.end_ms)}` : ""}</strong><b>{Math.round(item.strength * 100)}%</b><small title={item.source_id}>{String(item.metadata["observed_text"] ?? item.metadata["observed_label"] ?? item.metadata["canonical_key"] ?? item.metadata["rationale"] ?? item.source_id)}</small></div>) : <div className="no-evidence">Aucune preuve qualifiante — claim explicitement exclu.</div>}</div>
            </div>
          </article>
        ))}</div>
      </div>

      <div className="knowledge-panel">
        <div className="panel-heading"><div><span>KNOWLEDGE · {evidence.knowledge_snapshot.namespace.toUpperCase()}</span><h3>Base versionnée et isolée</h3></div><span className="namespace-chip">{evidence.knowledge_snapshot.game_version} · {evidence.knowledge_items.length} item(s)</span></div>
        <p className="knowledge-notice">{evidence.knowledge_snapshot.notice} GTA V et GTA VI ne partagent automatiquement aucun fait.</p>
        <div className="knowledge-grid">{evidence.knowledge_items.length > 0 ? evidence.knowledge_items.map((item) => <article key={item.id}><span>{item.namespace}</span><strong>{String(item.value["label"] ?? item.canonical_key)}</strong><p>{item.canonical_key}</p><small>r{item.revision} · {item.revision_count} révision(s) · {item.project_usage_count} usage(s) · {STATUS_LABELS[item.status]}</small></article>) : <div className="knowledge-empty">Namespace volontairement vide : aucune connaissance non vérifiée n’a été préchargée.</div>}</div>
      </div>
    </section>
  );
}
