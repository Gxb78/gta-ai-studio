from __future__ import annotations

from typing import Any


class StudioError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable
        self.details = details or {}


class JobCancelled(StudioError):
    def __init__(self) -> None:
        super().__init__("JOB_CANCELLED", "Job cancellation requested.", status_code=409)

