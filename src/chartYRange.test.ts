import { describe, expect, it } from "vitest";
import {
  gridPanSnapTarget,
  gridStepLadder,
  nearestGridStep,
  panReleaseVelocity,
  panYAxisRange,
  yZoomRungs,
  zoomYAxisToGrid,
  zoomYAxisRange,
} from "./chartYRange";

describe("panYAxisRange", () => {
  it("shifts both endpoints while preserving the span", () => {
    expect(panYAxisRange([10, 20], 0.25)).toEqual([12.5, 22.5]);
    expect(panYAxisRange([10, 20], -0.5)).toEqual([5, 15]);
  });

  it("moves the view up when dragging the pointer upward", () => {
    const result = panYAxisRange([0, 100], 1 / 6)!;
    expect(result[0]).toBeCloseTo(100 / 6, 12);
    expect(result[1]).toBeCloseTo(100 + 100 / 6, 12);
  });

  it("is free and never clamps to data bounds", () => {
    expect(panYAxisRange([0, 100], 3)).toEqual([300, 400]);
    expect(panYAxisRange([0, 100], -2)).toEqual([-200, -100]);
  });

  it("rejects invalid extents and non-finite deltas", () => {
    expect(panYAxisRange([Number.NaN, 100], 0.1)).toBeNull();
    expect(panYAxisRange([100, 100], 0.1)).toBeNull();
    expect(panYAxisRange([0, 100], Number.NaN)).toBeNull();
    expect(panYAxisRange([0, 100], Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("zoomYAxisRange", () => {
  it("zooms in around the anchor ratio for a positive wheel delta", () => {
    const result = zoomYAxisRange([0, 100], 0.5, 4);
    expect(result).not.toBeNull();
    const nextSpan = 100 / 1.4;
    expect(result![0]).toBeCloseTo(50 - nextSpan / 2, 12);
    expect(result![1]).toBeCloseTo(50 + nextSpan / 2, 12);
  });

  it("zooms out for a negative wheel delta", () => {
    const result = zoomYAxisRange([0, 100], 0.5, -4);
    const nextSpan = 100 * 1.4;
    expect(result![0]).toBeCloseTo(50 - nextSpan / 2, 12);
    expect(result![1]).toBeCloseTo(50 + nextSpan / 2, 12);
  });

  it("keeps the anchor value at the same ratio for off-center anchors", () => {
    const extent: [number, number] = [-20, 80];
    for (const ratio of [0, 0.25, 0.75, 1]) {
      const result = zoomYAxisRange(extent, ratio, 4)!;
      const [min, max] = extent;
      const anchor = min + (max - min) * ratio;
      const nextSpan = (max - min) / 1.4;
      expect(result[0]).toBeCloseTo(anchor - nextSpan * ratio, 12);
      expect(result[1]).toBeCloseTo(anchor + nextSpan * (1 - ratio), 12);
    }
  });

  it("applies the magnitude tiers matching the x-axis wheel zoom", () => {
    expect(zoomYAxisRange([0, 100], 0.5, 1)![1]).toBeCloseTo(
      50 + 50 / 1.1,
      12,
    );
    expect(zoomYAxisRange([0, 100], 0.5, 2)![1]).toBeCloseTo(
      50 + 50 / 1.2,
      12,
    );
    expect(zoomYAxisRange([0, 100], 0.5, 4)![1]).toBeCloseTo(
      50 + 50 / 1.4,
      12,
    );
  });

  it("is free and never clamps to data bounds", () => {
    const result = zoomYAxisRange([0, 100], 0, -4)!;
    expect(result[0]).toBeCloseTo(0, 12);
    expect(result[1]).toBeCloseTo(140, 12);
    const outward = zoomYAxisRange([0, 100], 1, 4)!;
    expect(outward[0]).toBeCloseTo(100 - 100 / 1.4, 12);
    expect(outward[1]).toBeCloseTo(100, 12);
  });

  it("rejects invalid input", () => {
    expect(zoomYAxisRange([0, 100], 0.5, 0)).toBeNull();
    expect(zoomYAxisRange([Number.NaN, 100], 0.5, 4)).toBeNull();
    expect(zoomYAxisRange([100, 100], 0.5, 4)).toBeNull();
    expect(zoomYAxisRange([0, 100], Number.NaN, 4)).toBeNull();
  });
});

describe("nearestGridStep", () => {
  it.each([
    [100, 5, 20],
    [50, 5, 10],
    [75, 5, 15],
    [7, 5, 1.4],
    [0.5, 5, 0.1],
    [160, 7, 22],
  ])("picks the ladder rung closest to %s / %s", (span, count, expected) => {
    expect(nearestGridStep(span, count)).toBeCloseTo(expected, 12);
  });

  it("cleans floating point noise", () => {
    const step = nearestGridStep(0.3, 5)!;
    expect(step).toBeCloseTo(0.06, 12);
    expect(Number(step.toPrecision(12))).toBe(step);
  });

  it("rejects invalid spans and tick counts", () => {
    expect(nearestGridStep(0, 5)).toBeNull();
    expect(nearestGridStep(-10, 5)).toBeNull();
    expect(nearestGridStep(Number.NaN, 5)).toBeNull();
    expect(nearestGridStep(100, 0)).toBeNull();
    expect(nearestGridStep(100, 2.5)).toBeNull();
    expect(nearestGridStep(100, 10)).toBeNull();
  });
});

describe("gridStepLadder", () => {
  it("moves one rung in either direction", () => {
    expect(gridStepLadder(20, -1)).toBeCloseTo(18, 12);
    expect(gridStepLadder(20, 1)).toBeCloseTo(22, 12);
    expect(gridStepLadder(10, -1)).toBeCloseTo(9, 12);
    expect(gridStepLadder(8, 1)).toBeCloseTo(9, 12);
    expect(gridStepLadder(80, 1)).toBeCloseTo(90, 12);
    expect(gridStepLadder(0.5, -1)).toBeCloseTo(0.45, 12);
  });

  it("wraps across decade boundaries without duplicates", () => {
    expect(gridStepLadder(10, 1)).toBeCloseTo(11, 12);
    expect(gridStepLadder(100, -1)).toBeCloseTo(90, 12);
    expect(gridStepLadder(1, -1)).toBeCloseTo(0.9, 12);
  });

  it("rejects invalid input", () => {
    expect(gridStepLadder(Number.NaN, -1)).toBeNull();
    expect(gridStepLadder(0, -1)).toBeNull();
    expect(gridStepLadder(-5, -1)).toBeNull();
  });
});

describe("zoomYAxisToGrid", () => {
  it("zooms in to the next smaller grid rung and aligns min", () => {
    expect(zoomYAxisToGrid([0, 100], 0.5, 4, 5)).toEqual([0, 90]);
    expect(zoomYAxisToGrid([0, 50], 0.5, 4, 5)).toEqual([0, 45]);
  });

  it("zooms out to the next larger grid rung and aligns min", () => {
    const result = zoomYAxisToGrid([0, 100], 0.5, -4, 5)!;
    expect(result).toEqual([0, 110]);
  });

  it("keeps the anchor value near the same ratio for off-center anchors", () => {
    const result = zoomYAxisToGrid([0, 100], 0.25, 4, 5)!;
    expect(result).toEqual([0, 90]);
    const anchor = result[0] + (result[1] - result[0]) * 0.25;
    expect(anchor).toBeCloseTo(22.5, 12);
  });

  it("moves multiple rungs in one call and aligns min once", () => {
    const result = zoomYAxisToGrid([0, 100], 0.5, 4, 5, 4)!;
    // 20 → 18 → 15 → 14 → 12：4 档后的整格步长 12，跨度 60
    expect(result[1] - result[0]).toBeCloseTo(60, 12);
    expect(result[0]).toBeCloseTo(24, 12);
    expect(result[0] / 12).toBeCloseTo(2, 12);
    const out = zoomYAxisToGrid([0, 100], 0.5, -4, 5, 4)!;
    // 20 → 22 → 25 → 30 → 35：跨度 175，min 对齐 35 整数倍
    expect(out[1] - out[0]).toBeCloseTo(175, 12);
    expect(out[0]).toBeCloseTo(-35, 12);
  });

  it("keeps the anchor deviation within half a step for multi-rung zooms", () => {
    const result = zoomYAxisToGrid([0, 100], 0.25, 4, 5, 4)!;
    const span = result[1] - result[0];
    const step = span / 5;
    const anchor = result[0] + span * 0.25;
    expect(Math.abs(anchor - 25)).toBeLessThanOrEqual(step / 2 + 1e-9);
  });

  it("rejects invalid input", () => {
    expect(zoomYAxisToGrid([100, 100], 0.5, 4, 5)).toBeNull();
    expect(zoomYAxisToGrid([0, 100], Number.NaN, 4, 5)).toBeNull();
    expect(zoomYAxisToGrid([0, 100], 0.5, 0, 5)).toBeNull();
    expect(zoomYAxisToGrid([0, 100], 0.5, 4, 0)).toBeNull();
    expect(zoomYAxisToGrid([0, 100], 0.5, 4, 5, 0)).toBeNull();
    expect(zoomYAxisToGrid([0, 100], 0.5, 4, 5, 1.5)).toBeNull();
    expect(zoomYAxisToGrid([0, 100], 0.5, 4, 5, Number.NaN)).toBeNull();
  });
});

describe("yZoomRungs", () => {
  it("maps one mouse notch to one grid rung", () => {
    const result = yZoomRungs(null, 1, 0)!;
    expect(result.rungs).toBe(1);
    expect(result.accumulator).toEqual({ value: 0, sign: 1, time: 0 });
    const out = yZoomRungs(null, -1, 0)!;
    expect(out.rungs).toBe(1);
    expect(out.accumulator.sign).toBe(-1);
  });

  it("accumulates small trackpad deltas across events", () => {
    const first = yZoomRungs(null, 0.4, 0)!;
    expect(first.rungs).toBe(0);
    expect(first.accumulator.value).toBeCloseTo(0.4, 12);
    const second = yZoomRungs(first.accumulator, 0.4, 16)!;
    expect(second.rungs).toBe(0);
    expect(second.accumulator.value).toBeCloseTo(0.8, 12);
    const third = yZoomRungs(second.accumulator, 0.4, 32)!;
    expect(third.rungs).toBe(1);
    expect(third.accumulator.value).toBeCloseTo(0.2, 12);
  });

  it("caps the rungs consumed by a single large delta", () => {
    const result = yZoomRungs(null, 10, 0)!;
    expect(result.rungs).toBe(4);
    expect(result.accumulator.value).toBe(0);
    const fractional = yZoomRungs(null, 4.5, 0)!;
    expect(fractional.rungs).toBe(4);
    expect(fractional.accumulator.value).toBeCloseTo(0.5, 12);
  });

  it("resets on direction change", () => {
    const acc = { value: 0.8, sign: 1 as const, time: 0 };
    const result = yZoomRungs(acc, -0.3, 8)!;
    expect(result.rungs).toBe(0);
    expect(result.accumulator.sign).toBe(-1);
    expect(result.accumulator.value).toBeCloseTo(0.3, 12);
  });

  it("resets after the accumulator expires", () => {
    const acc = { value: 0.8, sign: 1 as const, time: 0 };
    const result = yZoomRungs(acc, 0.4, 201)!;
    expect(result.rungs).toBe(0);
    expect(result.accumulator.value).toBeCloseTo(0.4, 12);
  });

  it("keeps the remainder within the expiry window", () => {
    const acc = { value: 0.8, sign: 1 as const, time: 0 };
    const result = yZoomRungs(acc, 0.4, 200)!;
    expect(result.rungs).toBe(1);
    expect(result.accumulator.value).toBeCloseTo(0.2, 12);
  });

  it("rejects invalid input", () => {
    expect(yZoomRungs(null, 0, 0)).toBeNull();
    expect(yZoomRungs(null, Number.NaN, 0)).toBeNull();
    expect(yZoomRungs(null, 1, Number.NaN)).toBeNull();
    expect(yZoomRungs(null, 1, 0, 0)).toBeNull();
    expect(yZoomRungs(null, 1, 0, 1, 0)).toBeNull();
    expect(yZoomRungs(null, 1, 0, 1, 4, 0)).toBeNull();
  });
});

describe("panReleaseVelocity", () => {
  it("returns the average velocity over the trailing window", () => {
    const samples = [
      { y: 500, t: 0 },
      { y: 480, t: 16 },
      { y: 460, t: 32 },
    ];
    expect(panReleaseVelocity(samples, 440, 48)).toBeCloseTo(-1.25, 12);
  });

  it("ignores samples outside the trailing window", () => {
    const samples = [
      { y: 500, t: 0 },
      { y: 470, t: 100 },
      { y: 470, t: 116 },
    ];
    expect(panReleaseVelocity(samples, 470, 132)).toBe(0);
  });

  it("treats short spans and tiny moves as stopped", () => {
    expect(panReleaseVelocity([{ y: 500, t: 0 }], 500, 16)).toBe(0);
    expect(
      panReleaseVelocity(
        [
          { y: 500, t: 0 },
          { y: 495, t: 100 },
        ],
        495,
        200,
      ),
    ).toBe(0);
    expect(
      panReleaseVelocity(
        [
          { y: 500, t: 0 },
          { y: 470, t: 8 },
        ],
        470,
        16,
      ),
    ).toBe(0);
  });

  it("rejects malformed samples with zero", () => {
    expect(panReleaseVelocity([{ y: 500, t: Number.NaN }], 500, 16)).toBe(0);
  });
});

describe("gridPanSnapTarget", () => {
  it("returns to the start grid line when released within the back threshold", () => {
    expect(gridPanSnapTarget(5, 20, 0, 0)).toBeCloseTo(0, 12);
    expect(gridPanSnapTarget(-5, 20, 0, 0)).toBeCloseTo(0, 12);
  });

  it("advances in the drag direction once past the threshold", () => {
    expect(gridPanSnapTarget(7.5, 20, 0, 0)).toBeCloseTo(20, 12);
    expect(gridPanSnapTarget(-7.5, 20, 0, 0)).toBeCloseTo(-20, 12);
    expect(gridPanSnapTarget(25, 20, 0, 0)).toBeCloseTo(20, 12);
    expect(gridPanSnapTarget(35, 20, 0, 0)).toBeCloseTo(40, 12);
    expect(gridPanSnapTarget(-35, 20, 0, 0)).toBeCloseTo(-40, 12);
  });

  it("anchors the back threshold to the nearest grid multiple of the drag start", () => {
    expect(gridPanSnapTarget(12.34, 20, 12.34, 0)).toBeCloseTo(0, 12);
    expect(gridPanSnapTarget(22.34, 20, 12.34, 0)).toBeCloseTo(20, 12);
  });

  it("continues one row in the flick direction without bouncing back", () => {
    expect(gridPanSnapTarget(5, 20, 0, -1)).toBeCloseTo(0, 12);
    expect(gridPanSnapTarget(-5, 20, 0, -1)).toBeCloseTo(-20, 12);
    expect(gridPanSnapTarget(-5, 20, 0, 1)).toBeCloseTo(0, 12);
    expect(gridPanSnapTarget(5, 20, 0, 1)).toBeCloseTo(20, 12);
  });

  it("treats slow movement as stopped below the flick threshold", () => {
    expect(gridPanSnapTarget(-5, 20, 0, 0.39)).toBeCloseTo(0, 12);
    expect(gridPanSnapTarget(-5, 20, 0, -0.4)).toBeCloseTo(-20, 12);
    expect(gridPanSnapTarget(-5, 20, 0, 0.4)).toBeCloseTo(0, 12);
  });

  it("rejects invalid input", () => {
    expect(gridPanSnapTarget(Number.NaN, 20, 0, 0)).toBeNull();
    expect(gridPanSnapTarget(5, 0, 0, 0)).toBeNull();
    expect(gridPanSnapTarget(5, 20, Number.NaN, 0)).toBeNull();
    expect(gridPanSnapTarget(5, 20, 0, Number.NaN)).toBeNull();
  });
});
