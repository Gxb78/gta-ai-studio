PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE INDEX ix_artifacts_project_kind
ON artifacts(project_id, kind, created_at)
WHERE deleted_at IS NULL;

CREATE INDEX ix_scripts_project_selected
ON scripts(project_id, selected, revision DESC);

CREATE INDEX ix_render_jobs_project_created
ON render_jobs(project_id, created_at DESC);

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (3, 'phase2_production_indexes', '0000000000000000000000000000000000000000000000000000000000000000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;
