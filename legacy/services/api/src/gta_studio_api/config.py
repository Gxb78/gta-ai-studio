from __future__ import annotations

from pathlib import Path
import sys
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


REPO_ROOT = Path(__file__).resolve().parents[4]
RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", REPO_ROOT)).resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="GTA_STUDIO_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Literal["development", "test", "production"] = "development"
    data_dir: Path = Field(default_factory=lambda: REPO_ROOT / "data")
    database_path: Path | None = None
    migration_dir: Path = Field(
        default_factory=lambda: (
            RESOURCE_ROOT / "migrations"
            if getattr(sys, "frozen", False)
            else REPO_ROOT / "packages" / "database" / "migrations"
        )
    )
    api_host: str = "127.0.0.1"
    api_port: int = Field(default=8765, ge=1024, le=65535)
    log_level: str = "INFO"
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    hardware_acceleration: Literal["auto", "cpu", "nvidia"] = "auto"
    worker_poll_interval_seconds: float = Field(default=0.25, gt=0, le=10)
    worker_lease_seconds: int = Field(default=30, ge=5, le=600)
    max_source_bytes: int = Field(default=150 * 1024**3, gt=0)
    proxy_max_width: int = Field(default=1280, ge=320, le=3840)
    proxy_crf: int = Field(default=28, ge=18, le=40)
    proxy_preset: str = "veryfast"
    render_width: int = Field(default=1080, ge=360, le=2160)
    render_height: int = Field(default=1920, ge=640, le=3840)
    render_crf: int = Field(default=21, ge=16, le=32)
    render_preset: str = "veryfast"
    scene_threshold: float = Field(default=0.28, ge=0.05, le=0.9)
    production_max_duration_seconds: int = Field(default=180, ge=3, le=900)
    analysis_frame_interval_seconds: float = Field(default=3.0, ge=0.5, le=30)
    analysis_max_frames: int = Field(default=180, ge=1, le=2_000)
    analysis_frame_max_width: int = Field(default=960, ge=320, le=1920)
    ocr_min_confidence: float = Field(default=0.38, ge=0.05, le=0.99)
    game_adapter_root: Path = Field(
        default_factory=lambda: (
            RESOURCE_ROOT / "game-adapters"
            if getattr(sys, "frozen", False)
            else REPO_ROOT / "game-adapters"
        )
    )
    template_root: Path = Field(
        default_factory=lambda: (
            RESOURCE_ROOT / "templates"
            if getattr(sys, "frozen", False)
            else REPO_ROOT / "templates"
        )
    )
    speech_script_path: Path = Field(
        default_factory=lambda: (
            RESOURCE_ROOT / "scripts" / "synthesize_speech.ps1"
            if getattr(sys, "frozen", False)
            else REPO_ROOT / "services" / "api" / "scripts" / "synthesize_speech.ps1"
        )
    )

    # Preview settings
    preview_prefetch_enabled: bool = True
    preview_prefetch_max_concurrent: int = 1
    preview_cache_max_bytes: int = 2 * 1024 * 1024 * 1024  # 2 Go
    preview_cache_max_entries: int = 200

    @field_validator("api_host")
    @classmethod
    def loopback_only(cls, value: str) -> str:
        if value not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("API host must be a loopback address")
        return value

    @model_validator(mode="after")
    def resolve_paths(self) -> "Settings":
        self.data_dir = self.data_dir.expanduser().resolve()
        self.migration_dir = self.migration_dir.expanduser().resolve()
        self.speech_script_path = self.speech_script_path.expanduser().resolve()
        self.game_adapter_root = self.game_adapter_root.expanduser().resolve()
        self.template_root = self.template_root.expanduser().resolve()
        if self.database_path is None:
            self.database_path = self.data_dir / "gta-ai-studio.db"
        else:
            self.database_path = self.database_path.expanduser().resolve()
        return self
