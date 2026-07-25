import assert from "node:assert/strict";
import test from "node:test";

import { computeCropRect, computePreviewWindow } from "../../../apps/desktop/src/reframe.js";

// ---------- Golden values (must match test_reframe.py) ----------

interface GoldenCase {
  name: string;
  sourceW: number;
  sourceH: number;
  outputW: number;
  outputH: number;
  focusX: number;
  focusY: number;
  zoom: number;
  expected: { cropX: number; cropY: number; cropWidth: number; cropHeight: number };
}

const GOLDEN_CASES: GoldenCase[] = [
  {
    name: "16:9-center",
    sourceW: 1920, sourceH: 1080, outputW: 540, outputH: 960,
    focusX: 0.5, focusY: 0.5, zoom: 1.0,
    expected: { cropX: 0.341796875, cropY: 0.0, cropWidth: 0.31640625, cropHeight: 1.0 },
  },
  {
    name: "16:9-left-edge",
    sourceW: 1920, sourceH: 1080, outputW: 540, outputH: 960,
    focusX: 0.0, focusY: 0.5, zoom: 1.0,
    expected: { cropX: 0.0, cropY: 0.0, cropWidth: 0.31640625, cropHeight: 1.0 },
  },
  {
    name: "16:9-right-edge",
    sourceW: 1920, sourceH: 1080, outputW: 540, outputH: 960,
    focusX: 1.0, focusY: 0.5, zoom: 1.0,
    expected: { cropX: 0.68359375, cropY: 0.0, cropWidth: 0.31640625, cropHeight: 1.0 },
  },
  {
    name: "16:9-zoom-1.2",
    sourceW: 1920, sourceH: 1080, outputW: 540, outputH: 960,
    focusX: 0.5, focusY: 0.5, zoom: 1.2,
    expected: {
      cropX: 0.5 - (0.31640625 / 1.2) / 2,
      cropY: 0.5 - (1.0 / 1.2) / 2,
      cropWidth: 0.31640625 / 1.2,
      cropHeight: 1.0 / 1.2,
    },
  },
  {
    name: "4:3-center",
    sourceW: 1440, sourceH: 1080, outputW: 540, outputH: 960,
    focusX: 0.5, focusY: 0.5, zoom: 1.0,
    expected: { cropX: 0.2890625, cropY: 0.0, cropWidth: 0.421875, cropHeight: 1.0 },
  },
  {
    name: "4k-center",
    sourceW: 3840, sourceH: 2160, outputW: 540, outputH: 960,
    focusX: 0.5, focusY: 0.5, zoom: 1.0,
    expected: { cropX: 0.341796875, cropY: 0.0, cropWidth: 0.31640625, cropHeight: 1.0 },
  },
  {
    name: "fidelity-center",
    sourceW: 1920, sourceH: 1080, outputW: 1080, outputH: 1920,
    focusX: 0.5, focusY: 0.5, zoom: 1.0,
    expected: { cropX: 0.341796875, cropY: 0.0, cropWidth: 0.31640625, cropHeight: 1.0 },
  },
  {
    name: "9:16-passthrough",
    sourceW: 1080, sourceH: 1920, outputW: 540, outputH: 960,
    focusX: 0.5, focusY: 0.5, zoom: 1.0,
    expected: { cropX: 0.0, cropY: 0.0, cropWidth: 1.0, cropHeight: 1.0 },
  },
  {
    name: "square-center",
    sourceW: 1080, sourceH: 1080, outputW: 540, outputH: 960,
    focusX: 0.5, focusY: 0.5, zoom: 1.0,
    expected: { cropX: 0.21875, cropY: 0.0, cropWidth: 0.5625, cropHeight: 1.0 },
  },
];

const TOLERANCE = 1e-6;

for (const c of GOLDEN_CASES) {
  test(`computeCropRect golden: ${c.name}`, () => {
    const result = computeCropRect(
      c.sourceW, c.sourceH, c.outputW, c.outputH, c.focusX, c.focusY, c.zoom,
    );
    assert.ok(
      Math.abs(result.cropX - c.expected.cropX) < TOLERANCE,
      `cropX: ${result.cropX} != ${c.expected.cropX}`,
    );
    assert.ok(
      Math.abs(result.cropY - c.expected.cropY) < TOLERANCE,
      `cropY: ${result.cropY} != ${c.expected.cropY}`,
    );
    assert.ok(
      Math.abs(result.cropWidth - c.expected.cropWidth) < TOLERANCE,
      `cropWidth: ${result.cropWidth} != ${c.expected.cropWidth}`,
    );
    assert.ok(
      Math.abs(result.cropHeight - c.expected.cropHeight) < TOLERANCE,
      `cropHeight: ${result.cropHeight} != ${c.expected.cropHeight}`,
    );
  });
}

test("computeCropRect: symmetry — focus 0.5 produces centered crop", () => {
  const result = computeCropRect(1920, 1080, 540, 960, 0.5, 0.5, 1.0);
  const midX = result.cropX + result.cropWidth / 2;
  assert.ok(Math.abs(midX - 0.5) < TOLERANCE, `Not centered: midpoint = ${midX}`);
});

test("computeCropRect: focus extremes produce valid crops", () => {
  for (const fx of [0.0, 1.0]) {
    for (const fy of [0.0, 1.0]) {
      const result = computeCropRect(1920, 1080, 540, 960, fx, fy, 1.0);
      assert.ok(result.cropX >= 0.0, `cropX < 0 for focus (${fx}, ${fy})`);
      assert.ok(result.cropY >= 0.0, `cropY < 0 for focus (${fx}, ${fy})`);
      assert.ok(result.cropX + result.cropWidth <= 1.0 + TOLERANCE);
      assert.ok(result.cropY + result.cropHeight <= 1.0 + TOLERANCE);
    }
  }
});

test("computeCropRect: higher zoom reduces crop area", () => {
  const base = computeCropRect(1920, 1080, 540, 960, 0.5, 0.5, 1.0);
  const zoomed = computeCropRect(1920, 1080, 540, 960, 0.5, 0.5, 1.15);
  assert.ok(zoomed.cropWidth < base.cropWidth);
  assert.ok(zoomed.cropHeight < base.cropHeight);
});

test("computeCropRect: crop aspect matches output aspect", () => {
  for (const zoom of [1.0, 1.05, 1.1, 1.15, 1.2]) {
    const result = computeCropRect(1920, 1080, 540, 960, 0.5, 0.5, zoom);
    const cropAspect = (result.cropWidth * 1920) / (result.cropHeight * 1080);
    const expectedAspect = 540 / 960;
    assert.ok(
      Math.abs(cropAspect - expectedAspect) < 1e-4,
      `Aspect mismatch at zoom=${zoom}: ${cropAspect} vs ${expectedAspect}`,
    );
  }
});

test("computeCropRect: animated focus produces ordered crops", () => {
  const start = computeCropRect(1920, 1080, 540, 960, 0.2, 0.5, 1.0);
  const mid = computeCropRect(1920, 1080, 540, 960, 0.5, 0.5, 1.0);
  const end = computeCropRect(1920, 1080, 540, 960, 0.8, 0.5, 1.0);
  assert.ok(start.cropX < mid.cropX);
  assert.ok(mid.cropX < end.cropX);
});

test("computePreviewWindow: centers around playhead", () => {
  const w = computePreviewWindow(5000, 10000, "draft");
  assert.equal(w.durationMs, 3000);
  assert.equal(w.startMs, 3500);
  assert.equal(w.playheadMs, 5000);
});

test("computePreviewWindow: clamps to start", () => {
  const w = computePreviewWindow(100, 10000, "draft");
  assert.equal(w.startMs, 0);
  assert.equal(w.durationMs, 3000);
});

test("computePreviewWindow: clamps to end", () => {
  const w = computePreviewWindow(9900, 10000, "draft");
  assert.equal(w.startMs, 7000);
  assert.equal(w.durationMs, 3000);
});

test("computePreviewWindow: fidelity uses 2s window", () => {
  const w = computePreviewWindow(5000, 10000, "fidelity");
  assert.equal(w.durationMs, 2000);
});

test("computePreviewWindow: short clip uses full duration", () => {
  const w = computePreviewWindow(500, 1500, "draft");
  assert.equal(w.durationMs, 1500);
  assert.equal(w.startMs, 0);
});
