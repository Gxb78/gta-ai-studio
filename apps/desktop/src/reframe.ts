/**
 * Canonical reframe contract shared between CSS preview and FFmpeg rendering.
 * This must produce identical results to reframe.py.
 */

export interface NormalizedTransform {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

/**
 * Canonical formula: focus + zoom + source geometry → normalized crop rectangle.
 *
 * Used by:
 * - InteractivePreview for CSS transforms (Level A)
 * - Python/FFmpeg for encoded preview (Levels B & C)
 * - Golden tests for parity verification
 */
export function computeCropRect(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  focusX: number,
  focusY: number,
  zoom: number,
): NormalizedTransform {
  const outputAspect = outputWidth / outputHeight;
  const sourceAspect = sourceWidth / sourceHeight;

  let cropW: number;
  let cropH: number;

  if (sourceAspect > outputAspect) {
    cropH = 1.0 / zoom;
    cropW = (cropH * outputAspect) / sourceAspect;
  } else {
    cropW = 1.0 / zoom;
    cropH = (cropW * sourceAspect) / outputAspect;
  }

  cropW = Math.min(cropW, 1.0);
  cropH = Math.min(cropH, 1.0);

  const cropX = Math.max(0, Math.min(1 - cropW, focusX - cropW / 2));
  const cropY = Math.max(0, Math.min(1 - cropH, focusY - cropH / 2));

  return { cropX, cropY, cropWidth: cropW, cropHeight: cropH };
}

/**
 * Compute the CSS transform style for a video element inside an overflow:hidden container.
 * The container dimensions match the output dimensions.
 */
export function computePreviewTransform(
  proxyWidth: number,
  proxyHeight: number,
  outputWidth: number,
  outputHeight: number,
  focusX: number,
  focusY: number,
  zoom: number,
): { transform: string; transformOrigin: string } {
  const crop = computeCropRect(
    proxyWidth, proxyHeight,
    outputWidth, outputHeight,
    focusX, focusY, zoom,
  );

  const scaleX = 1 / crop.cropWidth;
  const scaleY = 1 / crop.cropHeight;
  const translateX = -crop.cropX * proxyWidth;
  const translateY = -crop.cropY * proxyHeight;

  return {
    transformOrigin: "0 0",
    transform: `scale(${scaleX}, ${scaleY}) translate(${translateX}px, ${translateY}px)`,
  };
}

/**
 * Compute the preview window centered around the playhead.
 */
export function computePreviewWindow(
  playheadMs: number,
  clipDurationMs: number,
  profile: "draft" | "fidelity",
): { playheadMs: number; startMs: number; durationMs: number } {
  const maxDuration = profile === "draft" ? 3000 : 2000;
  const duration = Math.min(clipDurationMs, maxDuration);
  const halfDuration = duration / 2;
  const start = Math.max(0, Math.min(
    clipDurationMs - duration,
    playheadMs - halfDuration,
  ));
  return {
    playheadMs,
    startMs: Math.round(start),
    durationMs: Math.round(duration),
  };
}
