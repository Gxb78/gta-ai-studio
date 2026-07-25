PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE advanced_edit_plans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    brief_id TEXT NOT NULL REFERENCES editorial_briefs(id) ON DELETE RESTRICT,
    plan_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    overlay_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    template_id TEXT NOT NULL,
    template_version TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('READY', 'READY_WITH_FALLBACKS', 'FAILED')),
    tracking_confidence REAL NOT NULL CHECK (tracking_confidence BETWEEN 0 AND 1),
    dynamic_reframe_count INTEGER NOT NULL CHECK (dynamic_reframe_count >= 0),
    overlay_count INTEGER NOT NULL CHECK (overlay_count >= 0),
    zoom_effect_count INTEGER NOT NULL CHECK (zoom_effect_count >= 0),
    speed_effect_count INTEGER NOT NULL CHECK (speed_effect_count >= 0),
    comparison_count INTEGER NOT NULL CHECK (comparison_count >= 0),
    plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
    created_at TEXT NOT NULL,
    UNIQUE(project_id, brief_id)
) STRICT;

CREATE INDEX ix_advanced_edit_plans_project_created
ON advanced_edit_plans(project_id, created_at DESC);

CREATE TABLE subject_track_points (
    id TEXT PRIMARY KEY,
    advanced_edit_plan_id TEXT NOT NULL REFERENCES advanced_edit_plans(id) ON DELETE CASCADE,
    segment_id TEXT REFERENCES segments(id) ON DELETE SET NULL,
    frame_id TEXT REFERENCES analysis_frames(id) ON DELETE SET NULL,
    timestamp_ms INTEGER NOT NULL CHECK (timestamp_ms >= 0),
    focus_x REAL NOT NULL CHECK (focus_x BETWEEN 0 AND 1),
    focus_y REAL NOT NULL CHECK (focus_y BETWEEN 0 AND 1),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    method TEXT NOT NULL CHECK (method IN ('evidence_region', 'visual_attention', 'combined', 'center_fallback')),
    source_type TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_subject_track_points_plan_time
ON subject_track_points(advanced_edit_plan_id, timestamp_ms);

CREATE TABLE overlay_cues (
    id TEXT PRIMARY KEY,
    advanced_edit_plan_id TEXT NOT NULL REFERENCES advanced_edit_plans(id) ON DELETE CASCADE,
    cue_type TEXT NOT NULL CHECK (cue_type IN ('title', 'step', 'proof', 'before_after', 'result', 'conclusion')),
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    text TEXT NOT NULL,
    secondary_text TEXT,
    template_key TEXT NOT NULL,
    supporting_claim_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_claim_ids_json)),
    parameters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(parameters_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_overlay_cues_plan_time
ON overlay_cues(advanced_edit_plan_id, start_ms);

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (7, 'phase6_advanced_editing', '0000000000000000000000000000000000000000000000000000000000000000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;
