from __future__ import annotations

from datetime import datetime
from typing import Generic, Literal, Protocol, TypeVar
from uuid import UUID

from pydantic import Field

from .common import DataPolicy, JsonValue, StudioModel

T = TypeVar("T")


class ProviderDescriptor(StudioModel):
    provider_id: str
    implementation_version: str
    model_id: str
    capabilities: list[Literal["llm", "vision", "ocr", "transcription", "tts", "image", "embedding", "publishing", "analytics"]]
    local: bool
    supported_locales: list[str] = Field(default_factory=list)
    limits: dict[str, JsonValue] = Field(default_factory=dict)


class ProviderContext(StudioModel):
    request_id: UUID
    trace_id: UUID
    project_id: UUID
    job_id: UUID
    deadline_at: datetime
    data_policy: DataPolicy
    idempotency_key: str


class ProviderResult(StudioModel, Generic[T]):
    value: T
    provider_id: str
    model_id: str
    latency_ms: int = Field(ge=0)
    usage: dict[str, JsonValue] = Field(default_factory=dict)
    cost_minor: int | None = Field(default=None, ge=0)
    currency: str | None = None


class BaseProvider(Protocol):
    descriptor: ProviderDescriptor

    async def health(self) -> Literal["healthy", "degraded", "unavailable", "disabled"]: ...
    async def estimate(self, input_data: dict[str, JsonValue], context: ProviderContext) -> dict[str, JsonValue]: ...

