from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import __version__
from .config import Settings
from .errors import StudioError
from .logging import configure_logging
from .models import ClipPreviewRequest, ErrorResponse, HealthResponse, ImportProjectRequest, ProductionRequest, TimelineRevisionRequest, PreviewResponse
from .service import StudioService


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or Settings()
    configure_logging(resolved_settings.data_dir, resolved_settings.log_level)
    service = StudioService(resolved_settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        service.initialize()
        await service.start_worker()
        app.state.service = service
        try:
            yield
        finally:
            await service.stop_worker()

    app = FastAPI(
        title="GTA AI Studio Local API",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if resolved_settings.environment != "production" else None,
        redoc_url=None,
    )
    app.state.service = service
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "tauri://localhost",
            "http://tauri.localhost",
            "http://localhost:1420",
            "http://127.0.0.1:1420",
        ],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    @app.exception_handler(StudioError)
    async def studio_error_handler(_: Request, error: StudioError) -> JSONResponse:
        body = ErrorResponse(
            code=error.code,
            message=error.message,
            retryable=error.retryable,
            details=error.details,
        )
        return JSONResponse(status_code=error.status_code, content=body.model_dump(mode="json"))

    @app.get("/api/v1/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        diagnostics = service.media.diagnostics()
        speech = service.speech.diagnostics()
        diagnostics["speech_available"] = bool(speech["speech_available"])
        diagnostics["speech_voice_count"] = str(len(speech["voices"]))
        diagnostics.update(service.vision.diagnostics())
        diagnostics.update(service.gta5_adapter.diagnostics())
        ok = bool(
            diagnostics["ffmpeg_available"]
            and diagnostics["ffprobe_available"]
            and diagnostics["speech_available"]
            and diagnostics["vision_available"]
            and diagnostics["gta5_adapter_available"]
        )
        return HealthResponse(
            status="ok" if ok else "degraded",
            version=__version__,
            database="ok",
            worker="running" if service.worker_running else "stopped",
            tools=diagnostics,
        )

    @app.get("/api/v1/system/hardware")
    async def hardware() -> dict[str, Any]:
        return service.media.hardware_diagnostics()

    @app.get("/api/v1/projects")
    async def list_projects() -> list[dict[str, Any]]:
        return service.list_projects()

    @app.post("/api/v1/projects/import", status_code=202)
    async def import_project(request: ImportProjectRequest) -> dict[str, Any]:
        return service.create_import_project(request.source_path, request.title, request.game_id)

    @app.get("/api/v1/projects/{project_id}")
    async def get_project(project_id: str) -> dict[str, Any]:
        return service.project_detail(project_id)

    @app.post("/api/v1/projects/{project_id}/retry", status_code=202)
    async def retry_project(project_id: str) -> dict[str, Any]:
        return service.retry_project(project_id)

    @app.get("/api/v1/voices")
    async def voices() -> list[dict[str, str]]:
        return service.available_voices()

    @app.post("/api/v1/projects/{project_id}/produce", status_code=202)
    async def produce_project(project_id: str, request: ProductionRequest) -> dict[str, Any]:
        return service.start_production(project_id, request)

    @app.post("/api/v1/projects/{project_id}/creative-package/generate", status_code=202)
    async def generate_creative_package(project_id: str) -> dict[str, Any]:
        return service.start_creative_package(project_id)

    @app.post("/api/v1/projects/{project_id}/timeline/revisions", status_code=201)
    async def save_timeline_revision(project_id: str, request: TimelineRevisionRequest) -> dict[str, Any]:
        return service.save_timeline_revision(project_id, request)

    @app.post("/api/v1/projects/{project_id}/timeline/preview", status_code=202, response_model=PreviewResponse)
    async def render_clip_preview(project_id: str, request: ClipPreviewRequest) -> PreviewResponse:
        return service.start_clip_preview(project_id, request)

    @app.post("/api/v1/jobs/{job_id}/cancel", status_code=202)
    async def cancel_job(job_id: str) -> dict[str, bool]:
        service.cancel_job(job_id)
        return {"accepted": True}

    @app.get("/api/v1/jobs/{job_id}")
    async def get_job(job_id: str) -> dict[str, Any]:
        """Récupère le statut d'un job par son ID."""
        job = service.repository.get_job(job_id)
        if not job:
            raise StudioError("JOB_NOT_FOUND", f"Job {job_id} not found", status_code=404)
        return job

    @app.get("/api/v1/projects/{project_id}/proxy")
    async def project_proxy(project_id: str) -> FileResponse:
        return FileResponse(service.proxy_path(project_id), media_type="video/mp4", filename=f"{project_id}-proxy.mp4")

    @app.get("/api/v1/projects/{project_id}/analysis/frames/{frame_id}")
    async def project_analysis_frame(project_id: str, frame_id: str) -> FileResponse:
        return FileResponse(service.analysis_frame_path(project_id, frame_id), media_type="image/jpeg")

    @app.get("/api/v1/projects/{project_id}/render")
    async def project_render(project_id: str) -> FileResponse:
        return FileResponse(
            service.production_artifact_path(project_id, "final_render"),
            media_type="video/mp4",
            filename=f"{project_id}-vertical.mp4",
        )

    @app.get("/api/v1/projects/{project_id}/voice")
    async def project_voice(project_id: str) -> FileResponse:
        return FileResponse(
            service.production_artifact_path(project_id, "voice"),
            media_type="audio/wav",
            filename=f"{project_id}-narration.wav",
        )

    @app.get("/api/v1/projects/{project_id}/waveform")
    async def project_waveform(project_id: str, track: str = "voice") -> dict[str, Any]:
        return service.audio_waveform(project_id, track)

    @app.get("/api/v1/projects/{project_id}/previews/{cache_key}")
    async def project_clip_preview(project_id: str, cache_key: str) -> FileResponse:
        return FileResponse(
            service.clip_preview_path(project_id, cache_key),
            media_type="video/mp4",
            filename=f"{project_id}-preview-{cache_key}.mp4",
        )

    @app.get("/api/v1/preview/stats")
    async def preview_cache_stats() -> dict[str, Any]:
        """Récupère les statistiques du cache de preview."""
        return service.repository.get_preview_cache_stats()

    @app.get("/api/v1/preview/metrics")
    async def preview_render_metrics() -> dict[str, Any]:
        """Récupère les métriques de performance du rendu de preview."""
        return service.repository.get_preview_render_metrics()

    @app.get("/api/v1/projects/{project_id}/subtitles")
    async def project_subtitles(project_id: str) -> FileResponse:
        return FileResponse(
            service.production_artifact_path(project_id, "subtitles_srt"),
            media_type="application/x-subrip",
            filename=f"{project_id}-captions.srt",
        )

    @app.get("/api/v1/projects/{project_id}/thumbnails/{variant_id}")
    async def project_thumbnail(project_id: str, variant_id: str) -> FileResponse:
        return FileResponse(
            service.thumbnail_path(project_id, variant_id),
            media_type="image/jpeg",
            filename=f"{project_id}-{variant_id}.jpg",
        )

    @app.get("/api/v1/projects/{project_id}/creative-package")
    async def project_creative_package(project_id: str) -> FileResponse:
        return FileResponse(
            service.production_artifact_path(project_id, "creative_package"),
            media_type="application/json",
            filename=f"{project_id}-creative-package.json",
        )

    @app.get("/api/v1/projects/{project_id}/events")
    async def project_events(project_id: str, request: Request) -> StreamingResponse:
        async def stream() -> AsyncIterator[str]:
            previous = ""
            while not await request.is_disconnected():
                payload = json.dumps(service.project_detail(project_id), ensure_ascii=False, separators=(",", ":"))
                if payload != previous:
                    yield f"event: project\ndata: {payload}\n\n"
                    previous = payload
                await asyncio.sleep(0.75)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
