from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from array import array
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable, Literal

from .errors import JobCancelled, StudioError


@dataclass(frozen=True)
class ProbeResult:
    duration_ms: int
    width: int
    height: int
    fps_numerator: int
    fps_denominator: int
    video_codec: str
    audio_codec: str | None
    format_name: str

    def as_dict(self) -> dict[str, int | str | None]:
        return {
            "duration_ms": self.duration_ms,
            "width": self.width,
            "height": self.height,
            "fps_numerator": self.fps_numerator,
            "fps_denominator": self.fps_denominator,
            "video_codec": self.video_codec,
            "audio_codec": self.audio_codec,
            "format_name": self.format_name,
        }


class MediaTools:
    def __init__(
        self,
        ffmpeg_path: str,
        ffprobe_path: str,
        max_width: int,
        crf: int,
        preset: str,
        hardware_acceleration: Literal["auto", "cpu", "nvidia"] = "auto",
    ) -> None:
        self.ffmpeg_path = ffmpeg_path
        self.ffprobe_path = ffprobe_path
        self.max_width = max_width
        self.crf = crf
        self.preset = preset
        self.hardware_acceleration = hardware_acceleration
        self._hardware: dict[str, Any] | None = None

    def diagnostics(self) -> dict[str, str | bool]:
        hardware = self.hardware_diagnostics()
        return {
            "ffmpeg_available": shutil.which(self.ffmpeg_path) is not None,
            "ffprobe_available": shutil.which(self.ffprobe_path) is not None,
            "ffmpeg": self._version(self.ffmpeg_path),
            "ffprobe": self._version(self.ffprobe_path),
            "acceleration": str(hardware["active_mode"]),
            "video_encoder": str(hardware["video_encoder"]),
            "gpu_name": str(hardware["gpu_name"]),
            "opencv_cuda": bool(hardware["opencv_cuda"]),
            "onnx_gpu": bool(hardware["onnx_gpu"]),
        }

    def hardware_diagnostics(self) -> dict[str, Any]:
        if self._hardware is not None:
            return dict(self._hardware)
        encoders = self._ffmpeg_encoders()
        gpu = self._nvidia_gpu()
        nvenc_compiled = "h264_nvenc" in encoders
        nvenc_ready = self.hardware_acceleration != "cpu" and nvenc_compiled and self._encoder_works("h264_nvenc")
        opencv_cuda, opencv_devices = self._opencv_cuda()
        providers = self._onnx_providers()
        reasons: list[str] = []
        if self.hardware_acceleration == "cpu":
            reasons.append("GPU disabled by GTA_STUDIO_HARDWARE_ACCELERATION=cpu")
        elif not gpu:
            reasons.append("No NVIDIA GPU was reported by nvidia-smi")
        if not nvenc_compiled:
            reasons.append("FFmpeg does not expose h264_nvenc")
        elif not nvenc_ready and self.hardware_acceleration != "cpu":
            reasons.append("NVENC self-test failed; encoding stays on CPU")
        if not opencv_cuda:
            reasons.append("OpenCV CUDA is unavailable; analysis uses the CPU path")
        if not any("CUDA" in provider or "Tensorrt" in provider for provider in providers):
            reasons.append("ONNX Runtime has no GPU execution provider")
        self._hardware = {
            "requested_mode": self.hardware_acceleration,
            "active_mode": "nvidia" if nvenc_ready else "cpu",
            "video_encoder": "h264_nvenc" if nvenc_ready else "libx264",
            "gpu_name": gpu.get("name", "None detected") if gpu else "None detected",
            "nvidia": gpu,
            "ffmpeg_hardware_encoders": sorted(encoder for encoder in encoders if encoder in {"h264_nvenc", "hevc_nvenc", "h264_qsv", "h264_amf"}),
            "nvenc_ready": nvenc_ready,
            "opencv_cuda": opencv_cuda,
            "opencv_cuda_devices": opencv_devices,
            "onnx_providers": providers,
            "onnx_gpu": any("CUDA" in provider or "Tensorrt" in provider for provider in providers),
            "fallback": "libx264 CPU is selected automatically whenever the NVENC probe is unavailable or fails.",
            "diagnostics": reasons,
        }
        return dict(self._hardware)

    def video_encode_args(self, crf: int, preset: str, *, force_cpu: bool = False) -> list[str]:
        hardware = self.hardware_diagnostics()
        if hardware["video_encoder"] == "h264_nvenc" and not force_cpu:
            return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", str(crf), "-b:v", "0"]
        return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf)]

    def disable_hardware_encoder(self, reason: str) -> None:
        hardware = self.hardware_diagnostics()
        hardware["active_mode"] = "cpu"
        hardware["video_encoder"] = "libx264"
        hardware["nvenc_ready"] = False
        hardware["diagnostics"] = [*list(hardware["diagnostics"]), reason]
        self._hardware = hardware

    def _ffmpeg_encoders(self) -> set[str]:
        try:
            result = subprocess.run(
                [self.ffmpeg_path, "-hide_banner", "-encoders"], capture_output=True, text=True,
                timeout=15, check=False, creationflags=_creation_flags(),
            )
            return set(re.findall(r"^\s*[VAS\.]{6}\s+([a-zA-Z0-9_]+)\s", result.stdout, re.MULTILINE))
        except (OSError, subprocess.SubprocessError):
            return set()

    def _encoder_works(self, encoder: str) -> bool:
        try:
            result = subprocess.run(
                [self.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=128x128:rate=1", "-frames:v", "1", "-c:v", encoder, "-f", "null", "-"],
                capture_output=True, timeout=20, check=False, creationflags=_creation_flags(),
            )
            return result.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def _nvidia_gpu(self) -> dict[str, str] | None:
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10, check=False, creationflags=_creation_flags(),
            )
            line = result.stdout.splitlines()[0] if result.returncode == 0 and result.stdout.splitlines() else ""
            parts = [part.strip() for part in line.split(",")]
            return {"name": parts[0], "driver": parts[1], "memory_mb": parts[2]} if len(parts) >= 3 else None
        except (OSError, subprocess.SubprocessError):
            return None

    def _opencv_cuda(self) -> tuple[bool, int]:
        try:
            import cv2
            count = int(cv2.cuda.getCudaEnabledDeviceCount()) if hasattr(cv2, "cuda") else 0
            return count > 0, count
        except (ImportError, RuntimeError, AttributeError):
            return False, 0

    def _onnx_providers(self) -> list[str]:
        try:
            import onnxruntime
            return [str(provider) for provider in onnxruntime.get_available_providers()]
        except ImportError:
            return []

    def audio_waveform(self, path: Path, bins: int = 480) -> dict[str, Any]:
        try:
            result = subprocess.run(
                [self.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", "4000", "-t", "600", "-f", "s16le", "pipe:1"],
                capture_output=True, timeout=90, check=False, creationflags=_creation_flags(),
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise StudioError("WAVEFORM_DECODE_FAILED", "The audio waveform could not be decoded.", retryable=True) from error
        if result.returncode != 0 or not result.stdout:
            raise StudioError("WAVEFORM_AUDIO_MISSING", "No readable audio track is available for the waveform.", status_code=409)
        samples = array("h")
        samples.frombytes(result.stdout[: len(result.stdout) - len(result.stdout) % 2])
        bucket_size = max(1, len(samples) // bins)
        peaks: list[float] = []
        rms: list[float] = []
        for offset in range(0, len(samples), bucket_size):
            bucket = samples[offset:offset + bucket_size]
            if not bucket:
                continue
            peaks.append(round(max(abs(value) for value in bucket) / 32768, 4))
            rms.append(round((sum(value * value for value in bucket) / len(bucket)) ** 0.5 / 32768, 4))
        return {"track": path.suffix.lower(), "sample_rate": 4000, "duration_ms": round(len(samples) / 4000 * 1000), "peaks": peaks[:bins], "rms": rms[:bins]}

    def _version(self, command: str) -> str:
        try:
            result = subprocess.run(
                [command, "-version"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
                creationflags=_creation_flags(),
            )
            return (result.stdout or result.stderr).splitlines()[0]
        except (OSError, subprocess.SubprocessError):
            return "unavailable"

    def probe(self, path: Path) -> ProbeResult:
        try:
            result = subprocess.run(
                [
                    self.ffprobe_path,
                    "-v", "error",
                    "-print_format", "json",
                    "-show_format",
                    "-show_streams",
                    str(path),
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
                creationflags=_creation_flags(),
            )
        except FileNotFoundError as error:
            raise StudioError("MEDIA_FFPROBE_MISSING", "FFprobe is not installed or not available in PATH.", status_code=503) from error
        except subprocess.TimeoutExpired as error:
            raise StudioError("MEDIA_FFPROBE_TIMEOUT", "FFprobe timed out.", retryable=True, status_code=504) from error
        if result.returncode != 0:
            raise StudioError(
                "MEDIA_FFPROBE_FAILED",
                "The selected MP4 could not be analyzed.",
                details={"diagnostic": result.stderr[-1000:]},
            )
        try:
            payload = json.loads(result.stdout)
            streams = payload.get("streams", [])
            video = next(stream for stream in streams if stream.get("codec_type") == "video")
            audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
            format_data = payload.get("format", {})
            duration_seconds = float(format_data.get("duration") or video.get("duration"))
            rate_text = video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"
            rate = Fraction(rate_text)
            format_name = str(format_data.get("format_name", ""))
            if "mp4" not in format_name and "mov" not in format_name:
                raise ValueError("unexpected container")
            if duration_seconds <= 0 or rate <= 0:
                raise ValueError("invalid duration or frame rate")
            return ProbeResult(
                duration_ms=round(duration_seconds * 1000),
                width=int(video["width"]),
                height=int(video["height"]),
                fps_numerator=rate.numerator,
                fps_denominator=rate.denominator,
                video_codec=str(video["codec_name"]),
                audio_codec=str(audio["codec_name"]) if audio else None,
                format_name=format_name,
            )
        except (KeyError, TypeError, ValueError, StopIteration, ZeroDivisionError) as error:
            raise StudioError("MEDIA_METADATA_INVALID", "FFprobe returned incomplete or invalid video metadata.") from error

    def probe_duration_ms(self, path: Path) -> int:
        try:
            result = subprocess.run(
                [
                    self.ffprobe_path,
                    "-v", "error",
                    "-print_format", "json",
                    "-show_entries", "format=duration",
                    str(path),
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
                creationflags=_creation_flags(),
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as error:
            raise StudioError("MEDIA_DURATION_PROBE_FAILED", "The media duration could not be read.", retryable=True) from error
        try:
            duration = float(json.loads(result.stdout)["format"]["duration"])
            if result.returncode != 0 or duration <= 0:
                raise ValueError("invalid duration")
            return round(duration * 1000)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise StudioError("MEDIA_DURATION_INVALID", "The media duration is missing or invalid.") from error

    def detect_scene_boundaries(
        self,
        path: Path,
        duration_ms: int,
        progress: Callable[[float], None],
        cancelled: Callable[[], bool],
        threshold: float = 0.28,
    ) -> list[int]:
        command = [
            self.ffmpeg_path,
            "-hide_banner",
            "-loglevel", "info",
            "-nostdin",
            "-i", str(path),
            "-an",
            "-vf", f"select='gt(scene,{threshold})',showinfo",
            "-fps_mode", "vfr",
            "-progress", "pipe:1",
            "-nostats",
            "-f", "null",
            "-",
        ]
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
        boundaries: list[int] = []
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
                match = re.search(r"pts_time:([0-9]+(?:\.[0-9]+)?)", line)
                if match:
                    boundaries.append(round(float(match.group(1)) * 1000))
                if line.startswith("out_time_us="):
                    try:
                        elapsed_ms = int(line.split("=", 1)[1]) / 1000
                        progress(min(0.98, max(0.01, elapsed_ms / duration_ms * 0.98)))
                    except ValueError:
                        pass
                elif line:
                    output_tail.append(line)
                    output_tail = output_tail[-20:]
            if process.wait() != 0:
                raise StudioError(
                    "MEDIA_SCENE_DETECTION_FAILED",
                    "FFmpeg could not detect scene changes.",
                    retryable=True,
                    details={"diagnostic": "\n".join(output_tail)[-2000:]},
                )
            progress(1.0)
            return sorted(set(boundaries))
        finally:
            if process.poll() is None:
                process.kill()

    def build_proxy_command(self, source: Path, destination: Path, *, force_cpu: bool = False) -> list[str]:
        return [
            self.ffmpeg_path,
            "-hide_banner",
            "-loglevel", "error",
            "-nostdin",
            "-y",
            "-i", str(source),
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-vf", f"scale={self.max_width}:-2:force_original_aspect_ratio=decrease",
            *self.video_encode_args(self.crf, self.preset, force_cpu=force_cpu),
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            "-stats_period", "0.5",
            "-progress", "pipe:1",
            "-nostats",
            str(destination),
        ]

    def generate_proxy(
        self,
        source: Path,
        destination: Path,
        source_duration_ms: int,
        progress: Callable[[float], None],
        cancelled: Callable[[], bool],
        *,
        force_cpu: bool = False,
    ) -> ProbeResult:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name("proxy.partial.mp4")
        temporary.unlink(missing_ok=True)
        command = self.build_proxy_command(source, temporary, force_cpu=force_cpu)
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
            raise StudioError("MEDIA_FFMPEG_MISSING", "FFmpeg is not installed or not available in PATH.", status_code=503) from error

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
                        progress(min(0.96, max(0.02, elapsed_ms / source_duration_ms * 0.96)))
                    except ValueError:
                        pass
                elif line and not line.startswith(("bitrate=", "speed=", "progress=", "frame=", "fps=", "stream_", "total_size=", "out_time")):
                    output_tail.append(line)
                    output_tail = output_tail[-20:]
            return_code = process.wait()
            if return_code != 0 or not temporary.exists() or temporary.stat().st_size == 0:
                if not force_cpu and self.hardware_diagnostics()["video_encoder"] == "h264_nvenc":
                    temporary.unlink(missing_ok=True)
                    self.disable_hardware_encoder("NVENC failed during proxy generation; the job was retried on CPU")
                    return self.generate_proxy(source, destination, source_duration_ms, progress, cancelled, force_cpu=True)
                raise StudioError(
                    "MEDIA_PROXY_FAILED",
                    "FFmpeg could not generate the proxy.",
                    retryable=False,
                    details={"diagnostic": "\n".join(output_tail)[-2000:]},
                )
            probe = self.probe(temporary)
            os.replace(temporary, destination)
            progress(1.0)
            return probe
        finally:
            if process.poll() is None:
                process.kill()
            temporary.unlink(missing_ok=True)


def _creation_flags() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
