from __future__ import annotations

from datetime import datetime
from typing import Literal, TypeAlias
from uuid import UUID

from pydantic import Field, model_validator

from .common import JsonValue, NonNegativeInt, Sha256, StudioModel, UnitScore

JobStatus: TypeAlias = Literal["QUEUED", "BLOCKED", "LEASED", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "FAILED", "CANCELLED"]


class JobError(StudioModel):
    code: str
    message: str
    retryable: bool
    details: dict[str, JsonValue] = Field(default_factory=dict)


class JobRun(StudioModel):
    id: UUID
    project_id: UUID
    kind: str
    status: JobStatus
    priority: int = 0
    idempotency_key: str
    input_fingerprint: Sha256
    algorithm_version: str
    parameters: dict[str, JsonValue] = Field(default_factory=dict)
    attempt: NonNegativeInt = 0
    max_attempts: int = Field(default=3, gt=0)
    progress: UnitScore = 0
    lease_owner: str | None = None
    lease_expires_at: datetime | None = None
    next_retry_at: datetime | None = None
    cancel_requested_at: datetime | None = None
    error: JobError | None = None
    result_artifact_id: UUID | None = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def validate_status_fields(self) -> "JobRun":
        if self.status in {"LEASED", "RUNNING"} and (self.lease_owner is None or self.lease_expires_at is None):
            raise ValueError("leased/running jobs require lease owner and expiry")
        if self.status == "RETRY_WAIT" and self.next_retry_at is None:
            raise ValueError("retry jobs require next_retry_at")
        if self.status == "SUCCEEDED" and self.result_artifact_id is None:
            raise ValueError("succeeded jobs require a result artifact")
        return self

