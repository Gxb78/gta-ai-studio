from __future__ import annotations
from dataclasses import dataclass

@dataclass(frozen=True)
class NormalizedTransform:
    """Rectangle de crop normalisé [0, 1] dans les coordonnées source."""
    crop_x: float
    crop_y: float
    crop_width: float
    crop_height: float

def compute_crop_rect(
    source_width: int,
    source_height: int,
    output_width: int,
    output_height: int,
    focus_x: float,
    focus_y: float,
    zoom: float,
) -> NormalizedTransform:
    """Canonical formula: focus + zoom + source geometry → normalized crop rectangle.
    
    Used by:
    - React/CSS for interactive transforms (Niveau A)
    - Python/FFmpeg for encoded preview (Niveaux B & C)
    - Golden tests for parity verification
    """
    output_aspect = output_width / output_height
    source_aspect = source_width / source_height
    
    if source_aspect > output_aspect:
        crop_h = 1.0 / zoom
        crop_w = crop_h * output_aspect / source_aspect
    else:
        crop_w = 1.0 / zoom
        crop_h = crop_w * source_aspect / output_aspect
    
    crop_w = min(crop_w, 1.0)
    crop_h = min(crop_h, 1.0)
    
    crop_x = max(0.0, min(1.0 - crop_w, focus_x - crop_w / 2))
    crop_y = max(0.0, min(1.0 - crop_h, focus_y - crop_h / 2))
    
    return NormalizedTransform(
        crop_x=crop_x,
        crop_y=crop_y,
        crop_width=crop_w,
        crop_height=crop_h,
    )


def crop_rect_to_pixels(
    transform: NormalizedTransform,
    source_width: int,
    source_height: int,
) -> tuple[int, int, int, int]:
    """Convert normalized crop to pixel values aligned to multiples of 2.
    
    Returns (x, y, width, height) in pixels.
    """
    w = round(transform.crop_width * source_width)
    h = round(transform.crop_height * source_height)
    w = w - w % 2
    h = h - h % 2
    w = max(2, w)
    h = max(2, h)
    x = round(transform.crop_x * source_width)
    y = round(transform.crop_y * source_height)
    x = min(x, source_width - w)
    y = min(y, source_height - h)
    return x, y, w, h
