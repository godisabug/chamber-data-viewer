import { describe, expect, it } from "vitest";
import { interpolateSeries } from "./chartInteraction";
import {
  SERIES_BACKGROUND_OPACITY,
  hasVisibleData,
  prepareDataset,
  semanticSeriesVisual,
  visiblePointsForRange,
  type PreparedDataset,
  type PreparedPoint,
} from "./chartSeries";
import { makeDataset } from "./test/fixtures";
import type { DataPoint } from "./types";

function formatLocalTimestamp(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function prepareVisibilityDataset(
  values: Array<number | null>,
): PreparedDataset {
  const baseTime = new Date(2026, 0, 1).getTime();
  return prepareDataset(
    makeDataset({
      timeRange: {
        start: formatLocalTimestamp(baseTime),
        end: formatLocalTimestamp(baseTime + (values.length - 1) * 1_000),
      },
      rowCount: values.length,
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
          points: values.map(
            (value, index) =>
              [
                formatLocalTimestamp(baseTime + index * 1_000),
                value,
              ] as DataPoint,
          ),
        },
      ],
    }),
  );
}

describe("prepareDataset", () => {
  it("removes an unused secondary axis when a file only contains temperature data", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: raw.series.filter((series) => series.axisId === "primary"),
    });

    expect(prepared.axes).toEqual([
      { id: "primary", role: "primary", name: "温度", unit: "degC" },
    ]);
  });

  it("treats an all-invalid humidity group as absent when temperature remains valid", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: raw.series.map((series) =>
        series.axisId === "secondary"
          ? {
              ...series,
              points: series.points.map(([timestamp]) => [timestamp, null]),
            }
          : series,
      ),
    });

    expect(prepared.axes).toEqual([
      { id: "primary", role: "primary", name: "温度", unit: "degC" },
    ]);
    expect(prepared.series.map((series) => series.id)).toEqual([
      "actual-temp",
      "set-temp",
    ]);
  });

  it("keeps a measured-only data group when its setpoint is invalid", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: raw.series.map((series) =>
        series.id === "set-humidity"
          ? {
              ...series,
              points: series.points.map(([timestamp]) => [timestamp, null]),
            }
          : series,
      ),
    });

    expect(prepared.axes).toEqual(raw.axes);
    expect(prepared.series.map((series) => series.id)).toEqual([
      "actual-temp",
      "set-temp",
      "actual-humidity",
    ]);
  });

  it("keeps a setpoint-only data group when it forms a visible line", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: raw.series.map((series) =>
        series.id === "actual-humidity"
          ? {
              ...series,
              points: series.points.map(([timestamp]) => [timestamp, null]),
            }
          : series,
      ),
    });

    expect(prepared.axes).toEqual(raw.axes);
    expect(prepared.series.map((series) => series.id)).toEqual([
      "actual-temp",
      "set-temp",
      "set-humidity",
    ]);
  });

  it("does not treat one isolated numeric sample as a visible data group", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: raw.series.map((series) => {
        if (series.id === "actual-humidity") {
          return {
            ...series,
            points: series.points.map(([timestamp]) => [timestamp, null]),
          };
        }
        if (series.id === "set-humidity") {
          return {
            ...series,
            points: series.points.map(([timestamp], index) => [
              timestamp,
              index === 0 ? 3.77 : null,
            ]),
          };
        }
        return series;
      }),
    });

    expect(prepared.axes).toEqual([
      { id: "primary", role: "primary", name: "温度", unit: "degC" },
    ]);
    expect(prepared.series.map((series) => series.id)).toEqual([
      "actual-temp",
      "set-temp",
    ]);
  });

  it("keeps sparse values at distinct timestamps without bridging their gap", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: raw.series.map((series) => {
        if (series.axisId !== "secondary") return series;
        if (series.id === "actual-humidity") {
          return {
            ...series,
            points: series.points.map(([timestamp]) => [timestamp, null]),
          };
        }
        return {
          ...series,
          points: [
            ["2026-01-01 00:00:00", 40],
            ["2026-01-01 00:05:00", null],
            ["2026-01-01 00:10:00", 60],
          ],
        };
      }),
    });

    expect(prepared.axes).toEqual(raw.axes);
    expect(prepared.series.map((series) => series.id)).toEqual([
      "actual-temp",
      "set-temp",
      "set-humidity",
    ]);
    expect(
      prepared.series.find((series) => series.id === "set-humidity")?.points,
    ).toEqual([
      [new Date(2026, 0, 1, 0, 0).getTime(), 40],
      [new Date(2026, 0, 1, 0, 5).getTime(), null],
      [new Date(2026, 0, 1, 0, 10).getTime(), 60],
    ]);
  });

  it("deduplicates timestamps before deciding whether a curve is visible", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: raw.series.map((series) => {
        if (series.axisId !== "secondary") return series;
        if (series.id === "actual-humidity") {
          return {
            ...series,
            points: series.points.map(([timestamp]) => [timestamp, null]),
          };
        }
        return {
          ...series,
          points: [
            ["2026-01-01 00:00:00", 40],
            ["2026-01-01 00:00:00", 60],
          ],
        };
      }),
    });

    expect(prepared.axes.map((axis) => axis.id)).toEqual(["primary"]);
    expect(prepared.series.map((series) => series.id)).toEqual([
      "actual-temp",
      "set-temp",
    ]);
  });

  it("does not combine unrelated singleton curves into a data group", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: raw.series.map((series) => {
        if (series.id === "actual-humidity") {
          return {
            ...series,
            points: series.points.map(([timestamp], index) => [
              timestamp,
              index === 0 ? 55 : null,
            ]),
          };
        }
        if (series.id === "set-humidity") {
          return {
            ...series,
            points: series.points.map(([timestamp], index) => [
              timestamp,
              index === 1 ? 60 : null,
            ]),
          };
        }
        return series;
      }),
    });

    expect(prepared.axes.map((axis) => axis.id)).toEqual(["primary"]);
    expect(prepared.series.map((series) => series.id)).toEqual([
      "actual-temp",
      "set-temp",
    ]);
  });

  it("keeps one valid sample when the complete data file has only one row", () => {
    const raw = makeDataset();
    const setHumidity = raw.series.find(
      (series) => series.id === "set-humidity",
    );
    if (!setHumidity) throw new Error("missing set-humidity fixture series");

    const prepared = prepareDataset({
      ...raw,
      rowCount: 1,
      timeRange: {
        start: "2026-01-01 00:00:00",
        end: "2026-01-01 00:00:00",
      },
      series: [
        {
          ...setHumidity,
          points: [["2026-01-01 00:00:00", 60]],
        },
      ],
    });

    expect(prepared.axes).toEqual([
      { id: "secondary", role: "primary", name: "湿度", unit: "%RH" },
    ]);
    expect(prepared.series.map((series) => series.id)).toEqual([
      "set-humidity",
    ]);
  });

  it("promotes a sole humidity data group from the secondary to the primary axis", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: raw.series.filter((series) => series.axisId === "secondary"),
    });

    expect(prepared.axes).toEqual([
      { id: "secondary", role: "primary", name: "湿度", unit: "%RH" },
    ]);
    expect(
      new Set(prepared.series.map((series) => series.axisId)),
    ).toEqual(new Set(["secondary"]));
  });

  it("promotes any sole physical data group instead of special-casing humidity", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      axes: [
        ...raw.axes,
        { id: "pressure", role: "secondary", name: "气压", unit: "kPa" },
      ],
      series: [
        {
          id: "actual-pressure",
          name: "实测气压",
          unit: "kPa",
          role: "measured",
          axisId: "pressure",
          points: raw.series[0].points,
        },
      ],
    });

    expect(prepared.axes).toEqual([
      { id: "pressure", role: "primary", name: "气压", unit: "kPa" },
    ]);
  });

  it("keeps the declared multi-axis contract when more than one data group exists", () => {
    const raw = makeDataset();
    const prepared = prepareDataset(raw);

    expect(prepared.axes).toEqual(raw.axes);
  });

  it("orders series by axis and semantic role while converting point times to numbers", () => {
    const dataset = prepareDataset(makeDataset());

    expect(dataset.series.map((series) => series.id)).toEqual([
      "actual-temp",
      "set-temp",
      "actual-humidity",
      "set-humidity",
    ]);
    for (const series of dataset.series) {
      for (const [time] of series.points) {
        expect(typeof time).toBe("number");
      }
    }
  });

  it("caches each series full numeric value extent while ignoring null gaps", () => {
    const raw = makeDataset();
    const actualTemperature = raw.series.find(
      (series) => series.id === "actual-temp",
    );
    if (!actualTemperature) throw new Error("missing actual-temp fixture series");
    actualTemperature.points = [
      ["2026-01-01 00:00:00", null],
      ["2026-01-01 00:05:00", -5],
      ["2026-01-01 00:10:00", 12],
    ];

    const prepared = prepareDataset(raw).series.find(
      (series) => series.id === "actual-temp",
    );

    expect(prepared?.valueExtent).toEqual([-5, 12]);
  });

  it("omits a curve when it contains no effective numeric values", () => {
    const raw = makeDataset();
    const actualTemperature = raw.series.find(
      (series) => series.id === "actual-temp",
    );
    if (!actualTemperature) throw new Error("missing actual-temp fixture series");
    actualTemperature.points = [
      ["2026-01-01 00:00:00", null],
      ["2026-01-01 00:10:00", null],
    ];

    const prepared = prepareDataset(raw).series.find(
      (series) => series.id === "actual-temp",
    );

    expect(prepared).toBeUndefined();
  });

  it("rejects duplicate series ids", () => {
    const raw = makeDataset();

    expect(() =>
      prepareDataset({
        ...raw,
        series: [
          { ...raw.series[0], id: "duplicate" },
          { ...raw.series[1], id: "duplicate" },
        ],
      }),
    ).toThrow("数据集存在重复的曲线 ID：duplicate");
  });

  it("allows distinct series ids to share a business name", () => {
    const raw = makeDataset();
    const prepared = prepareDataset({
      ...raw,
      series: [
        { ...raw.series[0], id: "series-a", name: "同名曲线" },
        { ...raw.series[1], id: "series-b", name: "同名曲线" },
      ],
    });

    expect(prepared.series.map((series) => series.name)).toEqual([
      "同名曲线",
      "同名曲线",
    ]);
    expect(prepared.series.map((series) => series.id).sort()).toEqual([
      "series-a",
      "series-b",
    ]);
  });

  it("sorts prepared points by time before interpolation", () => {
    const raw = makeDataset();
    const rawActualTemperature = raw.series.find(
      (series) => series.id === "actual-temp",
    );
    if (!rawActualTemperature) throw new Error("missing actual-temp fixture series");
    rawActualTemperature.points = [
      ["2026-01-01 00:20:00", 200],
      ["2026-01-01 00:00:00", 0],
      ["2026-01-01 00:10:00", 10],
    ];

    const actualTemperature = prepareDataset(raw).series.find(
      (series) => series.id === "actual-temp",
    );

    expect(actualTemperature).toBeDefined();
    expect(actualTemperature!.points.map(([time]) => time)).toEqual(
      [...actualTemperature!.points.map(([time]) => time)].sort(
        (left, right) => left - right,
      ),
    );
    expect(
      interpolateSeries(
        actualTemperature!,
        new Date(2026, 0, 1, 0, 15).getTime(),
      ),
    ).toBe(105);
  });

  it("keeps the last raw value for a duplicate timestamp", () => {
    const raw = makeDataset();
    const rawActualTemperature = raw.series.find(
      (series) => series.id === "actual-temp",
    );
    if (!rawActualTemperature) throw new Error("missing actual-temp fixture series");
    rawActualTemperature.points = [
      ["2026-01-01 00:00:00", 10],
      ["2026-01-01 00:00:00", 15],
    ];

    const actualTemperature = prepareDataset(raw).series.find(
      (series) => series.id === "actual-temp",
    );
    if (!actualTemperature) throw new Error("missing prepared actual-temp series");

    expect(actualTemperature.points).toHaveLength(1);
    expect(actualTemperature.valueExtent).toEqual([15, 15]);
    expect(
      interpolateSeries(
        actualTemperature,
        new Date(2026, 0, 1, 0, 0).getTime(),
      ),
    ).toBe(15);
  });

  it("preserves distinct subsecond points as numeric timestamps", () => {
    const raw = makeDataset();
    const actualTemperature = raw.series.find(
      (series) => series.id === "actual-temp",
    );
    if (!actualTemperature) throw new Error("missing actual-temp fixture series");
    actualTemperature.points = [
      ["2026-01-01 00:00:00.000", 24],
      ["2026-01-01 00:00:00.500", 25],
    ];

    const prepared = prepareDataset(raw).series.find(
      (series) => series.id === "actual-temp",
    );
    if (!prepared) throw new Error("missing prepared actual-temp series");

    expect(prepared.points).toHaveLength(2);
    expect(prepared.points[1][0] - prepared.points[0][0]).toBe(500);
  });

  it("rejects invalid point timestamps with series and point context", () => {
    const raw = makeDataset();
    const invalidSeries = raw.series.map((series) =>
      series.id === "actual-temp"
        ? {
            ...series,
            points: [["2026-02-30 00:00:00", 24] as DataPoint],
          }
        : series,
    );

    expect(() => prepareDataset({ ...raw, series: invalidSeries })).toThrow(
      "曲线 实测温度 的第 0 个数据点时间无效",
    );
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "rejects a non-finite %s point value with series and point context",
    (_label, invalidValue) => {
      const raw = makeDataset();
      const invalidSeries = raw.series.map((series) =>
        series.id === "actual-temp"
          ? {
              ...series,
              points: [
                ["2026-01-01 00:00:00", invalidValue] as DataPoint,
              ],
            }
          : series,
      );

      expect(() => prepareDataset({ ...raw, series: invalidSeries })).toThrow(
        "曲线 实测温度 的第 0 个数据点数值无效",
      );
    },
  );
});

describe("visiblePointsForRange", () => {
  it("keeps one point on both sides of the visible window", () => {
    const points: PreparedPoint[] = [
      [0, 0],
      [10, 10],
      [20, 20],
    ];

    expect(visiblePointsForRange(points, 5, 15)).toEqual(points);
  });

  it("keeps both crossing endpoints when the window contains no points", () => {
    const points: PreparedPoint[] = [
      [0, 0],
      [10, 20],
    ];

    expect(visiblePointsForRange(points, 2, 8)).toEqual(points);
  });

  it("keeps exact boundary points without duplicating them", () => {
    const points: PreparedPoint[] = [
      [0, 0],
      [10, 10],
      [20, 20],
    ];

    expect(visiblePointsForRange(points, 10, 10)).toEqual(points);
    expect(visiblePointsForRange(points, 0, 20)).toEqual(points);
    expect(visiblePointsForRange(points, -10, -1)).toEqual([[0, 0]]);
    expect(visiblePointsForRange(points, 21, 30)).toEqual([[20, 20]]);
  });

  it("preserves a null neighbor that prevents a ghost line", () => {
    const points: PreparedPoint[] = [
      [0, 0],
      [10, null],
      [20, 20],
      [30, 30],
    ];

    expect(visiblePointsForRange(points, 20, 30)).toEqual([
      [10, null],
      [20, 20],
      [30, 30],
    ]);
  });

  it("uses logarithmic point reads for a large sorted series", () => {
    const pointCount = 100_000;
    const points = Array.from(
      { length: pointCount },
      (_, index) => [index, index] as PreparedPoint,
    );
    let numericIndexReads = 0;
    const observedPoints = new Proxy(points, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) {
          numericIndexReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      visiblePointsForRange(
        observedPoints,
        pointCount - 9.75,
        pointCount - 9.25,
      ),
    ).toEqual([
      [pointCount - 10, pointCount - 10],
      [pointCount - 9, pointCount - 9],
    ]);
    expect(numericIndexReads).toBeLessThan(100);
  });

  it("returns no data for an empty or reversed input", () => {
    expect(visiblePointsForRange([], 0, 10)).toEqual([]);
    expect(visiblePointsForRange([[0, 0]], 10, 0)).toEqual([]);
  });
});

describe("semanticSeriesVisual", () => {
  const dataset = prepareDataset(makeDataset());
  const primaryAxis = dataset.axes.find((axis) => axis.id === "primary")!;
  const actualTemperature = dataset.series.find(
    (series) => series.id === "actual-temp",
  )!;
  const setTemperature = dataset.series.find(
    (series) => series.id === "set-temp",
  )!;

  it("uses the primary measured and setpoint visual hierarchy", () => {
    expect(semanticSeriesVisual(actualTemperature, primaryAxis, 0, null)).toEqual({
      color: "#1c69d4",
      width: 2.8,
      opacity: 1,
      z: 2,
    });
    expect(semanticSeriesVisual(setTemperature, primaryAxis, 0, null)).toEqual({
      color: "#4a86dc",
      width: 1.8,
      opacity: 0.86,
      z: 3,
    });
  });

  it("emphasizes the previewed actual series and fades other setpoints", () => {
    expect(
      semanticSeriesVisual(
        actualTemperature,
        primaryAxis,
        0,
        "actual-temp",
      ).width,
    ).toBe(3.2);
    expect(
      semanticSeriesVisual(
        setTemperature,
        primaryAxis,
        0,
        "actual-temp",
      ).opacity,
    ).toBe(0.2);
  });

  it("dims nonlocked axis context without changing width or hit-test layering", () => {
    const dimmedActual = semanticSeriesVisual(
      actualTemperature,
      primaryAxis,
      0,
      null,
      true,
    );
    const dimmedSetpoint = semanticSeriesVisual(
      setTemperature,
      primaryAxis,
      0,
      null,
      true,
    );

    expect(dimmedActual).toMatchObject({
      width: 2.8,
      opacity: SERIES_BACKGROUND_OPACITY,
      z: 2,
    });
    expect(dimmedSetpoint).toMatchObject({
      width: 1.8,
      opacity: SERIES_BACKGROUND_OPACITY,
      z: 3,
    });
  });

  it("lets a legend preview override persistent axis-lock dimming", () => {
    expect(
      semanticSeriesVisual(
        actualTemperature,
        primaryAxis,
        0,
        "actual-temp",
        true,
      ),
    ).toMatchObject({ width: 3.2, opacity: 1 });
    expect(
      semanticSeriesVisual(
        setTemperature,
        primaryAxis,
        0,
        "actual-temp",
        true,
      ).opacity,
    ).toBe(0.2);
  });

  it("gives the third axis its own hue family", () => {
    const secondaryAxis = dataset.axes.find(
      (axis) => axis.id === "secondary",
    )!;
    expect(
      semanticSeriesVisual(actualTemperature, secondaryAxis, 2, null).color,
    ).toBe("#0f6f78");
    expect(
      semanticSeriesVisual(setTemperature, secondaryAxis, 2, null).color,
    ).toBe("#5f8f94");
    expect(
      semanticSeriesVisual(actualTemperature, secondaryAxis, 1, null).color,
    ).toBe("#262626");
  });
});

describe("hasVisibleData", () => {
  const datasetWithPoints = (points: PreparedPoint[]): PreparedDataset => {
    const prepared = prepareDataset(makeDataset());
    const actualTemperature = prepared.series.find(
      (series) => series.id === "actual-temp",
    )!;
    return {
      ...prepared,
      series: [
        {
          ...actualTemperature,
          points,
          valueExtent: points.reduce<[number, number] | null>(
            (extent, [, value]) => {
              if (value === null || !Number.isFinite(value)) return extent;
              return extent
                ? [Math.min(extent[0], value), Math.max(extent[1], value)]
                : [value, value];
            },
            null,
          ),
        },
      ],
    };
  };

  it("detects a crossing segment when the x window contains no points", () => {
    const prepared = datasetWithPoints([
      [0, 0],
      [10, 10],
    ]);
    const range = { start: 2, end: 8 };

    expect(
      hasVisibleData(prepared, new Set(["actual-temp"]), range, {}),
    ).toBe(true);
    expect(
      hasVisibleData(prepared, new Set(["actual-temp"]), range, {
        primary: { min: 4, max: 6 },
      }),
    ).toBe(true);
  });

  it("rejects a crossing x segment that misses the manual y range", () => {
    const prepared = datasetWithPoints([
      [0, 0],
      [10, 10],
    ]);

    expect(
      hasVisibleData(
        prepared,
        new Set(["actual-temp"]),
        { start: 2, end: 8 },
        { primary: { min: 30, max: 40 } },
      ),
    ).toBe(false);
  });

  it("detects a segment between two in-window points crossing manual y bounds", () => {
    const prepared = datasetWithPoints([
      [2, -10],
      [8, 20],
    ]);

    expect(
      hasVisibleData(
        prepared,
        new Set(["actual-temp"]),
        { start: 0, end: 10 },
        { primary: { min: 0, max: 10 } },
      ),
    ).toBe(true);
  });

  it("rejects in-window points and segments fully outside one y side", () => {
    const prepared = datasetWithPoints([
      [2, -10],
      [8, -5],
    ]);

    expect(
      hasVisibleData(
        prepared,
        new Set(["actual-temp"]),
        { start: 0, end: 10 },
        { primary: { min: 0, max: 10 } },
      ),
    ).toBe(false);
  });

  it("does not treat a null gap as visible line geometry", () => {
    const prepared = datasetWithPoints([
      [0, 0],
      [10, null],
    ]);

    expect(
      hasVisibleData(
        prepared,
        new Set(["actual-temp"]),
        { start: 2, end: 8 },
        {},
      ),
    ).toBe(false);
  });

  it("ignores visible geometry from a hidden series", () => {
    const prepared = datasetWithPoints([
      [0, 0],
      [10, 10],
    ]);

    expect(
      hasVisibleData(prepared, new Set(), { start: 2, end: 8 }, {}),
    ).toBe(false);
  });

  it("returns false when visible points are outside the configured axis bounds", () => {
    const dataset = prepareDataset(makeDataset());
    const range = {
      start: new Date(dataset.timeRange.start.replace(" ", "T")).getTime(),
      end: new Date(dataset.timeRange.end.replace(" ", "T")).getTime(),
    };

    expect(
      hasVisibleData(dataset, new Set(["actual-temp"]), range, {
        primary: { min: 100, max: 110 },
      }),
    ).toBe(false);
  });

  it("rejects a globally excluded manual y range without scanning every point", () => {
    const pointCount = 100_000;
    const points = Array.from(
      { length: pointCount },
      (_, index) => [index, index % 2] as PreparedPoint,
    );
    let numericIndexReads = 0;
    const observedPoints = new Proxy(points, {
      get(target, property, receiver) {
        if (
          typeof property === "string" &&
          /^(0|[1-9]\d*)$/.test(property)
        ) {
          numericIndexReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const prepared = prepareDataset(makeDataset());
    const actualTemperature = prepared.series.find(
      (series) => series.id === "actual-temp",
    )!;
    const largeDataset: PreparedDataset = {
      ...prepared,
      series: [
        {
          ...actualTemperature,
          points: observedPoints,
          valueExtent: [0, 1],
        },
      ],
    };

    expect(
      hasVisibleData(
        largeDataset,
        new Set([actualTemperature.id]),
        { start: 0, end: pointCount - 1 },
        { primary: { min: 100, max: 110 } },
      ),
    ).toBe(false);
    expect(numericIndexReads).toBeLessThan(100);
  });

  it("uses the prepared visibility index when only the current x window misses y", () => {
    const pointCount = 65_537;
    const baseTime = new Date(2026, 0, 1).getTime();
    const formatLocalTimestamp = (time: number): string => {
      const date = new Date(time);
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };
    const raw = makeDataset({
      timeRange: {
        start: formatLocalTimestamp(baseTime),
        end: formatLocalTimestamp(baseTime + (pointCount - 1) * 1_000),
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
                formatLocalTimestamp(baseTime + index * 1_000),
                index === pointCount - 1 ? 100 : 0,
              ] as DataPoint,
          ),
        },
      ],
    });
    const prepared = prepareDataset(raw);
    const series = prepared.series[0];
    let pointFieldReads = 0;
    for (let index = 0; index < series.points.length; index += 1) {
      series.points[index] = new Proxy(series.points[index], {
        get(target, property, receiver) {
          if (property === "0" || property === "1") pointFieldReads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
    }

    expect(
      hasVisibleData(
        prepared,
        new Set([series.id]),
        {
          start: baseTime,
          end: baseTime + (pointCount - 2) * 1_000,
        },
        { primary: { min: 50, max: 60 } },
      ),
    ).toBe(false);
    expect(pointFieldReads).toBeLessThan(4_096);
  });

  it("does not join null-separated indexed runs across the manual y range", () => {
    const prepared = prepareVisibilityDataset(
      Array.from({ length: 160 }, (_, index) => {
        if (index % 4 === 0) return -10;
        if (index % 4 === 2) return 10;
        return null;
      }),
    );
    const series = prepared.series[0];

    expect(
      hasVisibleData(
        prepared,
        new Set([series.id]),
        {
          start: series.points[0][0],
          end: series.points.at(-1)![0],
        },
        { primary: { min: -1, max: 1 } },
      ),
    ).toBe(false);
  });

  it("matches the zero-allocation brute scan for deterministic indexed queries", () => {
    let seed = 0x9e3779b9;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const values = Array.from({ length: 192 }, () => {
      if (random() < 0.22) return null;
      return Math.round((random() * 40 - 20) * 10) / 10;
    });
    const indexed = prepareVisibilityDataset(values);
    const brute: PreparedDataset = {
      ...indexed,
      series: indexed.series.map((series) => ({
        ...series,
        points: [...series.points],
      })),
    };
    const series = indexed.series[0];
    const firstTime = series.points[0][0];

    for (let iteration = 0; iteration < 80; iteration += 1) {
      const leftIndex = Math.floor(random() * 180);
      const width = 1 + Math.floor(random() * (192 - leftIndex));
      const start = firstTime + leftIndex * 1_000 + (random() < 0.5 ? 0 : 250);
      const end = Math.min(
        series.points.at(-1)![0],
        firstTime + (leftIndex + width) * 1_000 - (random() < 0.5 ? 0 : 250),
      );
      if (start > end) continue;
      const yStart = Math.round((random() * 44 - 22) * 10) / 10;
      const yEnd = yStart + Math.round(random() * 80) / 10;
      const range = { start, end };
      const axes = { primary: { min: yStart, max: yEnd } };
      const visibleSeries = new Set([series.id]);

      expect(
        hasVisibleData(indexed, visibleSeries, range, axes),
      ).toBe(hasVisibleData(brute, visibleSeries, range, axes));
    }
  });

  it.each([
    ["time", [Number.NaN, 24] as PreparedPoint],
    ["value", [new Date("2026-01-01T00:00:00").getTime(), Number.NaN] as PreparedPoint],
  ])("ignores a manually prepared point with non-finite %s", (_field, point) => {
    const prepared = prepareDataset(makeDataset());
    const actualTemperature = prepared.series.find(
      (series) => series.id === "actual-temp",
    )!;
    const invalidDataset: PreparedDataset = {
      ...prepared,
      series: [{ ...actualTemperature, points: [point] }],
    };

    expect(
      hasVisibleData(
        invalidDataset,
        new Set(["actual-temp"]),
        {
          start: new Date("2026-01-01T00:00:00").getTime(),
          end: new Date("2026-01-01T00:10:00").getTime(),
        },
        {},
      ),
    ).toBe(false);
  });

  it("seeks near the visible range before scanning sorted points", () => {
    const pointCount = 50_000;
    const points = Array.from(
      { length: pointCount },
      (_, index) => [index, index] as PreparedPoint,
    );
    let numericIndexReads = 0;
    const observedPoints = new Proxy(points, {
      get(target, property, receiver) {
        if (
          typeof property === "string" &&
          /^(0|[1-9]\d*)$/.test(property)
        ) {
          numericIndexReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const prepared = prepareDataset(makeDataset());
    const actualTemperature = prepared.series.find(
      (series) => series.id === "actual-temp",
    )!;
    const largeDataset: PreparedDataset = {
      ...prepared,
      series: [{ ...actualTemperature, points: observedPoints }],
    };

    expect(
      hasVisibleData(
        largeDataset,
        new Set([actualTemperature.id]),
        { start: pointCount - 100, end: pointCount - 1 },
        { primary: { min: pointCount, max: pointCount + 100 } },
      ),
    ).toBe(false);
    expect(numericIndexReads).toBeLessThan(200);
  });
});
