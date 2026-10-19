import { describe, expect, it } from "vitest";
import {
  AXIS_LOCK_CLICK_SLOP_PX,
  CURVE_GROUP_HIT_RADIUS_PX,
  effectiveYAxisIds,
  interpolateSeries,
  isAxisLockClick,
  pickNearestCurveGroup,
  placeTooltip,
  rangeFromPercent,
  toggleLockedAxis,
  type CurveHitSeries,
} from "./chartInteraction";
import { prepareDataset } from "./chartSeries";
import { makeDataset } from "./test/fixtures";

const midpointTime = new Date(2026, 0, 1, 0, 5).getTime();

describe("chart interaction helpers", () => {
  const hitSeries: CurveHitSeries[] = [
    {
      id: "actual-temp",
      axisId: "primary",
      points: [[0, 20], [10, 40]],
      z: 2,
    },
    {
      id: "set-temp",
      axisId: "primary",
      points: [[0, 35], [10, 35]],
      z: 3,
    },
    {
      id: "actual-humidity",
      axisId: "secondary",
      points: [[0, 50], [10, 50]],
      z: 2,
    },
  ];
  const allHitSeries = new Set(hitSeries.map((series) => series.id));
  const valueToPixel = (axisId: string, value: number) =>
    axisId === "primary" ? 200 - value * 2 : 250 - value;

  it("locks one axis at a time and releases the locked axis when toggled again", () => {
    const primary = toggleLockedAxis(new Set(), "primary");
    expect([...primary]).toEqual(["primary"]);

    const secondary = toggleLockedAxis(primary, "secondary");
    expect([...secondary]).toEqual(["secondary"]);
    expect([...primary]).toEqual(["primary"]);

    expect([...toggleLockedAxis(secondary, "primary")]).toEqual(["primary"]);
    expect([...toggleLockedAxis(secondary, "secondary")]).toEqual([]);
  });

  it("uses all visible axes only when the explicit lock set is empty", () => {
    const order = ["primary", "secondary", "pressure"];
    const visible = new Set(["secondary", "pressure"]);

    expect(effectiveYAxisIds(order, visible, new Set())).toEqual([
      "secondary",
      "pressure",
    ]);
    expect(
      effectiveYAxisIds(order, visible, new Set(["primary", "secondary"])),
    ).toEqual(["secondary"]);
    expect(
      effectiveYAxisIds(order, visible, new Set(["primary"])),
    ).toEqual([]);
  });

  it("accepts only a same-axis Shift click within the movement slop", () => {
    const start = { x: 100, y: 100, axisId: "primary" };
    expect(
      isAxisLockClick(start, {
        x: 100 + AXIS_LOCK_CLICK_SLOP_PX,
        y: 100,
        axisId: "primary",
      }),
    ).toBe(true);
    expect(
      isAxisLockClick(start, {
        x: 100 + AXIS_LOCK_CLICK_SLOP_PX + 0.01,
        y: 100,
        axisId: "primary",
      }),
    ).toBe(false);
    expect(
      isAxisLockClick(start, { x: 100, y: 100, axisId: "secondary" }),
    ).toBe(false);
    expect(
      isAxisLockClick(
        { x: 100, y: 100, axisId: null },
        { x: 100, y: 100, axisId: null },
      ),
    ).toBe(false);
  });

  it("picks the nearest rendered curve and returns its shared axis group", () => {
    expect(
      pickNearestCurveGroup(hitSeries, allHitSeries, 5, 141, valueToPixel),
    ).toEqual({
      seriesId: "actual-temp",
      axisId: "primary",
      distancePx: 1,
    });
  });

  it("uses the configured hit radius and ignores hidden or missing curves", () => {
    expect(
      pickNearestCurveGroup(
        hitSeries,
        new Set(["actual-humidity"]),
        5,
        141,
        valueToPixel,
      ),
    ).toBeNull();
    expect(
      pickNearestCurveGroup(
        hitSeries,
        new Set(["actual-temp"]),
        5,
        140 - CURVE_GROUP_HIT_RADIUS_PX,
        valueToPixel,
      ),
    ).toEqual(expect.objectContaining({ seriesId: "actual-temp" }));
    expect(
      pickNearestCurveGroup(
        hitSeries,
        new Set(["actual-temp"]),
        5,
        140 - CURVE_GROUP_HIT_RADIUS_PX - 0.01,
        valueToPixel,
      ),
    ).toBeNull();

    const missing: CurveHitSeries[] = [
      {
        id: "missing",
        axisId: "primary",
        points: [[0, 20], [10, null]],
        z: 10,
      },
    ];
    expect(
      pickNearestCurveGroup(missing, new Set(["missing"]), 5, 160, valueToPixel),
    ).toBeNull();
  });

  it("prefers the visually topmost curve when different axes overlap", () => {
    const overlapping: CurveHitSeries[] = [
      { ...hitSeries[0], points: [[0, 30], [10, 30]], z: 2 },
      { ...hitSeries[2], points: [[0, 110], [10, 110]], z: 3 },
    ];
    expect(
      pickNearestCurveGroup(
        overlapping,
        new Set(overlapping.map((series) => series.id)),
        5,
        140,
        valueToPixel,
      ),
    ).toEqual({
      seriesId: "actual-humidity",
      axisId: "secondary",
      distancePx: 0,
    });
  });

  it("interpolates prepared numeric series", () => {
    const actualTemperature = prepareDataset(makeDataset()).series.find(
      (series) => series.id === "actual-temp",
    );

    expect(actualTemperature).toBeDefined();
    expect(interpolateSeries(actualTemperature!, midpointTime)).toBe(24.5);
  });

  it("does not interpolate across a missing sample", () => {
    const rawDataset = makeDataset();
    const rawActualTemperature = rawDataset.series.find(
      (series) => series.id === "actual-temp",
    );
    if (!rawActualTemperature) throw new Error("missing actual-temp fixture series");
    rawActualTemperature.points = [
      ["2026-01-01 00:00:00", 24],
      ["2026-01-01 00:10:00", null],
    ];

    const actualTemperature = prepareDataset(rawDataset).series.find(
      (series) => series.id === "actual-temp",
    );

    expect(actualTemperature).toBeDefined();
    expect(interpolateSeries(actualTemperature!, midpointTime)).toBeNull();
  });

  it("returns null for a non-finite query time", () => {
    const actualTemperature = prepareDataset(makeDataset()).series.find(
      (series) => series.id === "actual-temp",
    );

    expect(actualTemperature).toBeDefined();
    expect(interpolateSeries(actualTemperature!, Number.NaN)).toBeNull();
  });

  it("returns null outside the prepared extent while preserving exact endpoints", () => {
    const actualTemperature = prepareDataset(makeDataset()).series.find(
      (series) => series.id === "actual-temp",
    );
    if (!actualTemperature) throw new Error("missing actual-temp fixture series");
    const first = actualTemperature.points[0];
    const last = actualTemperature.points.at(-1)!;

    expect(interpolateSeries(actualTemperature, first[0] - 1)).toBeNull();
    expect(interpolateSeries(actualTemperature, first[0])).toBe(first[1]);
    expect(interpolateSeries(actualTemperature, last[0])).toBe(last[1]);
    expect(interpolateSeries(actualTemperature, last[0] + 1)).toBeNull();
  });

  it("places an overflowing tooltip to the left and above the pointer", () => {
    expect(
      placeTooltip(
        { x: 990, y: 590 },
        { width: 1_000, height: 600 },
        { width: 220, height: 154 },
      ),
    ).toEqual({ x: 756, y: 424 });
  });

  it("keeps an oversized tooltip at the minimum container inset", () => {
    expect(
      placeTooltip(
        { x: 50, y: 40 },
        { width: 100, height: 80 },
        { width: 220, height: 154 },
      ),
    ).toEqual({ x: 8, y: 8 });
  });

  it("maps percent endpoints across the complete numeric bounds", () => {
    expect(rangeFromPercent({ start: 0, end: 1_000 }, 25, 75)).toEqual({
      start: 250,
      end: 750,
    });
  });

  it.each([
    ["NaN start percent", { start: 0, end: 1_000 }, Number.NaN, 75],
    ["infinite end percent", { start: 0, end: 1_000 }, 25, Number.POSITIVE_INFINITY],
    ["NaN bounds start", { start: Number.NaN, end: 1_000 }, 25, 75],
    ["infinite bounds end", { start: 0, end: Number.POSITIVE_INFINITY }, 25, 75],
  ])("rejects %s", (_label, bounds, startPercent, endPercent) => {
    expect(() => rangeFromPercent(bounds, startPercent, endPercent)).toThrow(
      "图表范围与百分比必须是有限数值",
    );
  });

  it("rejects reversed numeric bounds", () => {
    expect(() => rangeFromPercent({ start: 1_000, end: 0 }, 25, 75)).toThrow(
      "图表范围起点不能晚于终点",
    );
  });
});
