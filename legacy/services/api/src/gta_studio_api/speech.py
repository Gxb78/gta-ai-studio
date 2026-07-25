from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .errors import StudioError


class SpeechTools:
    def __init__(self, script_path: Path, powershell_path: str = "powershell.exe") -> None:
        self.script_path = script_path
        self.powershell_path = powershell_path
        self._voices_cache: list[dict[str, str]] | None = None

    def diagnostics(self) -> dict[str, Any]:
        available = shutil.which(self.powershell_path) is not None and self.script_path.is_file()
        voices: list[dict[str, str]] = []
        if available:
            try:
                voices = self.list_voices()
            except StudioError:
                available = False
        return {"speech_available": available, "voices": voices}

    def list_voices(self) -> list[dict[str, str]]:
        if self._voices_cache is not None:
            return [dict(voice) for voice in self._voices_cache]
        result = self._run(["-ListVoices"], timeout=30)
        try:
            payload = json.loads(result.stdout.strip() or "[]")
            voices = [payload] if isinstance(payload, dict) else list(payload)
            self._voices_cache = voices
            return [dict(voice) for voice in voices]
        except (json.JSONDecodeError, TypeError) as error:
            raise StudioError("SPEECH_VOICE_LIST_INVALID", "Windows returned an invalid voice list.", status_code=503) from error

    def synthesize(self, text_path: Path, output_path: Path, voice_id: str | None, rate: int) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = output_path.with_suffix(".partial.wav")
        temporary.unlink(missing_ok=True)
        arguments = [
            "-TextPath", str(text_path),
            "-OutputPath", str(temporary),
            "-Rate", str(rate),
        ]
        if voice_id:
            arguments.extend(["-VoiceId", voice_id])
        try:
            self._run(arguments, timeout=300)
            if not temporary.is_file() or temporary.stat().st_size < 100:
                raise StudioError("SPEECH_OUTPUT_MISSING", "Windows speech synthesis produced no audio.")
            os.replace(temporary, output_path)
        finally:
            temporary.unlink(missing_ok=True)

    def build_command(self, arguments: list[str]) -> list[str]:
        return [
            self.powershell_path,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", str(self.script_path),
            *arguments,
        ]

    def _run(self, arguments: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
        try:
            result = subprocess.run(
                self.build_command(arguments),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except FileNotFoundError as error:
            raise StudioError("SPEECH_ENGINE_MISSING", "Windows PowerShell speech synthesis is unavailable.", status_code=503) from error
        except subprocess.TimeoutExpired as error:
            raise StudioError("SPEECH_TIMEOUT", "Windows speech synthesis timed out.", retryable=True, status_code=504) from error
        if result.returncode != 0:
            raise StudioError(
                "SPEECH_SYNTHESIS_FAILED",
                "Windows could not synthesize the narration.",
                details={"diagnostic": (result.stderr or result.stdout)[-1500:]},
            )
        return result
