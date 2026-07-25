PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE creative_packages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    brief_id TEXT NOT NULL REFERENCES editorial_briefs(id) ON DELETE RESTRICT,
    render_job_id TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE RESTRICT,
    package_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    algorithm_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('READY', 'READY_WITH_WARNINGS', 'FAILED')),
    selected_thumbnail_id TEXT,
    selected_metadata_ids_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(selected_metadata_ids_json)),
    package_json TEXT NOT NULL CHECK (json_valid(package_json)),
    created_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    UNIQUE(project_id, brief_id)
) STRICT;

CREATE INDEX ix_creative_packages_project_created
ON creative_packages(project_id, created_at DESC);

ALTER TABLE thumbnail_candidates
ADD COLUMN creative_package_id TEXT REFERENCES creative_packages(id) ON DELETE CASCADE;

ALTER TABLE thumbnail_candidates
ADD COLUMN source_frame_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_frame_ids_json));

ALTER TABLE thumbnail_candidates
ADD COLUMN rank INTEGER NOT NULL DEFAULT 1 CHECK (rank > 0);

ALTER TABLE thumbnail_candidates
ADD COLUMN template_key TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE thumbnail_candidates
ADD COLUMN headline TEXT NOT NULL DEFAULT '';

ALTER TABLE thumbnail_candidates
ADD COLUMN score_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(score_json));

ALTER TABLE thumbnail_candidates
ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json));

CREATE INDEX ix_thumbnail_candidates_package_rank
ON thumbnail_candidates(creative_package_id, rank);

ALTER TABLE metadata_candidates
ADD COLUMN creative_package_id TEXT REFERENCES creative_packages(id) ON DELETE CASCADE;

ALTER TABLE metadata_candidates
ADD COLUMN category TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE metadata_candidates
ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json));

ALTER TABLE metadata_candidates
ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json));

CREATE INDEX ix_metadata_candidates_package_platform_score
ON metadata_candidates(creative_package_id, platform, kind, score DESC);

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (8, 'phase7_creative_package', '0000000000000000000000000000000000000000000000000000000000000000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;
