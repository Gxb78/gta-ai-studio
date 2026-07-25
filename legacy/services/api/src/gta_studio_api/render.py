from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any, Callable

from .errors import JobCancelled, StudioError
from .media import MediaTools, ProbeResult, _creation_flags
from .reframe import compute_crop_rect, crop_rect_to_pixels

PREVIEW_PROFILES: dict[str, dict[str, Any]] = {
    "draft": {
        "width": 540, "height": 960, "fps": 30,
        "codec": "libx264", "preset": "ultrafast", "crf": 28,
        "pixel_format": "yuv420p",
        "audio_codec": "aac", "audio_bitrate": "96k",
        "movflags": "+faststart", "max_window_seconds": 5,
    },
}

def resolve_preview_profile(name: str, renderer: "VerticalRenderer") -> dict[str, Any]:
    if name == "draft":
        return dict(PREVIEW_PROFILES["draft"])
    return {
        "width": renderer.width, "height": renderer.height, "fps": 30,
        "codec": "libx264", "preset": renderer.preset, "crf": renderer.crf,
        "pixel_format": "yuv420p",
        "audio_codec": "aac", "audio_bitrate": "128k",
        "movflags": "+faststart", "max_window_seconds": 2,
    }


class VerticalRenderer:
    def __init__(self, media: MediaTools, width: int, height: int, crf: int, preset: str) -> None:
        self.media = media
        self.width = width
        self.height = height
        self.crf = crf
        self.preset = preset

    def build_command(
        self,
        source: Path,
        voice: Path,
        subtitles: Path,
        destination: Path,
        clips: list[dict[str, Any]],
        *,
        composition: str,
        source_has_audio: bool,
        source_audio_level: float,
        duration_ms: int,
        overlays: Path | None = None,
        audio_mix: dict[str, Any] | None = None,
        force_cpu: bool = False,
    ) -> list[str]:
        command = [self.media.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
        clip_inputs: list[dict[str, int | None]] = []
        input_index = 0
        for clip in clips:
            comparison = clip.get("comparison")
            if isinstance(comparison, dict):
                before_index = input_index
                command.extend([
                    "-ss", _seconds(int(comparison["before_start_ms"])),
                    "-t", _seconds(int(comparison["duration_ms"])),
                    "-i", str(source),
                ])
                input_index += 1
                after_index = input_index
                command.extend([
                    "-ss", _seconds(int(comparison["after_start_ms"])),
                    "-t", _seconds(int(comparison["duration_ms"])),
                    "-i", str(source),
                ])
                input_index += 1
                clip_inputs.append({"video": before_index, "comparison": after_index, "audio": after_index})
            else:
                command.extend([
                    "-ss", _seconds(int(clip["start_ms"])),
                    "-t", _seconds(int(clip.get("source_duration_ms", clip["duration_ms"]))),
                    "-i", str(source),
                ])
                clip_inputs.append({"video": input_index, "comparison": None, "audio": input_index})
                input_index += 1
        voice_index = input_index
        command.extend(["-i", str(voice)])

        filters: list[str] = []
        mix = dict(audio_mix or {})
        ambient_level = _clamp_float(mix.get("source_audio_level", source_audio_level), 0.0, 1.0, source_audio_level)
        ambient_highpass = _clamp_float(mix.get("ambient_highpass_hz", 55), 20, 500, 55)
        ambient_lowpass = _clamp_float(mix.get("ambient_lowpass_hz", 14500), 2000, 20000, 14500)
        for index, (clip, input_map) in enumerate(zip(clips, clip_inputs, strict=True)):
            speed = _clamp_float(clip.get("speed", 1.0), 1.0, 2.0, 1.0)
            output_seconds = int(clip["duration_ms"]) / 1000
            before_index = int(input_map["video"])
            comparison_index = input_map["comparison"]
            if comparison_index is not None:
                half_width = self.width // 2
                filters.extend([
                    f"[{before_index}:v]scale={half_width}:{self.height}:force_original_aspect_ratio=increase,"
                    f"crop={half_width}:{self.height},setsar=1,fps=30,trim=duration={output_seconds:.3f},setpts=PTS-STARTPTS[left{index}]",
                    f"[{int(comparison_index)}:v]scale={self.width - half_width}:{self.height}:force_original_aspect_ratio=increase,"
                    f"crop={self.width - half_width}:{self.height},setsar=1,fps=30,trim=duration={output_seconds:.3f},setpts=PTS-STARTPTS[right{index}]",
                    f"[left{index}][right{index}]hstack=inputs=2[vbase{index}]",
                ])
            elif str(clip.get("reframe_mode", composition)) in {"dynamic_crop", "fixed_crop", "center_crop"}:
                zoom = _clamp_float(clip.get("zoom", 1.0), 1.0, 1.2, 1.0)
                focus_start = _clamp_float(clip.get("focus_start_x", 0.5), 0.0, 1.0, 0.5)
                focus_end = _clamp_float(clip.get("focus_end_x", focus_start), 0.0, 1.0, focus_start)
                focus_y = _clamp_float(clip.get("focus_y", 0.5), 0.0, 1.0, 0.5)
                source_seconds = max(0.001, int(clip.get("source_duration_ms", clip["duration_ms"])) / 1000)
                focus_expression = f"{focus_start:.6f}+({focus_end - focus_start:.6f})*min(t/{source_seconds:.3f},1)"
                x_expression = f"max(0,min(iw-ow,(iw-ow)*({focus_expression})))"
                y_expression = f"max(0,min(ih-oh,(ih-oh)*{focus_y:.6f}))"
                filters.append(
                    f"[{before_index}:v]scale={self.width}:{self.height}:force_original_aspect_ratio=increase,setsar=1,"
                    f"scale=iw*{zoom:.5f}:ih*{zoom:.5f},crop={self.width}:{self.height}:x='{x_expression}':y='{y_expression}',"
                    f"fps=30,setpts=(PTS-STARTPTS)/{speed:.5f},trim=duration={output_seconds:.3f}[vbase{index}]"
                )
            else:
                zoom = _clamp_float(clip.get("zoom", 1.0), 1.0, 1.2, 1.0)
                filters.extend([
                    f"[{before_index}:v]split=2[bg{index}][fg{index}]",
                    f"[bg{index}]scale={self.width}:{self.height}:force_original_aspect_ratio=increase,"
                    f"crop={self.width}:{self.height},boxblur=24:2[blur{index}]",
                    f"[fg{index}]scale={self.width}:{self.height}:force_original_aspect_ratio=decrease,"
                    f"scale=iw*{zoom:.5f}:ih*{zoom:.5f}[front{index}]",
                    f"[blur{index}][front{index}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,"
                    f"setpts=(PTS-STARTPTS)/{speed:.5f},trim=duration={output_seconds:.3f}[vbase{index}]",
                ])
            video_chain = f"[vbase{index}]"
            fade_filters: list[str] = []
            fade_in = min(int(clip.get("fade_in_ms") or 0), int(clip["duration_ms"]) // 3) / 1000
            fade_out = min(int(clip.get("fade_out_ms") or 0), int(clip["duration_ms"]) // 3) / 1000
            if fade_in >= 0.06:
                fade_filters.append(f"fade=t=in:st=0:d={fade_in:.3f}")
            if fade_out >= 0.06:
                fade_filters.append(f"fade=t=out:st={max(0.0, output_seconds - fade_out):.3f}:d={fade_out:.3f}")
            fade_filters.extend(["format=yuv420p", f"setpts=PTS-STARTPTS[v{index}]"])
            filters.append(video_chain + ",".join(fade_filters))
            if source_has_audio:
                audio_index = int(input_map["audio"])
                filters.append(
                    f"[{audio_index}:a]aresample=48000,asetpts=PTS-STARTPTS,atempo={speed:.5f},"
                    f"atrim=duration={output_seconds:.3f},apad=whole_dur={output_seconds:.3f},"
                    f"highpass=f={ambient_highpass:.1f},lowpass=f={ambient_lowpass:.1f},"
                    f"volume={ambient_level:.3f}[a{index}]"
                )

        if len(clips) == 1:
            filters.append("[v0]null[montage]")
            if source_has_audio:
                filters.append("[a0]anull[ambient]")
        else:
            video_inputs = "".join(f"[v{index}]" for index in range(len(clips)))
            if source_has_audio:
                audio_video_inputs = "".join(f"[v{index}][a{index}]" for index in range(len(clips)))
                filters.append(f"{audio_video_inputs}concat=n={len(clips)}:v=1:a=1[montage][ambient]")
            else:
                filters.append(f"{video_inputs}concat=n={len(clips)}:v=1:a=0[montage]")

        ass_path = _escape_filter_path(subtitles)
        filters.append(f"[montage]ass=filename='{ass_path}'[captioned]")
        if overlays is not None:
            overlay_path = _escape_filter_path(overlays)
            filters.append(f"[captioned]ass=filename='{overlay_path}'[video_out]")
        else:
            filters.append("[captioned]null[video_out]")
        duration_seconds = _seconds(duration_ms)
        target_lufs = _clamp_float(mix.get("target_lufs", -14), -18, -12, -14)
        true_peak = _clamp_float(mix.get("true_peak_db", -1), -2.5, -0.5, -1)
        lra = _clamp_float(mix.get("lra", 8), 4, 20, 8)
        filters.append(
            f"[{voice_index}:a]aresample=48000,atrim=duration={duration_seconds},"
            f"apad=whole_dur={duration_seconds},asetpts=PTS-STARTPTS,highpass=f=80,lowpass=f=12000,"
            f"acompressor=threshold=0.125:ratio=3:attack=20:release=250:makeup=1.5,"
            f"loudnorm=I={target_lufs:.1f}:TP={true_peak:.1f}:LRA={lra:.1f}[voice]"
        )
        if source_has_audio:
            duck_threshold = _clamp_float(mix.get("ducking_threshold", 0.025), 0.005, 0.2, 0.025)
            duck_ratio = _clamp_float(mix.get("ducking_ratio", 8), 2, 20, 8)
            attack = _clamp_float(mix.get("attack_ms", 20), 1, 200, 20)
            release = _clamp_float(mix.get("release_ms", 300), 20, 2000, 300)
            filters.extend([
                f"[ambient][voice]sidechaincompress=threshold={duck_threshold:.4f}:ratio={duck_ratio:.2f}:"
                f"attack={attack:.1f}:release={release:.1f}[ducked]",
                "[ducked][voice]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[audio_out]",
            ])
        else:
            filters.append("[voice]anull[audio_out]")

        command.extend([
            "-filter_complex", ";".join(filters),
            "-map", "[video_out]",
            "-map", "[audio_out]",
            *self.media.video_encode_args(self.crf, self.preset, force_cpu=force_cpu),
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ar", "48000",
            "-t", duration_seconds,
            "-movflags", "+faststart",
            "-stats_period", "0.5",
            "-progress", "pipe:1",
            "-nostats",
            str(destination),
        ])
        return command

    def render(
        self,
        source: Path,
        voice: Path,
        subtitles: Path,
        destination: Path,
        clips: list[dict[str, Any]],
        *,
        composition: str,
        source_has_audio: bool,
        source_audio_level: float,
        duration_ms: int,
        overlays: Path | None = None,
        audio_mix: dict[str, Any] | None = None,
        progress: Callable[[float], None],
        cancelled: Callable[[], bool],
        force_cpu: bool = False,
    ) -> ProbeResult:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".partial.mp4")
        temporary.unlink(missing_ok=True)
        command = self.build_command(
            source,
            voice,
            subtitles,
            temporary,
            clips,
            composition=composition,
            source_has_audio=source_has_audio,
            source_audio_level=source_audio_level,
            duration_ms=duration_ms,
            overlays=overlays,
            audio_mix=audio_mix,
            force_cpu=force_cpu,
        )
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=_creation_flags(),
            )
        except FileNotFoundError as error:
            raise StudioError("MEDIA_FFMPEG_MISSING", "FFmpeg is unavailable.", status_code=503) from error
        output_tail: list[str] = []
        try:
            assert process.stdout is not None
            for raw_line in process.stdout:
                line = raw_line.strip()
                if cancelled():
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                    raise JobCancelled()
                if line.startswith("out_time_us="):
                    try:
                        elapsed_ms = int(line.split("=", 1)[1]) / 1000
                        progress(min(0.98, max(0.01, elapsed_ms / duration_ms * 0.98)))
                    except ValueError:
                        pass
                elif line and not line.startswith(("bitrate=", "speed=", "progress=", "frame=", "fps=", "stream_", "total_size=", "out_time")):
                    output_tail.append(line)
                    output_tail = output_tail[-30:]
            return_code = process.wait()
            if return_code != 0 or not temporary.is_file() or temporary.stat().st_size == 0:
                if not force_cpu and self.media.hardware_diagnostics()["video_encoder"] == "h264_nvenc":
                    temporary.unlink(missing_ok=True)
                    self.media.disable_hardware_encoder("NVENC failed during final rendering; the job was retried on CPU")
                    return self.render(
                        source, voice, subtitles, destination, clips,
                        composition=composition,
                        source_has_audio=source_has_audio,
                        source_audio_level=source_audio_level,
                        duration_ms=duration_ms,
                        overlays=overlays,
                        audio_mix=audio_mix,
                        progress=progress,
                        cancelled=cancelled,
                        force_cpu=True,
                    )
                raise StudioError(
                    "RENDER_FFMPEG_FAILED",
                    "FFmpeg could not render the vertical video.",
                    details={"diagnostic": "\n".join(output_tail)[-3000:]},
                )
            probe = self.media.probe(temporary)
            if probe.width != self.width or probe.height != self.height:
                raise StudioError("RENDER_DIMENSIONS_INVALID", "The rendered video has unexpected dimensions.")
            os.replace(temporary, destination)
            progress(1.0)
            return probe
        finally:
            if process.poll() is None:
                process.kill()
            temporary.unlink(missing_ok=True)

    def build_clip_preview_command(
        self,
        source: Path,
        destination: Path,
        clip: dict[str, Any],
        *,
        composition: str,
        source_has_audio: bool,
        resolved_profile: dict[str, Any] | None = None,
        preview_window: dict[str, Any] | None = None,
        force_cpu: bool = False,
    ) -> list[str]:
        if resolved_profile is None:
            width, height = 540, 960
            crf, preset = 27, "veryfast"
            fps = 30
            pixel_format = "yuv420p"
            audio_codec = "aac"
            audio_bitrate = "128k"
        else:
            width, height = resolved_profile["width"], resolved_profile["height"]
            crf, preset = resolved_profile["crf"], resolved_profile["preset"]
            fps = resolved_profile["fps"]
            pixel_format = resolved_profile["pixel_format"]
            audio_codec = resolved_profile["audio_codec"]
            audio_bitrate = resolved_profile["audio_bitrate"]

        duration_ms = int(clip["duration_ms"])
        source_duration_ms = int(clip.get("source_duration_ms", duration_ms))
        speed = _clamp_float(clip.get("speed", 1), 0.5, 2, 1)
        start_ms = int(clip["start_ms"])

        if preview_window:
            window_start_ms = int(preview_window["start_ms"])
            window_duration_ms = int(preview_window["duration_ms"])
            # Convert window time to source time
            source_window_start_ms = start_ms + int(window_start_ms * speed)
            source_window_duration_ms = int(window_duration_ms * speed)
            start_ms = min(start_ms + source_duration_ms, source_window_start_ms)
            source_duration_ms = min(source_duration_ms - (source_window_start_ms - start_ms), source_window_duration_ms)
            duration_ms = window_duration_ms

        command = [self.media.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
        comparison = clip.get("comparison")
        if isinstance(comparison, dict):
            command.extend([
                "-ss", _seconds(int(comparison["before_start_ms"])), "-t", _seconds(int(comparison["duration_ms"])), "-i", str(source),
                "-ss", _seconds(int(comparison["after_start_ms"])), "-t", _seconds(int(comparison["duration_ms"])), "-i", str(source),
            ])
            filters = [
                f"[0:v]scale={width // 2}:{height}:force_original_aspect_ratio=increase,crop={width // 2}:{height},setsar=1,fps={fps},trim=duration={duration_ms / 1000:.3f},setpts=PTS-STARTPTS[left]",
                f"[1:v]scale={width - width // 2}:{height}:force_original_aspect_ratio=increase,crop={width - width // 2}:{height},setsar=1,fps={fps},trim=duration={duration_ms / 1000:.3f},setpts=PTS-STARTPTS[right]",
                "[left][right]hstack=inputs=2[video_out]",
            ]
            audio_index = 1
        else:
            command.extend(["-ss", _seconds(start_ms), "-t", _seconds(source_duration_ms), "-i", str(source)])
            mode = str(clip.get("reframe_mode", composition))
            zoom = _clamp_float(clip.get("zoom", 1), 1, 1.2, 1)
            if mode in {"dynamic_crop", "fixed_crop", "center_crop"}:
                focus_start = _clamp_float(clip.get("focus_start_x", 0.5), 0, 1, 0.5)
                focus_end = _clamp_float(clip.get("focus_end_x", focus_start), 0, 1, focus_start)
                focus_y = _clamp_float(clip.get("focus_y", 0.5), 0, 1, 0.5)
                source_seconds = max(0.001, source_duration_ms / 1000)
                focus = f"{focus_start:.6f}+({focus_end - focus_start:.6f})*min(t/{source_seconds:.3f},1)"
                x = f"max(0,min(iw-ow,(iw-ow)*({focus})))"
                y = f"max(0,min(ih-oh,(ih-oh)*{focus_y:.6f}))"
                filters = [
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,setsar=1,scale=iw*{zoom:.5f}:ih*{zoom:.5f},"
                    f"crop={width}:{height}:x='{x}':y='{y}',fps={fps},setpts=(PTS-STARTPTS)/{speed:.5f},"
                    f"trim=duration={duration_ms / 1000:.3f},format={pixel_format}[video_out]"
                ]
            else:
                filters = [
                    "[0:v]split=2[bg][fg]",
                    f"[bg]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},boxblur=18:2[blur]",
                    f"[fg]scale={width}:{height}:force_original_aspect_ratio=decrease,scale=iw*{zoom:.5f}:ih*{zoom:.5f}[front]",
                    f"[blur][front]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={fps},setpts=(PTS-STARTPTS)/{speed:.5f},"
                    f"trim=duration={duration_ms / 1000:.3f},format={pixel_format}[video_out]",
                ]
            audio_index = 0
        if source_has_audio:
            filters.append(
                f"[{audio_index}:a]aresample=48000,asetpts=PTS-STARTPTS,atempo={speed:.5f},"
                f"atrim=duration={duration_ms / 1000:.3f},apad=whole_dur={duration_ms / 1000:.3f}[audio_out]"
            )
        else:
            filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={duration_ms / 1000:.3f}[audio_out]")
        command.extend([
            "-filter_complex", ";".join(filters), "-map", "[video_out]", "-map", "[audio_out]",
            *self.media.video_encode_args(crf, preset, force_cpu=force_cpu),
            "-pix_fmt", pixel_format, "-c:a", audio_codec, "-b:a", audio_bitrate, "-t", _seconds(duration_ms),
            "-movflags", "+faststart", "-stats_period", "0.25", "-progress", "pipe:1", "-nostats", str(destination),
        ])
        return command

    def render_clip_preview(
        self,
        source: Path,
        destination: Path,
        clip: dict[str, Any],
        *,
        composition: str,
        source_has_audio: bool,
        resolved_profile: dict[str, Any] | None = None,
        preview_window: dict[str, Any] | None = None,
        progress: Callable[[float], None],
        cancelled: Callable[[], bool],
        force_cpu: bool = False,
    ) -> ProbeResult:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".partial.mp4")
        temporary.unlink(missing_ok=True)
        command = self.build_clip_preview_command(
            source, temporary, clip, composition=composition, source_has_audio=source_has_audio,
            resolved_profile=resolved_profile, preview_window=preview_window, force_cpu=force_cpu,
        )
        try:
            process = subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                encoding="utf-8", errors="replace", creationflags=_creation_flags(),
            )
        except FileNotFoundError as error:
            raise StudioError("MEDIA_FFMPEG_MISSING", "FFmpeg is unavailable.", status_code=503) from error
        output_tail: list[str] = []
        duration_ms = int(clip["duration_ms"])
        try:
            assert process.stdout is not None
            for raw_line in process.stdout:
                line = raw_line.strip()
                if cancelled():
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                    raise JobCancelled()
                if line.startswith("out_time_us="):
                    try:
                        elapsed_ms = int(line.split("=", 1)[1]) / 1000
                        progress(min(0.98, max(0.01, elapsed_ms / duration_ms * 0.98)))
                    except ValueError:
                        pass
                elif line:
                    output_tail.append(line)
                    output_tail = output_tail[-25:]
            if process.wait() != 0 or not temporary.is_file() or temporary.stat().st_size == 0:
                if not force_cpu and self.media.hardware_diagnostics()["video_encoder"] == "h264_nvenc":
                    temporary.unlink(missing_ok=True)
                    self.media.disable_hardware_encoder("NVENC failed during clip preview; the job was retried on CPU")
                    return self.render_clip_preview(
                        source, destination, clip, composition=composition, source_has_audio=source_has_audio,
                        resolved_profile=resolved_profile, preview_window=preview_window,
                        progress=progress, cancelled=cancelled, force_cpu=True,
                    )
                raise StudioError(
                    "TIMELINE_PREVIEW_RENDER_FAILED", "FFmpeg could not render the selected clip preview.",
                    details={"diagnostic": "\n".join(output_tail)[-2500:]},
                )
            probe = self.media.probe(temporary)
            expected_width = resolved_profile["width"] if resolved_profile else 540
            expected_height = resolved_profile["height"] if resolved_profile else 960
            if probe.width != expected_width or probe.height != expected_height:
                raise StudioError("TIMELINE_PREVIEW_DIMENSIONS_INVALID", "The clip preview has unexpected dimensions.")
            os.replace(temporary, destination)
            progress(1)
            return probe
        finally:
            if process.poll() is None:
                process.kill()
            temporary.unlink(missing_ok=True)


def _seconds(milliseconds: int) -> str:
    return f"{milliseconds / 1000:.3f}"


def _escape_filter_path(path: Path) -> str:
    value = path.resolve().as_posix().replace("'", "\\'")
    return value.replace(":", "\\:")


def _clamp_float(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    return max(minimum, min(maximum, number))
