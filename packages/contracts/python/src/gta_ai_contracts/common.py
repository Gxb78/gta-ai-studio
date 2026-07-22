from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, TypeAlias
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

GameId: TypeAlias = Literal["gta5", "gta6", "unknown"]
DataPolicy: TypeAlias = Literal["local_only", "metadata_only", "media_allowed"]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
UnitScore = Annotated[float, Field(ge=0, le=1)]
NonNegativeInt = Annotated[int, Field(ge=0)]
PositiveInt = Annotated[int, Field(gt=0)]


class StudioModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Rational(StudioModel):
    numerator: PositiveInt
    denominator: PositiveInt


class TimeRange(StudioModel):
    start_ms: NonNegativeInt
    end_ms: PositiveInt

    @model_validator(mode="after")
    def validate_order(self) -> "TimeRange":
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")
        return self


class BoundingBox(StudioModel):
    x: UnitScore
    y: UnitScore
    width: Annotated[float, Field(gt=0, le=1)]
    height: Annotated[float, Field(gt=0, le=1)]

    @model_validator(mode="after")
    def validate_bounds(self) -> "BoundingBox":
        if self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError("bounding box must fit inside normalized frame")
        return self


class ArtifactRef(StudioModel):
    id: UUID
    kind: Annotated[str, StringConstraints(min_length=1)]
    uri: Annotated[str, StringConstraints(min_length=1)]
    sha256: Sha256
    size_bytes: NonNegativeInt
    media_type: Annotated[str, StringConstraints(min_length=1)]
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("datetime must include a timezone")
        return value


JsonScalar: TypeAlias = str | int | float | bool | None
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]
