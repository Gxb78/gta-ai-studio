PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

BEGIN IMMEDIATE;

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
    applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    game_id TEXT NOT NULL DEFAULT 'unknown' CHECK (game_id IN ('gta5', 'gta6', 'unknown')),
    pipeline_stage TEXT NOT NULL DEFAULT 'CREATED' CHECK (pipeline_stage IN (
        'CREATED', 'SOURCE_SELECTED', 'BRIEF_CAPTURED', 'BRIEF_STRUCTURED', 'INGESTED',
        'PROXIED', 'ANALYZED', 'SEGMENTED', 'NARRATIVE_MAPPED', 'COVERAGE_CHECKED',
        'CONTENT_PLANNED', 'FACTS_VERIFIED', 'SCRIPTED', 'VOICED', 'TIMELINE_BUILT',
        'DRAFT_RENDERED', 'QC_ANALYZED', 'CORRECTED', 'FINAL_RENDERED',
        'READY_TO_PUBLISH', 'PUBLISHED', 'ANALYTICS_COLLECTED', 'LEARNING_UPDATED'
    )),
    run_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (run_status IN (
        'ACTIVE', 'PAUSED', 'WAITING_FOR_USER', 'WAITING_FOR_PROVIDER', 'MISSING_FOOTAGE',
        'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED', 'COMPLETED'
    )),
    target_stage TEXT NOT NULL DEFAULT 'FINAL_RENDERED' CHECK (target_stage IN (
        'CREATED', 'SOURCE_SELECTED', 'BRIEF_CAPTURED', 'BRIEF_STRUCTURED', 'INGESTED',
        'PROXIED', 'ANALYZED', 'SEGMENTED', 'NARRATIVE_MAPPED', 'COVERAGE_CHECKED',
        'CONTENT_PLANNED', 'FACTS_VERIFIED', 'SCRIPTED', 'VOICED', 'TIMELINE_BUILT',
        'DRAFT_RENDERED', 'QC_ANALYZED', 'CORRECTED', 'FINAL_RENDERED',
        'READY_TO_PUBLISH', 'PUBLISHED', 'ANALYTICS_COLLECTED', 'LEARNING_UPDATED'
    )),
    data_policy TEXT NOT NULL DEFAULT 'local_only' CHECK (data_policy IN ('local_only', 'metadata_only', 'media_allowed')),
    failure_code TEXT,
    failure_message TEXT,
    row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
) STRICT;

CREATE TABLE editorial_briefs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    raw_instruction TEXT NOT NULL,
    structured_json TEXT NOT NULL CHECK (json_valid(structured_json)),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE(project_id, revision)
) STRICT;

CREATE UNIQUE INDEX ux_editorial_briefs_current
    ON editorial_briefs(project_id) WHERE is_current = 1;

CREATE TABLE media_assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'image', 'subtitle', 'document')),
    status TEXT NOT NULL CHECK (status IN ('registered', 'verified', 'invalid', 'deleted')),
    original_uri TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    fps_numerator INTEGER CHECK (fps_numerator IS NULL OR fps_numerator > 0),
    fps_denominator INTEGER CHECK (fps_denominator IS NULL OR fps_denominator > 0),
    video_codec TEXT,
    audio_codec TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    captured_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, sha256)
) STRICT;

CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    uri TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    media_type TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    deleted_at TEXT
) STRICT;

CREATE INDEX ix_artifacts_cache ON artifacts(kind, algorithm_version, input_fingerprint) WHERE deleted_at IS NULL;

CREATE TABLE media_derivatives (
    id TEXT PRIMARY KEY,
    source_media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(source_media_id, artifact_id, kind)
) STRICT;

CREATE TABLE game_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL CHECK (game_id IN ('gta5', 'gta6', 'unknown')),
    game_version TEXT,
    platform TEXT NOT NULL DEFAULT 'ps5',
    started_at TEXT,
    ended_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE TABLE segments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    scene_type TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    motion_score REAL NOT NULL CHECK (motion_score BETWEEN 0 AND 1),
    visual_quality_score REAL NOT NULL CHECK (visual_quality_score BETWEEN 0 AND 1),
    relevance_score REAL NOT NULL CHECK (relevance_score BETWEEN 0 AND 1),
    novelty_score REAL NOT NULL CHECK (novelty_score BETWEEN 0 AND 1),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    has_dialogue INTEGER NOT NULL DEFAULT 0 CHECK (has_dialogue IN (0, 1)),
    has_music INTEGER NOT NULL DEFAULT 0 CHECK (has_music IN (0, 1)),
    has_potential_copyright_music INTEGER NOT NULL DEFAULT 0 CHECK (has_potential_copyright_music IN (0, 1)),
    transcript TEXT,
    attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
    created_at TEXT NOT NULL,
    UNIQUE(media_id, start_ms, end_ms)
) STRICT;

CREATE INDEX ix_segments_media_time ON segments(media_id, start_ms, end_ms);
CREATE INDEX ix_segments_project_relevance ON segments(project_id, relevance_score DESC);

CREATE TABLE detected_texts (
    id TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    locale TEXT,
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    region_json TEXT CHECK (region_json IS NULL OR json_valid(region_json)),
    detector_version TEXT NOT NULL
) STRICT;

CREATE INDEX ix_detected_texts_normalized ON detected_texts(normalized_text);

CREATE TABLE detected_entities (
    id TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    canonical_id TEXT,
    label TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    start_ms INTEGER,
    end_ms INTEGER,
    region_json TEXT CHECK (region_json IS NULL OR json_valid(region_json)),
    detector_version TEXT NOT NULL,
    attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json))
) STRICT;

CREATE INDEX ix_detected_entities_lookup ON detected_entities(entity_type, canonical_id);

CREATE TABLE detected_events (
    id TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    detector_version TEXT NOT NULL,
    attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json))
) STRICT;

CREATE INDEX ix_detected_events_type ON detected_events(event_type, start_ms);

CREATE TABLE narrative_maps (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    brief_id TEXT NOT NULL REFERENCES editorial_briefs(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    required_coverage REAL NOT NULL CHECK (required_coverage BETWEEN 0 AND 1),
    missing_required_count INTEGER NOT NULL CHECK (missing_required_count >= 0),
    created_at TEXT NOT NULL,
    UNIQUE(project_id, revision)
) STRICT;

CREATE TABLE narrative_beats (
    id TEXT PRIMARY KEY,
    narrative_map_id TEXT NOT NULL REFERENCES narrative_maps(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    intent TEXT NOT NULL,
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('found', 'partially_found', 'ambiguous', 'missing', 'contradicted', 'unusable')),
    candidates_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates_json)),
    UNIQUE(narrative_map_id, sort_order)
) STRICT;

CREATE TABLE knowledge_items (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    canonical_key TEXT NOT NULL,
    game_id TEXT NOT NULL CHECK (game_id IN ('gta5', 'gta6', 'unknown')),
    game_version TEXT,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    source_uri TEXT,
    source_type TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    status TEXT NOT NULL CHECK (status IN ('hypothesis', 'observed_once', 'reproduced', 'verified', 'contradicted', 'outdated', 'unknown')),
    verified_at TEXT,
    valid_from TEXT,
    valid_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(namespace, canonical_key, game_version)
) STRICT;

CREATE TABLE claims (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    statement TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('hypothesis', 'observed_once', 'reproduced', 'verified', 'contradicted', 'outdated', 'unknown')),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    game_version TEXT,
    observed_at TEXT,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    start_ms INTEGER,
    end_ms INTEGER,
    strength REAL NOT NULL CHECK (strength BETWEEN 0 AND 1),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_evidence_claim ON evidence(claim_id);

CREATE TABLE content_plans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    narrative_map_id TEXT NOT NULL REFERENCES narrative_maps(id) ON DELETE RESTRICT,
    variant TEXT NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
    score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE scripts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content_plan_id TEXT NOT NULL REFERENCES content_plans(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    language TEXT NOT NULL,
    estimated_duration_ms INTEGER NOT NULL CHECK (estimated_duration_ms > 0),
    selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE(project_id, revision)
) STRICT;

CREATE TABLE script_blocks (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    purpose TEXT NOT NULL,
    narration TEXT NOT NULL,
    on_screen_text TEXT,
    supporting_segment_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_segment_ids_json)),
    supporting_claim_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_claim_ids_json)),
    estimated_duration_ms INTEGER NOT NULL CHECK (estimated_duration_ms > 0),
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    UNIQUE(script_id, sort_order)
) STRICT;

CREATE TABLE voice_tracks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE RESTRICT,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    provider_call_id TEXT REFERENCES provider_calls(id) ON DELETE SET NULL,
    voice_id TEXT NOT NULL,
    locale TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    alignment_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alignment_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE edit_projects (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    script_id TEXT REFERENCES scripts(id) ON DELETE RESTRICT,
    schema_version TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    fps_numerator INTEGER NOT NULL CHECK (fps_numerator > 0),
    fps_denominator INTEGER NOT NULL CHECK (fps_denominator > 0),
    timebase_numerator INTEGER NOT NULL CHECK (timebase_numerator > 0),
    timebase_denominator INTEGER NOT NULL CHECK (timebase_denominator > 0),
    duration INTEGER NOT NULL CHECK (duration > 0),
    timeline_json TEXT NOT NULL CHECK (json_valid(timeline_json)),
    created_at TEXT NOT NULL,
    UNIQUE(project_id, revision)
) STRICT;

CREATE TABLE timeline_tracks (
    id TEXT PRIMARY KEY,
    edit_project_id TEXT NOT NULL REFERENCES edit_projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'text', 'overlay')),
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    exclusive INTEGER NOT NULL CHECK (exclusive IN (0, 1)),
    muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
    UNIQUE(edit_project_id, sort_order)
) STRICT;

CREATE TABLE timeline_clips (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES timeline_tracks(id) ON DELETE CASCADE,
    start_time INTEGER NOT NULL CHECK (start_time >= 0),
    duration INTEGER NOT NULL CHECK (duration > 0),
    source_media_id TEXT REFERENCES media_assets(id) ON DELETE RESTRICT,
    source_in INTEGER,
    source_duration INTEGER,
    clip_json TEXT NOT NULL CHECK (json_valid(clip_json))
) STRICT;

CREATE INDEX ix_timeline_clips_track_time ON timeline_clips(track_id, start_time);

CREATE TABLE render_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    edit_project_id TEXT NOT NULL REFERENCES edit_projects(id) ON DELETE RESTRICT,
    job_run_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    render_kind TEXT NOT NULL CHECK (render_kind IN ('draft', 'final', 'thumbnail', 'preview')),
    status TEXT NOT NULL,
    ffmpeg_version TEXT,
    render_plan_json TEXT CHECK (render_plan_json IS NULL OR json_valid(render_plan_json)),
    created_at TEXT NOT NULL,
    completed_at TEXT
) STRICT;

CREATE TABLE quality_checks (
    id TEXT PRIMARY KEY,
    render_job_id TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
    check_id TEXT NOT NULL,
    check_version TEXT NOT NULL,
    dimension TEXT NOT NULL CHECK (dimension IN ('technical', 'editorial', 'factual', 'audio', 'subtitle', 'visual', 'platform')),
    status TEXT NOT NULL CHECK (status IN ('pass', 'warn', 'fail', 'skipped')),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocker')),
    message TEXT NOT NULL,
    measured_json TEXT NOT NULL CHECK (json_valid(measured_json)),
    threshold_json TEXT NOT NULL CHECK (json_valid(threshold_json)),
    evidence_artifact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_artifact_ids_json)),
    correction_action TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(render_job_id, check_id, check_version)
) STRICT;

CREATE TABLE thumbnail_candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    source_segment_id TEXT REFERENCES segments(id) ON DELETE SET NULL,
    score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
    selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE metadata_candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
    selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE publications (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    render_job_id TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE RESTRICT,
    platform TEXT NOT NULL,
    remote_id TEXT,
    status TEXT NOT NULL,
    published_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE metric_snapshots (
    id TEXT PRIMARY KEY,
    publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
    captured_at TEXT NOT NULL,
    metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
    UNIQUE(publication_id, captured_at)
) STRICT;

CREATE TABLE experiments (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    experiment_type TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    status TEXT NOT NULL,
    variants_json TEXT NOT NULL CHECK (json_valid(variants_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    created_at TEXT NOT NULL,
    completed_at TEXT
) STRICT;

CREATE TABLE user_preferences (
    id TEXT PRIMARY KEY,
    preference_key TEXT NOT NULL UNIQUE,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    source TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE brand_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_brand_profiles_default ON brand_profiles(is_default) WHERE is_default = 1;

CREATE TABLE model_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    job_run_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL,
    capability TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version TEXT,
    prompt_fingerprint TEXT CHECK (prompt_fingerprint IS NULL OR length(prompt_fingerprint) = 64),
    input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
    parameters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(parameters_json)),
    output_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL
) STRICT;

CREATE TABLE provider_calls (
    id TEXT PRIMARY KEY,
    model_run_id TEXT REFERENCES model_runs(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE,
    provider_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    status TEXT NOT NULL,
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    cost_minor INTEGER CHECK (cost_minor IS NULL OR cost_minor >= 0),
    currency TEXT,
    usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
    transmitted_data_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transmitted_data_json)),
    error_code TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
) STRICT;

CREATE TABLE game_adapters (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL CHECK (game_id IN ('gta5', 'gta6')),
    version TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    installed_at TEXT NOT NULL,
    UNIQUE(game_id, version)
) STRICT;

CREATE TABLE job_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('QUEUED', 'BLOCKED', 'LEASED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    priority INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
    algorithm_version TEXT NOT NULL,
    parameters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(parameters_json)),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    progress REAL NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
    lease_owner TEXT,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    next_retry_at TEXT,
    cancel_requested_at TEXT,
    error_code TEXT,
    error_message TEXT,
    error_details_json TEXT CHECK (error_details_json IS NULL OR json_valid(error_details_json)),
    result_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    UNIQUE(project_id, idempotency_key)
) STRICT;

CREATE INDEX ix_job_runs_runnable ON job_runs(status, next_retry_at, priority DESC, created_at);
CREATE INDEX ix_job_runs_lease ON job_runs(lease_expires_at) WHERE status IN ('LEASED', 'RUNNING');

CREATE TABLE job_dependencies (
    job_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
    depends_on_job_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
    required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
    PRIMARY KEY(job_id, depends_on_job_id),
    CHECK (job_id <> depends_on_job_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    job_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL,
    trace_id TEXT,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_audit_events_project_time ON audit_events(project_id, occurred_at);

CREATE TABLE outbox_events (
    id TEXT PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    occurred_at TEXT NOT NULL,
    published_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
) STRICT;

CREATE INDEX ix_outbox_events_pending ON outbox_events(occurred_at) WHERE published_at IS NULL;

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (1, 'initial', '0000000000000000000000000000000000000000000000000000000000000000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;
