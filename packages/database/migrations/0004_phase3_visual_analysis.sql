PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE analysis_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    brief_id TEXT NOT NULL REFERENCES editorial_briefs(id) ON DELETE RESTRICT,
    adapter_id TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    vision_version TEXT NOT NULL,
    ocr_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
    report_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(project_id, brief_id)
) STRICT;

CREATE INDEX ix_analysis_runs_project_created
ON analysis_runs(project_id, created_at DESC);

CREATE TABLE analysis_frames (
    id TEXT PRIMARY KEY,
    analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    timestamp_ms INTEGER NOT NULL CHECK (timestamp_ms >= 0),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
    detections_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detections_json)),
    created_at TEXT NOT NULL,
    UNIQUE(analysis_run_id, timestamp_ms)
) STRICT;

CREATE INDEX ix_analysis_frames_run_time
ON analysis_frames(analysis_run_id, timestamp_ms);

ALTER TABLE detected_texts
ADD COLUMN analysis_run_id TEXT REFERENCES analysis_runs(id) ON DELETE CASCADE;

ALTER TABLE detected_texts
ADD COLUMN frame_id TEXT REFERENCES analysis_frames(id) ON DELETE CASCADE;

ALTER TABLE detected_entities
ADD COLUMN analysis_run_id TEXT REFERENCES analysis_runs(id) ON DELETE CASCADE;

ALTER TABLE detected_entities
ADD COLUMN frame_id TEXT REFERENCES analysis_frames(id) ON DELETE CASCADE;

ALTER TABLE detected_events
ADD COLUMN analysis_run_id TEXT REFERENCES analysis_runs(id) ON DELETE CASCADE;

ALTER TABLE detected_events
ADD COLUMN frame_id TEXT REFERENCES analysis_frames(id) ON DELETE CASCADE;

CREATE INDEX ix_detected_texts_analysis_run
ON detected_texts(analysis_run_id, start_ms);

CREATE INDEX ix_detected_entities_analysis_run
ON detected_entities(analysis_run_id, start_ms);

CREATE INDEX ix_detected_events_analysis_run
ON detected_events(analysis_run_id, start_ms);

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (4, 'phase3_visual_analysis', '0000000000000000000000000000000000000000000000000000000000000000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;
