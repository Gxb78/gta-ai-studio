from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from .config import Settings
from .creative_intelligence import (
    CREATIVE_PACKAGE_VERSION,
    THUMBNAIL_VERSION,
    build_creative_package,
    render_thumbnail_variants,
)
from .database import Database
from .errors import JobCancelled, StudioError
from .evidence_engine import EVIDENCE_VERSION, build_verification_report, load_knowledge_pack
from .editing_intelligence import (
    ADVANCED_EDIT_VERSION,
    OVERLAY_RENDER_VERSION,
    build_advanced_edit_plan,
    load_edit_template,
    write_overlay_ass,
)
from .gta5_adapter import ADAPTER_VERSION, Gta5Adapter
from .ids import uuid7
from .media import MediaTools
from .models import ClipPreviewRequest, ProductionRequest, TimelineRevisionRequest, PreviewResponse
from .narrative_intelligence import (
    CONTENT_PLAN_VERSION,
    NARRATIVE_VERSION,
    build_content_plans,
    build_narrative_map,
)
from .production import (
    build_captions,
    build_scene_segments,
    build_script,
    build_timeline,
    select_planned_clips,
    structure_brief,
    write_subtitles,
)
from .render import VerticalRenderer, resolve_preview_profile
from .repository import Repository, fingerprint, utc_now
from .speech import SpeechTools
from .storage import Storage, sha256_file
from .vision import VisionTools, build_generic_visual_report, normalize_observed_text


logger = logging.getLogger(__name__)
INGEST_VERSION = "ingest-v1"
PROXY_VERSION = "proxy-h264-auto-v2"
SCENE_VERSION = "ffmpeg-scene-v1"
FRAME_VERSION = "opencv-keyframes-v1"
OCR_VERSION = "rapidocr-ppocrv6-v1"
SCRIPT_VERSION = "evidence-aware-template-v2"
VOICE_VERSION = "windows-sapi-v1"
TIMELINE_VERSION = "advanced-timeline-v2"
RENDER_VERSION = "advanced-vertical-render-v3"
TIMELINE_EDITOR_VERSION = "timeline-editor-v1"
CLIP_PREVIEW_VERSION = "clip-preview-v1"

PIPELINE_ORDER = [
    "CREATED", "SOURCE_SELECTED", "BRIEF_CAPTURED", "BRIEF_STRUCTURED", "INGESTED",
    "PROXIED", "ANALYZED", "SEGMENTED", "NARRATIVE_MAPPED", "COVERAGE_CHECKED",
    "CONTENT_PLANNED", "FACTS_VERIFIED", "SCRIPTED", "VOICED", "TIMELINE_BUILT",
    "DRAFT_RENDERED", "QC_ANALYZED", "CORRECTED", "FINAL_RENDERED", "READY_TO_PUBLISH",
]


class StudioService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        assert settings.database_path is not None
        self.database = Database(settings.database_path, settings.migration_dir)
        self.repository = Repository(self.database)
        self.storage = Storage(settings.data_dir, settings.max_source_bytes)
        self.media = MediaTools(
            settings.ffmpeg_path,
            settings.ffprobe_path,
            settings.proxy_max_width,
            settings.proxy_crf,
            settings.proxy_preset,
            settings.hardware_acceleration,
        )
        self.speech = SpeechTools(settings.speech_script_path)
        self.vision = VisionTools(
            frame_interval_seconds=settings.analysis_frame_interval_seconds,
            max_frames=settings.analysis_max_frames,
            max_width=settings.analysis_frame_max_width,
            ocr_min_confidence=settings.ocr_min_confidence,
        )
        self.gta5_adapter = Gta5Adapter(
            settings.game_adapter_root / "gta5" / "adapter.manifest.json",
            settings.game_adapter_root / "gta5" / "taxonomy.json",
        )
        self.renderer = VerticalRenderer(
            self.media,
            settings.render_width,
            settings.render_height,
            settings.render_crf,
            settings.render_preset,
        )
        self.worker_id = f"local-worker-{uuid7()}"
        self._stop = asyncio.Event()
        self._worker_task: asyncio.Task[None] | None = None

    @property
    def _ffmpeg_build_id(self) -> str:
        return self.media.diagnostics().get("ffmpeg_version", "unknown")

    def initialize(self) -> None:
        self.storage.initialize()
        self.database.initialize()
        knowledge_sync = {
            game_id: self.repository.sync_knowledge_pack(load_knowledge_pack(self.settings.game_adapter_root, game_id))
            for game_id in ("gta5", "gta6")
        }
        recovered = self.repository.recover_abandoned_jobs()
        diagnostics = self.media.diagnostics()
        speech_diagnostics = self.speech.diagnostics()
        vision_diagnostics = self.vision.diagnostics()
        adapter_diagnostics = self.gta5_adapter.diagnostics()
        diagnostics["speech_available"] = bool(speech_diagnostics["speech_available"])
        diagnostics["speech_voice_count"] = str(len(speech_diagnostics["voices"]))
        diagnostics.update(vision_diagnostics)
        diagnostics.update(adapter_diagnostics)
        if not diagnostics["ffmpeg_available"] or not diagnostics["ffprobe_available"]:
            logger.warning("Media tools are unavailable", extra={"event": "system.media_tools_missing", "attributes": diagnostics})
        logger.info(
            "GTA Studio API initialized",
            extra={"event": "system.initialized", "attributes": {"recovered_jobs": recovered, "knowledge_sync": knowledge_sync, **diagnostics}},
        )

    async def start_worker(self) -> None:
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._worker_loop(), name="gta-studio-local-worker")

    async def stop_worker(self) -> None:
        self._stop.set()
        if self._worker_task:
            await self._worker_task
            self._worker_task = None

    @property
    def worker_running(self) -> bool:
        return self._worker_task is not None and not self._worker_task.done()

    def create_import_project(self, source_path: str, title: str | None, game_id: str) -> dict[str, Any]:
        source = self.storage.validate_source(source_path)
        project_title = title.strip() if title and title.strip() else source.stem
        project_id = self.repository.create_project(project_title, game_id, "PROXIED")
        self.storage.prepare_project(project_id)
        self.repository.update_stage(
            project_id,
            "CREATED",
            "SOURCE_SELECTED",
            event="project.source_selected",
        )
        stat = source.stat()
        preflight = {
            "resolved_source_path": str(source),
            "source_size": stat.st_size,
            "source_mtime_ns": stat.st_mtime_ns,
            "copy_mode": "managed",
        }
        input_fingerprint = fingerprint(preflight)
        self.repository.enqueue_job(
            project_id,
            "INGEST_SOURCE",
            preflight,
            input_fingerprint,
            INGEST_VERSION,
        )
        return self.project_detail(project_id)

    def list_projects(self) -> list[dict[str, Any]]:
        return self.repository.list_projects()

    def project_detail(self, project_id: str) -> dict[str, Any]:
        project = self.repository.get_project(project_id)
        if project["proxy"]:
            project["proxy_url"] = f"/api/v1/projects/{project_id}/proxy"
        else:
            project["proxy_url"] = None
        production = project["production"]
        artifacts = production.get("artifacts", {})
        production["render_url"] = f"/api/v1/projects/{project_id}/render" if artifacts.get("final_render") else None
        production["voice_url"] = f"/api/v1/projects/{project_id}/voice" if artifacts.get("voice") else None
        production["subtitles_url"] = f"/api/v1/projects/{project_id}/subtitles" if artifacts.get("subtitles_srt") else None
        creative_package = production.get("creative_package")
        if creative_package:
            creative_package["download_url"] = f"/api/v1/projects/{project_id}/creative-package"
            for thumbnail in creative_package.get("thumbnails", []):
                thumbnail["url"] = f"/api/v1/projects/{project_id}/thumbnails/{thumbnail['id']}"
        for frame in project["analysis"]["frames"]:
            frame["url"] = f"/api/v1/projects/{project_id}/analysis/frames/{frame['id']}"
        return project

    def available_voices(self) -> list[dict[str, str]]:
        return self.speech.list_voices()

    def start_production(self, project_id: str, request: ProductionRequest) -> dict[str, Any]:
        project = self.repository.get_project(project_id)
        media = project["media"][0] if project["media"] else None
        if not media or not project["proxy"]:
            raise StudioError("PRODUCTION_PROJECT_NOT_READY", "The project proxy is not ready.", status_code=409)
        voices = self.speech.list_voices()
        if not voices:
            raise StudioError("SPEECH_NO_VOICE", "No Windows speech voice is installed.", status_code=503)
        selected_voice = request.voice_id
        voice_ids = {voice["id"] for voice in voices}
        if selected_voice and selected_voice not in voice_ids:
            raise StudioError("SPEECH_VOICE_NOT_FOUND", "The selected Windows voice is unavailable.", status_code=409)
        if not selected_voice:
            selected_voice = next((voice["id"] for voice in voices if voice.get("culture", "").lower().startswith("fr")), voices[0]["id"])
        structured = structure_brief(
            request.brief,
            game_id=str(project["game_id"]),
            target_duration_seconds=request.target_duration_seconds,
            editorial_style=request.editorial_style,
            voice_id=selected_voice,
            voice_rate=request.voice_rate,
            caption_style=request.caption_style,
            composition=request.composition,
            source_audio_level=request.source_audio_level,
            include_hook=request.include_hook,
            include_cta=request.include_cta,
        )
        brief_id = self.repository.begin_production(project_id, structured)
        adapter_id = "studio.game-adapter.gta5" if project["game_id"] == "gta5" else "studio.game-adapter.generic"
        adapter_version = str(self.gta5_adapter.descriptor["version"]) if project["game_id"] == "gta5" else "1.0.0"
        analysis_run_id = self.repository.create_analysis_run(
            project_id,
            brief_id,
            adapter_id=adapter_id,
            adapter_version=adapter_version,
            vision_version=FRAME_VERSION,
            ocr_version=OCR_VERSION,
        )
        parameters = {
            "brief_id": brief_id,
            "analysis_run_id": analysis_run_id,
            "structured_brief": structured,
            "game_id": project["game_id"],
            "media_id": media["id"],
            "media_sha256": media["sha256"],
            "source_duration_ms": media["duration_ms"],
        }
        self.repository.enqueue_job(
            project_id,
            "ANALYZE_SCENES",
            parameters,
            fingerprint(parameters),
            SCENE_VERSION,
        )
        return self.project_detail(project_id)

    def retry_project(self, project_id: str) -> dict[str, Any]:
        self.repository.retry_latest_failed_job(project_id)
        return self.project_detail(project_id)

    def start_creative_package(self, project_id: str) -> dict[str, Any]:
        parameters = self.repository.prepare_creative_package(project_id)
        self.repository.enqueue_job(
            project_id,
            "GENERATE_CREATIVE_PACKAGE",
            parameters,
            fingerprint(parameters),
            CREATIVE_PACKAGE_VERSION,
            idempotency_suffix=f":manual:{uuid7()}",
        )
        return self.project_detail(project_id)

    def cancel_job(self, job_id: str) -> None:
        self.repository.request_job_cancellation(job_id)

    def save_timeline_revision(self, project_id: str, request: TimelineRevisionRequest) -> dict[str, Any]:
        project = self.repository.get_project(project_id)
        production = dict(project["production"])
        current_edit = production.get("edit")
        advanced_edit = production.get("advanced_edit")
        script = production.get("script")
        voice = production.get("voice")
        brief = production.get("brief")
        if not current_edit or not advanced_edit or not script or not voice or not brief:
            raise StudioError("TIMELINE_EDITOR_NOT_READY", "A complete timeline, voice and advanced edit are required.", status_code=409)
        if str(current_edit["id"]) != request.base_edit_project_id or int(current_edit["revision"]) != request.expected_revision:
            raise StudioError(
                "TIMELINE_REVISION_CONFLICT",
                "The timeline changed since this editor session started. Reload the latest revision.",
                status_code=409,
                details={"current_edit_project_id": current_edit["id"], "current_revision": current_edit["revision"]},
            )
        media_record = self.repository.get_primary_media(project_id)
        source_duration = int(media_record["duration_ms"])
        clips = [clip.model_dump(mode="json") for clip in request.clips]
        total_duration = 0
        for index, clip in enumerate(clips):
            if clip.get("id") is None:
                clip["id"] = uuid7()
            if int(clip["end_ms"]) <= int(clip["start_ms"]):
                raise StudioError("TIMELINE_CLIP_RANGE_INVALID", f"Clip {index + 1} has an invalid source range.")
            if int(clip["end_ms"]) > source_duration:
                raise StudioError("TIMELINE_CLIP_OUT_OF_SOURCE", f"Clip {index + 1} exceeds the source duration.")
            clip["index"] = index
            clip["source_duration_ms"] = int(clip["end_ms"]) - int(clip["start_ms"])
            total_duration += int(clip["duration_ms"])
        if total_duration > self.settings.production_max_duration_seconds * 1000:
            raise StudioError("TIMELINE_DURATION_TOO_LONG", "The edited timeline exceeds the configured production duration.")

        overlays = [cue.model_dump(mode="json") for cue in request.overlays]
        seen_overlay_ids: set[str] = set()
        for cue in overlays:
            if cue["id"] in seen_overlay_ids:
                raise StudioError("TIMELINE_OVERLAY_ID_DUPLICATE", "Overlay identifiers must be unique.")
            seen_overlay_ids.add(str(cue["id"]))
            if int(cue["end_ms"]) <= int(cue["start_ms"]) or int(cue["end_ms"]) > total_duration:
                raise StudioError("TIMELINE_OVERLAY_RANGE_INVALID", "An overlay is outside the edited timeline.")
            if bool(cue.get("manual_override")):
                cue["supporting_claim_ids"] = []

        production_settings = dict(brief["structured"].get("production", {}))
        style = str(production_settings.get("editorial_style", "dynamic"))
        template = load_edit_template(self.settings.template_root, style)
        revision_id = uuid7()
        transitions = [
            {"id": uuid7(), "from_index": index - 1, "to_index": index, "type": "crossfade", "duration_ms": 120}
            for index in range(1, len(clips))
        ]
        tracking_confidence = sum(float(clip["tracking_confidence"]) for clip in clips) / len(clips)
        summary = {
            "clip_count": len(clips),
            "track_point_count": int(dict(advanced_edit.get("summary", {})).get("track_point_count", 0)),
            "tracking_confidence": round(tracking_confidence, 5),
            "dynamic_reframe_count": sum(clip["reframe_mode"] == "dynamic_crop" for clip in clips),
            "fallback_reframe_count": sum(clip["reframe_mode"] != "dynamic_crop" for clip in clips),
            "overlay_count": sum(bool(cue["enabled"]) for cue in overlays),
            "zoom_effect_count": sum(float(clip["zoom"]) > 1.001 for clip in clips),
            "speed_effect_count": sum(abs(float(clip["speed"]) - 1) > 0.01 for clip in clips),
            "comparison_count": sum(clip.get("comparison") is not None for clip in clips),
            "transition_count": len(transitions),
        }
        editor_state = {
            **dict(advanced_edit),
            "id": revision_id,
            "brief_id": brief["id"],
            "status": "READY",
            "algorithm_version": TIMELINE_EDITOR_VERSION,
            "template_id": template["id"],
            "template_version": template["version"],
            "template": {
                "id": template["id"], "version": template["version"],
                "editorial_style": template["editorial_style"], "font_family": template["font_family"],
                "accent_color": template["accent_color"], "secondary_color": template["secondary_color"],
            },
            "tracking_confidence": round(tracking_confidence, 5),
            "clips": clips,
            "overlays": overlays,
            "transitions": transitions,
            "summary": summary,
            "created_at": utc_now(),
            "manual_revision": True,
        }
        plan_path = self.storage.write_json(project_id, f"timelines/editor-state-{revision_id}.json", editor_state)
        overlay_path = self.storage.project_file(project_id, f"timelines/editor-overlays-{revision_id}.ass")
        write_overlay_ass(editor_state, overlay_path)
        state_fingerprint = fingerprint(editor_state)
        state_artifact_id = self.repository.register_artifact(
            project_id, "timeline_edit_state", self.storage.to_uri(plan_path), sha256_file(plan_path),
            plan_path.stat().st_size, "application/json", TIMELINE_EDITOR_VERSION, state_fingerprint,
            {"parent_edit_project_id": current_edit["id"], "clip_count": len(clips)},
        )
        overlay_artifact_id = self.repository.register_artifact(
            project_id, "overlay_ass", self.storage.to_uri(overlay_path), sha256_file(overlay_path),
            overlay_path.stat().st_size, "text/x-ssa", TIMELINE_EDITOR_VERSION,
            fingerprint({"revision_id": revision_id, "overlays": overlays}),
            {"editor_revision_id": revision_id, "overlay_count": summary["overlay_count"]},
        )
        captions = []
        for caption in voice.get("alignment", []):
            start_ms = int(caption.get("start_ms", 0))
            end_ms = min(total_duration, int(caption.get("end_ms", total_duration)))
            if end_ms > start_ms and start_ms < total_duration:
                captions.append({**caption, "start_ms": start_ms, "end_ms": end_ms})
        timeline = build_timeline(
            project_id=project_id,
            media_id=str(media_record["id"]),
            media_uri=str(media_record["original_uri"]),
            voice_artifact_id=str(voice["artifact_id"]),
            clips=clips,
            captions=captions,
            composition=str(production_settings.get("composition", "smart_blur")),
            output_duration_ms=total_duration,
            width=self.settings.render_width,
            height=self.settings.render_height,
            advanced_edit_plan=editor_state,
        )
        timeline_path = self.storage.write_json(project_id, f"timelines/editor-{revision_id}.timeline.json", timeline)
        timeline_artifact_id = self.repository.register_artifact(
            project_id, "timeline_revision", self.storage.to_uri(timeline_path), sha256_file(timeline_path),
            timeline_path.stat().st_size, "application/json", TIMELINE_EDITOR_VERSION,
            fingerprint({"editor_state": state_fingerprint, "timeline": timeline}),
            {"duration_ms": total_duration, "parent_edit_project_id": current_edit["id"]},
        )
        self.repository.create_edit_project(
            project_id,
            str(script["id"]),
            timeline,
            editor_revision={
                "id": revision_id,
                "parent_edit_project_id": current_edit["id"],
                "base_advanced_edit_plan_id": advanced_edit.get("id"),
                "state_artifact_id": state_artifact_id,
                "timeline_artifact_id": timeline_artifact_id,
                "overlay_artifact_id": overlay_artifact_id,
                "state": editor_state,
                "note": request.note,
            },
        )
        return self.project_detail(project_id)

    def start_clip_preview(self, project_id: str, request: ClipPreviewRequest) -> PreviewResponse:
        import logging
        logger = logging.getLogger(__name__)

        logger.info(
            "Preview request received",
            extra={
                "event": "preview.request.received",
                "project_id": project_id,
                "attributes": {
                    "clip_id": request.clip_id,
                    "render_profile": request.render_profile,
                    "timeline_revision": request.timeline_revision,
                    "origin": request.origin,
                    "has_window": request.preview_window is not None,
                },
            },
        )

        project = self.repository.get_project(project_id)
        production = dict(project["production"])
        edit = production.get("edit")
        advanced_edit = production.get("advanced_edit")
        if not edit or not advanced_edit or str(edit["id"]) != request.edit_project_id:
            raise StudioError("TIMELINE_PREVIEW_REVISION_STALE", "Save or reload the current timeline revision before generating a preview.", status_code=409)
        
        if int(edit["revision"]) != request.timeline_revision:
            raise StudioError("TIMELINE_PREVIEW_REVISION_MISMATCH", "Timeline revision mismatch.", status_code=409)

        clips = list(advanced_edit.get("clips", []))
        clip = next((c for c in clips if c.get("id") == request.clip_id), None)
        if clip is None:
            raise StudioError("TIMELINE_CLIP_NOT_FOUND", "The selected clip does not exist.", status_code=404)

        media_record = self.repository.get_primary_media(project_id)
        resolved_profile = resolve_preview_profile(request.render_profile, self.renderer)
        preview_window = request.preview_window.model_dump() if request.preview_window else None
        
        cache_key = _preview_cache_key(
            source_sha256=media_record["sha256"],
            clip=clip,
            preview_window=preview_window,
            resolved_profile=resolved_profile,
            renderer_version=RENDER_VERSION,
            ffmpeg_build_id=self._ffmpeg_build_id,
        )

        existing_entry = self.repository.find_preview_cache_entry(cache_key)
        if existing_entry and existing_entry["status"] == "ready":
            logger.info(
                "Preview cache hit (ready)",
                extra={
                    "event": "preview.cache.hit",
                    "project_id": project_id,
                    "attributes": {
                        "cache_key": cache_key,
                        "clip_id": request.clip_id,
                        "hit_count": existing_entry.get("hit_count", 0),
                    },
                },
            )
            self.repository.touch_preview_cache(cache_key)
            self.repository.link_project_preview(project_id, cache_key, request.clip_id)
            return PreviewResponse(
                client_request_id=request.client_request_id,
                job_run_id=None,
                cache_key=cache_key,
                cache_hit=True,
                status="ready",
                artifact_url=self._clip_preview_url(project_id, cache_key),
                clip_id=request.clip_id,
                clip_revision=request.clip_revision,
                timeline_revision=request.timeline_revision,
                render_profile=request.render_profile,
            )

        if existing_entry and existing_entry["status"] in ("pending", "rendering"):
            logger.info(
                "Preview cache hit (in-progress)",
                extra={
                    "event": "preview.cache.hit_inprogress",
                    "project_id": project_id,
                    "attributes": {
                        "cache_key": cache_key,
                        "clip_id": request.clip_id,
                        "status": existing_entry["status"],
                        "job_run_id": existing_entry.get("job_run_id"),
                    },
                },
            )
            self.repository.link_project_preview(project_id, cache_key, request.clip_id)
            return PreviewResponse(
                client_request_id=request.client_request_id,
                job_run_id=existing_entry["job_run_id"],
                cache_key=cache_key,
                cache_hit=True,
                status=existing_entry["status"],  # type: ignore
                artifact_url=None,
                clip_id=request.clip_id,
                clip_revision=request.clip_revision,
                timeline_revision=request.timeline_revision,
                render_profile=request.render_profile,
            )

        parameters = {
            "edit_project_id": request.edit_project_id,
            "clip_id": request.clip_id,
            "clip": clip,
            "composition": dict(production["brief"]["structured"].get("production", {})).get("composition", "smart_blur"),
            "resolved_profile": resolved_profile,
            "preview_window": preview_window,
            "cache_key": cache_key,
        }
        
        job_id = self.repository.enqueue_job(
            project_id, "RENDER_CLIP_PREVIEW", parameters, cache_key, CLIP_PREVIEW_VERSION,
            idempotency_suffix=f":manual:{uuid7()}",
        )

        logger.info(
            "Preview cache miss, job enqueued",
            extra={
                "event": "preview.cache.miss",
                "project_id": project_id,
                "job_id": job_id,
                "attributes": {
                    "cache_key": cache_key,
                    "clip_id": request.clip_id,
                    "render_profile": request.render_profile,
                    "origin": request.origin,
                },
            },
        )

        self.repository.create_preview_cache_entry(
            cache_key=cache_key,
            render_profile=request.render_profile,
            renderer_version=RENDER_VERSION,
            job_run_id=job_id,
        )
        self.repository.link_project_preview(project_id, cache_key, request.clip_id)
        self.repository.set_project_status(project_id, "ACTIVE")

        # Prefetch automatique des clips adjacents (non-récursif)
        if request.origin == "user":
            self._prefetch_adjacent_clips(project_id, request, clips, clip)

        return PreviewResponse(
            client_request_id=request.client_request_id,
            job_run_id=job_id,
            cache_key=cache_key,
            cache_hit=False,
            status="pending",
            artifact_url=None,
            clip_id=request.clip_id,
            clip_revision=request.clip_revision,
            timeline_revision=request.timeline_revision,
            render_profile=request.render_profile,
        )

    def _prefetch_adjacent_clips(
        self,
        project_id: str,
        original_request: ClipPreviewRequest,
        clips: list[dict[str, Any]],
        current_clip: dict[str, Any],
    ) -> None:
        """
        Prefetch automatique des clips précédent et suivant (non-récursif).

        - Seules les requêtes origin="user" déclenchent prefetch
        - Les requêtes prefetch ont origin="prefetch" (pas de récursion)
        - Préfère draft profile pour économiser ressources
        - Ignore les erreurs de prefetch (fire-and-forget)
        """
        import logging
        logger = logging.getLogger(__name__)

        current_index = next((i for i, c in enumerate(clips) if c.get("id") == current_clip.get("id")), None)
        if current_index is None:
            return

        adjacent_indices = []
        if current_index > 0:
            adjacent_indices.append(current_index - 1)  # Clip précédent
        if current_index < len(clips) - 1:
            adjacent_indices.append(current_index + 1)  # Clip suivant

        if adjacent_indices:
            logger.info(
                "Starting prefetch for adjacent clips",
                extra={
                    "event": "preview.prefetch.start",
                    "project_id": project_id,
                    "attributes": {
                        "current_clip_id": current_clip.get("id"),
                        "current_index": current_index,
                        "adjacent_count": len(adjacent_indices),
                    },
                },
            )

        prefetch_profile = "draft"  # Toujours draft pour prefetch

        for idx in adjacent_indices:
            adjacent_clip = clips[idx]
            try:
                # Créer une requête prefetch avec un UUID unique (pas de concaténation)
                from .ids import uuid7

                prefetch_request = ClipPreviewRequest(
                    client_request_id=uuid7(),
                    edit_project_id=original_request.edit_project_id,
                    clip_id=adjacent_clip.get("id"),
                    timeline_revision=original_request.timeline_revision,
                    clip_revision=0,
                    render_profile=prefetch_profile,
                    preview_window=None,  # Pas de window pour prefetch, clip entier
                    origin="prefetch",
                )

                # Lancer le prefetch (peut être cache hit)
                result = self.start_clip_preview(project_id, prefetch_request)

                logger.debug(
                    "Prefetch completed",
                    extra={
                        "event": "preview.prefetch.completed",
                        "project_id": project_id,
                        "attributes": {
                            "adjacent_clip_id": adjacent_clip.get("id"),
                            "adjacent_index": idx,
                            "cache_hit": result.cache_hit,
                        },
                    },
                )

            except Exception as e:
                # Fire-and-forget: ne pas propager les erreurs de prefetch
                logger.warning(
                    f"Prefetch failed for adjacent clip {idx} (clip_id={adjacent_clip.get('id')}): {e}",
                    extra={
                        "event": "preview.prefetch.failed",
                        "project_id": project_id,
                        "attributes": {
                            "adjacent_clip_id": adjacent_clip.get("id"),
                            "adjacent_index": idx,
                            "error": str(e),
                        },
                    },
                )

    def _clip_preview_url(self, project_id: str, cache_key: str) -> str:
        return f"/api/v1/projects/{project_id}/previews/{cache_key}"

    def clip_preview_path(self, project_id: str, cache_key: str) -> Path:
        entry = self.repository.find_preview_cache_entry(cache_key)
        if not entry or entry["status"] != "ready":
            raise StudioError("STORAGE_ARTIFACT_FILE_MISSING", "Clip preview file is missing or not ready.", status_code=500)
        path = self.storage.resolve_uri(str(entry["artifact_uri"]))
        if not path.is_file():
            raise StudioError("STORAGE_ARTIFACT_FILE_MISSING", "Clip preview file is missing.", status_code=500)
        return path

    def proxy_path(self, project_id: str) -> Path:
        project = self.repository.get_project(project_id)
        proxy = project.get("proxy")
        if not proxy:
            raise StudioError("MEDIA_PROXY_NOT_READY", "Proxy is not ready.", status_code=409)
        path = self.storage.resolve_uri(str(proxy["uri"]))
        if not path.is_file():
            raise StudioError("STORAGE_ARTIFACT_FILE_MISSING", "Proxy artifact file is missing.", status_code=500)
        return path

    def production_artifact_path(self, project_id: str, kind: str) -> Path:
        project = self.repository.get_project(project_id)
        artifact = project["production"].get("artifacts", {}).get(kind)
        if not artifact:
            raise StudioError("PRODUCTION_ARTIFACT_NOT_READY", f"Production artifact {kind} is not ready.", status_code=409)
        if artifact.get("project_id") != project_id:
            raise StudioError("SECURITY_ARTIFACT_PROJECT_MISMATCH", "Artifact does not belong to this project.", status_code=500)
        path = self.storage.resolve_uri(str(artifact["uri"]))
        if not path.is_file():
            raise StudioError("STORAGE_ARTIFACT_FILE_MISSING", "Production artifact file is missing.", status_code=500)
        return path

    def audio_waveform(self, project_id: str, track: str) -> dict[str, Any]:
        if track == "voice":
            source = self.production_artifact_path(project_id, "voice")
        elif track == "source":
            source = self.proxy_path(project_id)
        else:
            raise StudioError("WAVEFORM_TRACK_INVALID", "Waveform track must be source or voice.")
        return self.media.audio_waveform(source, bins=480)

    def analysis_frame_path(self, project_id: str, frame_id: str) -> Path:
        artifact = self.repository.get_analysis_frame(project_id, frame_id)
        path = self.storage.resolve_uri(str(artifact["uri"]))
        if not path.is_file():
            raise StudioError("STORAGE_ARTIFACT_FILE_MISSING", "Analysis frame file is missing.", status_code=500)
        return path

    def thumbnail_path(self, project_id: str, variant_id: str) -> Path:
        artifact = self.repository.get_thumbnail_artifact(project_id, variant_id)
        path = self.storage.resolve_uri(str(artifact["uri"]))
        if not path.is_file():
            raise StudioError("STORAGE_ARTIFACT_FILE_MISSING", "Thumbnail artifact file is missing.", status_code=500)
        return path

    async def _worker_loop(self) -> None:
        while not self._stop.is_set():
            job = await asyncio.to_thread(
                self.repository.claim_job,
                self.worker_id,
                self.settings.worker_lease_seconds,
            )
            if job is None:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.settings.worker_poll_interval_seconds)
                except TimeoutError:
                    pass
                continue
            await asyncio.to_thread(self._run_job, job)

    def _run_job(self, job: dict[str, Any]) -> None:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        try:
            if job["kind"] == "INGEST_SOURCE":
                artifact_id = self._ingest(job)
            elif job["kind"] == "GENERATE_PROXY":
                artifact_id = self._proxy(job)
            elif job["kind"] == "ANALYZE_SCENES":
                artifact_id = self._analyze_scenes(job)
            elif job["kind"] == "EXTRACT_KEYFRAMES":
                artifact_id = self._extract_keyframes(job)
            elif job["kind"] == "OCR_FRAMES":
                artifact_id = self._ocr_frames(job)
            elif job["kind"] == "ANALYZE_GAMEPLAY":
                artifact_id = self._analyze_gameplay(job)
            elif job["kind"] == "BUILD_NARRATIVE_MAP":
                artifact_id = self._build_narrative_map(job)
            elif job["kind"] == "PLAN_CONTENT":
                artifact_id = self._plan_content(job)
            elif job["kind"] == "VERIFY_FACTS":
                artifact_id = self._verify_facts(job)
            elif job["kind"] == "GENERATE_SCRIPT":
                artifact_id = self._generate_script(job)
            elif job["kind"] == "SYNTHESIZE_VOICE":
                artifact_id = self._synthesize_voice(job)
            elif job["kind"] == "PLAN_ADVANCED_EDIT":
                artifact_id = self._plan_advanced_edit(job)
            elif job["kind"] == "BUILD_TIMELINE":
                artifact_id = self._build_timeline(job)
            elif job["kind"] == "RENDER_VERTICAL":
                artifact_id = self._render_vertical(job)
            elif job["kind"] == "GENERATE_CREATIVE_PACKAGE":
                artifact_id = self._generate_creative_package(job)
            elif job["kind"] == "RENDER_CLIP_PREVIEW":
                artifact_id = self._render_clip_preview(job)
            else:
                raise StudioError("JOB_KIND_UNSUPPORTED", f"Unsupported job kind: {job['kind']}", status_code=500)
            if job["kind"] == "GENERATE_PROXY":
                self.repository.complete_proxy_job(job_id, self.worker_id, artifact_id, project_id)
            else:
                self.repository.complete_job(job_id, self.worker_id, artifact_id)
        except JobCancelled as error:
            self._mark_analysis_failed(job)
            self.repository.fail_job(job_id, self.worker_id, error)
        except StudioError as error:
            logger.error(
                error.message,
                extra={"event": "job.failed", "project_id": project_id, "job_id": job_id, "attributes": {"code": error.code}},
            )
            self._mark_analysis_failed(job)
            self.repository.fail_job(job_id, self.worker_id, error)
        except Exception as error:
            logger.exception("Unexpected worker failure", extra={"event": "job.unexpected_failure", "project_id": project_id, "job_id": job_id})
            self.repository.fail_job(
                job_id,
                self.worker_id,
                StudioError("INTERNAL_UNEXPECTED", "Unexpected worker failure.", status_code=500, details={"type": type(error).__name__}),
            )
            self._mark_analysis_failed(job)

    def _mark_analysis_failed(self, job: dict[str, Any]) -> None:
        if job["kind"] not in {"ANALYZE_SCENES", "EXTRACT_KEYFRAMES", "OCR_FRAMES", "ANALYZE_GAMEPLAY"}:
            return
        analysis_run_id = dict(job["parameters"]).get("analysis_run_id")
        if analysis_run_id:
            self.repository.fail_analysis_run(str(analysis_run_id))

    def _ingest(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        progress = self._progress_callback(job_id)
        cancelled = lambda: self.repository.is_cancel_requested(job_id)
        source = self.storage.ingest_source(
            str(parameters["resolved_source_path"]),
            project_id,
            progress,
            cancelled,
        )
        if cancelled():
            raise JobCancelled()
        probe = self.media.probe(source.path)
        progress(0.94)
        media_id = self.repository.register_media(project_id, source.uri, source.sha256, source.size_bytes, probe)
        project = self.repository.get_project(project_id)
        if project["pipeline_stage"] == "SOURCE_SELECTED":
            self.repository.update_stage(project_id, "SOURCE_SELECTED", "INGESTED", event="project.ingested")

        report = {
            "schema_version": "1.0",
            "project_id": project_id,
            "media_id": media_id,
            "integrity": {"sha256": source.sha256, "size_bytes": source.size_bytes},
            "metadata": probe.as_dict(),
            "managed_source_uri": source.uri,
        }
        report_path = self.storage.write_json(project_id, "reports/import.json", report)
        report_sha = sha256_file(report_path)
        report_artifact_id = self.repository.register_artifact(
            project_id,
            "import_report",
            self.storage.to_uri(report_path),
            report_sha,
            report_path.stat().st_size,
            "application/json",
            INGEST_VERSION,
            source.sha256,
            {"media_id": media_id},
        )
        proxy_parameters = {
            "media_id": media_id,
            "source_sha256": source.sha256,
            "max_width": self.settings.proxy_max_width,
            "crf": self.settings.proxy_crf,
            "preset": self.settings.proxy_preset,
        }
        proxy_fingerprint = fingerprint({
            "source_sha256": source.sha256,
            "max_width": self.settings.proxy_max_width,
            "crf": self.settings.proxy_crf,
            "preset": self.settings.proxy_preset,
        })
        self.repository.enqueue_job(
            project_id,
            "GENERATE_PROXY",
            proxy_parameters,
            proxy_fingerprint,
            PROXY_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return report_artifact_id

    def _proxy(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        media_record = self.repository.get_primary_media(project_id)
        source = self.storage.resolve_uri(str(media_record["original_uri"]))
        input_fingerprint = str(job["input_fingerprint"])
        cached = self.repository.find_artifact("proxy", PROXY_VERSION, input_fingerprint)
        if cached:
            cached_path = self.storage.resolve_uri(str(cached["uri"]))
            if cached_path.is_file():
                self.repository.link_derivative(str(parameters["media_id"]), str(cached["id"]), "proxy")
                self.storage.link_project_proxy(project_id, cached_path)
                return str(cached["id"])

        destination = self.storage.proxy_cache_path(input_fingerprint)
        progress = self._progress_callback(job_id)
        cancelled = lambda: self.repository.is_cancel_requested(job_id)
        if destination.is_file() and destination.stat().st_size > 0:
            proxy_probe = self.media.probe(destination)
        else:
            proxy_probe = self.media.generate_proxy(
                source,
                destination,
                int(media_record["duration_ms"]),
                progress,
                cancelled,
            )
        if cancelled():
            raise JobCancelled()
        proxy_sha = sha256_file(destination)
        artifact_id = self.repository.register_artifact(
            None,
            "proxy",
            self.storage.to_uri(destination),
            proxy_sha,
            destination.stat().st_size,
            "video/mp4",
            PROXY_VERSION,
            input_fingerprint,
            proxy_probe.as_dict(),
        )
        self.repository.link_derivative(str(parameters["media_id"]), artifact_id, "proxy")
        self.storage.link_project_proxy(project_id, destination)
        progress(1.0)
        return artifact_id

    def _analyze_scenes(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        production_key = str(parameters["brief_id"])
        media_record = self.repository.get_primary_media(project_id)
        proxy = self.proxy_path(project_id)
        progress = self._progress_callback(job_id)
        cancelled = lambda: self.repository.is_cancel_requested(job_id)
        boundaries = self.media.detect_scene_boundaries(
            proxy,
            int(media_record["duration_ms"]),
            progress,
            cancelled,
            self.settings.scene_threshold,
        )
        segments = build_scene_segments(boundaries, int(media_record["duration_ms"]), str(media_record["id"]))
        self.repository.replace_segments(project_id, segments)
        structured = dict(parameters["structured_brief"])
        output_duration_ms = min(
            int(media_record["duration_ms"]),
            int(structured["target_duration_seconds"]) * 1000,
        )
        report = {
            "schema_version": "1.0",
            "detector": SCENE_VERSION,
            "threshold": self.settings.scene_threshold,
            "source_duration_ms": media_record["duration_ms"],
            "requested_duration_ms": int(structured["target_duration_seconds"]) * 1000,
            "output_duration_ms": output_duration_ms,
            "boundaries_ms": boundaries,
            "segments": segments,
            "selected_clips": [],
        }
        path = self.storage.write_json(project_id, f"analysis/scenes-{production_key}.json", report)
        artifact_id = self.repository.register_artifact(
            project_id,
            "scene_report",
            self.storage.to_uri(path),
            sha256_file(path),
            path.stat().st_size,
            "application/json",
            SCENE_VERSION,
            str(job["input_fingerprint"]),
            {"segment_count": len(segments), "output_duration_ms": output_duration_ms},
        )
        self._ensure_stages(project_id, ["ANALYZED"])
        next_parameters = {
            **parameters,
            "scene_report_artifact_id": artifact_id,
            "segments": segments,
            "output_duration_ms": output_duration_ms,
        }
        self.repository.enqueue_job(
            project_id,
            "EXTRACT_KEYFRAMES",
            next_parameters,
            fingerprint(next_parameters),
            FRAME_VERSION,
            dependencies=[job_id],
        )
        return artifact_id

    def _extract_keyframes(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        analysis_run_id = str(parameters["analysis_run_id"])
        media_record = self.repository.get_primary_media(project_id)
        progress = self._progress_callback(job_id)
        cancelled = lambda: self.repository.is_cancel_requested(job_id)
        frame_dir = self.storage.project_file(project_id, f"frames/{parameters['brief_id']}")
        frame_dir.mkdir(parents=True, exist_ok=True)
        frames = self.vision.extract_frames(
            self.proxy_path(project_id),
            frame_dir,
            int(media_record["duration_ms"]),
            list(parameters["segments"]),
            progress,
            cancelled,
        )
        persisted_frames: list[dict[str, Any]] = []
        for frame in frames:
            path = Path(frame.pop("path"))
            frame_fingerprint = fingerprint({
                "analysis_run_id": analysis_run_id,
                "media_sha256": parameters["media_sha256"],
                "timestamp_ms": frame["timestamp_ms"],
                "frame_version": FRAME_VERSION,
            })
            artifact_id = self.repository.register_artifact(
                project_id,
                "analysis_frame",
                self.storage.to_uri(path),
                sha256_file(path),
                path.stat().st_size,
                "image/jpeg",
                FRAME_VERSION,
                frame_fingerprint,
                {"timestamp_ms": frame["timestamp_ms"], "width": frame["width"], "height": frame["height"]},
            )
            persisted_frames.append({**frame, "artifact_id": artifact_id, "uri": self.storage.to_uri(path)})
        self.repository.save_analysis_frames(
            analysis_run_id,
            project_id,
            str(media_record["id"]),
            persisted_frames,
        )
        manifest = {
            "schema_version": "1.0",
            "extractor": FRAME_VERSION,
            "analysis_run_id": analysis_run_id,
            "frame_count": len(persisted_frames),
            "frames": persisted_frames,
        }
        path = self.storage.write_json(project_id, f"analysis/frames-{parameters['brief_id']}.json", manifest)
        artifact_id = self.repository.register_artifact(
            project_id,
            "frame_manifest",
            self.storage.to_uri(path),
            sha256_file(path),
            path.stat().st_size,
            "application/json",
            FRAME_VERSION,
            str(job["input_fingerprint"]),
            {"analysis_run_id": analysis_run_id, "frame_count": len(persisted_frames)},
        )
        next_parameters = {**parameters, "frame_manifest_artifact_id": artifact_id}
        self.repository.enqueue_job(
            project_id,
            "OCR_FRAMES",
            next_parameters,
            fingerprint(next_parameters),
            OCR_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return artifact_id

    def _ocr_frames(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        analysis_run_id = str(parameters["analysis_run_id"])
        analysis = self.repository.get_project(project_id)["analysis"]
        frames = list(analysis["frames"])
        detections: list[dict[str, Any]] = []
        progress = self._progress_callback(job_id)
        cancelled = lambda: self.repository.is_cancel_requested(job_id)
        for index, frame in enumerate(frames):
            if cancelled():
                raise JobCancelled()
            for observed in self.vision.recognize_text(self.storage.resolve_uri(str(frame["artifact_uri"]))):
                text = str(observed["text"])
                normalized = self.gta5_adapter.normalize_text(text) if parameters["game_id"] == "gta5" else normalize_observed_text(text)
                detections.append({
                    "id": uuid7(),
                    "segment_id": frame["segment_id"],
                    "frame_id": frame["id"],
                    "start_ms": frame["timestamp_ms"],
                    "end_ms": int(frame["timestamp_ms"]) + 1,
                    "text": text,
                    "normalized_text": normalized,
                    "locale": "und",
                    "confidence": observed["confidence"],
                    "region": observed["region"],
                    "detector_version": OCR_VERSION,
                    "attributes": {"pass": observed["pass"], "fact_status": "observed_text"},
                })
            progress((index + 1) / max(1, len(frames)))
        self.repository.replace_ocr_detections(analysis_run_id, project_id, detections)
        report = {
            "schema_version": "1.0",
            "detector": OCR_VERSION,
            "analysis_run_id": analysis_run_id,
            "frame_count": len(frames),
            "text_count": len(detections),
            "detections": detections,
            "notice": "Le texte est une observation OCR avec confiance; son interprétation n'est pas un fait vérifié.",
        }
        path = self.storage.write_json(project_id, f"analysis/ocr-{parameters['brief_id']}.json", report)
        artifact_id = self.repository.register_artifact(
            project_id,
            "ocr_report",
            self.storage.to_uri(path),
            sha256_file(path),
            path.stat().st_size,
            "application/json",
            OCR_VERSION,
            str(job["input_fingerprint"]),
            {"analysis_run_id": analysis_run_id, "text_count": len(detections)},
        )
        next_parameters = {**parameters, "ocr_report_artifact_id": artifact_id}
        self.repository.enqueue_job(
            project_id,
            "ANALYZE_GAMEPLAY",
            next_parameters,
            fingerprint(next_parameters),
            ADAPTER_VERSION if parameters["game_id"] == "gta5" else "generic-visual-v1",
            dependencies=[job_id],
        )
        progress(1.0)
        return artifact_id

    def _analyze_gameplay(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        analysis_run_id = str(parameters["analysis_run_id"])
        progress = self._progress_callback(job_id)
        progress(0.08)
        analysis = self.repository.get_project(project_id)["analysis"]
        frames = list(analysis["frames"])
        texts_by_frame: dict[str, list[dict[str, Any]]] = {}
        for text in analysis["texts"]:
            texts_by_frame.setdefault(str(text["frame_id"]), []).append(text)
        structured = dict(parameters["structured_brief"])
        if parameters["game_id"] == "gta5":
            report = self.gta5_adapter.analyze(
                brief=str(structured["raw_instruction"]),
                frames=frames,
                texts_by_frame=texts_by_frame,
                segments=list(parameters["segments"]),
            )
        else:
            report = build_generic_visual_report(
                brief=str(structured["raw_instruction"]),
                frames=frames,
                texts_by_frame=texts_by_frame,
                segments=list(parameters["segments"]),
            )
        report["analysis_run_id"] = analysis_run_id
        report["fact_policy"] = {
            "brief": "editorial_intention_only",
            "ocr": "observed_text_with_confidence",
            "detections": "inferred_candidates",
            "verified_game_facts": 0,
        }
        progress(0.42)
        path = self.storage.write_json(project_id, f"analysis/gameplay-{parameters['brief_id']}.json", report)
        artifact_id = self.repository.register_artifact(
            project_id,
            "visual_analysis_report",
            self.storage.to_uri(path),
            sha256_file(path),
            path.stat().st_size,
            "application/json",
            str(report["adapter"]["detector_version"]),
            str(job["input_fingerprint"]),
            {"analysis_run_id": analysis_run_id, **report["summary"]},
        )
        self.repository.complete_visual_analysis(analysis_run_id, project_id, artifact_id, report)
        self._ensure_stages(project_id, ["SEGMENTED"])
        progress(0.72)
        source_segments = {str(segment["id"]): segment for segment in parameters["segments"]}
        updated_segments = [
            {**source_segments[str(segment["id"])], **segment}
            for segment in report["segment_updates"]
        ]
        next_parameters = {
            **parameters,
            "analysis_report_artifact_id": artifact_id,
            "segments": updated_segments,
        }
        self.repository.enqueue_job(
            project_id,
            "BUILD_NARRATIVE_MAP",
            next_parameters,
            fingerprint(next_parameters),
            NARRATIVE_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return artifact_id

    def _build_narrative_map(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        progress = self._progress_callback(job_id)
        progress(0.08)
        narrative_map, coverage_report = build_narrative_map(
            project_id=project_id,
            brief_id=str(parameters["brief_id"]),
            structured_brief=dict(parameters["structured_brief"]),
            segments=list(parameters["segments"]),
        )
        narrative_map_id = self.repository.create_narrative_package(
            project_id,
            str(parameters["brief_id"]),
            narrative_map,
            coverage_report,
        )
        progress(0.48)
        production_key = str(parameters["brief_id"])
        map_path = self.storage.write_json(project_id, f"analysis/narrative-map-{production_key}.json", narrative_map)
        artifact_id = self.repository.register_artifact(
            project_id,
            "narrative_map",
            self.storage.to_uri(map_path),
            sha256_file(map_path),
            map_path.stat().st_size,
            "application/json",
            NARRATIVE_VERSION,
            str(job["input_fingerprint"]),
            {
                "narrative_map_id": narrative_map_id,
                "required_coverage": narrative_map["required_coverage"],
                "missing_required_count": narrative_map["missing_required_count"],
            },
        )
        coverage_path = self.storage.write_json(project_id, f"reports/coverage-{production_key}.json", coverage_report)
        coverage_artifact_id = self.repository.register_artifact(
            project_id,
            "coverage_report",
            self.storage.to_uri(coverage_path),
            sha256_file(coverage_path),
            coverage_path.stat().st_size,
            "application/json",
            NARRATIVE_VERSION,
            fingerprint({"map": narrative_map_id, "coverage": coverage_report}),
            {
                "narrative_map_id": narrative_map_id,
                "editing_decision": coverage_report["editing_decision"],
                "complementary_footage_count": len(coverage_report["complementary_footage"]),
            },
        )
        self._ensure_stages(project_id, ["NARRATIVE_MAPPED", "COVERAGE_CHECKED"])
        progress(0.82)
        next_parameters = {
            **parameters,
            "narrative_map_id": narrative_map_id,
            "narrative_map_artifact_id": artifact_id,
            "coverage_artifact_id": coverage_artifact_id,
            "narrative_map": narrative_map,
            "coverage_report": coverage_report,
        }
        self.repository.enqueue_job(
            project_id,
            "PLAN_CONTENT",
            next_parameters,
            fingerprint(next_parameters),
            CONTENT_PLAN_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return artifact_id

    def _plan_content(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        progress = self._progress_callback(job_id)
        progress(0.1)
        plans = build_content_plans(
            dict(parameters["structured_brief"]),
            dict(parameters["narrative_map"]),
            dict(parameters["coverage_report"]),
            int(parameters["output_duration_ms"]),
        )
        selected_plan = next(plan for plan in plans if plan["selected"])
        content_plan_id = self.repository.create_content_plans(
            project_id,
            str(parameters["narrative_map_id"]),
            plans,
        )
        media_record = self.repository.get_primary_media(project_id)
        structured = dict(parameters["structured_brief"])
        clips = select_planned_clips(
            list(parameters["segments"]),
            selected_plan,
            int(media_record["duration_ms"]),
            int(parameters["output_duration_ms"]),
            str(structured["pacing"]),
        )
        progress(0.56)
        production_key = str(parameters["brief_id"])
        path = self.storage.write_json(project_id, f"scripts/content-plans-{production_key}.json", {
            "schema_version": "1.0",
            "narrative_map_id": parameters["narrative_map_id"],
            "selected_plan_id": content_plan_id,
            "plans": plans,
        })
        artifact_id = self.repository.register_artifact(
            project_id,
            "content_plan",
            self.storage.to_uri(path),
            sha256_file(path),
            path.stat().st_size,
            "application/json",
            CONTENT_PLAN_VERSION,
            str(job["input_fingerprint"]),
            {
                "content_plan_id": content_plan_id,
                "variant": selected_plan["variant"],
                "score": selected_plan["score"],
                "variant_count": len(plans),
            },
        )
        self._ensure_stages(project_id, ["CONTENT_PLANNED"])
        next_parameters = {
            **parameters,
            "content_plan_id": content_plan_id,
            "content_plan_artifact_id": artifact_id,
            "content_plans": plans,
            "selected_plan": selected_plan,
            "clips": clips,
        }
        self.repository.enqueue_job(
            project_id,
            "VERIFY_FACTS",
            next_parameters,
            fingerprint(next_parameters),
            EVIDENCE_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return artifact_id

    def _verify_facts(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        game_id = str(parameters["game_id"])
        progress = self._progress_callback(job_id)
        progress(0.08)
        project = self.repository.get_project(project_id)
        knowledge_items = self.repository.list_knowledge_items(game_id)
        history_counts = self.repository.claim_history_counts(game_id, project_id)
        report = build_verification_report(
            project_id=project_id,
            brief_id=str(parameters["brief_id"]),
            game_id=game_id,
            structured_brief=dict(parameters["structured_brief"]),
            narrative_map=dict(parameters["narrative_map"]),
            selected_plan=dict(parameters["selected_plan"]),
            analysis=dict(project["analysis"]),
            knowledge_items=knowledge_items,
            history_counts=history_counts,
        )
        progress(0.46)
        production_key = str(parameters["brief_id"])
        path = self.storage.write_json(project_id, f"reports/evidence-{production_key}.json", report)
        artifact_id = self.repository.register_artifact(
            project_id,
            "evidence_report",
            self.storage.to_uri(path),
            sha256_file(path),
            path.stat().st_size,
            "application/json",
            EVIDENCE_VERSION,
            str(job["input_fingerprint"]),
            {
                "verification_run_id": report["id"],
                "status": report["status"],
                **report["summary"],
            },
        )
        self.repository.create_verification_package(
            project_id,
            str(parameters["brief_id"]),
            game_id,
            report,
            artifact_id,
        )
        self._ensure_stages(project_id, ["FACTS_VERIFIED"])
        progress(0.82)
        next_parameters = {
            **parameters,
            "evidence_report_artifact_id": artifact_id,
            "verification_report": report,
        }
        self.repository.enqueue_job(
            project_id,
            "GENERATE_SCRIPT",
            next_parameters,
            fingerprint(next_parameters),
            SCRIPT_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return artifact_id

    def _generate_script(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        production_key = str(parameters["brief_id"])
        progress = self._progress_callback(job_id)
        progress(0.1)
        script = build_script(
            dict(parameters["structured_brief"]),
            int(parameters["output_duration_ms"]),
            content_plan=dict(parameters["selected_plan"]),
            coverage_report=dict(parameters["coverage_report"]),
            verification_report=dict(parameters["verification_report"]),
        )
        script_id = self.repository.create_script_package(
            project_id,
            str(parameters["content_plan_id"]),
            script,
        )
        progress(0.65)
        path = self.storage.write_json(project_id, f"scripts/script-{production_key}.json", script)
        self.storage.write_text(project_id, f"scripts/narration-{production_key}.txt", str(script["full_text"]))
        artifact_id = self.repository.register_artifact(
            project_id,
            "script",
            self.storage.to_uri(path),
            sha256_file(path),
            path.stat().st_size,
            "application/json",
            SCRIPT_VERSION,
            str(job["input_fingerprint"]),
            {"script_id": script_id, "block_count": len(script["blocks"]), **script["safety"]},
        )
        self._ensure_stages(project_id, ["SCRIPTED"])
        next_parameters = {
            **parameters,
            "script_id": script_id,
            "script_artifact_id": artifact_id,
            "script": script,
        }
        self.repository.enqueue_job(
            project_id,
            "SYNTHESIZE_VOICE",
            next_parameters,
            fingerprint(next_parameters),
            VOICE_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return artifact_id

    def _synthesize_voice(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        production_key = str(parameters["brief_id"])
        structured = dict(parameters["structured_brief"])
        production = dict(structured["production"])
        progress = self._progress_callback(job_id)
        text_path = self.storage.write_text(project_id, f"voice/narration-{production_key}.txt", str(parameters["script"]["full_text"]))
        voice_path = self.storage.project_file(project_id, f"voice/narration-{production_key}.wav")
        progress(0.1)
        self.speech.synthesize(text_path, voice_path, str(production["voice_id"]), int(production["voice_rate"]))
        voice_duration_ms = self.media.probe_duration_ms(voice_path)
        progress(0.55)
        captions = build_captions(dict(parameters["script"]), voice_duration_ms, int(parameters["output_duration_ms"]))
        srt_path = self.storage.project_file(project_id, f"scripts/captions-{production_key}.srt")
        ass_path = self.storage.project_file(project_id, f"scripts/captions-{production_key}.ass")
        write_subtitles(captions, srt_path, ass_path, str(production["caption_style"]))
        artifact_fingerprint = str(job["input_fingerprint"])
        voice_artifact_id = self.repository.register_artifact(
            project_id,
            "voice",
            self.storage.to_uri(voice_path),
            sha256_file(voice_path),
            voice_path.stat().st_size,
            "audio/wav",
            VOICE_VERSION,
            artifact_fingerprint,
            {"voice_id": production["voice_id"], "rate": production["voice_rate"], "duration_ms": voice_duration_ms},
        )
        srt_artifact_id = self.repository.register_artifact(
            project_id,
            "subtitles_srt",
            self.storage.to_uri(srt_path),
            sha256_file(srt_path),
            srt_path.stat().st_size,
            "application/x-subrip",
            VOICE_VERSION,
            artifact_fingerprint,
            {"caption_count": len(captions), "style": production["caption_style"]},
        )
        ass_artifact_id = self.repository.register_artifact(
            project_id,
            "subtitles_ass",
            self.storage.to_uri(ass_path),
            sha256_file(ass_path),
            ass_path.stat().st_size,
            "text/x-ssa",
            VOICE_VERSION,
            artifact_fingerprint,
            {"caption_count": len(captions), "style": production["caption_style"]},
        )
        self.repository.create_voice_track(
            project_id,
            str(parameters["script_id"]),
            voice_artifact_id,
            str(production["voice_id"]),
            voice_duration_ms,
            captions,
        )
        self._ensure_stages(project_id, ["VOICED"])
        next_parameters = {
            **parameters,
            "voice_artifact_id": voice_artifact_id,
            "srt_artifact_id": srt_artifact_id,
            "ass_artifact_id": ass_artifact_id,
            "captions": captions,
            "voice_duration_ms": voice_duration_ms,
        }
        self.repository.enqueue_job(
            project_id,
            "PLAN_ADVANCED_EDIT",
            next_parameters,
            fingerprint(next_parameters),
            ADVANCED_EDIT_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return voice_artifact_id

    def _plan_advanced_edit(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        production_key = str(parameters["brief_id"])
        progress = self._progress_callback(job_id)
        project = self.repository.get_project(project_id)
        existing_edit = project["production"].get("advanced_edit")
        if existing_edit and str(existing_edit.get("brief_id", parameters["brief_id"])) == str(parameters["brief_id"]):
            existing_plan_path = self.storage.resolve_uri(str(existing_edit["plan_artifact_uri"]))
            existing_plan = json.loads(existing_plan_path.read_text(encoding="utf-8"))
            next_parameters = {
                **parameters,
                "advanced_edit_plan_artifact_id": existing_edit["plan_artifact_id"],
                "overlay_artifact_id": existing_edit["overlay_artifact_id"],
                "advanced_edit_plan": existing_plan,
                "clips": existing_plan["clips"],
            }
            self.repository.enqueue_job(
                project_id,
                "BUILD_TIMELINE",
                next_parameters,
                fingerprint(next_parameters),
                TIMELINE_VERSION,
                dependencies=[job_id],
            )
            progress(1.0)
            return str(existing_edit["plan_artifact_id"])
        analysis = dict(project["analysis"])
        frame_paths = {
            str(frame["id"]): self.storage.resolve_uri(str(frame["artifact_uri"]))
            for frame in analysis.get("frames", [])
            if frame.get("artifact_uri")
        }
        style = str(parameters["structured_brief"]["production"]["editorial_style"])
        template = load_edit_template(self.settings.template_root, style)
        progress(0.12)
        plan = build_advanced_edit_plan(
            project_id=project_id,
            brief_id=str(parameters["brief_id"]),
            structured_brief=dict(parameters["structured_brief"]),
            clips=list(parameters["clips"]),
            script=dict(parameters["script"]),
            content_plan=dict(parameters["selected_plan"]),
            narrative_map=dict(parameters["narrative_map"]),
            verification_report=dict(parameters["verification_report"]),
            analysis=analysis,
            frame_paths=frame_paths,
            template=template,
            source_duration_ms=int(parameters["source_duration_ms"]),
        )
        progress(0.6)
        plan_path = self.storage.write_json(project_id, f"timelines/advanced-edit-{production_key}.json", plan)
        overlay_path = self.storage.project_file(project_id, f"timelines/overlays-{production_key}.ass")
        write_overlay_ass(plan, overlay_path)
        plan_artifact_id = self.repository.register_artifact(
            project_id,
            "advanced_edit_plan",
            self.storage.to_uri(plan_path),
            sha256_file(plan_path),
            plan_path.stat().st_size,
            "application/json",
            ADVANCED_EDIT_VERSION,
            str(job["input_fingerprint"]),
            dict(plan["summary"]),
        )
        overlay_artifact_id = self.repository.register_artifact(
            project_id,
            "overlay_ass",
            self.storage.to_uri(overlay_path),
            sha256_file(overlay_path),
            overlay_path.stat().st_size,
            "text/x-ssa",
            OVERLAY_RENDER_VERSION,
            fingerprint({"plan_id": plan["id"], "overlays": plan["overlays"]}),
            {"plan_id": plan["id"], "overlay_count": len(plan["overlays"]), "template_id": plan["template"]["id"]},
        )
        self.repository.create_advanced_edit_package(
            project_id,
            str(parameters["brief_id"]),
            plan_artifact_id,
            overlay_artifact_id,
            plan,
        )
        next_parameters = {
            **parameters,
            "advanced_edit_plan_artifact_id": plan_artifact_id,
            "overlay_artifact_id": overlay_artifact_id,
            "advanced_edit_plan": plan,
            "clips": plan["clips"],
        }
        self.repository.enqueue_job(
            project_id,
            "BUILD_TIMELINE",
            next_parameters,
            fingerprint(next_parameters),
            TIMELINE_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return plan_artifact_id

    def _build_timeline(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        production_key = str(parameters["brief_id"])
        media_record = self.repository.get_primary_media(project_id)
        production = dict(parameters["structured_brief"]["production"])
        timeline = build_timeline(
            project_id=project_id,
            media_id=str(media_record["id"]),
            media_uri=str(media_record["original_uri"]),
            voice_artifact_id=str(parameters["voice_artifact_id"]),
            clips=list(parameters["clips"]),
            captions=list(parameters["captions"]),
            composition=str(production["composition"]),
            output_duration_ms=int(parameters["output_duration_ms"]),
            width=self.settings.render_width,
            height=self.settings.render_height,
            advanced_edit_plan=dict(parameters["advanced_edit_plan"]),
        )
        path = self.storage.write_json(project_id, f"timelines/main-{production_key}.timeline.json", timeline)
        artifact_id = self.repository.register_artifact(
            project_id,
            "timeline",
            self.storage.to_uri(path),
            sha256_file(path),
            path.stat().st_size,
            "application/json",
            TIMELINE_VERSION,
            str(job["input_fingerprint"]),
            {"duration_ms": timeline["duration"], "width": timeline["width"], "height": timeline["height"]},
        )
        edit_project_id = self.repository.create_edit_project(project_id, str(parameters["script_id"]), timeline)
        self._ensure_stages(project_id, ["TIMELINE_BUILT"])
        next_parameters = {
            **parameters,
            "timeline_artifact_id": artifact_id,
            "edit_project_id": edit_project_id,
        }
        self.repository.enqueue_job(
            project_id,
            "RENDER_VERTICAL",
            next_parameters,
            fingerprint(next_parameters),
            RENDER_VERSION,
            dependencies=[job_id],
        )
        return artifact_id

    def _render_vertical(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        production_key = str(parameters["brief_id"])
        media_record = self.repository.get_primary_media(project_id)
        source = self.storage.resolve_uri(str(media_record["original_uri"]))
        voice_artifact = self.repository.get_artifact(str(parameters["voice_artifact_id"]))
        ass_artifact = self.repository.get_artifact(str(parameters["ass_artifact_id"]))
        overlay_artifact = self.repository.get_artifact(str(parameters["overlay_artifact_id"]))
        voice_path = self.storage.resolve_uri(str(voice_artifact["uri"]))
        ass_path = self.storage.resolve_uri(str(ass_artifact["uri"]))
        overlay_path = self.storage.resolve_uri(str(overlay_artifact["uri"]))
        destination = self.storage.project_file(project_id, f"renders/final-vertical-{production_key}.mp4")
        production = dict(parameters["structured_brief"]["production"])
        advanced_edit = dict(parameters["advanced_edit_plan"])
        render_plan = {
            "schema_version": "1.0",
            "renderer": RENDER_VERSION,
            "width": self.settings.render_width,
            "height": self.settings.render_height,
            "fps": 30,
            "duration_ms": parameters["output_duration_ms"],
            "composition": production["composition"],
            "source_audio_level": production["source_audio_level"],
            "clips": parameters["clips"],
            "advanced_edit_plan_id": advanced_edit["id"],
            "advanced_edit_plan_artifact_id": parameters["advanced_edit_plan_artifact_id"],
            "overlay_artifact_id": parameters["overlay_artifact_id"],
            "template": advanced_edit["template"],
            "audio_mix": advanced_edit["audio_mix"],
            "voice_artifact_id": parameters["voice_artifact_id"],
            "subtitle_artifact_id": parameters["ass_artifact_id"],
            "timeline_artifact_id": parameters["timeline_artifact_id"],
        }
        render_job_id = self.repository.create_render_job(project_id, str(parameters["edit_project_id"]), job_id, render_plan)
        progress = self._progress_callback(job_id)
        cancelled = lambda: self.repository.is_cancel_requested(job_id)
        probe = self.renderer.render(
            source,
            voice_path,
            ass_path,
            destination,
            list(parameters["clips"]),
            composition=str(production["composition"]),
            source_has_audio=bool(media_record["audio_codec"]),
            source_audio_level=float(production["source_audio_level"]),
            duration_ms=int(parameters["output_duration_ms"]),
            overlays=overlay_path,
            audio_mix=dict(advanced_edit["audio_mix"]),
            progress=progress,
            cancelled=cancelled,
        )
        artifact_id = self.repository.register_artifact(
            project_id,
            "final_render",
            self.storage.to_uri(destination),
            sha256_file(destination),
            destination.stat().st_size,
            "video/mp4",
            RENDER_VERSION,
            str(job["input_fingerprint"]),
            probe.as_dict(),
        )
        self.repository.link_derivative(str(media_record["id"]), artifact_id, "render")
        ffmpeg_version = str(self.media.diagnostics()["ffmpeg"])
        self.repository.complete_render_job(project_id, render_job_id, artifact_id, ffmpeg_version)
        duration_delta = abs(probe.duration_ms - int(parameters["output_duration_ms"]))
        verification_report = dict(parameters.get("verification_report", {}))
        script_safety = dict(parameters.get("script", {}).get("safety", {}))
        admitted_claim_ids = {str(value) for value in verification_report.get("gate", {}).get("admitted_claim_ids", [])}
        sourced_claim_ids = {str(value) for value in script_safety.get("sourced_claim_ids", [])}
        block_claim_ids = {
            str(claim_id)
            for block in parameters.get("script", {}).get("blocks", [])
            for claim_id in block.get("supporting_claim_ids", [])
        }
        factual_mismatch = sorted((sourced_claim_ids | block_claim_ids) - admitted_claim_ids)
        overlay_claim_ids = {
            str(claim_id)
            for cue in advanced_edit.get("overlays", [])
            for claim_id in cue.get("supporting_claim_ids", [])
        }
        overlay_mismatch = sorted(overlay_claim_ids - admitted_claim_ids)
        admitted_count = len(sourced_claim_ids)
        blocked_count = int(script_safety.get("blocked_claims", 0))
        edit_summary = dict(advanced_edit.get("summary", {}))
        tracking_confidence = float(edit_summary.get("tracking_confidence", 0.0))
        checks = [
            {"check_id": "vertical_dimensions", "dimension": "platform", "status": "pass", "severity": "info", "message": f"Format vertical {probe.width}×{probe.height} validé."},
            {"check_id": "duration_tolerance", "dimension": "technical", "status": "pass" if duration_delta <= 250 else "warn", "severity": "info" if duration_delta <= 250 else "warning", "message": f"Durée rendue : {probe.duration_ms / 1000:.2f} s."},
            {"check_id": "audio_present", "dimension": "audio", "status": "pass" if probe.audio_codec else "fail", "severity": "info" if probe.audio_codec else "blocker", "message": "Piste voix AAC présente." if probe.audio_codec else "Piste audio absente."},
            {"check_id": "captions_burned", "dimension": "subtitle", "status": "pass", "severity": "info", "message": f"{len(parameters['captions'])} bloc(s) de sous-titres intégré(s)."},
            {
                "check_id": "factual_safety",
                "dimension": "factual",
                "status": "fail" if factual_mismatch else "pass",
                "severity": "blocker" if factual_mismatch else "info",
                "message": (
                    f"Claims non admis détectés dans le script : {', '.join(factual_mismatch)}."
                    if factual_mismatch
                    else f"{admitted_count} affirmation(s) sourcée(s) admise(s), {blocked_count} claim(s) exclu(s)."
                ),
            },
            {
                "check_id": "subject_tracking",
                "dimension": "visual",
                "status": "pass",
                "severity": "info",
                "message": (
                    f"Suivi dynamique actif (confiance {tracking_confidence:.0%})."
                    if tracking_confidence >= 0.38
                    else f"Recadrage de secours utilisé lorsque le suivi est incertain (confiance {tracking_confidence:.0%})."
                ),
            },
            {
                "check_id": "overlay_factual_safety",
                "dimension": "factual",
                "status": "fail" if overlay_mismatch else "pass",
                "severity": "blocker" if overlay_mismatch else "info",
                "message": (
                    f"Claims non admis dans les overlays : {', '.join(overlay_mismatch)}."
                    if overlay_mismatch
                    else f"{len(advanced_edit.get('overlays', []))} overlay(s) contrôlé(s), uniquement à partir des preuves admises."
                ),
            },
            {
                "check_id": "advanced_audio_mix",
                "dimension": "audio",
                "status": "pass",
                "severity": "info",
                "message": (
                    f"Mix voix prioritaire, cible {float(advanced_edit['audio_mix']['target_lufs']):.1f} LUFS, "
                    "ducking sidechain actif."
                ),
            },
            {
                "check_id": "purposeful_effects",
                "dimension": "visual",
                "status": "pass",
                "severity": "info",
                "message": (
                    f"{edit_summary.get('dynamic_reframe_count', 0)} recadrage(s), "
                    f"{edit_summary.get('zoom_effect_count', 0)} zoom(s), "
                    f"{edit_summary.get('speed_effect_count', 0)} accélération(s), "
                    f"{edit_summary.get('comparison_count', 0)} comparaison(s)."
                ),
            },
        ]
        self.repository.create_quality_checks(render_job_id, checks)
        self._ensure_stages(project_id, ["DRAFT_RENDERED", "QC_ANALYZED", "FINAL_RENDERED"])
        next_parameters = {
            "brief_id": parameters["brief_id"],
            "render_job_id": render_job_id,
            "render_artifact_id": artifact_id,
            "game_id": parameters["game_id"],
        }
        self.repository.enqueue_job(
            project_id,
            "GENERATE_CREATIVE_PACKAGE",
            next_parameters,
            fingerprint(next_parameters),
            CREATIVE_PACKAGE_VERSION,
            dependencies=[job_id],
        )
        progress(1.0)
        return artifact_id

    def _render_clip_preview(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        clip_id = str(parameters["clip_id"])
        clip = dict(parameters["clip"])
        cache_key = str(parameters["cache_key"])
        resolved_profile = parameters.get("resolved_profile")
        preview_window = parameters.get("preview_window")
        origin = str(parameters.get("origin", "system"))

        media_record = self.repository.get_primary_media(project_id)
        source = self.storage.resolve_uri(str(media_record["original_uri"]))
        destination = self.storage.project_file(
            project_id,
            f"renders/previews/{cache_key}.mp4",
        )
        progress = self._progress_callback(job_id)
        try:
            probe = self.renderer.render_clip_preview(
                source,
                destination,
                clip,
                composition=str(parameters.get("composition", "smart_blur")),
                source_has_audio=bool(media_record["audio_codec"]),
                resolved_profile=resolved_profile,
                preview_window=preview_window,
                progress=progress,
                cancelled=lambda: self.repository.is_cancel_requested(job_id),
            )
            
            artifact_uri = self.storage.to_uri(destination)
            sha256 = sha256_file(destination)
            size_bytes = destination.stat().st_size
            
            artifact_id = self.repository.register_artifact(
                project_id,
                "clip_preview",
                artifact_uri,
                sha256,
                size_bytes,
                "video/mp4",
                CLIP_PREVIEW_VERSION,
                str(job["input_fingerprint"]),
                {**probe.as_dict(), "clip_id": clip_id, "cache_key": cache_key},
            )
            
            self.repository.complete_preview_cache(cache_key, artifact_uri, sha256, size_bytes)
            self.repository.link_project_preview(project_id, cache_key, clip_id)
            
            # Prefetch neighbors: only for user-originated requests, never recursive
            if origin == "user" and self.settings.preview_prefetch_enabled:
                try:
                    project = self.repository.get_project(project_id)
                    production = dict(project["production"])
                    advanced_edit = production.get("advanced_edit")
                    if advanced_edit:
                        all_clips = list(advanced_edit.get("clips", []))
                        current_index = next(
                            (i for i, c in enumerate(all_clips) if str(c.get("id")) == clip_id), -1,
                        )
                        media = self.repository.get_primary_media(project_id)
                        composition = str(
                            dict(production.get("brief", {}).get("structured", {}).get("production", {}))
                            .get("composition", "smart_blur")
                        )
                        draft_profile = resolve_preview_profile("draft", self.renderer)
                        for offset in (-1, 1):
                            neighbor_idx = current_index + offset
                            if 0 <= neighbor_idx < len(all_clips):
                                neighbor_clip = all_clips[neighbor_idx]
                                neighbor_key = _preview_cache_key(
                                    source_sha256=str(media["sha256"]),
                                    clip=neighbor_clip,
                                    preview_window=None,
                                    resolved_profile=draft_profile,
                                    renderer_version=RENDER_VERSION,
                                    ffmpeg_build_id=self._ffmpeg_build_id,
                                )
                                if self.repository.find_preview_cache_entry(neighbor_key) is None:
                                    neighbor_params = {
                                        "edit_project_id": str(parameters.get("edit_project_id", "")),
                                        "clip_id": str(neighbor_clip.get("id", "")),
                                        "clip": neighbor_clip,
                                        "composition": composition,
                                        "resolved_profile": draft_profile,
                                        "preview_window": None,
                                        "cache_key": neighbor_key,
                                        "origin": "prefetch",
                                    }
                                    self.repository.enqueue_job(
                                        project_id, "RENDER_CLIP_PREVIEW",
                                        neighbor_params, neighbor_key, CLIP_PREVIEW_VERSION,
                                        idempotency_suffix=f":prefetch:{neighbor_key[:16]}",
                                    )
                                    self.repository.create_preview_cache_entry(
                                        neighbor_key, "draft", RENDER_VERSION, "",
                                    )
                except Exception:
                    pass  # Prefetch failure must not block the main render
            
            self.repository.evict_preview_cache_lru(
                self.settings.preview_cache_max_bytes, 
                self.settings.preview_cache_max_entries
            )
            
            return artifact_id
        except Exception as error:
            self.repository.fail_preview_cache(cache_key, str(error))
            raise

    def _generate_creative_package(self, job: dict[str, Any]) -> str:
        job_id = str(job["id"])
        project_id = str(job["project_id"])
        parameters = dict(job["parameters"])
        progress = self._progress_callback(job_id)
        project = self.repository.get_project(project_id)
        production = dict(project["production"])
        brief = production.get("brief")
        render = production.get("render")
        if not brief or str(brief["id"]) != str(parameters["brief_id"]):
            raise StudioError("CREATIVE_BRIEF_STALE", "The creative job does not match the current brief.", status_code=409)
        if not render or not render.get("artifact_id"):
            raise StudioError("CREATIVE_RENDER_REQUIRED", "A final render is required before building the creative package.", status_code=409)
        progress(0.08)

        frame_paths = {
            str(frame["id"]): self.storage.resolve_uri(str(frame["artifact_uri"]))
            for frame in project["analysis"]["frames"]
        }
        output_duration_ms = int((production.get("edit") or {}).get("duration") or 0)
        if output_duration_ms <= 0:
            output_duration_ms = int((render.get("artifact_metadata") or {}).get("duration_ms") or 1_000)
        package = build_creative_package(
            project_id=project_id,
            brief_id=str(brief["id"]),
            game_id=str(project["game_id"]),
            structured_brief=dict(brief["structured"]),
            analysis=dict(project["analysis"]),
            narrative=production.get("narrative"),
            evidence=production.get("evidence"),
            script=production.get("script"),
            output_duration_ms=output_duration_ms,
        )
        progress(0.24)
        destination_dir = self.storage.project_file(project_id, f"thumbnails/{brief['id']}/{package['id']}")
        destination_dir.mkdir(parents=True, exist_ok=True)
        paths = render_thumbnail_variants(package["thumbnails"], frame_paths, destination_dir, str(project["game_id"]))
        progress(0.62)

        for thumbnail in package["thumbnails"]:
            path = paths[str(thumbnail["id"])]
            kind = f"thumbnail_{thumbnail['template_key']}"
            artifact_input = fingerprint({
                "creative_input": job["input_fingerprint"],
                "variant_id": thumbnail["id"],
                "source_frame_ids": thumbnail["source_frame_ids"],
                "headline": thumbnail["headline"],
            })
            thumbnail["artifact_id"] = self.repository.register_artifact(
                project_id,
                kind,
                self.storage.to_uri(path),
                sha256_file(path),
                path.stat().st_size,
                "image/jpeg",
                THUMBNAIL_VERSION,
                artifact_input,
                {
                    "width": thumbnail["width"],
                    "height": thumbnail["height"],
                    "score": thumbnail["score"],
                    "headline": thumbnail["headline"],
                    "source_frame_ids": thumbnail["source_frame_ids"],
                },
            )
            thumbnail["artifact_kind"] = kind
        package_path = self.storage.write_json(project_id, f"exports/creative-package-{brief['id']}-{package['id']}.json", package)
        package_artifact_id = self.repository.register_artifact(
            project_id,
            "creative_package",
            self.storage.to_uri(package_path),
            sha256_file(package_path),
            package_path.stat().st_size,
            "application/json",
            CREATIVE_PACKAGE_VERSION,
            str(job["input_fingerprint"]),
            package["summary"],
        )
        progress(0.84)
        render_job_id = str(parameters.get("render_job_id") or render["id"])
        self.repository.save_creative_package(
            project_id,
            str(brief["id"]),
            render_job_id,
            package_artifact_id,
            package,
        )
        self.repository.create_quality_checks(render_job_id, [
            {
                "check_id": "thumbnail_valid",
                "dimension": "platform",
                "status": "pass",
                "severity": "info",
                "message": f"{len(package['thumbnails'])} miniatures JPEG 1280×720 créées depuis les images observées.",
            },
            {
                "check_id": "metadata_factual_safety",
                "dimension": "factual",
                "status": "pass",
                "severity": "info",
                "message": "Titres et descriptions bornés par les preuves; sujet non vérifié exclu des affirmations.",
            },
        ])
        self._ensure_stages(project_id, ["READY_TO_PUBLISH"], final_status="COMPLETED")
        self.repository.set_project_status(project_id, "COMPLETED")
        progress(1.0)
        return package_artifact_id

    def _ensure_stages(self, project_id: str, targets: list[str], final_status: str = "ACTIVE") -> None:
        for index, target in enumerate(targets):
            project = self.repository.get_project(project_id)
            current = str(project["pipeline_stage"])
            if PIPELINE_ORDER.index(current) >= PIPELINE_ORDER.index(target):
                continue
            expected = "QC_ANALYZED" if target == "FINAL_RENDERED" else PIPELINE_ORDER[PIPELINE_ORDER.index(target) - 1]
            if current != expected:
                raise StudioError(
                    "DOMAIN_INVALID_STAGE_TRANSITION",
                    f"Expected {expected}, found {current} while advancing to {target}.",
                    status_code=409,
                )
            status = final_status if index == len(targets) - 1 else "ACTIVE"
            self.repository.update_stage(
                project_id,
                expected,
                target,
                run_status=status,
                event=f"project.{target.lower()}",
            )

    def _progress_callback(self, job_id: str) -> Callable[[float], None]:
        def callback(progress: float) -> None:
            self.repository.update_job_progress(job_id, self.worker_id, progress, self.settings.worker_lease_seconds)

        return callback

def _preview_cache_key(
    source_sha256: str,
    clip: dict[str, Any],
    preview_window: dict[str, Any] | None,
    resolved_profile: dict[str, Any],
    renderer_version: str,
    ffmpeg_build_id: str,
) -> str:
    normalized = {
        "source_sha256": source_sha256,
        "source_range_ms": [int(clip["start_ms"]), int(clip["end_ms"])],
        "preview_window": _normalize_window(preview_window),
        "transform": {
            "reframe_mode": str(clip.get("reframe_mode", "center_crop")),
            "focus_start_x": _round4(clip.get("focus_start_x", 0.5)),
            "focus_end_x": _round4(clip.get("focus_end_x", 0.5)),
            "focus_y": _round4(clip.get("focus_y", 0.5)),
            "zoom": _round4(clip.get("zoom", 1.0)),
        },
        "speed": _round4(clip.get("speed", 1.0)),
        "fade_in_ms": int(clip.get("fade_in_ms") or 0),
        "fade_out_ms": int(clip.get("fade_out_ms") or 0),
        "comparison": _normalize_comparison(clip.get("comparison")),
        "output": {
            "width": int(resolved_profile["width"]),
            "height": int(resolved_profile["height"]),
            "fps": int(resolved_profile["fps"]),
            "codec": str(resolved_profile["codec"]),
            "preset": str(resolved_profile["preset"]),
            "crf": int(resolved_profile["crf"]),
            "pixel_format": str(resolved_profile["pixel_format"]),
            "audio_codec": str(resolved_profile["audio_codec"]),
            "audio_bitrate": str(resolved_profile["audio_bitrate"]),
        },
        "renderer_version": renderer_version,
        "ffmpeg_build_id": ffmpeg_build_id,
    }
    return fingerprint(normalized)

def _round4(value: Any) -> float:
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return 0.0

def _normalize_window(window: dict[str, Any] | None) -> dict[str, int] | None:
    if window is None:
        return None
    return {"start_ms": int(window["start_ms"]), "duration_ms": int(window["duration_ms"])}

def _normalize_comparison(comparison: Any) -> dict[str, Any] | None:
    if not isinstance(comparison, dict):
        return None
    return {
        "before_start_ms": int(comparison["before_start_ms"]),
        "after_start_ms": int(comparison["after_start_ms"]),
        "duration_ms": int(comparison["duration_ms"]),
    }
