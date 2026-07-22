PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

ALTER TABLE media_assets
ADD COLUMN game_id TEXT NOT NULL DEFAULT 'unknown'
CHECK (game_id IN ('gta5', 'gta6', 'unknown'));

UPDATE media_assets
SET game_id = COALESCE(
    (SELECT projects.game_id FROM projects WHERE projects.id = media_assets.project_id),
    'unknown'
);

INSERT INTO schema_migrations(version, name, checksum_sha256, applied_at)
VALUES (2, 'media_game_id', '0000000000000000000000000000000000000000000000000000000000000000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;

