# Modèle de données

## Principes

- Identifiant applicatif : UUID v7 en texte canonique.
- Horodatages : UTC RFC 3339 (`TEXT`) ; aucun temps local en base.
- Montants : unités mineures entières + devise ISO 4217.
- Scores : nombres entre 0 et 1 avec contrainte SQL.
- Données flexibles : JSON canonique seulement quand la structure varie réellement ; les champs de recherche restent normalisés.
- Médias : chemin/URI + empreinte SHA-256 + taille, jamais de gros BLOB en base.
- Suppression projet : suppression logique immédiate, purge physique orchestrée et auditée.

## Agrégats majeurs

| Agrégat | Racine | Enfants / références |
| --- | --- | --- |
| Projet | `projects` | briefs, médias, maps, scripts, timelines, rendus, QC, jobs |
| Média | `media_assets` | derivatives, segments, analyses, frames, détections |
| Analyse | `analysis_runs` | frames, textes OCR, entités et événements candidats |
| Narration | `narrative_maps` | beats, content plans, scripts, script blocks |
| Preuve | `claims` | evidence, knowledge items, usages |
| Plan de montage | `advanced_edit_plans` | subject track points, overlay cues, artefacts JSON/ASS |
| Pack créatif | `creative_packages` | thumbnail candidates, metadata candidates, artefact JSON |
| Montage | `edit_projects` | timeline tracks, clips, voice tracks, render jobs |
| Exécution | `job_runs` | dependencies, artifacts, audit events |

## Traçabilité

Un contenu final doit être remontable jusqu’aux sources :

```text
publication
  -> render_job
  -> edit_project / timeline clips
  -> script blocks / claims
  -> segments / media asset / timecodes
  -> original file fingerprint
  -> model runs / provider calls / prompts
  -> quality checks / user decisions
```

Les tables `audit_events`, `model_runs` et `provider_calls` ne doivent contenir ni secret ni média brut.

## Concurrence

Les lignes mutables majeures possèdent `row_version`. Une mise à jour s’effectue avec `WHERE id = ? AND row_version = ?`, puis incrémente la version. Un résultat nul signale un conflit et ne doit pas être écrasé silencieusement.

La queue utilise des leases (`lease_owner`, `lease_expires_at`) et une clé d’idempotence unique. Les dépendances sont explicites dans `job_dependencies`.

## Migrations exécutables

La fondation vient de [`0001_initial.sql`](../packages/database/migrations/0001_initial.sql). La Phase 3 active l’analyse visuelle via [`0004_phase3_visual_analysis.sql`](../packages/database/migrations/0004_phase3_visual_analysis.sql). La Phase 4 ajoute [`0005_phase4_narrative_intelligence.sql`](../packages/database/migrations/0005_phase4_narrative_intelligence.sql) : version d’algorithme et couverture globale sur `narrative_maps`, concept/décision sur chaque beat, rapport complet dans `coverage_reports` et index de sélection des variantes. La Phase 5 ajoute [`0006_phase5_evidence_knowledge.sql`](../packages/database/migrations/0006_phase5_evidence_knowledge.sql) : exécutions de vérification, rattachement des claims à leur run, historique de statut, révisions de connaissance et usages par projet.

La Phase 6 ajoute [`0007_phase6_advanced_editing.sql`](../packages/database/migrations/0007_phase6_advanced_editing.sql). `advanced_edit_plans` conserve le template, la version d’algorithme, les métriques et le plan canonique ; `subject_track_points` normalise les focus horodatés avec méthode et confiance ; `overlay_cues` conserve timing, texte, template, paramètres et claims de support. Le plan référence séparément ses artefacts JSON et ASS.

La Phase 7 ajoute [`0008_phase7_creative_package.sql`](../packages/database/migrations/0008_phase7_creative_package.sql). `creative_packages` rattache une révision de brief à son rendu et à l’artefact JSON canonique. Les tables fondatrices `thumbnail_candidates` et `metadata_candidates` reçoivent le package, le rang/catégorie, les sous-scores et la provenance. Une miniature conserve ses frames sources et son segment principal ; une proposition éditoriale conserve plateforme, catégorie, contenu détaillé, claims admis et absence explicite de score historique.

La passe 0.7.2 ajoute [`0009_timeline_editor.sql`](../packages/database/migrations/0009_timeline_editor.sql). `timeline_edit_revisions` relie chaque nouvel `edit_project` à sa révision parente et aux artefacts immuables d’état, timeline et overlays. `timeline_clip_previews` conserve les rendus ciblés par révision et index de plan. Les anciens montages et previews ne sont jamais remplacés.

Chaque `coverage_report` conserve les manquants, ambiguïtés, séquences de faible qualité, faits à vérifier, demandes de rush et décision de montage. Les trois `content_plans` sont persistés ensemble ; un seul est marqué `selected`. Le script référence directement ce plan retenu, sans recréer une carte narrative fictive.

Chaque `verification_run` est unique par projet et révision de brief. Ses claims possèdent une clé canonique, un statut, une confiance, une décision `allowed_in_script`, une formulation de certitude et zéro ou plusieurs preuves. Les preuves conservent type, source, force, intervalle et métadonnées. `knowledge_revisions` rend l’historique append-only ; `knowledge_usages` rattache exactement la révision consommée au claim et au projet.

WAL, `foreign_keys=ON`, `busy_timeout` et une stratégie de sauvegarde sont configurés à chaque ouverture de connexion par la future couche database ; le `PRAGMA` de la migration sert uniquement de valeur sûre pour les outils manuels.

## Versionnement

- Une migration appliquée n’est jamais modifiée.
- Une évolution additive reçoit le numéro suivant (`0002_...sql`).
- Les migrations destructives utilisent une table de remplacement, une copie vérifiée, puis un échange atomique.
- `schema_migrations` enregistre le numéro, l’empreinte et l’horodatage.
- La compatibilité des contrats suit `MAJOR.MINOR` ; un champ supprimé ou sémantiquement modifié incrémente `MAJOR`.
