from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .errors import JobCancelled, StudioError


ProgressCallback = Callable[[float], None]
CancelCallback = Callable[[], bool]


@dataclass(frozen=True)
class ManagedSource:
    path: Path
    uri: str
    sha256: str
    size_bytes: int


class Storage:
    def __init__(self, data_dir: Path, max_source_bytes: int) -> None:
        self.data_dir = data_dir.resolve()
        self.max_source_bytes = max_source_bytes

    def initialize(self) -> None:
        for name in ("inbox", "projects", "library", "cache", "temp", "backups", "datasets", "logs"):
            (self.data_dir / name).mkdir(parents=True, exist_ok=True)

    def validate_source(self, source_path: str) -> Path:
        if "\x00" in source_path:
            raise StudioError("MEDIA_INVALID_PATH", "Source path contains a null byte.")
        path = Path(source_path).expanduser().resolve(strict=False)
        if not path.exists() or not path.is_file():
            raise StudioError("MEDIA_SOURCE_NOT_FOUND", "The selected video does not exist.", status_code=404)
        if path.suffix.lower() != ".mp4":
            raise StudioError("MEDIA_UNSUPPORTED_CONTAINER", "GTA AI Studio accepts MP4 files only.")
        size = path.stat().st_size
        if size <= 0:
            raise StudioError("MEDIA_EMPTY_SOURCE", "The selected video is empty.")
        if size > self.max_source_bytes:
            raise StudioError("MEDIA_SOURCE_TOO_LARGE", "The selected video exceeds the configured size limit.")
        return path

    def project_dir(self, project_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f-]{36}", project_id):
            raise StudioError("STORAGE_INVALID_PROJECT_ID", "Invalid project identifier.", status_code=500)
        return self._inside(self.data_dir / "projects" / project_id)

    def prepare_project(self, project_id: str) -> Path:
        root = self.project_dir(project_id)
        for name in ("source", "proxy", "audio", "frames", "analysis", "scripts", "voice", "timelines", "renders", "thumbnails", "exports", "reports"):
            (root / name).mkdir(parents=True, exist_ok=True)
        return root

    def ingest_source(
        self,
        source_path: str,
        project_id: str,
        progress: ProgressCallback,
        cancelled: CancelCallback,
    ) -> ManagedSource:
        project_source = self._inside(self.prepare_project(project_id) / "source" / "original.mp4")
        if project_source.is_file() and project_source.stat().st_size > 0:
            existing_sha = sha256_file(project_source)
            progress(0.9)
            return ManagedSource(
                path=project_source,
                uri=self.to_uri(project_source),
                sha256=existing_sha,
                size_bytes=project_source.stat().st_size,
            )

        source = self.validate_source(source_path)
        total = source.stat().st_size
        temp = self._inside(self.data_dir / "temp" / f"{project_id}.ingest.partial.mp4")
        digest = hashlib.sha256()
        copied = 0
        try:
            with source.open("rb") as reader, temp.open("wb") as writer:
                while chunk := reader.read(4 * 1024 * 1024):
                    if cancelled():
                        raise JobCancelled()
                    writer.write(chunk)
                    digest.update(chunk)
                    copied += len(chunk)
                    progress(min(0.85, 0.85 * copied / total))
                writer.flush()
                os.fsync(writer.fileno())
            sha256 = digest.hexdigest()
            library_dir = self._inside(self.data_dir / "library" / "sources" / sha256)
            library_dir.mkdir(parents=True, exist_ok=True)
            library_path = self._inside(library_dir / "source.mp4")
            if library_path.exists():
                if library_path.stat().st_size != total or sha256_file(library_path) != sha256:
                    raise StudioError("STORAGE_HASH_COLLISION", "Existing source has a conflicting size.", status_code=500)
                temp.unlink(missing_ok=True)
            else:
                os.replace(temp, library_path)

            if not project_source.exists():
                try:
                    os.link(library_path, project_source)
                except OSError:
                    shutil.copy2(library_path, project_source)
            progress(0.9)
            return ManagedSource(
                path=project_source,
                uri=self.to_uri(project_source),
                sha256=sha256,
                size_bytes=total,
            )
        finally:
            temp.unlink(missing_ok=True)

    def write_json(self, project_id: str, relative: str, value: dict[str, Any]) -> Path:
        destination = self._inside(self.project_dir(project_id) / relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".partial")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, destination)
        return destination

    def project_file(self, project_id: str, relative: str) -> Path:
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise StudioError("SECURITY_INVALID_PROJECT_PATH", "Project path is outside the managed root.", status_code=500)
        destination = self._inside(self.prepare_project(project_id) / relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        return destination

    def write_text(self, project_id: str, relative: str, value: str) -> Path:
        destination = self.project_file(project_id, relative)
        temporary = destination.with_suffix(destination.suffix + ".partial")
        temporary.write_text(value, encoding="utf-8")
        os.replace(temporary, destination)
        return destination

    def proxy_cache_path(self, input_fingerprint: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{64}", input_fingerprint):
            raise StudioError("STORAGE_INVALID_FINGERPRINT", "Invalid proxy fingerprint.", status_code=500)
        path = self._inside(self.data_dir / "cache" / "proxies" / input_fingerprint / "proxy.mp4")
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def preview_cache_path(self, cache_key: str) -> Path:
        """Global preview cache path (not project-specific)."""
        if not re.fullmatch(r"[0-9a-f]{64}", cache_key):
            raise StudioError("STORAGE_INVALID_CACHE_KEY", "Invalid preview cache key.", status_code=500)
        # Sharding: ab/cd/abcdef...
        prefix = cache_key[:2]
        subdir = cache_key[2:4]
        path = self._inside(self.data_dir / "cache" / "previews" / prefix / subdir / f"{cache_key}.mp4")
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def link_project_proxy(self, project_id: str, cache_path: Path) -> Path:
        destination = self._inside(self.prepare_project(project_id) / "proxy" / "proxy.mp4")
        if destination.exists():
            return destination
        try:
            os.link(cache_path, destination)
        except OSError:
            shutil.copy2(cache_path, destination)
        return destination

    def resolve_uri(self, uri: str) -> Path:
        relative = Path(uri.replace("/", os.sep))
        if relative.is_absolute() or ".." in relative.parts:
            raise StudioError("SECURITY_INVALID_ARTIFACT_URI", "Artifact URI is outside the data root.", status_code=500)
        path = self._inside(self.data_dir / relative)
        return path

    def to_uri(self, path: Path) -> str:
        resolved = self._inside(path)
        return resolved.relative_to(self.data_dir).as_posix()

    def _inside(self, path: Path) -> Path:
        resolved = path.resolve(strict=False)
        try:
            resolved.relative_to(self.data_dir)
        except ValueError as error:
            raise StudioError("SECURITY_PATH_ESCAPE", "Resolved path escapes the data root.", status_code=500) from error
        return resolved


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
