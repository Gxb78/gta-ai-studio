from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .errors import StudioError


CHECKSUM_PLACEHOLDER = "0" * 64


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        try:
            return bool(super().__exit__(exc_type, exc_value, traceback))
        finally:
            self.close()


class Database:
    def __init__(self, path: Path, migration_dir: Path) -> None:
        self.path = path
        self.migration_dir = migration_dir

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.path,
            timeout=5,
            isolation_level=None,
            factory=ClosingConnection,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        migrations = sorted(self.migration_dir.glob("[0-9][0-9][0-9][0-9]_*.sql"))
        if not migrations:
            raise StudioError("STORAGE_MIGRATIONS_MISSING", f"No migration found in {self.migration_dir}", status_code=500)

        with self.connect() as connection:
            table_exists = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
            ).fetchone() is not None
            applied: dict[int, str] = {}
            if table_exists:
                applied = {
                    int(row["version"]): str(row["checksum_sha256"])
                    for row in connection.execute("SELECT version, checksum_sha256 FROM schema_migrations")
                }

            for migration in migrations:
                version = int(migration.name.split("_", 1)[0])
                source = migration.read_text(encoding="utf-8")
                checksum = hashlib.sha256(source.encode("utf-8")).hexdigest()
                if version in applied:
                    if applied[version] != checksum:
                        raise StudioError(
                            "STORAGE_MIGRATION_DRIFT",
                            f"Migration {migration.name} changed after application.",
                            status_code=500,
                        )
                    continue
                if CHECKSUM_PLACEHOLDER not in source:
                    raise StudioError(
                        "STORAGE_MIGRATION_CHECKSUM_PLACEHOLDER_MISSING",
                        f"Migration {migration.name} has no checksum placeholder.",
                        status_code=500,
                    )
                connection.executescript(source.replace(CHECKSUM_PLACEHOLDER, checksum, 1))
                table_exists = True
                applied[version] = checksum

            violations = list(connection.execute("PRAGMA foreign_key_check"))
            if violations:
                raise StudioError("STORAGE_FOREIGN_KEY_VIOLATION", "Database foreign key check failed.", status_code=500)

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
