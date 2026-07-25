from __future__ import annotations

import json
import logging
import logging.handlers
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


SENSITIVE_KEYS = {"authorization", "cookie", "password", "secret", "token", "api_key", "api-key"}


def _redact(value: Any, key: str = "") -> Any:
    if any(part in key.lower() for part in SENSITIVE_KEYS):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(child_key): _redact(child, str(child_key)) for child_key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact(child, key) for child in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "schema_version": "1.0",
            "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname,
            "event": getattr(record, "event", "log.message"),
            "service": "api",
            "message": record.getMessage(),
            "trace_id": getattr(record, "trace_id", None),
            "project_id": getattr(record, "project_id", None),
            "job_id": getattr(record, "job_id", None),
        }
        attributes = getattr(record, "attributes", None)
        if attributes:
            payload["attributes"] = _redact(attributes)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(_redact(payload), ensure_ascii=False, separators=(",", ":"))


def configure_logging(data_dir: Path, level: str) -> None:
    log_dir = data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    formatter = JsonFormatter()
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    file_handler = logging.handlers.RotatingFileHandler(
        log_dir / "studio.jsonl",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level.upper())
    root.addHandler(stream)
    root.addHandler(file_handler)

