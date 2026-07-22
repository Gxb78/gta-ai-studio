PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

ALTER TABLE narrative_maps
ADD COLUMN algorithm_version TEXT NOT NULL DEFAULT 'narrative-map-rules-v1';

ALTER TABLE narrative_maps
ADD COLUMN overall_coverage REAL NOT NULL DEFAULT 0 CHECK (overall_coverage BETWEEN 0 AND 1);

ALTER TABLE narrative_maps
ADD COLUMN content_type TEXT NOT NULL DEFAULT 'other';

ALTER TABLE narrative_beats
ADD COLUMN concept TEXT;

ALTER TABLE narrative_beats
ADD COLUMN purpose TEXT;

ALTER TABLE narrative_beats
ADD COLUMN explicitly_requested INTEGER NOT NULL DEFAULT 0 CHECK (explicitly_requested IN (0, 1));

ALTER TABLE narrative_beats
ADD COLUMN decision_reason TEXT;

CREATE TABLE coverage_reports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    brief_id TEXT NOT NULL REFERENCES editorial_briefs(id) ON DELETE RESTRICT,
    narrative_map_id TEXT NOT NULL REFERENCES narrative_maps(id) ON DELETE CASCADE,
    required_coverage REAL NOT NULL CHECK (required_coverage BETWEEN 0 AND 1),
    overall_coverage REAL NOT NULL CHECK (overall_coverage BETWEEN 0 AND 1),
    editing_decision TEXT NOT NULL CHECK (editing_decision IN (
        'ready_with_prudent_narration',
        'continue_adapted_with_warning',
        'continue_partial_and_request_footage'
    )),
    report_json TEXT NOT NULL CHECK (json_valid(report_json)),
    created_at TEXT NOT NULL,
    UNIQUE(narrative_map_id)
) STRICT;

CREATE INDEX ix_coverage_reports_project_created
ON coverage_reports(project_id, created_at DESC);

CREATE INDEX ix_content_plans_map_selected
ON content_plans(narrative_map_id, selected, score DESC);

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (5, 'phase4_narrative_intelligence', '0000000000000000000000000000000000000000000000000000000000000000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;
