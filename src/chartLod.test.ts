import { describe, expect, it } from "vitest";
import {
  buildLodWindow,
  containsRange,
  expandRange,
  lodHardPointBudget,
  lodPointBudget,
  selectLodPoints,
} from "./chartLod";
import {
  prepareDataset,
  type PreparedDataset,
  type PreparedPoint,
} from "./chartSeries";
import { makeDataset } from "./test/fixtures";
import type { DataPoint } from "./types";

const points = (values: Array<number | null>): PreparedPoint[] =>
  values.map((value, index) => [index, value]);

function singleSeriesDataset(seriesPoints: PreparedPoint[]): PreparedDataset {
  const dataset = prepareDataset(makeDataset());
  const numericValues = seriesPoints.flatMap(([, value]) =>
    value === null ? [] : [value],
  );
  return {
    ...dataset,
    series: [
      {
        ...dataset.series[0],
        points: seriesPoints,
        valueExtent:
          numericValues.length === 0
            ? null
            : [Math.min(...numericValues), Math.max(...numericValues)],
      },
    ],
  };
}

function formatLocalTimestamp(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function preparedNumericDataset(pointCount: number): PreparedDataset {
  const start = new Date(2026, 0, 1).getTime();
  return prepareDataset(
    makeDataset({
      timeRange: {
        start: formatLocalTimestamp(start),
        end: formatLocalTimestamp(start + (pointCount - 1) * 1_000),
      },
      rowCount: pointCount,
      axes: [
        { id: "primary", role: "primary", name: "温度", unit: "degC" },
      ],
      series: [
        {
          id: "actual-temp",
          name: "实测温度",
          unit: "degC",
          role: "measured",
          axisId: "primary",
          points: Array.from(
            { length: pointCount },
            (_, index) =>
              [
                formatLocalTimestamp(start + index * 1_000),
                Math.sin(index / 17),
              ] as DataPoint,
          ),
        },
      ],
    }),
  );
}

function expectNoGhostConnections(
  source: PreparedPoint[],
  selected: PreparedPoint[],
): void {
  const sourceIndex = new Map(source.map((point, index) => [point, index]));
  const runIds = new Int32Array(source.length);
  let runId = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (index > 0 && (source[index][1] === null) !== (source[index - 1][1] === null)) {
      runId += 1;
    }
    runIds[index] = runId;
  }
  let previousNumericIndex: number | null = null;
  let sawNull = true;
  for (const point of selected) {
    const index = sourceIndex.get(point)!;
    if (point[1] === null) {
      sawNull = true;
      continue;
    }
    if (previousNumericIndex !== null && !sawNull) {
      expect(runIds[index]).toBe(runIds[previousNumericIndex]);
    }
    previousNumericIndex = index;
    sawNull = false;
  }
}

describe("chart pixel LOD", () => {
  it("uses the 4/2/1 pixel quality ladder at 942 CSS pixels", () => {
    expect(lodPointBudget(942, "interactive")).toBe(946);
    expect(lodPointBudget(942, "interactive", 2)).toBe(946);
    expect(lodPointBudget(942, "settled")).toBe(1_886);
    expect(lodPointBudget(942, "export")).toBe(3_770);
    expect(lodPointBudget(942, "export", 2)).toBe(7_538);
  });

  it("returns no budget or points for invalid geometry", () => {
    expect(lodPointBudget(0, "settled")).toBe(0);
    expect(lodPointBudget(Number.NaN, "settled")).toBe(0);
    expect(lodPointBudget(100, "settled", 0)).toBe(0);
    expect(
      selectLodPoints(points([1, 2]), { start: 1, end: 1 }, 100, "settled"),
    ).toEqual([]);
    expect(
      selectLodPoints(points([1, 2]), { start: 0, end: 1 }, 0, "settled"),
    ).toEqual([]);
  });

  it("keeps both ends of short rising and falling numeric islands", () => {
    const source = Array.from(
      { length: 201 },
      (_, index) => {
        let value: number | null = null;
        if (index >= 71 && index <= 76) value = 10 + (index - 71) * 3;
        if (index >= 121 && index <= 126) value = 40 - (index - 121) * 4;
        return [index, value] as PreparedPoint;
      },
    );
    const selected = selectLodPoints(
      source,
      { start: 0, end: 200 },
      1,
      "interactive",
    );

    expect(selected).toContain(source[71]);
    expect(selected).toContain(source[76]);
    expect(selected).toContain(source[121]);
    expect(selected).toContain(source[126]);
  });

  it("keeps short rising and falling endpoints in overlapping zoom ranges", () => {
    const source = Array.from(
      { length: 201 },
      (_, index) => {
        if (index === 70 || index === 77) return [index, null] as PreparedPoint;
        if (index > 70 && index < 77) {
          return [index, 10 + (index - 71) * 3] as PreparedPoint;
        }
        return [index, Math.sin(index)] as PreparedPoint;
      },
    );

    for (const range of [
      { start: 0, end: 200 },
      { start: 40, end: 140 },
    ]) {
      const selected = selectLodPoints(source, range, 1, "settled");
      expect(selected).toContain(source[71]);
      expect(selected).toContain(source[76]);
    }
  });

  it("keeps first, minimum, maximum, and last representatives in order", () => {
    const source: PreparedPoint[] = [
      [0, 5],
      [1, 1],
      [2, 9],
      [3, 4],
      [4, 6],
      [5, 2],
      [6, 8],
      [7, 3],
    ];

    expect(
      selectLodPoints(source, { start: 0, end: 7 }, 1, "interactive"),
    ).toEqual([source[0], source[1], source[2], source[7]]);
  });

  it("retains null markers and numeric shores so gaps never reconnect", () => {
    const source: PreparedPoint[] = [
      [0, -10],
      [1, null],
      [2, null],
      [3, 10],
      [4, 20],
      [5, null],
      [6, -20],
    ];
    const selected = selectLodPoints(
      source,
      { start: 0, end: 6 },
      1,
      "interactive",
    );

    expect(selected.filter(([, value]) => value === null)).toHaveLength(2);
    expect(selected).toContain(source[0]);
    expect(selected).toContain(source[3]);
    expect(selected).toContain(source[4]);
    expect(selected).toContain(source[6]);
  });

  it("retains one point outside each window boundary including a null shore", () => {
    const source: PreparedPoint[] = [
      [0, 0],
      [10, null],
      [20, 20],
      [30, 30],
      [40, 40],
    ];

    expect(
      selectLodPoints(source, { start: 20, end: 30 }, 100, "settled"),
    ).toEqual([source[1], source[2], source[3], source[4]]);
  });

  it("strictly bounds ordinary numeric output for every quality", () => {
    const source = Array.from(
      { length: 100_000 },
      (_, index) => [index, Math.sin(index / 10)] as PreparedPoint,
    );

    for (const quality of ["interactive", "settled", "export"] as const) {
      const selected = selectLodPoints(
        source,
        { start: 0, end: source.length - 1 },
        942,
        quality,
      );
      expect(selected.length).toBeLessThanOrEqual(
        lodPointBudget(942, quality),
      );
      const indexes = selected.map(([time]) => time);
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
      expect(new Set(indexes).size).toBe(indexes.length);
    }
  });

  it("buckets representatives by time instead of source-array position", () => {
    const source: PreparedPoint[] = [
      [0, 50],
      [1, 5],
      [2, 90],
      [3, -90],
      [4, 10],
      [5, 11],
      [6, 12],
      [7, 13],
      [8, 14],
      [9, 60],
      [90, 40],
      [100, 41],
    ];
    const selected = selectLodPoints(
      source,
      { start: 0, end: 100 },
      4,
      "settled",
    );

    expect(selected).toEqual([
      source[0],
      source[2],
      source[3],
      source[9],
      source[10],
      source[11],
    ]);
  });

  it("does not move a sparse bucket cursor behind the visible start", () => {
    const source: PreparedPoint[] = [
      [-100, 1],
      [-50, 2],
      [90, 9],
      [99, 10],
      [100, 11],
    ];
    const selected = selectLodPoints(
      source,
      { start: 0, end: 100 },
      4,
      "settled",
    );

    expect(selected).not.toContain(source[0]);
    expect(selected).toContain(source[1]);
    expect(selected).toContain(source[2]);
    expect(selected).toContain(source[4]);
  });

  it("keeps singleton alternating gaps hard-bounded and omits unrenderable runs", () => {
    const source = Array.from(
      { length: 100_000 },
      (_, index) =>
        [index, index % 2 === 0 ? index : null] as PreparedPoint,
    );
    const selected = selectLodPoints(
      source,
      { start: 0, end: source.length - 1 },
      942,
      "settled",
    );
    const hardBudget = lodHardPointBudget(942, "settled");

    expect(selected.length).toBeLessThanOrEqual(hardBudget);
    expect(selected.some(([, value]) => value !== null)).toBe(false);
    expectNoGhostConnections(source, selected);
  });

  it("keeps dense two-point runs drawable without exceeding the hard topology budget", () => {
    const source = Array.from(
      { length: 100_000 },
      (_, index) =>
        [index, index % 3 === 2 ? null : Math.sin(index)] as PreparedPoint,
    );
    const selected = selectLodPoints(
      source,
      { start: 0, end: source.length - 1 },
      942,
      "settled",
    );
    const hardBudget = lodHardPointBudget(942, "settled");

    expect(selected.length).toBeLessThanOrEqual(hardBudget);
    expectNoGhostConnections(source, selected);
    const selectedNumericRuns: number[] = [];
    let currentRunLength = 0;
    for (const [, value] of selected) {
      if (value === null) {
        if (currentRunLength > 0) selectedNumericRuns.push(currentRunLength);
        currentRunLength = 0;
      } else {
        currentRunLength += 1;
      }
    }
    if (currentRunLength > 0) selectedNumericRuns.push(currentRunLength);
    expect(selectedNumericRuns.length).toBeGreaterThan(0);
    expect(selectedNumericRuns.every((length) => length >= 2)).toBe(true);
  });

  it("binary-seeks before scanning a narrow range in a large series", () => {
    const source = Array.from(
      { length: 100_000 },
      (_, index) => [index, index] as PreparedPoint,
    );
    let numericReads = 0;
    const observed = new Proxy(source, {
      get(target, property, receiver) {
        if (
          typeof property === "string" &&
          /^(0|[1-9]\d*)$/.test(property)
        ) {
          numericReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      selectLodPoints(
        observed,
        { start: 99_900, end: 99_999 },
        942,
        "settled",
      ),
    ).toHaveLength(101);
    expect(numericReads).toBeLessThan(400);
  });

  it("prefetches interaction windows, keeps export exact, and caches by dataset", () => {
    const source = Array.from(
      { length: 1_001 },
      (_, index) => [index, Math.sin(index)] as PreparedPoint,
    );
    const dataset = singleSeriesDataset(source);
    const viewport = { start: 400, end: 600 };
    const bounds = { start: 0, end: 1_000 };

    expect(expandRange(viewport)).toEqual({ start: 200, end: 800 });
    expect(containsRange({ start: 200, end: 800 }, viewport)).toBe(true);
    const settled = buildLodWindow(
      dataset,
      viewport,
      bounds,
      942,
      "settled",
    );
    expect(settled.range).toEqual({ start: 200, end: 800 });
    expect(
      buildLodWindow(dataset, viewport, bounds, 942, "settled"),
    ).toBe(settled);
    expect(
      buildLodWindow(dataset, viewport, bounds, 942, "export").range,
    ).toEqual(viewport);
  });

  it("prefetches beyond the data bounds so out-of-range panning stays reusable", () => {
    const source = Array.from(
      { length: 101 },
      (_, index) => [index, Math.sin(index)] as PreparedPoint,
    );
    const dataset = singleSeriesDataset(source);
    const bounds = { start: 0, end: 100 };
    const beyondRight = { start: 140, end: 160 };
    const beyondLeft = { start: -60, end: -40 };

    expect(expandRange(beyondRight)).toEqual({ start: 120, end: 180 });
    expect(containsRange(expandRange(beyondRight), beyondRight)).toBe(true);
    const rightWindow = buildLodWindow(
      dataset,
      beyondRight,
      bounds,
      942,
      "settled",
    );
    expect(containsRange(rightWindow.range, beyondRight)).toBe(true);
    expect(rightWindow.seriesData[0]).toHaveLength(1);

    const leftWindow = buildLodWindow(
      dataset,
      beyondLeft,
      bounds,
      942,
      "settled",
    );
    expect(containsRange(leftWindow.range, beyondLeft)).toBe(true);
    expect(leftWindow.seriesData[0]).toHaveLength(1);
  });

  it("queries multiple prepared viewports without reads proportional to visible rows", () => {
    const dataset = preparedNumericDataset(100_000);
    const series = dataset.series[0];
    let pointFieldReads = 0;
    for (let index = 0; index < series.points.length; index += 1) {
      series.points[index] = new Proxy(series.points[index], {
        get(target, property, receiver) {
          if (property === "0" || property === "1") pointFieldReads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
    }
    const bounds = {
      start: series.points[0][0],
      end: series.points.at(-1)![0],
    };
    const viewports = [
      bounds,
      {
        start: series.points[20_000][0],
        end: series.points[60_000][0],
      },
      bounds,
    ];

    for (const viewport of viewports) {
      pointFieldReads = 0;
      buildLodWindow(dataset, viewport, bounds, 942, "settled");
      expect(pointFieldReads).toBeLessThan(80_000);
    }
  });
});
