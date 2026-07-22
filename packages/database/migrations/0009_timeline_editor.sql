PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE timeline_edit_revisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    edit_project_id TEXT NOT NULL UNIQUE REFERENCES edit_projects(id) ON DELETE CASCADE,
    parent_edit_project_id TEXT REFERENCES edit_projects(id) ON DELETE SET NULL,
    base_advanced_edit_plan_id TEXT REFERENCES advanced_edit_plans(id) ON DELETE SET NULL,
    state_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    timeline_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    overlay_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    editor_state_json TEXT NOT NULL CHECK (json_valid(editor_state_json)),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_timeline_edit_revisions_project_created
ON timeline_edit_revisions(project_id, created_at DESC);

CREATE TABLE timeline_clip_previews (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    edit_project_id TEXT NOT NULL REFERENCES edit_projects(id) ON DELETE CASCADE,
    clip_index INTEGER NOT NULL CHECK (clip_index >= 0),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    job_run_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_timeline_clip_previews_lookup
ON timeline_clip_previews(edit_project_id, clip_index, created_at DESC);

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (9, 'timeline_editor', '0000000000000000000000000000000000000000000000000000000000000000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;
