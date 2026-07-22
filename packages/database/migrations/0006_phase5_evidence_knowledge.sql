PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

ALTER TABLE claims
ADD COLUMN game_id TEXT NOT NULL DEFAULT 'unknown' CHECK (game_id IN ('gta5', 'gta6', 'unknown'));

ALTER TABLE claims
ADD COLUMN claim_key TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE claims
ADD COLUMN claim_type TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE claims
ADD COLUMN normalized_statement TEXT NOT NULL DEFAULT '';

ALTER TABLE claims
ADD COLUMN allowed_in_script INTEGER NOT NULL DEFAULT 0 CHECK (allowed_in_script IN (0, 1));

ALTER TABLE claims
ADD COLUMN certainty_language TEXT NOT NULL DEFAULT 'excluded';

ALTER TABLE claims
ADD COLUMN verification_reason TEXT;

ALTER TABLE claims
ADD COLUMN verified_at TEXT;

ALTER TABLE claims
ADD COLUMN algorithm_version TEXT NOT NULL DEFAULT 'evidence-engine-v1';

CREATE INDEX ix_claims_game_key_status
ON claims(game_id, claim_key, status, created_at DESC);

CREATE TABLE verification_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    brief_id TEXT NOT NULL REFERENCES editorial_briefs(id) ON DELETE RESTRICT,
    game_id TEXT NOT NULL CHECK (game_id IN ('gta5', 'gta6', 'unknown')),
    algorithm_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PASSED', 'PASSED_WITH_EXCLUSIONS', 'FAILED')),
    report_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
    created_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    UNIQUE(project_id, brief_id)
) STRICT;

ALTER TABLE claims
ADD COLUMN verification_run_id TEXT REFERENCES verification_runs(id) ON DELETE CASCADE;

CREATE INDEX ix_claims_verification_run
ON claims(verification_run_id, created_at);

CREATE TABLE claim_status_history (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('hypothesis', 'observed_once', 'reproduced', 'verified', 'contradicted', 'outdated', 'unknown')),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    reason TEXT NOT NULL,
    origin TEXT NOT NULL,
    occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_claim_status_history_claim_time
ON claim_status_history(claim_id, occurred_at);

CREATE TABLE knowledge_revisions (
    id TEXT PRIMARY KEY,
    knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    source_uri TEXT,
    source_type TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    status TEXT NOT NULL CHECK (status IN ('hypothesis', 'observed_once', 'reproduced', 'verified', 'contradicted', 'outdated', 'unknown')),
    verified_at TEXT,
    change_reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(knowledge_item_id, revision)
) STRICT;

CREATE INDEX ix_knowledge_revisions_item
ON knowledge_revisions(knowledge_item_id, revision DESC);

CREATE TABLE knowledge_usages (
    id TEXT PRIMARY KEY,
    knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE RESTRICT,
    knowledge_revision INTEGER NOT NULL CHECK (knowledge_revision > 0),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    usage_kind TEXT NOT NULL CHECK (usage_kind IN ('verification', 'context', 'contradiction_check')),
    created_at TEXT NOT NULL,
    UNIQUE(knowledge_item_id, project_id, claim_id, usage_kind)
) STRICT;

CREATE INDEX ix_knowledge_usages_project
ON knowledge_usages(project_id, created_at DESC);

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (6, 'phase5_evidence_knowledge', '0000000000000000000000000000000000000000000000000000000000000000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;
