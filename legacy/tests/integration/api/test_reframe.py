"""Tests for the canonical reframe contract (CSS/FFmpeg parity)."""
from __future__ import annotations

import pytest

from gta_studio_api.reframe import NormalizedTransform, compute_crop_rect, crop_rect_to_pixels


# ---------- Golden values ----------
# Each tuple: (source_w, source_h, output_w, output_h, focus_x, focus_y, zoom, expected)
# Expected values are verified by hand and must match the TypeScript port.

GOLDEN_CASES: list[tuple[int, int, int, int, float, float, float, NormalizedTransform]] = [
    # 16:9 source → 9:16 output, center focus, zoom 1.0
    # source_aspect=1.778 > output_aspect=0.5625 → crop_h=1.0, crop_w=0.5625/1.778=0.31640625
    # Wait: crop_w = crop_h * output_aspect / source_aspect = 1.0 * 0.5625 / 1.7778 ≈ 0.31640625
    # But looking at the actual formula more carefully:
    # source_aspect = 1920/1080 = 16/9; output_aspect = 540/960 = 9/16
    # crop_h = 1.0 / 1.0 = 1.0; crop_w = 1.0 * (9/16) / (16/9) = (9/16) * (9/16) = 81/256 ≈ 0.31640625
    # Hmm that doesn't match 0.5625. Let me re-derive:
    # Actually the formula is designed so the crop rectangle, when scaled to output dimensions,
    # fills the output. So crop_w * source_width should map to output_width, 
    # crop_h * source_height maps to output_height.
    # The goal: (crop_w * source_w) / (crop_h * source_h) = output_w / output_h
    # With source_aspect > output_aspect:
    #   crop_h = 1.0/zoom → full height used
    #   crop_w = crop_h * output_aspect / source_aspect
    #   = 1.0 * (540/960) / (1920/1080) = 0.5625 / 1.7778 = 0.31640625
    # crop_x = max(0, min(1 - 0.31640625, 0.5 - 0.31640625/2)) = min(0.68359, 0.34180) = 0.34180
    # crop_y = max(0, min(0, 0.5 - 0.5)) = 0.0
    (1920, 1080, 540, 960, 0.5, 0.5, 1.0, NormalizedTransform(
        crop_x=0.341796875, crop_y=0.0, crop_width=0.31640625, crop_height=1.0,
    )),
    # 16:9 source → 9:16 output, left edge focus
    (1920, 1080, 540, 960, 0.0, 0.5, 1.0, NormalizedTransform(
        crop_x=0.0, crop_y=0.0, crop_width=0.31640625, crop_height=1.0,
    )),
    # 16:9 source → 9:16 output, right edge focus
    (1920, 1080, 540, 960, 1.0, 0.5, 1.0, NormalizedTransform(
        crop_x=0.68359375, crop_y=0.0, crop_width=0.31640625, crop_height=1.0,
    )),
    # 16:9 source → 9:16 output, zoom 1.2, center
    # crop_h = 1/1.2 = 0.833333; crop_w = 0.833333 * 0.5625 / 1.7778 = 0.263672
    # crop_x = max(0, min(1-0.263672, 0.5-0.263672/2)) = min(0.736328, 0.368164) = 0.368164
    # crop_y = max(0, min(1-0.833333, 0.5-0.833333/2)) = min(0.166667, 0.083333) = 0.083333
    (1920, 1080, 540, 960, 0.5, 0.5, 1.2, NormalizedTransform(
        crop_x=0.5 - 0.31640625 / 1.2 / 2,
        crop_y=0.5 - 1.0 / 1.2 / 2,
        crop_width=0.31640625 / 1.2,
        crop_height=1.0 / 1.2,
    )),
    # 4:3 source (1440x1080) → 9:16 output, center
    # source_aspect = 1440/1080 = 4/3 ≈ 1.3333; output_aspect = 0.5625
    # source_aspect > output_aspect → crop_h = 1.0; crop_w = 1.0 * 0.5625 / 1.3333 = 0.421875
    # crop_x = max(0, min(0.578125, 0.5 - 0.421875/2)) = min(0.578125, 0.2890625) = 0.2890625
    (1440, 1080, 540, 960, 0.5, 0.5, 1.0, NormalizedTransform(
        crop_x=0.2890625, crop_y=0.0, crop_width=0.421875, crop_height=1.0,
    )),
    # 4K 16:9 source → 540x960, center (same ratio as 1920x1080)
    (3840, 2160, 540, 960, 0.5, 0.5, 1.0, NormalizedTransform(
        crop_x=0.341796875, crop_y=0.0, crop_width=0.31640625, crop_height=1.0,
    )),
    # 16:9 source → 1080x1920 (full res fidelity), center (same ratio)
    (1920, 1080, 1080, 1920, 0.5, 0.5, 1.0, NormalizedTransform(
        crop_x=0.341796875, crop_y=0.0, crop_width=0.31640625, crop_height=1.0,
    )),
    # Exact 9:16 source → 9:16 output (no crop needed)
    # source_aspect = 1080/1920 = 0.5625 = output_aspect → else branch
    # crop_w = 1.0/1.0 = 1.0; crop_h = 1.0 * 0.5625 / 0.5625 = 1.0
    (1080, 1920, 540, 960, 0.5, 0.5, 1.0, NormalizedTransform(
        crop_x=0.0, crop_y=0.0, crop_width=1.0, crop_height=1.0,
    )),
    # Square source (1080x1080) → 9:16 output, center
    # source_aspect = 1.0 > output_aspect = 0.5625 → crop_h = 1.0, crop_w = 0.5625 / 1.0 = 0.5625
    # crop_x = max(0, min(0.4375, 0.5-0.28125)) = 0.21875
    (1080, 1080, 540, 960, 0.5, 0.5, 1.0, NormalizedTransform(
        crop_x=0.21875, crop_y=0.0, crop_width=0.5625, crop_height=1.0,
    )),
]


@pytest.mark.parametrize(
    "source_w,source_h,output_w,output_h,focus_x,focus_y,zoom,expected",
    GOLDEN_CASES,
    ids=[
        "16:9-center",
        "16:9-left-edge",
        "16:9-right-edge",
        "16:9-zoom-1.2",
        "4:3-center",
        "4k-center",
        "fidelity-center",
        "9:16-passthrough",
        "square-center",
    ],
)
def test_compute_crop_rect_golden(
    source_w: int, source_h: int, output_w: int, output_h: int,
    focus_x: float, focus_y: float, zoom: float, expected: NormalizedTransform,
) -> None:
    result = compute_crop_rect(source_w, source_h, output_w, output_h, focus_x, focus_y, zoom)
    assert abs(result.crop_x - expected.crop_x) < 1e-6, f"crop_x: {result.crop_x} != {expected.crop_x}"
    assert abs(result.crop_y - expected.crop_y) < 1e-6, f"crop_y: {result.crop_y} != {expected.crop_y}"
    assert abs(result.crop_width - expected.crop_width) < 1e-6, f"crop_width: {result.crop_width} != {expected.crop_width}"
    assert abs(result.crop_height - expected.crop_height) < 1e-6, f"crop_height: {result.crop_height} != {expected.crop_height}"


def test_crop_rect_symmetry() -> None:
    """Focus 0.5 should produce a centered crop."""
    result = compute_crop_rect(1920, 1080, 540, 960, 0.5, 0.5, 1.0)
    mid_x = result.crop_x + result.crop_width / 2
    assert abs(mid_x - 0.5) < 1e-6, f"Not centered: midpoint = {mid_x}"


def test_focus_extremes_clamped() -> None:
    """Focus at 0.0 and 1.0 should not produce negative crops."""
    for fx in (0.0, 1.0):
        for fy in (0.0, 1.0):
            result = compute_crop_rect(1920, 1080, 540, 960, fx, fy, 1.0)
            assert result.crop_x >= 0.0
            assert result.crop_y >= 0.0
            assert result.crop_x + result.crop_width <= 1.0 + 1e-9
            assert result.crop_y + result.crop_height <= 1.0 + 1e-9


def test_zoom_reduces_crop_area() -> None:
    """Higher zoom should produce a smaller crop area."""
    base = compute_crop_rect(1920, 1080, 540, 960, 0.5, 0.5, 1.0)
    zoomed = compute_crop_rect(1920, 1080, 540, 960, 0.5, 0.5, 1.15)
    assert zoomed.crop_width < base.crop_width
    assert zoomed.crop_height < base.crop_height


def test_crop_rect_to_pixels_even() -> None:
    """Pixel dimensions must be even and within source bounds."""
    transform = compute_crop_rect(1920, 1080, 540, 960, 0.3, 0.7, 1.1)
    x, y, w, h = crop_rect_to_pixels(transform, 1920, 1080)
    assert w % 2 == 0
    assert h % 2 == 0
    assert x >= 0
    assert y >= 0
    assert x + w <= 1920
    assert y + h <= 1080
    assert w >= 2
    assert h >= 2


def test_crop_rect_to_pixels_4k() -> None:
    """4K source should produce valid pixel values."""
    transform = compute_crop_rect(3840, 2160, 540, 960, 0.5, 0.5, 1.0)
    x, y, w, h = crop_rect_to_pixels(transform, 3840, 2160)
    assert x + w <= 3840
    assert y + h <= 2160


def test_focus_animated_interpolation() -> None:
    """Animated focus should produce intermediate crops between start and end."""
    start = compute_crop_rect(1920, 1080, 540, 960, 0.2, 0.5, 1.0)
    mid = compute_crop_rect(1920, 1080, 540, 960, 0.5, 0.5, 1.0)
    end = compute_crop_rect(1920, 1080, 540, 960, 0.8, 0.5, 1.0)
    assert start.crop_x < mid.crop_x < end.crop_x


def test_passthrough_produces_no_crop() -> None:
    """When source aspect matches output, zoom=1 → full frame."""
    result = compute_crop_rect(540, 960, 540, 960, 0.5, 0.5, 1.0)
    assert abs(result.crop_x) < 1e-9
    assert abs(result.crop_y) < 1e-9
    assert abs(result.crop_width - 1.0) < 1e-9
    assert abs(result.crop_height - 1.0) < 1e-9


@pytest.mark.parametrize("zoom", [1.0, 1.05, 1.1, 1.15, 1.2])
def test_crop_fills_output_aspect(zoom: float) -> None:
    """Crop aspect ratio should match output aspect ratio."""
    result = compute_crop_rect(1920, 1080, 540, 960, 0.5, 0.5, zoom)
    crop_aspect = (result.crop_width * 1920) / (result.crop_height * 1080)
    expected_aspect = 540 / 960
    assert abs(crop_aspect - expected_aspect) < 1e-4, f"Aspect mismatch: {crop_aspect} vs {expected_aspect}"
