from __future__ import annotations

import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "packages" / "database" / "migrations" / "0001_initial.sql"


def test_initial_migration_applies_to_empty_database() -> None:
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(MIGRATION.read_text(encoding="utf-8"))
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        assert {"projects", "media_assets", "job_runs", "audit_events"} <= tables
        assert list(connection.execute("PRAGMA foreign_key_check")) == []
    finally:
        connection.close()

