from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from typing import Annotated, Literal, Any


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ImportProjectRequest(ApiModel):
    source_path: Annotated[str, StringConstraints(min_length=1)]
    title: Annotated[str, StringConstraints(min_length=1, max_length=160)] | None = None
    game_id: Literal["gta5", "gta6", "unknown"] = "gta5"
    copy_mode: Literal["managed"] = "managed"


class ProductionRequest(ApiModel):
    brief: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=2_000)]
    target_duration_seconds: int = Field(default=30, ge=3, le=180)
    editorial_style: Literal["dynamic", "cinematic", "tutorial"] = "dynamic"
    voice_id: Annotated[str, StringConstraints(min_length=1, max_length=200)] | None = None
    voice_rate: int = Field(default=1, ge=-4, le=4)
    caption_style: Literal["impact", "minimal"] = "impact"
    composition: Literal["smart_blur", "center_crop"] = "smart_blur"
    source_audio_level: float = Field(default=0.16, ge=0, le=1)
    include_hook: bool = True
    include_cta: bool = True


class ErrorResponse(ApiModel):
    code: str
    message: str
    retryable: bool
    details: dict[str, object] = Field(default_factory=dict)


class HealthResponse(ApiModel):
    status: Literal["ok", "degraded"]
    version: str
    database: Literal["ok"]
    worker: Literal["running", "stopped"]
    tools: dict[str, str | bool]


class EditableClip(ApiModel):
    id: str | None = None
    index: int = Field(ge=0, le=499)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    source_duration_ms: int = Field(gt=0, le=900_000)
    duration_ms: int = Field(ge=250, le=180_000)
    reframe_mode: Literal["dynamic_crop", "fixed_crop", "blur_background", "split_screen"]
    tracking_confidence: float = Field(ge=0, le=1)
    tracking_method: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    speed: float = Field(ge=0.5, le=2)
    speed_reason: Annotated[str, StringConstraints(max_length=120)] = "manual"
    zoom: float = Field(ge=1, le=1.2)
    zoom_reason: Annotated[str, StringConstraints(max_length=120)] = "manual"
    focus_start_x: float = Field(ge=0, le=1)
    focus_end_x: float = Field(ge=0, le=1)
    focus_y: float = Field(ge=0, le=1)
    supporting_segment_ids: list[str] = Field(default_factory=list, max_length=100)
    supporting_claim_ids: list[str] = Field(default_factory=list, max_length=100)
    selection_score: float | None = Field(default=None, ge=0, le=1)
    concepts: list[str] = Field(default_factory=list, max_length=50)
    purposes: list[str] = Field(default_factory=list, max_length=50)
    comparison: dict[str, object] | None = None
    fade_in_ms: int | None = Field(default=None, ge=0, le=5_000)
    fade_out_ms: int | None = Field(default=None, ge=0, le=5_000)


class EditableOverlay(ApiModel):
    id: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    cue_type: Literal["title", "step", "proof", "before_after", "result", "conclusion"]
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    text: Annotated[str, StringConstraints(max_length=240)]
    secondary_text: Annotated[str, StringConstraints(max_length=240)] | None = None
    template_key: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    supporting_claim_ids: list[str] = Field(default_factory=list, max_length=100)
    parameters: dict[str, object] = Field(default_factory=dict)
    enabled: bool = True
    manual_override: bool = False


class TimelineRevisionRequest(ApiModel):
    base_edit_project_id: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    expected_revision: int = Field(ge=1)
    clips: list[EditableClip] = Field(min_length=1, max_length=500)
    overlays: list[EditableOverlay] = Field(default_factory=list, max_length=200)
    note: Annotated[str, StringConstraints(max_length=500)] = ""


class PreviewWindowRequest(ApiModel):
    playhead_ms: int = Field(ge=0)
    duration_ms: int = Field(ge=500, le=10_000, default=3000)

class ClipPreviewRequest(ApiModel):
    client_request_id: str = Field(min_length=36, max_length=36)
    edit_project_id: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    clip_id: str = Field(min_length=36, max_length=36)
    timeline_revision: int = Field(ge=0)
    clip_revision: int = Field(ge=0, default=0)
    render_profile: Literal["draft", "fidelity"] = "draft"
    preview_window: PreviewWindowRequest | None = None
    origin: Literal["user", "prefetch"] = "user"

class PreviewResponse(ApiModel):
    client_request_id: str
    job_run_id: str | None
    cache_key: str
    cache_hit: bool
    status: Literal["ready", "pending", "rendering", "failed"]
    artifact_url: str | None
    clip_id: str
    clip_revision: int
    timeline_revision: int
    render_profile: Literal["draft", "fidelity"]


class PreviewRenderSpec(ApiModel):
    """
    Snapshot immuable des paramètres de rendu pour une preview.

    Ce modèle capture tous les paramètres nécessaires au rendu au moment
    de la création du job. Le worker ne doit JAMAIS relire la timeline.
    """
    client_request_id: str = Field(min_length=36, max_length=36)
    project_id: str = Field(min_length=36, max_length=36)
    edit_project_id: str = Field(min_length=36, max_length=36)

    # Identité du clip
    clip_id: str = Field(min_length=36, max_length=36)
    clip_revision: int = Field(ge=0, default=0)
    timeline_revision: int = Field(ge=0)

    # Source média
    source_path: str = Field(min_length=1)
    source_sha256: str = Field(min_length=64, max_length=64)
    source_start_ms: int = Field(ge=0)
    source_end_ms: int = Field(gt=0)
    source_width: int = Field(gt=0)
    source_height: int = Field(gt=0)

    # Fenêtre de preview (temps de sortie du clip)
    preview_start_ms: int = Field(ge=0)
    preview_duration_ms: int = Field(ge=500, le=10_000)

    # Transformation géométrique (crop normalisé)
    crop_x: float = Field(ge=0, le=1)
    crop_y: float = Field(ge=0, le=1)
    crop_width: float = Field(gt=0, le=1)
    crop_height: float = Field(gt=0, le=1)
    focus_x: float = Field(ge=0, le=1)
    focus_y: float = Field(ge=0, le=1)
    zoom: float = Field(ge=1, le=2)

    # Cinématique
    speed: float = Field(ge=0.5, le=2)

    # Paramètres de sortie
    output_width: int = Field(gt=0)
    output_height: int = Field(gt=0)
    output_fps: int = Field(gt=0, le=60)
    codec: str = Field(min_length=1)
    preset: str = Field(min_length=1)
    crf: int = Field(ge=0, le=51)
    pixel_format: str = Field(min_length=1)
    audio_codec: str = Field(min_length=1)
    audio_bitrate: str = Field(min_length=1)

