from __future__ import annotations

from pathlib import Path

import pytest

from gta_studio_api.config import REPO_ROOT
from gta_studio_api.errors import StudioError
from gta_studio_api.media import MediaTools
from gta_studio_api.storage import Storage


def test_ffmpeg_command_is_an_argument_array_without_shell_text(tmp_path: Path) -> None:
    tools = MediaTools("ffmpeg", "ffprobe", 1280, 28, "veryfast")
    command = tools.build_proxy_command(tmp_path / "input.mp4", tmp_path / "output.mp4")
    assert isinstance(command, list)
    assert command[0] == "ffmpeg"
    assert all(";" not in argument and "&&" not in argument for argument in command)
    assert "-nostdin" in command


def test_artifact_uri_cannot_escape_data_root(tmp_path: Path) -> None:
    storage = Storage(tmp_path / "data", 1024)
    storage.initialize()
    with pytest.raises(StudioError, match="outside the data root"):
        storage.resolve_uri("../secrets.txt")


def test_demo_fixture_is_a_real_file() -> None:
    fixture = REPO_ROOT / "tests" / "fixtures" / "demo-gameplay.mp4"
    assert fixture.is_file()
    assert fixture.stat().st_size > 1_000

