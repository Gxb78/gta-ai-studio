PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- Global cache: NO foreign key to projects
CREATE TABLE preview_cache_entries (
    cache_key         TEXT PRIMARY KEY,
    artifact_uri      TEXT,
    artifact_sha256   TEXT,
    status            TEXT NOT NULL CHECK (status IN (
        'pending', 'rendering', 'ready', 'corrupted', 'failed'
    )) DEFAULT 'pending',
    size_bytes        INTEGER NOT NULL DEFAULT 0,
    render_profile    TEXT NOT NULL CHECK (render_profile IN ('draft', 'fidelity')),
    renderer_version  TEXT NOT NULL,
    error_message     TEXT,
    created_at        TEXT NOT NULL,
    last_accessed_at  TEXT NOT NULL,
    hit_count         INTEGER NOT NULL DEFAULT 0,
    linked_project_count INTEGER NOT NULL DEFAULT 0,
    pin_count         INTEGER NOT NULL DEFAULT 0,
    job_run_id        TEXT REFERENCES job_runs(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX ix_preview_cache_lru
    ON preview_cache_entries(last_accessed_at ASC);

CREATE TABLE project_preview_cache_refs (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cache_key   TEXT NOT NULL REFERENCES preview_cache_entries(cache_key) ON DELETE CASCADE,
    clip_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (project_id, cache_key, clip_id)
) STRICT;

CREATE INDEX ix_project_preview_refs_cache
    ON project_preview_cache_refs(cache_key);

CREATE INDEX ix_preview_cache_status
    ON preview_cache_entries(status, pin_count);

-- Trigger: décrémenter linked_project_count lors de la suppression d'une ref
CREATE TRIGGER tg_preview_ref_decrement
AFTER DELETE ON project_preview_cache_refs
BEGIN
    UPDATE preview_cache_entries
    SET linked_project_count = linked_project_count - 1
    WHERE cache_key = OLD.cache_key;
END;

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (10, 'preview_cache', '0000000000000000000000000000000000000000000000000000000000000000',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;
