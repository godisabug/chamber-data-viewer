// @vitest-environment node

import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { describe, expect, it } from "vitest";
import {
  autoIntegerAlignedExtent,
  buildChartOptions,
  buildChartUpdate,
  createYAxisValueFormatter,
  resolveYAxisExtents,
  type ChartConfig,
  type ChartPresentation,
} from "./chartOptions";
import {
  prepareDataset,
  SERIES_BACKGROUND_OPACITY,
  type PreparedDataset,
} from "./chartSeries";
import { DEFAULT_CHART_SETTINGS } from "./chartSettings";
import { makeDataset } from "./test/fixtures";

const dataset = prepareDataset(makeDataset());
const config: ChartConfig = {
  ...DEFAULT_CHART_SETTINGS,
  xMin: new Date("2026-01-01T00:00:00").getTime(),
  xMax: new Date("2026-01-01T00:10:00").getTime(),
};

function presentationFor(prepared: PreparedDataset): ChartPresentation {
  return {
    visibleSeries: new Set(prepared.series.map((series) => series.id)),
    previewSeriesId: null,
  };
}

const presentation = presentationFor(dataset);

function prepareThreeAxisDataset(): PreparedDataset {
  const raw = makeDataset();
  return prepareDataset({
    ...raw,
    controllerRule: "freud-history-csv-v1",
    axes: [
      { id: "primary", role: "primary", name: "温度", unit: "degC" },
      { id: "secondary", role: "secondary", name: "湿度", unit: "%RH" },
      { id: "pressure", role: "secondary", name: "气压", unit: "kPa" },
    ],
    series: [
      { ...raw.series[0], axisId: "primary", unit: "degC" },
      { ...raw.series[1], axisId: "primary", unit: "degC" },
      { ...raw.series[2], axisId: "secondary", unit: "%RH" },
      { ...raw.series[3], axisId: "secondary", unit: "%RH" },
      {
        id: "actual-pressure",
        name: "实测气压",
        unit: "kPa",
        role: "measured",
        axisId: "pressure",
        points: raw.series[0].points,
      },
      {
        id: "set-pressure",
        name: "设定气压",
        unit: "kPa",
        role: "setpoint",
        axisId: "pressure",
        points: raw.series[1].points,
      },
    ],
  });
}

function prepareOutlierDataset(): PreparedDataset {
  return prepareDataset(
    makeDataset({
      timeRange: {
        start: "2026-01-01 00:00:00",
        end: "2026-01-01 00:20:00",
      },
      rowCount: 3,
      axes: [
        { id: "primary", role: "primary", name: "温度", unit: "degC" },
      ],
      series: [
        {
          id: "base-temp",
          name: "基础温度",
          unit: "degC",
          role: "measured",
          axisId: "primary",
          points: [
            ["2026-01-01 00:00:00", 10],
            ["2026-01-01 00:10:00", 20],
          ],
        },
        {
          id: "outlier-temp",
          name: "窗口外异常值",
          unit: "degC",
          role: "setpoint",
          axisId: "primary",
          points: [["2026-01-01 00:20:00", 1_000]],
        },
      ],
    }),
  );
}

function minuteTimestamp(minute: number): number {
  return new Date(2026, 0, 1, 0, minute).getTime();
}

function prepareSparseDataset(middleValue: number | null = 10): PreparedDataset {
  return prepareDataset(
    makeDataset({
      timeRange: {
        start: "2026-01-01 00:00:00",
        end: "2026-01-01 00:20:00",
      },
      rowCount: 3,
      axes: [
        { id: "primary", role: "primary", name: "温度", unit: "degC" },
      ],
      series: [
        {
          id: "sparse-temp",
          name: "稀疏温度",
          unit: "degC",
          role: "measured",
          axisId: "primary",
          points: [
            ["2026-01-01 00:00:00", 0],
            ["2026-01-01 00:10:00", middleValue],
            ["2026-01-01 00:20:00", 20],
          ],
        },
      ],
    }),
  );
}

function configForMinutes(start: number, end: number): ChartConfig {
  return {
    ...DEFAULT_CHART_SETTINGS,
    xMin: minuteTimestamp(start),
    xMax: minuteTimestamp(end),
  };
}

type RuntimeAxisViewLabel = {
  formattedLabel: string;
  tick: { value: number };
};

type RuntimeAxisTickCoordinate = {
  tickValue: number;
};

type RuntimeRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type RuntimeLayerElement = {
  type: string;
  z: number;
  z2: number;
  style?: {
    stroke?: string;
    lineWidth?: number;
    text?: string;
    font?: string;
  };
  transform?: number[];
  shape?: { x1?: number; y1?: number; x2?: number; y2?: number };
  __clipPaths?: Array<{ shape?: RuntimeRect }>;
  getBoundingRect?: () => RuntimeRect;
};

type RuntimeAxisModel = {
  axis: {
    getTicksCoords: () => RuntimeAxisTickCoordinate[];
    getViewLabels: () => RuntimeAxisViewLabel[];
    scale: {
      getExtent: () => number[];
      isBlank: () => boolean;
    };
  };
  get: (path: string) => unknown;
};

type RuntimeGridModel = {
  coordinateSystem: {
    getRect: () => RuntimeRect;
  };
};

type RuntimeChart = {
  getModel: () => {
    getComponent: {
      (mainType: "xAxis" | "yAxis", index: number): RuntimeAxisModel;
      (mainType: "grid", index?: number): RuntimeGridModel;
    };
    getSeriesByIndex: (index: number) => {
      getData: () => {
        count: () => number;
        get: (dimension: string, index: number) => unknown;
      };
    };
  };
  getZr: () => {
    storage: {
      getDisplayList: (
        update?: boolean,
        includeIgnore?: boolean,
      ) => RuntimeLayerElement[];
    };
  };
  renderToSVGString: () => string;
};

function runtimeChart(chart: ReturnType<typeof echarts.init>): RuntimeChart {
  return chart as unknown as RuntimeChart;
}

function readRuntimeXAxisView(
  chart: ReturnType<typeof echarts.init>,
): { labels: string[]; tickValues: number[] } {
  const viewLabels = runtimeChart(chart)
    .getModel()
    .getComponent("xAxis", 0).axis.getViewLabels();
  return {
    labels: viewLabels.map((item) => item.formattedLabel),
    tickValues: viewLabels.map((item) => item.tick.value),
  };
}

function transformedRect(element: RuntimeLayerElement): RuntimeRect {
  const rect = element.getBoundingRect!();
  const transform = element.transform ?? [1, 0, 0, 1, 0, 0];
  return {
    x: transform[0] * rect.x + transform[2] * rect.y + transform[4],
    y: transform[1] * rect.x + transform[3] * rect.y + transform[5],
    width: rect.width,
    height: rect.height,
  };
}

function hasFiniteLineGeometry(
  element: RuntimeLayerElement,
): element is RuntimeLayerElement & {
  shape: { x1: number; y1: number; x2: number; y2: number };
} {
  const { x1, y1, x2, y2 } = element.shape ?? {};
  return (
    element.type === "line" &&
    [x1, y1, x2, y2].every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  );
}

function nativeAxisPointerLines(
  chart: ReturnType<typeof echarts.init>,
): Array<RuntimeLayerElement & {
  shape: { x1: number; y1: number; x2: number; y2: number };
}> {
  return runtimeChart(chart)
    .getZr()
    .storage.getDisplayList(true, false)
    .filter(
      (
        element,
      ): element is RuntimeLayerElement & {
        shape: { x1: number; y1: number; x2: number; y2: number };
      } => {
        const { x1, y1, x2, y2 } = element.shape ?? {};
        return (
          element.type === "Line" &&
          element.style?.stroke === "rgba(117, 117, 117, 0.42)" &&
          element.style?.lineWidth === 1 &&
          [x1, y1, x2, y2].every(
            (coordinate) =>
              typeof coordinate === "number" && Number.isFinite(coordinate),
          )
        );
      },
    );
}

function expectNativeAxisPointerAt(
  chart: ReturnType<typeof echarts.init>,
  pointerX: number,
  grid: RuntimeRect,
): void {
  const pointers = nativeAxisPointerLines(chart);
  expect(pointers).toHaveLength(1);
  const { x1, x2, y1, y2 } = pointers[0].shape;
  expect(x1).toBeCloseTo(pointerX, 1);
  expect(x2).toBeCloseTo(pointerX, 1);
  expect(Math.min(y1, y2)).toBeCloseTo(grid.y, 1);
  expect(Math.max(y1, y2)).toBeCloseTo(grid.y + grid.height, 1);
}

function prepareSubPrecisionDataset(max: number): PreparedDataset {
  return prepareDataset(
    makeDataset({
      axes: [
        { id: "primary", role: "primary", name: "微量", unit: "unit" },
      ],
      series: [
        {
          id: "tiny-value",
          name: "极小值",
          unit: "unit",
          role: "measured",
          axisId: "primary",
          points: [
            ["2026-01-01 00:00:00", 0],
            ["2026-01-01 00:10:00", max],
          ],
        },
      ],
    }),
  );
}

function isVerticalLine(element: RuntimeLayerElement): boolean {
  if (!hasFiniteLineGeometry(element)) {
    return false;
  }
  const { x1, y1, x2, y2 } = element.shape;
  return x1 === x2 && Math.abs(y2 - y1) > 0;
}

function isHorizontalLine(element: RuntimeLayerElement): boolean {
  if (!hasFiniteLineGeometry(element)) {
    return false;
  }
  const { x1, y1, x2, y2 } = element.shape;
  return y1 === y2 && Math.abs(x2 - x1) > 0;
}

describe("grid line geometry", () => {
  it("rejects missing and zero-length line geometry", () => {
    const missingCoordinates: RuntimeLayerElement = {
      type: "line",
      z: 0,
      z2: 0,
    };
    const point: RuntimeLayerElement = {
      type: "line",
      z: 0,
      z2: 0,
      shape: { x1: 10, y1: 20, x2: 10, y2: 20 },
    };
    const vertical: RuntimeLayerElement = {
      type: "line",
      z: 0,
      z2: 0,
      shape: { x1: 10, y1: 20, x2: 10, y2: 40 },
    };
    const horizontal: RuntimeLayerElement = {
      type: "line",
      z: 0,
      z2: 0,
      shape: { x1: 10, y1: 20, x2: 30, y2: 20 },
    };

    expect(isVerticalLine(missingCoordinates)).toBe(false);
    expect(isHorizontalLine(missingCoordinates)).toBe(false);
    expect(isVerticalLine(point)).toBe(false);
    expect(isHorizontalLine(point)).toBe(false);
    expect(isVerticalLine(vertical)).toBe(true);
    expect(isHorizontalLine(horizontal)).toBe(true);
  });
});

function ssrYAxisExtent(option: EChartsOption, axisIndex = 0): number[] {
  const chart = echarts.init(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: 800,
    height: 600,
  });
  try {
    chart.setOption(option);
    const axisModel = runtimeChart(chart)
      .getModel()
      .getComponent("yAxis", axisIndex);
    return [...axisModel.axis.scale.getExtent()];
  } finally {
    chart.dispose();
  }
}

function readRuntimeYAxisView(
  chart: ReturnType<typeof echarts.init>,
  axisIndex = 0,
): { labels: string[]; tickValues: number[] } {
  const viewLabels = runtimeChart(chart)
    .getModel()
    .getComponent("yAxis", axisIndex).axis.getViewLabels();
  return {
    labels: viewLabels.map((item) => item.formattedLabel),
    tickValues: viewLabels.map((item) => item.tick.value),
  };
}

function ssrYAxisView(option: EChartsOption, axisIndex = 0) {
  const chart = echarts.init(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: 800,
    height: 600,
  });
  try {
    chart.setOption(option);
    return readRuntimeYAxisView(chart, axisIndex);
  } finally {
    chart.dispose();
  }
}

function optionYAxisView(
  option: EChartsOption,
  axisIndex = 0,
): { labels: string[]; tickValues: number[] } {
  const axes = option.yAxis as Array<{
    axisLabel: {
      customValues: number[];
      formatter: (value: number) => string;
    };
  }>;
  const { customValues, formatter } = axes[axisIndex].axisLabel;

  return {
    labels: customValues.map((value) => formatter(value)),
    tickValues: customValues,
  };
}

function buildChartOptionsForSubPrecisionExtent(
  min: number,
  max: number,
  count: number,
): EChartsOption {
  return buildChartOptions(
    dataset,
    {
      ...config,
      axes: { primary: { min, max } },
      yGridCount: count,
    },
    presentation,
  );
}

function expectedYAxisTickValues(
  min: number,
  max: number,
  count: number,
): number[] {
  const interval = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, index) =>
    index === count ? max : min + interval * index,
  );
}

function expectExactYAxisTickValues(
  tickValues: number[],
  min: number,
  max: number,
  count: number,
): void {
  const expectedTickValues = expectedYAxisTickValues(min, max, count);

  expect(tickValues).toHaveLength(expectedTickValues.length);
  expectedTickValues.forEach((expectedValue, index) => {
    expect(tickValues[index]).toBeCloseTo(expectedValue, 12);
  });
}

function readRuntimeYAxisTickValues(
  chart: ReturnType<typeof echarts.init>,
  axisIndex = 0,
): number[] {
  return runtimeChart(chart)
    .getModel()
    .getComponent("yAxis", axisIndex)
    .axis.getTicksCoords()
    .map((item) => item.tickValue);
}

function isolateYAxisOption(option: EChartsOption): EChartsOption {
  return {
    ...option,
    xAxis: {
      ...(option.xAxis as Record<string, unknown>),
      show: false,
    },
    yAxis: (option.yAxis as Array<Record<string, unknown>>).map((axis) => ({
      ...axis,
      name: "",
    })),
  };
}

function runtimeYAxisCustomValues(
  chart: ReturnType<typeof echarts.init>,
  axisIndex = 0,
): { formatter: unknown; labels: unknown; ticks: unknown } {
  const yAxis = chart.getOption().yAxis as Array<{
    axisLabel?: { customValues?: unknown; formatter?: unknown };
    axisTick?: { customValues?: unknown };
  }>;
  const axis = yAxis[axisIndex];
  return {
    formatter: axis.axisLabel?.formatter,
    labels: axis.axisLabel?.customValues,
    ticks: axis.axisTick?.customValues,
  };
}

function primarySplitLineCount(chart: ReturnType<typeof echarts.init>): number {
  return (runtimeChart(chart).renderToSVGString().match(/stroke="#e0e0e0"/g) ?? [])
    .length;
}

function runtimeYAxisTickCount(option: EChartsOption, axisIndex = 0): number {
  const chart = echarts.init(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: 800,
    height: 600,
  });
  try {
    chart.setOption(option);
    return runtimeChart(chart)
      .getModel()
      .getComponent("yAxis", axisIndex).axis.getTicksCoords().length;
  } finally {
    chart.dispose();
  }
}

describe("resolveYAxisExtents", () => {
  it.each([
    { data: [0, 100] as const, gridCount: 6, extent: [0, 120] as const },
    { data: [58, 60] as const, gridCount: 6, extent: [58, 64] as const },
    { data: [60, 65] as const, gridCount: 6, extent: [60, 66] as const },
    { data: [95.3, 99.8] as const, gridCount: 6, extent: [95, 101] as const },
    { data: [58, 60] as const, gridCount: 5, extent: [58, 63] as const },
    { data: [60, 60] as const, gridCount: 6, extent: [60, 66] as const },
  ])(
    "aligns an automatic secondary extent to integer grid steps for %j",
    ({ data, gridCount, extent }) => {
      expect(autoIntegerAlignedExtent(data, gridCount)).toEqual(extent);
    },
  );

  it("exposes the displayed extent used by an automatic y axis", () => {
    const prepared = prepareOutlierDataset();

    const extents = resolveYAxisExtents(
      prepared,
      config,
      presentationFor(prepared),
    );

    expect(extents.get("primary")).toEqual([-200, 1_200]);
  });

  it("returns independent displayed extents for both y axes", () => {
    const extents = resolveYAxisExtents(dataset, config, presentation);
    const primary = extents.get("primary");
    const secondary = extents.get("secondary");

    expect(primary).not.toBe(secondary);
    expect(primary?.every(Number.isFinite)).toBe(true);
    expect(secondary?.every(Number.isFinite)).toBe(true);
  });

  it.each([
    { min: Number.NaN, max: 1 },
    { min: 1, max: 1 },
    { min: 2, max: 1 },
  ])(
    "rejects an invalid complete manual y extent [$min, $max]",
    ({ min, max }) => {
      expect(() =>
        resolveYAxisExtents(
          dataset,
          { axes: { primary: { min, max } }, yGridCount: 5 },
          presentation,
        ),
      ).toThrow("纵坐标轴 primary 的手动范围无效");
    },
  );
});

describe("buildChartOptions", () => {
  it("keeps passive curves on the system default cursor", () => {
    const fullSeries = buildChartOptions(dataset, config, presentation)
      .series as Array<{ cursor?: string; silent?: boolean }>;
    const updateSeries = buildChartUpdate(dataset, config, presentation)
      .series as Array<{ cursor?: string; silent?: boolean }>;

    for (const series of [...fullSeries, ...updateSeries]) {
      expect(series).toMatchObject({ cursor: "default", silent: true });
    }
  });

  it("defines a quiet programmatic emphasis state for curve-group targeting", () => {
    const options = buildChartOptions(dataset, config, presentation);
    const fullSeries = options.series as Array<{
      id: string;
      lineStyle: { width: number; opacity: number };
      emphasis: {
        disabled: boolean;
        lineStyle: { width: number; opacity: number };
      };
    }>;
    const updateSeries = buildChartUpdate(dataset, config, presentation)
      .series as Array<{
        id: string;
        emphasis: {
          disabled: boolean;
          lineStyle: { width: number; opacity: number };
        };
      }>;

    for (const series of fullSeries) {
      expect(series.emphasis).toEqual({
        disabled: true,
        lineStyle: {
          width: series.lineStyle.width + 0.4,
          opacity: series.lineStyle.opacity,
        },
      });
    }
    expect(updateSeries.map(({ id, emphasis }) => ({ id, emphasis }))).toEqual(
      fullSeries.map(({ id, emphasis }) => ({ id, emphasis })),
    );
  });

  it("keeps locked curves and y axes normal while dimming nonlocked context", () => {
    const lockedPresentation: ChartPresentation = {
      ...presentation,
      lockedAxisIds: new Set(["primary"]),
    };
    const normalOptions = buildChartOptions(dataset, config, presentation);
    const options = buildChartOptions(dataset, config, lockedPresentation);
    const series = options.series as Array<{
      id: string;
      lineStyle: { color: string; width: number; opacity: number };
      emphasis: { lineStyle: { opacity: number } };
    }>;
    const actualTemperature = series.find(
      (candidate) => candidate.id === "actual-temp",
    )!;
    const setTemperature = series.find(
      (candidate) => candidate.id === "set-temp",
    )!;
    const actualHumidity = series.find(
      (candidate) => candidate.id === "actual-humidity",
    )!;
    const setHumidity = series.find(
      (candidate) => candidate.id === "set-humidity",
    )!;

    expect(actualTemperature.lineStyle).toMatchObject({ width: 2.8, opacity: 1 });
    expect(setTemperature.lineStyle).toMatchObject({ width: 1.8, opacity: 0.86 });
    expect(actualHumidity.lineStyle.width).toBe(2.8);
    expect(actualHumidity.lineStyle.opacity).toBe(SERIES_BACKGROUND_OPACITY);
    expect(setHumidity.lineStyle).toMatchObject({
      width: 1.8,
      opacity: SERIES_BACKGROUND_OPACITY,
    });
    expect(actualHumidity.emphasis.lineStyle.opacity).toBe(1);
    expect(JSON.parse(JSON.stringify(options.yAxis))).toEqual(
      JSON.parse(JSON.stringify(normalOptions.yAxis)),
    );

    const allLocked = buildChartOptions(dataset, config, {
      ...presentation,
      lockedAxisIds: new Set(["primary", "secondary"]),
    }).series as Array<{ lineStyle: { opacity: number } }>;
    expect(allLocked.map((item) => item.lineStyle.opacity)).toEqual([
      1,
      0.86,
      1,
      0.86,
    ]);

    const previewedNonlocked = buildChartOptions(dataset, config, {
      ...lockedPresentation,
      previewSeriesId: "actual-humidity",
    }).series as Array<{
      id: string;
      lineStyle: { width: number; opacity: number };
    }>;
    expect(
      previewedNonlocked.find((item) => item.id === "actual-humidity")
        ?.lineStyle,
    ).toMatchObject({ width: 3.2, opacity: 1 });
    expect(
      previewedNonlocked.find((item) => item.id === "actual-temp")?.lineStyle
        .opacity,
    ).toBe(0.2);

    const unlockedUpdate = buildChartUpdate(dataset, config, {
      ...presentation,
      lockedAxisIds: new Set(),
    });
    const unlockedSeries = unlockedUpdate.series as Array<{
      lineStyle: { opacity: number };
    }>;
    expect(unlockedSeries.map((item) => item.lineStyle.opacity)).toEqual([
      1,
      0.86,
      1,
      0.86,
    ]);
    expect(JSON.parse(JSON.stringify(unlockedUpdate.yAxis))).toEqual(
      JSON.parse(
        JSON.stringify(buildChartUpdate(dataset, config, presentation).yAxis),
      ),
    );
  });

  it("configures a quiet native x-axis pointer only for real visible series", () => {
    const axisPointer = (
      buildChartOptions(dataset, config, presentation).xAxis as {
        axisPointer: Record<string, unknown>;
      }
    ).axisPointer;

    expect(axisPointer).toEqual({
      show: true,
      type: "line",
      snap: false,
      label: { show: false },
      triggerTooltip: false,
      triggerEmphasis: false,
      animation: false,
      lineStyle: {
        color: "rgba(117, 117, 117, 0.42)",
        width: 1,
        type: "solid",
      },
    });

    for (const visibleSeries of [new Set<string>(), new Set(["missing-series"])]) {
      expect(
        (
          buildChartOptions(dataset, config, {
            visibleSeries,
            previewSeriesId: null,
          }).xAxis as { axisPointer: { show: boolean } }
        ).axisPointer.show,
      ).toBe(false);
    }
  });

  it("leaves the pointer line to ChartView instead of ECharts' own mouse tracking", () => {
    // 轴线若自行跟随鼠标，就会在读数卡片隐藏时（按住 Shift、拖动平移）单独留在图上。
    expect(buildChartOptions(dataset, config, presentation).axisPointer).toEqual({
      triggerOn: "none",
    });
    expect(buildChartUpdate(dataset, config, presentation)).not.toHaveProperty(
      "axisPointer",
    );
  });

  it("hides the native x-axis pointer when the cursor display is disabled", () => {
    const cursorHiddenPresentation = {
      ...presentation,
      cursorVisible: false,
    };

    const initialPointer = (
      buildChartOptions(dataset, config, cursorHiddenPresentation).xAxis as {
        axisPointer: { show: boolean };
      }
    ).axisPointer;
    const updatedPointer = (
      buildChartUpdate(dataset, config, cursorHiddenPresentation).xAxis as {
        axisPointer: { show: boolean; status?: string };
      }
    ).axisPointer;

    expect(initialPointer.show).toBe(false);
    expect(updatedPointer).toEqual({ show: false, status: "hide" });
  });

  it("hides vertical grid lines when no visible y-axis remains", () => {
    const splitLine = (visibleSeries: ReadonlySet<string>) =>
      (
        buildChartOptions(dataset, config, {
          visibleSeries,
          previewSeriesId: null,
        }).xAxis as { splitLine: { show: boolean } }
      ).splitLine;

    expect(splitLine(presentation.visibleSeries).show).toBe(true);
    expect(splitLine(new Set()).show).toBe(false);
    expect(splitLine(new Set(["missing-series"])).show).toBe(false);
  });

  it.each([980, 1280, 1600])(
    "clips the native axis pointer to the resized grid at width %i",
    (width) => {
      const chart = echarts.init(null, undefined, {
        renderer: "svg",
        ssr: true,
        width,
        height: 800,
      });
      try {
        chart.setOption(buildChartOptions(dataset, config, presentation));
        expect(nativeAxisPointerLines(chart)).toHaveLength(0);

        for (const expectedWidth of [width, width - 80]) {
          if (expectedWidth !== width) {
            chart.resize({ width: expectedWidth, height: 720 });
          }
          const grid = runtimeChart(chart)
            .getModel()
            .getComponent("grid", 0).coordinateSystem.getRect();
          const pointerX = grid.x + grid.width / 2;
          chart.dispatchAction({
            type: "updateAxisPointer",
            x: pointerX,
            y: grid.y + grid.height / 2,
          });

          expectNativeAxisPointerAt(chart, pointerX, grid);
        }
      } finally {
        chart.dispose();
      }
    },
  );

  it("hides a stale native pointer until a real event follows a visible merge", () => {
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 980,
      height: 800,
    });
    const pointerOption = () =>
      (chart.getOption().xAxis as Array<{ axisPointer: Record<string, unknown> }>)[0]
        .axisPointer;
    try {
      chart.setOption(buildChartOptions(dataset, config, presentation));
      const grid = runtimeChart(chart)
        .getModel()
        .getComponent("grid", 0).coordinateSystem.getRect();
      chart.dispatchAction({
        type: "updateAxisPointer",
        x: grid.x + grid.width / 2,
        y: grid.y + grid.height / 2,
      });
      expect(nativeAxisPointerLines(chart)).toHaveLength(1);

      chart.setOption(
        buildChartUpdate(dataset, config, {
          visibleSeries: new Set(["missing-series"]),
          previewSeriesId: null,
        }),
      );
      expect(pointerOption()).toMatchObject({ show: false, status: "hide" });
      expect(nativeAxisPointerLines(chart)).toHaveLength(0);

      chart.setOption(buildChartUpdate(dataset, config, presentation));
      expect(pointerOption()).toMatchObject({ show: true, status: "hide" });
      expect(nativeAxisPointerLines(chart)).toHaveLength(0);

      chart.dispatchAction({
        type: "updateAxisPointer",
        x: grid.x + grid.width / 2,
        y: grid.y + grid.height / 2,
      });
      expect(nativeAxisPointerLines(chart)).toHaveLength(1);
    } finally {
      chart.dispose();
    }
  });

  it("keeps an export-hidden native pointer hidden through LOD restore", () => {
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 980,
      height: 800,
    });
    try {
      chart.setOption(buildChartOptions(dataset, config, presentation));
      const grid = runtimeChart(chart)
        .getModel()
        .getComponent("grid", 0).coordinateSystem.getRect();
      const pointerAction = {
        type: "updateAxisPointer" as const,
        x: grid.x + grid.width / 2,
        y: grid.y + grid.height / 2,
      };
      chart.dispatchAction(pointerAction);
      expect(nativeAxisPointerLines(chart)).toHaveLength(1);

      chart.setOption(buildChartUpdate(dataset, config, presentation));
      chart.dispatchAction({
        type: "updateAxisPointer",
        currTrigger: "leave",
      });
      chart.getZr().flush();
      expect(nativeAxisPointerLines(chart)).toHaveLength(0);

      chart.setOption(buildChartUpdate(dataset, config, presentation));
      expect(nativeAxisPointerLines(chart)).toHaveLength(0);

      chart.dispatchAction(pointerAction);
      expect(nativeAxisPointerLines(chart)).toHaveLength(1);
    } finally {
      chart.dispose();
    }
  });

  it("builds one full-range time x-axis with data and boundary y-axes", () => {
    const options = buildChartOptions(dataset, config, presentation);
    const xAxis = options.xAxis as {
      type: string;
      min: number;
      max: number;
      axisLine: { onZero: boolean };
      axisTick: { show: boolean; customValues: number[] };
      axisLabel: {
        customValues: number[];
        hideOverlap: boolean;
        margin: number;
        formatter: (value: number, index: number) => string;
        alignMinLabel: string;
        showMinLabel: boolean | null;
        fontSize: number;
        lineHeight: number;
      };
    };
    const grid = options.grid as {
      left: number;
      right: number;
      top: number;
      bottom: number;
    };
    const yAxis = options.yAxis as Array<{
      id: string;
      name: string;
      position: string;
      splitNumber?: number;
    }>;
    const dataAxes = yAxis.slice(0, dataset.axes.length);
    const boundaryAxes = yAxis.slice(dataset.axes.length);

    expect(xAxis).toMatchObject({
      type: "time",
      min: config.xMin - (config.xMax - config.xMin),
      max: config.xMax + (config.xMax - config.xMin),
    });
    expect(xAxis.axisTick).toMatchObject({ show: false });
    expect(xAxis.axisTick.customValues).toHaveLength(7);
    expect(xAxis.axisLabel.customValues).toEqual(
      xAxis.axisTick.customValues,
    );
    expect(xAxis.axisLabel.hideOverlap).toBe(true);
    expect(xAxis.axisLabel.formatter(config.xMin, 0)).toBe("00:00\n01-01");
    expect(xAxis.axisLabel.formatter(xAxis.axisLabel.customValues[1], 1)).toBe(
      "00:01",
    );
    expect(xAxis.axisLabel).toMatchObject({
      alignMinLabel: "left",
      showMinLabel: true,
      fontSize: 12,
      lineHeight: 16,
    });
    expect(grid).toEqual({ left: 78, right: 78, top: 54, bottom: 68 });
    expect(xAxis.axisLine).toMatchObject({ onZero: false });
    expect(xAxis.axisLabel.margin).toBe(14);
    expect(yAxis).toHaveLength(6);
    expect(dataAxes[0]).toMatchObject({
      id: "primary",
      name: "温度 °C",
      position: "left",
      splitNumber: 6,
    });
    expect(dataAxes[1]).toMatchObject({
      id: "secondary",
      name: "湿度 %RH",
      position: "right",
      splitNumber: 6,
    });
    expect(boundaryAxes).toEqual([
      {
        id: "__y-boundary-mask-primary",
        type: "value",
        show: true,
        silent: true,
        name: "",
        position: "left",
        z: 4,
        offset: 3,
        min: 0,
        max: 1,
        scale: true,
        axisLine: {
          show: true,
          onZero: false,
          lineStyle: { color: "#fafbfc", width: 6 },
        },
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      {
        id: "__y-boundary-line-primary",
        type: "value",
        show: true,
        silent: true,
        name: "",
        position: "left",
        z: 5,
        offset: 0,
        min: 0,
        max: 1,
        scale: true,
        axisLine: {
          show: true,
          onZero: false,
          lineStyle: { color: "#757575", width: 1 },
        },
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      {
        id: "__y-boundary-mask-secondary",
        type: "value",
        show: true,
        silent: true,
        name: "",
        position: "right",
        z: 4,
        offset: 3,
        min: 0,
        max: 1,
        scale: true,
        axisLine: {
          show: true,
          onZero: false,
          lineStyle: { color: "#fafbfc", width: 6 },
        },
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      {
        id: "__y-boundary-line-secondary",
        type: "value",
        show: true,
        silent: true,
        name: "",
        position: "right",
        z: 5,
        offset: 0,
        min: 0,
        max: 1,
        scale: true,
        axisLine: {
          show: true,
          onZero: false,
          lineStyle: { color: "#757575", width: 1 },
        },
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
    ]);
    expect(new Set(yAxis.map((axis) => axis.id)).size).toBe(yAxis.length);
  });

  it.each([1, 6, 9])(
    "renders the date only under the first real ECharts x label with %i intervals",
    (xGridCount) => {
      const option = buildChartOptions(
        dataset,
        { ...config, xGridCount },
        presentation,
      );
      const chart = echarts.init(null, undefined, {
        renderer: "svg",
        ssr: true,
        width: 980,
        height: 800,
      });
      try {
        chart.setOption(option);
        const labels = readRuntimeXAxisView(chart).labels;
        expect(labels[0]).toBe("00:00\n01-01");
        expect(labels.slice(1).every((label) => !label.includes("\n"))).toBe(true);
      } finally {
        chart.dispose();
      }
    },
  );

  it.each([980, 1280, 1600])(
    "left-aligns both first-label rows to grid.x at width %i before and after resize",
    (width) => {
      const chart = echarts.init(null, undefined, {
        renderer: "svg",
        ssr: true,
        width,
        height: 800,
      });
      try {
        chart.setOption(buildChartOptions(dataset, config, presentation));
        for (const expectedWidth of [width, width - 80]) {
          if (expectedWidth !== width) chart.resize({ width: expectedWidth, height: 720 });
          const runtime = runtimeChart(chart);
          const gridX = runtime.getModel().getComponent("grid", 0).coordinateSystem.getRect().x;
          const tspans = runtime
            .getZr()
            .storage.getDisplayList(true, false)
            .filter(
              (element) =>
                element.type === "tspan" &&
                (element.style?.text === "00:00" || element.style?.text === "01-01"),
            );
          const time = tspans.find((element) => element.style?.text === "00:00")!;
          const date = tspans.find((element) => element.style?.text === "01-01")!;
          const timeRect = transformedRect(time);
          const dateRect = transformedRect(date);

          expect(time).toBeTruthy();
          expect(date).toBeTruthy();
          expect(timeRect.x).toBeCloseTo(gridX, 5);
          expect(dateRect.x).toBeCloseTo(gridX, 5);
          expect(dateRect.y - timeRect.y).toBeCloseTo(16, 5);
          expect(time.style?.font).toContain("12px");
          expect(date.style?.font).toContain("12px");
        }
      } finally {
        chart.dispose();
      }
    },
  );

  it("preserves the default single-line cross-day label layout", () => {
    const crossDayDataset = prepareDataset(
      makeDataset({
        timeRange: {
          start: "2026-01-01 18:00:00",
          end: "2026-01-02 06:00:00",
        },
      }),
    );
    const crossDayConfig = {
      ...config,
      xMin: new Date("2026-01-01T18:00:00").getTime(),
      xMax: new Date("2026-01-02T06:00:00").getTime(),
      xGridCount: 6,
    };
    const option = buildChartOptions(
      crossDayDataset,
      crossDayConfig,
      presentationFor(crossDayDataset),
    );
    const xAxis = option.xAxis as {
      axisLabel: Record<string, unknown>;
    };
    const baselineAxisLabel = { ...xAxis.axisLabel };
    delete baselineAxisLabel.alignMinLabel;
    delete baselineAxisLabel.showMinLabel;
    delete baselineAxisLabel.fontSize;
    delete baselineAxisLabel.lineHeight;
    const baselineOption = {
      ...option,
      xAxis: {
        ...(option.xAxis as Record<string, unknown>),
        axisLabel: baselineAxisLabel,
      },
    };
    expect(baselineAxisLabel).not.toEqual(xAxis.axisLabel);
    const charts = [option, baselineOption].map(() =>
      echarts.init(null, undefined, {
        renderer: "svg",
        ssr: true,
        width: 980,
        height: 800,
      }),
    );
    try {
      const labelRects = charts.map((chart, index) => {
        chart.setOption(index === 0 ? option : baselineOption);
        const firstLabel = runtimeChart(chart)
          .getZr()
          .storage.getDisplayList(true, false)
          .find(
            (element) =>
              element.type === "tspan" &&
              element.style?.text === "01-01 18:00",
          )!;
        expect(firstLabel).toBeTruthy();
        return transformedRect(firstLabel);
      });

      expect(labelRects[0].x).toBeCloseTo(labelRects[1].x, 5);
      expect(labelRects[0].y).toBeCloseTo(labelRects[1].y, 5);
      expect(labelRects[0].width).toBeCloseTo(labelRects[1].width, 5);
      expect(labelRects[0].height).toBeCloseTo(labelRects[1].height, 5);
      expect(xAxis.axisLabel).not.toHaveProperty("fontSize");
      expect(xAxis.axisLabel).not.toHaveProperty("lineHeight");
    } finally {
      charts.forEach((chart) => chart.dispose());
    }
  });

  it("hides a data axis and its boundary layers when all valid series on it hide", () => {
    const secondaryHidden: ChartPresentation = {
      visibleSeries: new Set(["actual-temp", "set-temp"]),
      previewSeriesId: null,
    };
    const options = buildChartOptions(
      dataset,
      {
        ...config,
        axes: { secondary: { min: 0, max: 100 } },
      },
      secondaryHidden,
    );
    const axes = options.yAxis as Array<{
      id: string;
      show: boolean;
      min?: number;
      max?: number;
    }>;

    expect(axes.map(({ id, show }) => ({ id, show }))).toEqual([
      { id: "primary", show: true },
      { id: "secondary", show: false },
      { id: "__y-boundary-mask-primary", show: true },
      { id: "__y-boundary-line-primary", show: true },
      { id: "__y-boundary-mask-secondary", show: false },
      { id: "__y-boundary-line-secondary", show: false },
    ]);
    expect(axes[1]).toMatchObject({ min: 0, max: 100 });
  });

  it("renders a file containing only humidity on one visible left-side primary axis", () => {
    const raw = makeDataset();
    const humidityOnly = prepareDataset({
      ...raw,
      series: raw.series.filter((series) => series.axisId === "secondary"),
    });
    const options = buildChartOptions(
      humidityOnly,
      config,
      presentationFor(humidityOnly),
    );
    const [humidityAxis] = options.yAxis as Array<{
      id: string;
      show: boolean;
      position: "left" | "right";
      offset: number;
    }>;
    const series = options.series as Array<{ yAxisIndex: number }>;

    expect(humidityOnly.axes).toHaveLength(1);
    expect(humidityOnly.axes[0]).toMatchObject({
      id: "secondary",
      role: "primary",
    });
    expect(humidityAxis).toMatchObject({
      id: "secondary",
      show: true,
      position: "left",
      offset: 0,
    });
    expect(series.map((item) => item.yAxisIndex)).toEqual([0, 0]);
  });

  it("does not render a secondary axis when all humidity values are invalid", () => {
    const raw = makeDataset();
    const temperatureOnly = prepareDataset({
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
    const options = buildChartOptions(
      temperatureOnly,
      config,
      presentationFor(temperatureOnly),
    );
    const dataAxes = (options.yAxis as Array<{
      id: string;
      show: boolean;
      position: "left" | "right";
    }>).slice(0, temperatureOnly.axes.length);
    const series = options.series as Array<{ id: string; yAxisIndex: number }>;

    expect(dataAxes).toEqual([
      expect.objectContaining({
        id: "primary",
        show: true,
        position: "left",
      }),
    ]);
    expect(series.map(({ id, yAxisIndex }) => ({ id, yAxisIndex }))).toEqual([
      { id: "actual-temp", yAxisIndex: 0 },
      { id: "set-temp", yAxisIndex: 0 },
    ]);
  });

  it("does not render an axis or legend series for an isolated Hanche humidity setpoint", () => {
    const raw = makeDataset();
    const temperatureOnly = prepareDataset({
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
    const options = buildChartOptions(
      temperatureOnly,
      config,
      presentationFor(temperatureOnly),
    );
    const dataAxes = (options.yAxis as Array<{
      id: string;
      show: boolean;
      position: "left" | "right";
    }>).slice(0, temperatureOnly.axes.length);
    const series = options.series as Array<{ id: string; yAxisIndex: number }>;

    expect(dataAxes).toEqual([
      expect.objectContaining({
        id: "primary",
        show: true,
        position: "left",
      }),
    ]);
    expect(series.map(({ id, yAxisIndex }) => ({ id, yAxisIndex }))).toEqual([
      { id: "actual-temp", yAxisIndex: 0 },
      { id: "set-temp", yAxisIndex: 0 },
    ]);
  });

  it("draws horizontal grid lines from the primary axis when both axes are visible", () => {
    const options = buildChartOptions(dataset, config, presentation);
    const dataAxes = (options.yAxis as Array<{
      id: string;
      splitLine: { show: boolean };
    }>).slice(0, dataset.axes.length);

    expect(
      dataAxes.map(({ id, splitLine }) => ({
        id,
        splitLine: splitLine.show,
      })),
    ).toEqual([
      { id: "primary", splitLine: true },
      { id: "secondary", splitLine: false },
    ]);
  });

  it("hands horizontal grid lines to the secondary axis when the primary axis hides", () => {
    const options = buildChartOptions(dataset, config, {
      visibleSeries: new Set(["actual-humidity", "set-humidity"]),
      previewSeriesId: null,
    });
    const dataAxes = (options.yAxis as Array<{
      id: string;
      splitLine: { show: boolean };
    }>).slice(0, dataset.axes.length);

    expect(
      dataAxes.map(({ id, splitLine }) => ({
        id,
        splitLine: splitLine.show,
      })),
    ).toEqual([
      { id: "primary", splitLine: false },
      { id: "secondary", splitLine: true },
    ]);
  });

  it("hands horizontal grid lines to the pressure axis when only pressure is visible", () => {
    const threeAxisDataset = prepareThreeAxisDataset();
    const options = buildChartOptions(threeAxisDataset, config, {
      visibleSeries: new Set(["actual-pressure", "set-pressure"]),
      previewSeriesId: null,
    });
    const dataAxes = (options.yAxis as Array<{
      id: string;
      splitLine: { show: boolean };
    }>).slice(0, threeAxisDataset.axes.length);

    expect(
      dataAxes.map(({ id, splitLine }) => ({
        id,
        splitLine: splitLine.show,
      })),
    ).toEqual([
      { id: "primary", splitLine: false },
      { id: "secondary", splitLine: false },
      { id: "pressure", splitLine: true },
    ]);
  });

  it("draws no horizontal grid lines when every y axis hides", () => {
    const options = buildChartOptions(dataset, config, {
      visibleSeries: new Set(),
      previewSeriesId: null,
    });
    const dataAxes = (options.yAxis as Array<{
      id: string;
      splitLine: { show: boolean };
    }>).slice(0, dataset.axes.length);

    expect(
      dataAxes.map(({ id, splitLine }) => ({
        id,
        splitLine: splitLine.show,
      })),
    ).toEqual([
      { id: "primary", splitLine: false },
      { id: "secondary", splitLine: false },
    ]);
  });

  it("renders horizontal grid lines through the visible secondary axis in real ECharts", () => {
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(
        buildChartOptions(dataset, config, {
          visibleSeries: new Set(["actual-humidity", "set-humidity"]),
          previewSeriesId: null,
        }),
      );
      const horizontalGridLines = runtimeChart(chart)
        .getZr()
        .storage.getDisplayList(true, true)
        .filter(
          (element) =>
            element.style?.stroke === "#e0e0e0" &&
            isHorizontalLine(element),
        );

      expect(horizontalGridLines.length).toBeGreaterThan(0);
    } finally {
      chart.dispose();
    }
  });

  it("renders horizontal grid lines through the pressure axis when only pressure is visible", () => {
    const threeAxisDataset = prepareThreeAxisDataset();
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(
        buildChartOptions(threeAxisDataset, config, {
          visibleSeries: new Set(["actual-pressure", "set-pressure"]),
          previewSeriesId: null,
        }),
      );
      const horizontalGridLines = runtimeChart(chart)
        .getZr()
        .storage.getDisplayList(true, true)
        .filter(
          (element) =>
            element.style?.stroke === "#e0e0e0" &&
            isHorizontalLine(element),
        );

      expect(horizontalGridLines.length).toBeGreaterThan(0);
    } finally {
      chart.dispose();
    }
  });

  it("renders no horizontal grid lines when every series hides", () => {
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(
        buildChartOptions(dataset, config, {
          visibleSeries: new Set(),
          previewSeriesId: null,
        }),
      );
      const horizontalGridLines = runtimeChart(chart)
        .getZr()
        .storage.getDisplayList(true, true)
        .filter(
          (element) =>
            element.style?.stroke === "#e0e0e0" &&
            isHorizontalLine(element),
        );

      expect(horizontalGridLines).toHaveLength(0);
    } finally {
      chart.dispose();
    }
  });

  it("keeps the x-axis line on the grid bottom when the primary y range crosses zero", () => {
    const options = buildChartOptions(
      dataset,
      {
        ...config,
        axes: { primary: { min: -60, max: 100 } },
      },
      presentation,
    );
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(options);
      const runtime = runtimeChart(chart);
      const grid = runtime
        .getModel()
        .getComponent("grid", 0)
        .coordinateSystem.getRect();
      const xAxisLines = runtime
        .getZr()
        .storage.getDisplayList(true, true)
        .filter(
          (element) =>
            element.style?.stroke === "#757575" &&
            isHorizontalLine(element) &&
            Math.abs(element.shape!.x2! - element.shape!.x1!) > 100,
        );

      expect(xAxisLines).toHaveLength(1);
      expect(
        Math.abs(xAxisLines[0].shape!.y1! - (grid.y + grid.height)),
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(xAxisLines[0].shape!.y2! - (grid.y + grid.height)),
      ).toBeLessThanOrEqual(0.5);
    } finally {
      chart.dispose();
    }
  });

  it("appends one mask and one boundary line for a single data axis", () => {
    const prepared = prepareOutlierDataset();
    const options = buildChartOptions(
      prepared,
      config,
      presentationFor(prepared),
    );
    const yAxis = options.yAxis as Array<{ id: string; position: string }>;

    expect(yAxis).toHaveLength(3);
    expect(yAxis.map((axis) => axis.id)).toEqual([
      "primary",
      "__y-boundary-mask-primary",
      "__y-boundary-line-primary",
    ]);
    expect(yAxis.map((axis) => axis.position)).toEqual([
      "left",
      "left",
      "left",
    ]);
  });

  it("keeps prepared series data order and null gaps without secondary sampling", () => {
    const rawWithGap = makeDataset();
    rawWithGap.series = rawWithGap.series.map((series) =>
      series.id === "actual-humidity"
        ? {
            ...series,
            points: [
              ["2026-01-01 00:00:00", 58],
              ["2026-01-01 00:05:00", null],
              ["2026-01-01 00:10:00", 59],
            ],
          }
        : series,
    );
    const preparedWithGap = prepareDataset(rawWithGap);
    const options = buildChartOptions(
      preparedWithGap,
      config,
      presentationFor(preparedWithGap),
    );
    const series = options.series as Array<{
      id: string;
      yAxisIndex: number;
      sampling: string;
      connectNulls: boolean;
      data: Array<[number, number | null]>;
    }>;

    expect(series.map((item) => item.id)).toEqual([
      "actual-temp",
      "set-temp",
      "actual-humidity",
      "set-humidity",
    ]);
    expect(series.map((item) => item.yAxisIndex)).toEqual([0, 0, 1, 1]);
    expect(series.every((item) => item.sampling === "none")).toBe(true);
    expect(series.every((item) => item.connectNulls === false)).toBe(true);
    expect(series.map((item) => item.data)).toEqual(
      preparedWithGap.series.map((item) => item.points),
    );
    expect(
      series
        .find((item) => item.id === "actual-humidity")
        ?.data.map((point) => point[1]),
    ).toEqual([58, null, 59]);
  });

  it("does not collapse a short rising island to one point on a narrow chart", () => {
    const start = minuteTimestamp(0);
    const shortIsland = Array.from(
      { length: 201 },
      (_, index) =>
        [
          start + index * 1_000,
          index >= 71 && index <= 76 ? 10 + (index - 71) * 3 : null,
        ] as [number, number | null],
    );
    const prepared = prepareDataset(
      makeDataset({
        timeRange: {
          start: "2026-01-01 00:00:00",
          end: "2026-01-01 00:03:20",
        },
        rowCount: shortIsland.length,
        axes: [
          { id: "primary", role: "primary", name: "温度", unit: "degC" },
        ],
        series: [
          {
            id: "rising-temp",
            name: "短上升段",
            unit: "degC",
            role: "measured",
            axisId: "primary",
            points: [
              ["2026-01-01 00:00:00", 10],
              ["2026-01-01 00:00:01", 10],
            ],
          },
        ],
      }),
    );
    prepared.series[0] = {
      ...prepared.series[0],
      points: shortIsland,
      valueExtent: [10, 25],
    };
    const narrowConfig = {
      ...DEFAULT_CHART_SETTINGS,
      xMin: start,
      xMax: start + 200_000,
    };
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 180,
      height: 300,
    });

    try {
      chart.setOption(
        buildChartOptions(
          prepared,
          narrowConfig,
          presentationFor(prepared),
        ),
      );
      const processed = runtimeChart(chart)
        .getModel()
        .getSeriesByIndex(0)
        .getData();
      const numericPointCount = Array.from(
        { length: processed.count() },
        (_, index) => processed.get("y", index),
      ).filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      ).length;

      expect(numericPointCount).toBeGreaterThanOrEqual(2);
    } finally {
      chart.dispose();
    }
  });

  it("keeps boundary neighbors as regular clipped line data", () => {
    const prepared = prepareSparseDataset();
    const sparseConfig = configForMinutes(5, 15);
    const options = buildChartOptions(
      prepared,
      sparseConfig,
      presentationFor(prepared),
    );
    const [series] = options.series as Array<{
      clip: boolean;
      data: Array<[number, number | null]>;
      markLine?: unknown;
    }>;

    expect(series.clip).toBe(true);
    expect(series.data).toEqual(prepared.series[0].points);
    expect(series.markLine).toBeUndefined();
  });

  it("renders every horizontal and vertical grid line behind the data series", () => {
    const options = buildChartOptions(dataset, config, presentation);
    const xAxis = options.xAxis as { z?: number };
    const axes = options.yAxis as Array<{ z?: number }>;
    const dataAxes = axes.slice(0, dataset.axes.length);
    const series = options.series as Array<{ z: number; clip: boolean }>;

    expect(series.every((item) => item.clip)).toBe(true);
    expect(series.every((item) => item.z === 2 || item.z === 3)).toBe(true);
    expect(series.some((item) => item.z === 2)).toBe(true);
    expect(series.some((item) => item.z === 3)).toBe(true);

    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });
    try {
      chart.setOption(options);
      const displayList = runtimeChart(chart)
        .getZr()
        .storage.getDisplayList(true, true);
      const gridLineIndexes = displayList.flatMap((element, index) =>
        element.type === "line" && element.style?.stroke === "#e0e0e0"
          ? [index]
          : [],
      );
      const seriesIndexes = displayList.flatMap((element, index) =>
        element.type === "ec-polyline" ? [index] : [],
      );

      const gridLines = gridLineIndexes.map((index) => displayList[index]);
      expect(seriesIndexes.length).toBeGreaterThan(0);
      expect(gridLines.some(isVerticalLine)).toBe(true);
      expect(gridLines.some(isHorizontalLine)).toBe(true);
      expect(gridLines.every((line) => line.z === 0 && line.z2 === 0)).toBe(
        true,
      );
      expect(Math.max(...gridLineIndexes)).toBeLessThan(
        Math.min(...seriesIndexes),
      );
    } finally {
      chart.dispose();
    }
    expect(xAxis.z ?? 0).toBeLessThan(Math.min(...series.map((item) => item.z)));
    expect(dataAxes.every((axis) => (axis.z ?? 0) < Math.min(...series.map((item) => item.z)))).toBe(
      true,
    );
  });

  it("covers only the left and right clip overflow before redrawing the axes", () => {
    const options = buildChartOptions(dataset, config, {
      ...presentation,
      previewSeriesId: "actual-temp",
    });
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(options);
      const runtime = runtimeChart(chart);
      const grid = runtime
        .getModel()
        .getComponent("grid", 0)
        .coordinateSystem.getRect();
      const displayList = runtime.getZr().storage.getDisplayList(true, true);
      const seriesElements = displayList.filter(
        (element) => element.type === "ec-polyline",
      );
      const boundaryElements = displayList.filter(
        (element) => element.z === 4 || element.z === 5,
      );
      const masks = displayList
        .filter(
          (
            element,
          ): element is RuntimeLayerElement & {
            shape: { x1: number; y1: number; x2: number; y2: number };
          } =>
            isVerticalLine(element) &&
            element.z === 4 &&
            element.style?.stroke === "#fafbfc" &&
            element.style.lineWidth === 6,
        )
        .sort((left, right) => left.shape.x1 - right.shape.x1);
      const edges = displayList
        .filter(
          (
            element,
          ): element is RuntimeLayerElement & {
            shape: { x1: number; y1: number; x2: number; y2: number };
          } =>
            isVerticalLine(element) &&
            element.z === 5 &&
            element.style?.stroke === "#757575" &&
            element.style.lineWidth === 1,
        )
        .sort((left, right) => left.shape.x1 - right.shape.x1);

      expect(seriesElements.length).toBeGreaterThan(0);
      const clips = seriesElements.map((seriesElement) => {
        expect(seriesElement.__clipPaths).toHaveLength(1);
        const clip = seriesElement.__clipPaths?.[0]?.shape;
        expect(clip).toBeDefined();
        return clip!;
      });
      expect(clips).toHaveLength(seriesElements.length);
      expect(masks).toHaveLength(2);
      expect(edges).toHaveLength(2);
      expect(boundaryElements).toHaveLength(4);

      const halfMask = 3;
      const leftMaskX = masks[0].shape.x1;
      const rightMaskX = masks[1].shape.x1;
      expect(leftMaskX + halfMask).toBeCloseTo(grid.x, 0);
      expect(rightMaskX - halfMask).toBeCloseTo(grid.x + grid.width, 0);
      for (const mask of masks) {
        expect(
          Math.abs(Math.min(mask.shape.y1, mask.shape.y2) - grid.y),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(
            Math.max(mask.shape.y1, mask.shape.y2) - (grid.y + grid.height),
          ),
        ).toBeLessThanOrEqual(1);
      }
      for (const clip of clips) {
        expect(leftMaskX - halfMask).toBeLessThanOrEqual(clip.x);
        expect(rightMaskX + halfMask).toBeGreaterThanOrEqual(
          clip.x + clip.width,
        );
      }

      expect(Math.abs(edges[0].shape.x1 - grid.x)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(edges[1].shape.x1 - (grid.x + grid.width)),
      ).toBeLessThanOrEqual(1);
      const seriesIndexes = seriesElements.map((element) =>
        displayList.indexOf(element),
      );
      const maskIndexes = masks.map((element) => displayList.indexOf(element));
      const edgeIndexes = edges.map((element) => displayList.indexOf(element));
      expect(Math.min(...maskIndexes)).toBeGreaterThan(
        Math.max(...seriesIndexes),
      );
      expect(Math.min(...edgeIndexes)).toBeGreaterThan(
        Math.max(...maskIndexes, ...seriesIndexes),
      );
    } finally {
      chart.dispose();
    }
  });

  it("renders a line crossing the whole window from offscreen neighbors", () => {
    const prepared = prepareSparseDataset();
    const sparseConfig = configForMinutes(5, 15);
    const option = buildChartOptions(
      prepared,
      sparseConfig,
      presentationFor(prepared),
    );
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(option);
      expect(
        runtimeChart(chart)
          .getModel()
          .getSeriesByIndex(0)
          .getData()
          .count(),
      ).toBe(3);
      const svg = runtimeChart(chart).renderToSVGString();
      expect(svg).toContain("<g clip-path=");
      expect(svg).toContain('stroke="#1c69d4"');
    } finally {
      chart.dispose();
    }
  });

  it("preserves an explicit null before visible data so no ghost line can form", () => {
    const prepared = prepareSparseDataset(null);
    const renderData = [
      [minuteTimestamp(10), null],
      [minuteTimestamp(20), 20],
    ] as Array<[number, number | null]>;
    const option = buildChartOptions(
      prepared,
      configForMinutes(15, 20),
      presentationFor(prepared),
      [renderData],
    );
    const [series] = option.series as Array<{
      data: Array<[number, number | null]>;
    }>;
    expect(series.data).toBe(renderData);

    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });
    try {
      chart.setOption(option);
      const svg = runtimeChart(chart).renderToSVGString();
      const linePath = svg.match(
        /<path d="([^"]+)"[^>]*stroke="#1c69d4"/,
      )?.[1];
      expect(linePath).toBeDefined();
      expect(linePath).not.toContain("L");
    } finally {
      chart.dispose();
    }
  });

  it.each([1, 6, 9])("renders exactly %s custom x-axis grid intervals", (count) => {
    const exactConfig = { ...config, xGridCount: count };
    const option = buildChartOptions(dataset, exactConfig, presentation);
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });
    try {
      chart.setOption(option);
      const axis = runtimeChart(chart).getModel().getComponent("xAxis", 0).axis;
      expect(axis.getTicksCoords()).toHaveLength(count + 1);
      expect(axis.getViewLabels()).toHaveLength(count + 1);
    } finally {
      chart.dispose();
    }
  });

  it("keeps an outlier outside the current x window in the automatic y extent", () => {
    const prepared = prepareOutlierDataset();
    const options = buildChartOptions(
      prepared,
      config,
      presentationFor(prepared),
    );
    const [primaryAxis] = options.yAxis as Array<{
      min?: number;
      max?: number;
    }>;

    expect(primaryAxis).toMatchObject({ min: -200, max: 1_200 });
  });

  it("matches the legacy filterMode none automatic y extent in ECharts SSR", () => {
    const prepared = prepareOutlierDataset();
    const filteredOption = buildChartOptions(
      prepared,
      config,
      presentationFor(prepared),
    );
    const legacyOption: EChartsOption = {
      ...filteredOption,
      dataZoom: (filteredOption.dataZoom as Array<Record<string, unknown>>).map(
        (zoom) => ({ ...zoom, filterMode: "none" }),
      ),
    };

    expect(ssrYAxisExtent(filteredOption)).toEqual(
      ssrYAxisExtent(legacyOption),
    );
  });

  it("keeps hidden series in the automatic y extent so legend toggles do not jump the axis", () => {
    const prepared = prepareOutlierDataset();
    const allVisibleOptions = buildChartOptions(
      prepared,
      config,
      presentationFor(prepared),
    );
    const [allVisibleAxis] = allVisibleOptions.yAxis as Array<{
      min?: number;
      max?: number;
    }>;
    const hiddenOptions = buildChartOptions(prepared, config, {
      visibleSeries: new Set(["base-temp"]),
      previewSeriesId: null,
    });
    const [hiddenAxis] = hiddenOptions.yAxis as Array<{
      min?: number;
      max?: number;
    }>;

    expect(allVisibleAxis).toMatchObject({ min: -200, max: 1_200 });
    expect(hiddenAxis).toMatchObject({ min: -200, max: 1_200 });
  });

  it("keeps every automatic y axis stable when a legend hides one series", () => {
    const prepared = dataset;
    const allVisible = buildChartOptions(prepared, config, presentation);
    const [allPrimary, allSecondary] = allVisible.yAxis as Array<{
      min?: number;
      max?: number;
    }>;
    const hiddenActualTemp = buildChartOptions(prepared, config, {
      visibleSeries: new Set(["set-temp", "set-humidity", "actual-humidity"]),
      previewSeriesId: null,
    });
    const [primary, secondary] = hiddenActualTemp.yAxis as Array<{
      min?: number;
      max?: number;
    }>;
    const hiddenActualHumidity = buildChartOptions(prepared, config, {
      visibleSeries: new Set(["set-temp", "actual-temp", "set-humidity"]),
      previewSeriesId: null,
    });
    const [primaryAgain, secondaryAgain] = hiddenActualHumidity.yAxis as Array<{
      min?: number;
      max?: number;
    }>;

    expect(primary).toMatchObject({ min: allPrimary.min, max: allPrimary.max });
    expect(secondary).toMatchObject({
      min: allSecondary.min,
      max: allSecondary.max,
    });
    expect(primaryAgain).toMatchObject({
      min: allPrimary.min,
      max: allPrimary.max,
    });
    expect(secondaryAgain).toMatchObject({
      min: allSecondary.min,
      max: allSecondary.max,
    });
  });

  it("leaves automatic bounds unset when all series are hidden", () => {
    const prepared = prepareOutlierDataset();
    const options = buildChartOptions(prepared, config, {
      visibleSeries: new Set(),
      previewSeriesId: null,
    });
    const [primaryAxis] = options.yAxis as Array<{
      min?: number;
      max?: number;
    }>;

    expect(primaryAxis).not.toHaveProperty("min");
    expect(primaryAxis).not.toHaveProperty("max");
  });

  it("leaves automatic bounds unset for an all-null visible series", () => {
    const prepared = prepareDataset(
      makeDataset({
        axes: [
          { id: "primary", role: "primary", name: "温度", unit: "degC" },
        ],
        series: [
          {
            id: "null-temp",
            name: "空温度",
            unit: "degC",
            role: "measured",
            axisId: "primary",
            points: [
              ["2026-01-01 00:00:00", null],
              ["2026-01-01 00:10:00", null],
            ],
          },
        ],
      }),
    );
    const options = buildChartOptions(
      prepared,
      config,
      presentationFor(prepared),
    );
    const [primaryAxis] = options.yAxis as Array<{
      min?: number;
      max?: number;
    }>;

    expect(primaryAxis).not.toHaveProperty("min");
    expect(primaryAxis).not.toHaveProperty("max");
  });

  it("uses the ECharts nice extent for a constant visible series", () => {
    const prepared = prepareDataset(
      makeDataset({
        axes: [
          { id: "primary", role: "primary", name: "温度", unit: "degC" },
        ],
        series: [
          {
            id: "constant-temp",
            name: "恒定温度",
            unit: "degC",
            role: "measured",
            axisId: "primary",
            points: [
              ["2026-01-01 00:00:00", 25],
              ["2026-01-01 00:10:00", 25],
            ],
          },
        ],
      }),
    );
    const options = buildChartOptions(
      prepared,
      config,
      presentationFor(prepared),
    );
    const [primaryAxis] = options.yAxis as Array<{
      min?: number;
      max?: number;
    }>;

    expect(primaryAxis).toMatchObject({ min: 10, max: 40 });
  });

  it("preserves manual y-axis bounds in both initial and update options", () => {
    const prepared = prepareOutlierDataset();
    const manualConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 12, max: 18 } },
    };
    const hiddenPresentation: ChartPresentation = {
      visibleSeries: new Set(),
      previewSeriesId: null,
    };
    const initial = buildChartOptions(prepared, manualConfig, hiddenPresentation);
    const update = buildChartUpdate(prepared, manualConfig, hiddenPresentation);

    expect((initial.yAxis as Array<Record<string, unknown>>)[0]).toMatchObject({
      min: 12,
      max: 18,
    });
    expect((update.yAxis as Array<Record<string, unknown>>)[0]).toMatchObject({
      min: 12,
      max: 18,
    });
  });

  it("keeps stable boundary axes through a visible-to-blank-to-visible cycle", () => {
    const prepared = prepareOutlierDataset();
    const initial = buildChartOptions(
      prepared,
      config,
      presentationFor(prepared),
    );
    const initialAxisIds = (initial.yAxis as Array<{ id: string }>).map(
      (axis) => axis.id,
    );
    expect(initialAxisIds).toEqual([
      "primary",
      "__y-boundary-mask-primary",
      "__y-boundary-line-primary",
    ]);
    const isolatedInitial = isolateYAxisOption(initial);
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(isolatedInitial);
      const beforeScale = runtimeChart(chart)
        .getModel()
        .getComponent("yAxis", 0).axis.scale;
      expect(beforeScale.isBlank()).toBe(false);

      const hiddenUpdate = buildChartUpdate(prepared, config, {
        visibleSeries: new Set(),
        previewSeriesId: null,
      });
      const hiddenAxes = hiddenUpdate.yAxis as Array<{
        id: string;
        show?: boolean;
      }>;
      expect(hiddenAxes.map((axis) => axis.id)).toEqual(initialAxisIds);
      expect(hiddenAxes).toEqual([
        expect.objectContaining({ id: "primary", show: false }),
        { id: "__y-boundary-mask-primary", show: false },
        expect.objectContaining({
          id: "__y-boundary-line-primary",
          show: false,
        }),
      ]);

      chart.setOption(hiddenUpdate);
      const hiddenRuntime = runtimeChart(chart);
      const afterScale = hiddenRuntime
        .getModel()
        .getComponent("yAxis", 0).axis.scale;
      const blankSvg = hiddenRuntime.renderToSVGString();
      const blankView = readRuntimeYAxisView(chart);
      const blankCustomValues = runtimeYAxisCustomValues(chart);

      expect(afterScale.isBlank()).toBe(true);
      expect(
        hiddenRuntime.getModel().getComponent("yAxis", 1).get("show"),
      ).toBe(false);
      expect(
        hiddenRuntime.getModel().getComponent("yAxis", 2).get("show"),
      ).toBe(false);
      expect(
        hiddenRuntime.getModel().getComponent("yAxis", 0).get("show"),
      ).toBe(false);
      expect(
        hiddenRuntime
          .getZr()
          .storage.getDisplayList(true, true)
          .filter((element) => element.z === 4 || element.z === 5),
      ).toHaveLength(0);
      expect(
        (chart.getOption().yAxis as Array<{ id: string }>).map(
          (axis) => axis.id,
        ),
      ).toEqual(initialAxisIds);
      expect(blankView.labels).toEqual([]);
      expect(blankView.tickValues).toEqual([]);
      expect(readRuntimeYAxisTickValues(chart)).toEqual([]);
      expect(blankCustomValues.labels).toEqual([]);
      expect(blankCustomValues.ticks).toEqual([]);
      expect(blankSvg.match(/<text\b/g) ?? []).toHaveLength(0);
      expect(blankSvg.match(/<path\b/g) ?? []).toHaveLength(0);

      const visibleAgainConfig: ChartConfig = {
        ...config,
        axes: { primary: { min: 0, max: 0.1 } },
        yGridCount: 6,
      };
      const visibleAgainUpdate = buildChartUpdate(
        prepared,
        visibleAgainConfig,
        presentationFor(prepared),
      );
      const visibleAgainAxes = visibleAgainUpdate.yAxis as Array<{
        id: string;
        show?: boolean;
      }>;
      expect(visibleAgainAxes.map((axis) => axis.id)).toEqual(initialAxisIds);
      expect(visibleAgainAxes).toEqual([
        expect.objectContaining({ id: "primary", show: true }),
        { id: "__y-boundary-mask-primary", show: true },
        expect.objectContaining({
          id: "__y-boundary-line-primary",
          show: true,
        }),
      ]);

      chart.setOption(visibleAgainUpdate);
      const visibleAgainView = readRuntimeYAxisView(chart);
      const visibleAgainCustomValues = runtimeYAxisCustomValues(chart);
      const visibleRuntime = runtimeChart(chart);
      const visibleBoundaryLines = visibleRuntime
        .getZr()
        .storage.getDisplayList(true, true)
        .filter(
          (element) =>
            (element.z === 4 || element.z === 5) && isVerticalLine(element),
        );

      expect(
        visibleRuntime.getModel().getComponent("yAxis", 1).get("show"),
      ).toBe(true);
      expect(
        visibleRuntime.getModel().getComponent("yAxis", 2).get("show"),
      ).toBe(true);
      expect(
        visibleRuntime.getModel().getComponent("yAxis", 0).get("show"),
      ).toBe(true);
      expect(visibleBoundaryLines).toHaveLength(2);
      expect(
        visibleRuntime
          .getZr()
          .storage.getDisplayList(true, true)
          .filter((element) => element.z === 4 || element.z === 5),
      ).toHaveLength(2);
      expect(
        (chart.getOption().yAxis as Array<{ id: string }>).map(
          (axis) => axis.id,
        ),
      ).toEqual(initialAxisIds);
      expect(visibleAgainView.labels).toEqual([
        "0", "0.02", "0.03", "0.05", "0.07", "0.08", "0.1",
      ]);
      expectExactYAxisTickValues(visibleAgainView.tickValues, 0, 0.1, 6);
      expectExactYAxisTickValues(readRuntimeYAxisTickValues(chart), 0, 0.1, 6);
      expect(visibleAgainCustomValues.labels).toEqual(
        expectedYAxisTickValues(0, 0.1, 6),
      );
      expect(visibleAgainCustomValues.ticks).toEqual(
        expectedYAxisTickValues(0, 0.1, 6),
      );
      expect(visibleAgainCustomValues.formatter).toEqual(expect.any(Function));
    } finally {
      chart.dispose();
    }
  });

  it("uses axis names from the parsed dataset instead of fixed labels", () => {
    const raw = makeDataset();
    const customDataset = prepareDataset({
      ...raw,
      controllerRule: "pressure-power-v1",
      axes: [
        { id: "power", role: "primary", name: "功率", unit: "kW" },
        { id: "pressure", role: "secondary", name: "压力", unit: "kPa" },
      ],
      series: raw.series.map((series) =>
        series.axisId === "primary"
          ? { ...series, unit: "kW", axisId: "power" }
          : { ...series, unit: "kPa", axisId: "pressure" },
      ),
    });

    const options = buildChartOptions(
      customDataset,
      config,
      presentationFor(customDataset),
    );
    const yAxis = options.yAxis as Array<{ name: string }>;
    const series = options.series as Array<{ yAxisIndex: number }>;

    expect(
      yAxis.slice(0, customDataset.axes.length).map((axis) => axis.name),
    ).toEqual(["功率 kW", "压力 kPa"]);
    expect(series.map((item) => item.yAxisIndex)).toEqual([0, 0, 1, 1]);
  });

  it("lays out a three-axis dataset with pressure hugging the plot edge", () => {
    const raw = makeDataset();
    const threeAxisDataset = prepareDataset({
      ...raw,
      controllerRule: "freud-history-csv-v1",
      axes: [
        { id: "primary", role: "primary", name: "温度", unit: "degC" },
        { id: "secondary", role: "secondary", name: "湿度", unit: "%RH" },
        { id: "pressure", role: "secondary", name: "气压", unit: "kPa" },
      ],
      series: [
        { ...raw.series[0], axisId: "primary", unit: "degC" },
        { ...raw.series[1], axisId: "primary", unit: "degC" },
        { ...raw.series[2], axisId: "secondary", unit: "%RH" },
        { ...raw.series[3], axisId: "secondary", unit: "%RH" },
        {
          id: "actual-pressure",
          name: "实测气压",
          unit: "kPa",
          role: "measured",
          axisId: "pressure",
          points: raw.series[0].points,
        },
        {
          id: "set-pressure",
          name: "设定气压",
          unit: "kPa",
          role: "setpoint",
          axisId: "pressure",
          points: raw.series[1].points,
        },
      ],
    });

    const options = buildChartOptions(
      threeAxisDataset,
      config,
      presentationFor(threeAxisDataset),
    );
    const yAxis = options.yAxis as Array<{
      id: string;
      name: string;
      position: string;
      offset: number;
      nameTextStyle: { color: string; fontSize: number; align: string };
      axisTick: {
        show: boolean;
        customValues: number[];
        inside?: boolean;
        length?: number;
        lineStyle?: { color: string };
      };
    }>;
    const dataAxes = yAxis.slice(0, threeAxisDataset.axes.length);
    const boundaryAxes = yAxis.slice(threeAxisDataset.axes.length);

    expect(dataAxes.map((axis) => axis.name)).toEqual([
      "温度 °C",
      "湿度 %RH",
      "气压 kPa",
    ]);
    expect(dataAxes.map((axis) => axis.position)).toEqual([
      "left",
      "right",
      "right",
    ]);
    expect(dataAxes.map((axis) => axis.offset)).toEqual([0, 60, 0]);
    expect(dataAxes.map((axis) => axis.axisTick.show)).toEqual([
      false,
      true,
      false,
    ]);
    expect(dataAxes.map((axis) => axis.nameTextStyle.align)).toEqual([
      "left",
      "left",
      "right",
    ]);
    for (const axis of dataAxes) {
      expect(axis.nameTextStyle).toMatchObject({
        color: "#757575",
        fontSize: 12,
      });
      expect(axis.axisTick.customValues).toHaveLength(7);
    }
    expect(dataAxes[0].axisTick).not.toHaveProperty("inside");
    expect(dataAxes[1].axisTick).toMatchObject({
      inside: true,
      length: 8,
      lineStyle: { color: "#e0e0e0" },
    });
    expect(dataAxes[2].axisTick).not.toHaveProperty("inside");
    expect(options.grid).toMatchObject({ right: 170 });

    expect(boundaryAxes).toHaveLength(6);
    const boundaryById = new Map(
      boundaryAxes.map((axis) => [axis.id, axis.offset]),
    );
    expect(boundaryById.get("__y-boundary-mask-secondary")).toBe(63);
    expect(boundaryById.get("__y-boundary-line-secondary")).toBe(60);
    expect(boundaryById.get("__y-boundary-mask-pressure")).toBe(3);
    expect(boundaryById.get("__y-boundary-line-pressure")).toBe(0);

    const series = options.series as Array<{
      id: string;
      yAxisIndex: number;
      lineStyle: { type: string };
    }>;
    expect(series.map((item) => item.yAxisIndex)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(
      Object.fromEntries(series.map((item) => [item.id, item.lineStyle.type])),
    ).toEqual({
      "set-temp": "dashed",
      "actual-temp": "solid",
      "set-humidity": "dashed",
      "actual-humidity": "solid",
      "actual-pressure": "solid",
      "set-pressure": "dashed",
    });
  });

  it("renders tick marks only on the outer secondary axis", () => {
    const raw = makeDataset();
    const threeAxisDataset = prepareDataset({
      ...raw,
      controllerRule: "freud-history-csv-v1",
      axes: [
        { id: "primary", role: "primary", name: "温度", unit: "degC" },
        { id: "secondary", role: "secondary", name: "湿度", unit: "%RH" },
        { id: "pressure", role: "secondary", name: "气压", unit: "kPa" },
      ],
      series: [
        { ...raw.series[0], axisId: "primary", unit: "degC" },
        { ...raw.series[1], axisId: "primary", unit: "degC" },
        { ...raw.series[2], axisId: "secondary", unit: "%RH" },
        { ...raw.series[3], axisId: "secondary", unit: "%RH" },
        {
          id: "actual-pressure",
          name: "实测气压",
          unit: "kPa",
          role: "measured",
          axisId: "pressure",
          points: raw.series[0].points,
        },
        {
          id: "set-pressure",
          name: "设定气压",
          unit: "kPa",
          role: "setpoint",
          axisId: "pressure",
          points: raw.series[1].points,
        },
      ],
    });
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });
    try {
      chart.setOption(
        buildChartOptions(
          threeAxisDataset,
          config,
          presentationFor(threeAxisDataset),
        ),
      );
      const elements = chart
        .getZr()
        .storage.getDisplayList(true, false) as unknown as Array<{
        type: string;
        style?: { stroke?: string };
        shape?: { x1?: number; y1?: number; x2?: number; y2?: number };
      }>;
      const shortHorizontalLines = (stroke: string) =>
        elements.filter((element) => {
          const { x1, y1, x2, y2 } = element.shape ?? {};
          return (
            element.type === "line" &&
            element.style?.stroke === stroke &&
            y1 === y2 &&
            Math.abs(x2! - x1!) > 0 &&
            Math.abs(x2! - x1!) < 30
          );
        });
      const humidityX = 800 - 170 + 60;
      const outerTicks = shortHorizontalLines("#e0e0e0").filter((element) => {
        const maxX = Math.max(element.shape!.x1!, element.shape!.x2!);
        return maxX >= humidityX - 0.5 && maxX <= humidityX + 0.5;
      });
      expect(outerTicks).toHaveLength(7);
      expect(shortHorizontalLines("#757575")).toHaveLength(0);
    } finally {
      chart.dispose();
    }
  });

  it("rejects a series that references an undefined axis", () => {
    const raw = makeDataset();
    const invalidDataset = prepareDataset({
      ...raw,
      series: [{ ...raw.series[0], axisId: "missing" }],
    });

    expect(() =>
      buildChartOptions(
        invalidDataset,
        config,
        presentationFor(invalidDataset),
      ),
    ).toThrow("曲线 设定温度 引用了不存在的纵坐标轴：missing");
  });

  it("rejects an axis contract without exactly one primary axis", () => {
    const raw = makeDataset();
    const invalidDataset = prepareDataset({
      ...raw,
      axes: [
        { id: "secondary", role: "secondary", name: "压力", unit: "kPa" },
      ],
      series: [],
    });

    expect(() =>
      buildChartOptions(
        invalidDataset,
        config,
        presentationFor(invalidDataset),
      ),
    ).toThrow("数据集必须定义且只能定义一条主坐标轴，并最多定义两条次坐标轴");
  });

  it("allocates stable boundary IDs without restricting data axis IDs", () => {
    const raw = makeDataset();
    const collidingAxisId = "__y-boundary-mask-primary";
    const collidingDataset = prepareDataset({
      ...raw,
      axes: [
        { id: "primary", role: "primary", name: "温度", unit: "degC" },
        {
          id: collidingAxisId,
          role: "secondary",
          name: "湿度",
          unit: "%RH",
        },
      ],
      series: raw.series.map((series) =>
        series.axisId === "secondary"
          ? { ...series, axisId: collidingAxisId }
          : series,
      ),
    });
    const visiblePresentation = presentationFor(collidingDataset);
    const hiddenPresentation: ChartPresentation = {
      visibleSeries: new Set(),
      previewSeriesId: null,
    };
    const initial = buildChartOptions(
      collidingDataset,
      config,
      visiblePresentation,
    );
    const hiddenUpdate = buildChartUpdate(
      collidingDataset,
      config,
      hiddenPresentation,
    );
    const visibleUpdate = buildChartUpdate(
      collidingDataset,
      config,
      visiblePresentation,
    );
    const initialAxes = initial.yAxis as Array<{ id: string }>;
    const hiddenAxes = hiddenUpdate.yAxis as Array<{
      id: string;
      show?: boolean;
    }>;
    const visibleAxes = visibleUpdate.yAxis as Array<{
      id: string;
      show?: boolean;
    }>;
    const realAxisIds = collidingDataset.axes.map((axis) => axis.id);
    const initialIds = initialAxes.map((axis) => axis.id);
    const overlayIds = initialIds.slice(collidingDataset.axes.length);

    expect(initialIds.slice(0, collidingDataset.axes.length)).toEqual(
      realAxisIds,
    );
    expect(new Set(initialIds).size).toBe(initialIds.length);
    expect(overlayIds).toHaveLength(collidingDataset.axes.length * 2);
    expect(overlayIds.every((id) => !realAxisIds.includes(id))).toBe(true);
    expect(overlayIds).toEqual([
      "__y-boundary-1-mask-primary",
      "__y-boundary-1-line-primary",
      `__y-boundary-1-mask-${collidingAxisId}`,
      `__y-boundary-1-line-${collidingAxisId}`,
    ]);
    expect(hiddenAxes.map((axis) => axis.id)).toEqual(initialIds);
    expect(visibleAxes.map((axis) => axis.id)).toEqual(initialIds);
    expect(
      hiddenAxes
        .slice(collidingDataset.axes.length)
        .map(({ id, show }) => ({ id, show })),
    ).toEqual(
      overlayIds.map((id) => ({ id, show: false })),
    );
    expect(
      visibleAxes
        .slice(collidingDataset.axes.length)
        .map(({ id, show }) => ({ id, show })),
    ).toEqual(
      overlayIds.map((id) => ({ id, show: true })),
    );

    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });
    try {
      chart.setOption(initial);
      chart.setOption(hiddenUpdate);
      expect(
        (chart.getOption().yAxis as Array<{ id: string }>).map(
          (axis) => axis.id,
        ),
      ).toEqual(initialIds);
      chart.setOption(visibleUpdate);
      expect(
        (chart.getOption().yAxis as Array<{ id: string }>).map(
          (axis) => axis.id,
        ),
      ).toEqual(initialIds);
    } finally {
      chart.dispose();
    }
  });

  it("keeps the default boundary namespace for noncolliding prefixed IDs", () => {
    const raw = makeDataset();
    const prefixedAxisId = `__y-boundary-${"_".repeat(512)}`;
    const prefixedDataset = prepareDataset({
      ...raw,
      axes: [
        { id: "primary", role: "primary", name: "温度", unit: "degC" },
        {
          id: prefixedAxisId,
          role: "secondary",
          name: "湿度",
          unit: "%RH",
        },
      ],
      series: raw.series.map((series) =>
        series.axisId === "secondary"
          ? { ...series, axisId: prefixedAxisId }
          : series,
      ),
    });
    const prefixedPresentation = presentationFor(prefixedDataset);
    const initial = buildChartOptions(
      prefixedDataset,
      config,
      prefixedPresentation,
    );
    const update = buildChartUpdate(
      prefixedDataset,
      config,
      prefixedPresentation,
    );
    const expectedOverlayIds = [
      "__y-boundary-mask-primary",
      "__y-boundary-line-primary",
      `__y-boundary-mask-${prefixedAxisId}`,
      `__y-boundary-line-${prefixedAxisId}`,
    ];

    expect(
      (initial.yAxis as Array<{ id: string }>)
        .slice(prefixedDataset.axes.length)
        .map((axis) => axis.id),
    ).toEqual(expectedOverlayIds);
    expect(
      (update.yAxis as Array<{ id: string }>)
        .slice(prefixedDataset.axes.length)
        .map((axis) => axis.id),
    ).toEqual(expectedOverlayIds);
  });

  it("uses only the inside zoom and omits the toolbox", () => {
    const controlledConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 20, max: 40 } },
    };
    const options = buildChartOptions(dataset, controlledConfig, presentation);
    const yAxis = options.yAxis as Array<{
      min?: number;
      max?: number;
      splitNumber: number;
    }>;
    const dataZoom = options.dataZoom as Array<Record<string, unknown>>;

    expect(yAxis[0]).toMatchObject({ min: 20, max: 40, splitNumber: 6 });
    expect(dataZoom).toHaveLength(1);
    expect(dataZoom[0]).toMatchObject({
      id: "inside-zoom",
      type: "inside",
      startValue: controlledConfig.xMin,
      endValue: controlledConfig.xMax,
      minValueSpan: 60_000,
      disabled: true,
      zoomOnMouseWheel: false,
      moveOnMouseWheel: false,
      moveOnMouseMove: false,
    });
    expect(dataZoom[0]).not.toHaveProperty("throttle");
    expect(dataZoom[0].filterMode).toBe("none");
    expect(dataZoom[0]).not.toHaveProperty("start");
    expect(dataZoom[0]).not.toHaveProperty("end");
    expect(options.toolbox).toBeUndefined();
  });

  it.each([3, 5, 7])(
    "renders exactly %s y-axis grid intervals for a non-divisible span",
    (count) => {
      const exactConfig: ChartConfig = {
        ...config,
        axes: {
          primary: { min: 0, max: 10 },
          secondary: { min: 40, max: 90 },
        },
        yGridCount: count,
      };

      const options = buildChartOptions(dataset, exactConfig, presentation);
      const axes = options.yAxis as Array<{ interval?: number }>;

      expect(axes[0].interval).toBeCloseTo(10 / count, 12);
      expect(axes[1].interval).toBeCloseTo(50 / count, 12);
      expect(runtimeYAxisTickCount(options, 0)).toBe(count + 1);
      expect(runtimeYAxisTickCount(options, 1)).toBe(count + 1);
    },
  );

  it("keeps exact y-axis intervals in incremental updates", () => {
    const exactConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 0, max: 10 } },
      yGridCount: 3,
    };

    const update = buildChartUpdate(dataset, exactConfig, presentation);
    const [primary] = update.yAxis as Array<{ interval?: number }>;

    expect(primary.interval).toBeCloseTo(10 / 3, 12);
  });

  it.each([
    {
      name: "thirds",
      min: 0,
      max: 10,
      count: 3,
      expected: ["0", "3.3", "6.7", "10"],
    },
    {
      name: "sevenths",
      min: -60,
      max: 100,
      count: 7,
      expected: ["-60", "-37.1", "-14.3", "8.6", "31.4", "54.3", "77.1", "100"],
    },
    {
      name: "integers",
      min: 0,
      max: 10,
      count: 5,
      expected: ["0", "2", "4", "6", "8", "10"],
    },
    {
      name: "sub-tenth ticks that remain distinct at one decimal",
      min: 0,
      max: 0.27,
      count: 3,
      expected: ["0", "0.1", "0.2", "0.3"],
    },
  ])(
    "formats common $name labels with at most one decimal",
    ({ min, max, count, expected }) => {
      const exactConfig: ChartConfig = {
        ...config,
        axes: { primary: { min, max } },
        yGridCount: count,
      };
      const { labels, tickValues } = ssrYAxisView(
        buildChartOptions(dataset, exactConfig, presentation),
      );

      expectExactYAxisTickValues(tickValues, min, max, count);
      expect(labels).toEqual(expected);
    },
  );

  it("uses only the precision needed to distinguish a tiny interval", () => {
    const tinyConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 0, max: 0.1 } },
      yGridCount: 5,
    };
    const { labels, tickValues } = ssrYAxisView(
      buildChartOptions(dataset, tinyConfig, presentation),
    );

    expect(labels).toEqual(["0", "0.02", "0.04", "0.06", "0.08", "0.1"]);
    expect(new Set(labels).size).toBe(labels.length);
    expectExactYAxisTickValues(tickValues, 0, 0.1, 5);
  });

  it("formats tooltip values one decimal beyond the y-axis label precision", () => {
    const tinyConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 0, max: 0.1 } },
      yGridCount: 5,
    };
    const extent = resolveYAxisExtents(dataset, tinyConfig, presentation).get(
      "primary",
    );
    expect(extent).not.toBeNull();
    const formatter = createYAxisValueFormatter(extent!, tinyConfig.yGridCount);

    expect(formatter(0.05)).toBe("0.050");
    expect(formatter(0.025)).toBe("0.025");
    expect(formatter(0)).toBe("0.000");
    expect(formatter(0.1)).toBe("0.100");
  });

  it("keeps the extra tooltip decimal even when the value rounds to an integer", () => {
    const extent = resolveYAxisExtents(dataset, config, presentation).get(
      "primary",
    );
    expect(extent).not.toBeNull();
    const formatter = createYAxisValueFormatter(extent!, config.yGridCount);

    expect(formatter(24.03)).toBe("24.03");
    expect(formatter(24.5)).toBe("24.50");
    expect(formatter(24.25)).toBe("24.25");
  });

  it("keeps at least one decimal when every y-axis label is an integer", () => {
    const integerConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 0, max: 5 } },
      yGridCount: 5,
    };
    const extent = resolveYAxisExtents(dataset, integerConfig, presentation).get(
      "primary",
    );
    expect(extent).not.toBeNull();
    const formatter = createYAxisValueFormatter(
      extent!,
      integerConfig.yGridCount,
    );

    expect(formatter(2.4)).toBe("2.4");
    expect(formatter(3.6)).toBe("3.6");
  });

  it("uses one more significant digit in exponential tooltip values than labels", () => {
    const formatter = createYAxisValueFormatter([0, 1e-20], 5);

    expect(formatter(0)).toBe("0");
    expect(formatter(2e-21)).toBe("2e-21");
    expect(formatter(2.4e-21)).toBe("2.4e-21");
    expect(formatter(1e-20)).toBe("1e-20");
  });

  it.each([
    {
      min: 0,
      max: 1e-20,
      expected: ["0", "2e-21", "4e-21", "6e-21", "8e-21", "1e-20"],
    },
    {
      min: 0,
      max: 1e-21,
      expected: ["0", "2e-22", "4e-22", "6e-22", "8e-22", "1e-21"],
    },
  ])(
    "keeps all SSR labels distinct for a sub-precision range [$min, $max]",
    ({ min, max, expected }) => {
      const count = 5;
      const { labels, tickValues } = ssrYAxisView(
        buildChartOptionsForSubPrecisionExtent(min, max, count),
      );

      expect(labels).toHaveLength(count + 1);
      expect(labels).toEqual(expected);
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels[0]).toBe("0");
      expect(labels.at(-1)).toBe(String(max));
      expect(labels.every((label) => !/^0\.0{10,}/.test(label))).toBe(true);
      expect(labels.every((label) => !/\.\d*0+e/.test(label))).toBe(true);
      expect(tickValues).toEqual(expectedYAxisTickValues(min, max, count));
    },
  );

  it.each([1e-21, 2.6e-20, 3e-20, 4e-20])(
    "renders a distinct exact tick plan for automatic extent [0, %s]",
    (dataMax) => {
      const prepared = prepareSubPrecisionDataset(dataMax);
      const count = 5;
      const automaticConfig: ChartConfig = {
        ...config,
        axes: {},
        yGridCount: count,
      };
      const option = buildChartOptions(
        prepared,
        automaticConfig,
        presentationFor(prepared),
      );
      const [primaryAxis] = option.yAxis as Array<{
        min?: number;
        max?: number;
      }>;
      const { labels, tickValues } = ssrYAxisView(option);

      // 自动范围按 3% 对称留白（与横向一致），数据不再从 0 起锚；
      // 用实际轴范围校验刻度计划与标签的完整性与唯一性。
      expect(primaryAxis.min).toBeDefined();
      expect(primaryAxis.max).toBeDefined();
      const min = primaryAxis.min!;
      const max = primaryAxis.max!;
      expect(labels).toHaveLength(count + 1);
      expect(new Set(labels).size).toBe(count + 1);
      expect(tickValues).toEqual(expectedYAxisTickValues(min, max, count));
    },
  );

  it.each([
    {
      name: "1e-20 origin range",
      min: 0,
      max: 1e-20,
      expected: ["0", "2e-21", "4e-21", "6e-21", "8e-21", "1e-20"],
    },
    {
      name: "1e-21 origin range",
      min: 0,
      max: 1e-21,
      expected: ["0", "2e-22", "4e-22", "6e-22", "8e-22", "1e-21"],
    },
    {
      name: "offset range requiring five significant digits",
      min: 1.2345e-20,
      max: 1.235e-20,
      expected: [
        "1.2345e-20",
        "1.2346e-20",
        "1.2347e-20",
        "1.2348e-20",
        "1.2349e-20",
        "1.235e-20",
      ],
    },
    {
      name: "range crossing zero",
      min: -5e-21,
      max: 5e-21,
      expected: [
        "-5e-21",
        "-3e-21",
        "-1e-21",
        "1e-21",
        "3e-21",
        "5e-21",
      ],
    },
  ])("formats $name exactly in the pure y-axis formatter", ({ min, max, expected }) => {
    const count = 5;
    const { labels, tickValues } = optionYAxisView(
      buildChartOptionsForSubPrecisionExtent(min, max, count),
    );

    expect(tickValues).toEqual(expectedYAxisTickValues(min, max, count));
    expect(labels).toEqual(expected);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("uses one exact logical tick plan for a six-part tiny initial range", () => {
    const min = 0;
    const max = 0.1;
    const count = 6;
    const exactConfig: ChartConfig = {
      ...config,
      axes: { primary: { min, max } },
      yGridCount: count,
    };
    const option = buildChartOptions(dataset, exactConfig, presentation);
    const [primaryAxis] = option.yAxis as Array<{ interval?: number }>;
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    expect(primaryAxis.interval).toBeCloseTo(0.1 / 6, 12);

    try {
      chart.setOption(isolateYAxisOption(option));
      const { labels, tickValues } = readRuntimeYAxisView(chart);

      expect(labels).toEqual(["0", "0.02", "0.03", "0.05", "0.07", "0.08", "0.1"]);
      expectExactYAxisTickValues(tickValues, min, max, count);
      expectExactYAxisTickValues(readRuntimeYAxisTickValues(chart), min, max, count);
      expect(primarySplitLineCount(chart)).toBe(count + 1);
    } finally {
      chart.dispose();
    }
  });

  it("replaces a visible range with the same exact six-part tiny tick plan", () => {
    const min = 0;
    const max = 0.1;
    const count = 6;
    const initialConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 0, max: 10 } },
      yGridCount: 5,
    };
    const updatedConfig: ChartConfig = {
      ...config,
      axes: { primary: { min, max } },
      yGridCount: count,
    };
    const update = buildChartUpdate(dataset, updatedConfig, presentation);
    const [primaryAxis] = update.yAxis as Array<{ interval?: number | null }>;
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    expect(primaryAxis.interval).toBeCloseTo(0.1 / 6, 12);

    try {
      chart.setOption(
        isolateYAxisOption(
          buildChartOptions(dataset, initialConfig, presentation),
        ),
      );
      chart.setOption(update);
      const { labels, tickValues } = readRuntimeYAxisView(chart);

      expect(labels).toEqual(["0", "0.02", "0.03", "0.05", "0.07", "0.08", "0.1"]);
      expectExactYAxisTickValues(tickValues, min, max, count);
      expectExactYAxisTickValues(readRuntimeYAxisTickValues(chart), min, max, count);
      expect(primarySplitLineCount(chart)).toBe(count + 1);
    } finally {
      chart.dispose();
    }
  });

  it("removes trailing zero and normalizes a rounded negative zero", () => {
    const zeroConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: -0.04, max: 0.16 } },
      yGridCount: 2,
    };

    const { labels, tickValues } = ssrYAxisView(
      buildChartOptions(dataset, zeroConfig, presentation),
    );

    expect(labels).toEqual(["0", "0.1", "0.2"]);
    expectExactYAxisTickValues(tickValues, -0.04, 0.16, 2);
  });

  it("recomputes y-axis label precision in incremental updates", () => {
    const initialConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 0, max: 0.1 } },
      yGridCount: 5,
    };
    const updatedConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: -60, max: 100 } },
      yGridCount: 7,
    };
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });
    try {
      chart.setOption(buildChartOptions(dataset, initialConfig, presentation));
      chart.setOption(buildChartUpdate(dataset, updatedConfig, presentation));
      const { labels, tickValues } = readRuntimeYAxisView(chart);

      expect(labels).toEqual([
        "-60", "-37.1", "-14.3", "8.6", "31.4", "54.3", "77.1", "100",
      ]);
      expectExactYAxisTickValues(tickValues, -60, 100, 7);
    } finally {
      chart.dispose();
    }
  });

  it("uses unique series ids as the hidden ECharts legend identity", () => {
    const options = buildChartOptions(dataset, config, presentation);

    expect(options.legend).toMatchObject({
      show: false,
      data: ["actual-temp", "set-temp", "actual-humidity", "set-humidity"],
      selected: {
        "actual-temp": true,
        "set-temp": true,
        "actual-humidity": true,
        "set-humidity": true,
      },
    });
  });

  it("selects duplicate business names independently by unique series id", () => {
    const raw = makeDataset();
    const duplicateNameDataset = prepareDataset({
      ...raw,
      series: [
        {
          ...raw.series.find((series) => series.id === "actual-temp")!,
          id: "temperature-a",
          name: "同名温度",
        },
        {
          ...raw.series.find((series) => series.id === "set-temp")!,
          id: "temperature-b",
          name: "同名温度",
        },
      ],
    });
    const duplicateNamePresentation: ChartPresentation = {
      visibleSeries: new Set(["temperature-a"]),
      previewSeriesId: null,
    };

    const options = buildChartOptions(
      duplicateNameDataset,
      config,
      duplicateNamePresentation,
    );
    const legend = options.legend as {
      data: string[];
      selected: Record<string, boolean>;
    };
    const series = options.series as Array<{ name: string }>;

    expect(duplicateNameDataset.series.map((item) => item.name)).toEqual([
      "同名温度",
      "同名温度",
    ]);
    expect(legend.data).toEqual(["temperature-a", "temperature-b"]);
    expect(legend.selected).toEqual({
      "temperature-a": true,
      "temperature-b": false,
    });
    expect(series.map((item) => item.name)).toEqual([
      "temperature-a",
      "temperature-b",
    ]);
  });

  it("keeps subsecond data bounds and widens the x extent to cover the viewport", () => {
    const subsecondDataset = prepareDataset(
      makeDataset({
        timeRange: {
          start: "2026-01-01 00:00:00.000",
          end: "2026-01-01 00:00:00.500",
        },
      }),
    );

    const options = buildChartOptions(
      subsecondDataset,
      config,
      presentationFor(subsecondDataset),
    );
    const xAxis = options.xAxis as { min: number; max: number };
    const subsecondBounds = {
      start: new Date("2026-01-01T00:00:00.000").getTime(),
      end: new Date("2026-01-01T00:00:00.500").getTime(),
    };

    expect(xAxis.min).toBeLessThanOrEqual(subsecondBounds.start);
    expect(xAxis.max).toBeGreaterThanOrEqual(subsecondBounds.end);
    const viewportSpan = config.xMax - config.xMin;
    expect(xAxis.min).toBe(config.xMin - viewportSpan);
    expect(xAxis.max).toBe(config.xMax + viewportSpan);
  });

  it("widens the x-axis extent so the viewport can roam beyond the data bounds", () => {
    const beyond = {
      ...config,
      xMin: config.xMax + 60_000,
      xMax: config.xMax + 600_000,
    };
    const options = buildChartOptions(dataset, beyond, presentation);
    const xAxis = options.xAxis as { min: number; max: number };
    const viewportSpan = beyond.xMax - beyond.xMin;

    expect(xAxis.min).toBe(
      Math.min(new Date("2026-01-01T00:00:00").getTime(), beyond.xMin - viewportSpan),
    );
    expect(xAxis.max).toBe(beyond.xMax + viewportSpan);

    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });
    try {
      chart.setOption(options);
      const dataZoom = chart.getOption().dataZoom as Array<{
        startValue: number;
        endValue: number;
      }>;
      expect(dataZoom[0].startValue).toBe(beyond.xMin);
      expect(dataZoom[0].endValue).toBe(beyond.xMax);
    } finally {
      chart.dispose();
    }
  });

  it.each([
    [
      "invalid",
      { start: "not-a-time", end: "2026-01-01 00:10:00" },
      "数据集时间范围无效",
    ],
    [
      "reversed",
      { start: "2026-01-01 00:10:00", end: "2026-01-01 00:00:00" },
      "数据集时间范围的开始时间必须早于结束时间",
    ],
  ])("rejects an %s dataset time range", (_label, timeRange, message) => {
    const invalidDataset = prepareDataset(makeDataset({ timeRange }));

    expect(() =>
      buildChartOptions(
        invalidDataset,
        config,
        presentationFor(invalidDataset),
      ),
    ).toThrow(message);
  });

  it.each([
    [
      "non-finite",
      { ...config, xMin: Number.NaN },
      "图表时间范围无效",
    ],
    [
      "reversed",
      { ...config, xMin: config.xMax, xMax: config.xMin },
      "图表时间范围的开始时间必须早于结束时间",
    ],
  ])("rejects a %s configured time range", (_label, invalidConfig, message) => {
    expect(() =>
      buildChartOptions(dataset, invalidConfig, presentation),
    ).toThrow(message);
  });
});

describe("buildChartUpdate", () => {
  it("updates native axis-pointer visibility without forcing a shown status", () => {
    const hidden = buildChartUpdate(dataset, config, {
      visibleSeries: new Set(["missing-series"]),
      previewSeriesId: null,
    }).xAxis as { axisPointer: Record<string, unknown> };
    const visible = buildChartUpdate(dataset, config, presentation).xAxis as {
      axisPointer: Record<string, unknown>;
    };

    expect(hidden.axisPointer).toEqual({ show: false, status: "hide" });
    expect(visible.axisPointer).toEqual({ show: true });
    expect(visible.axisPointer).not.toHaveProperty("status");
  });

  it("hides and restores vertical grid lines through a blank cycle", () => {
    const splitLine = (visibleSeries: ReadonlySet<string>) =>
      (
        buildChartUpdate(dataset, config, {
          visibleSeries,
          previewSeriesId: null,
        }).xAxis as { splitLine: { show: boolean } }
      ).splitLine;

    expect(splitLine(presentation.visibleSeries).show).toBe(true);
    expect(splitLine(new Set()).show).toBe(false);
    expect(splitLine(presentation.visibleSeries).show).toBe(true);
  });

  it("updates presentation, exact x ticks, and axes without resending series data", () => {
    const update = buildChartUpdate(dataset, config, presentation);
    const xAxis = update.xAxis as {
      axisTick: { show: boolean; customValues: number[] };
      axisLabel: { customValues: number[] };
    };
    const yAxis = update.yAxis as Array<{
      id: string;
      show?: boolean;
      splitNumber?: number;
    }>;
    const dataAxes = yAxis.slice(0, dataset.axes.length);
    const series = update.series as Array<Record<string, unknown>>;
    const dataZoom = update.dataZoom as Array<Record<string, unknown>>;

    expect(xAxis.axisTick).toMatchObject({ show: false });
    expect(xAxis.axisTick.customValues).toHaveLength(7);
    expect(xAxis.axisLabel.customValues).toEqual(
      xAxis.axisTick.customValues,
    );
    expect(yAxis).toHaveLength(6);
    expect(dataAxes.every((axis) => axis.splitNumber === 6)).toBe(true);
    expect(dataAxes[0]).toMatchObject({ min: 23.8, max: 25.2 });
    expect(dataAxes[1]).toMatchObject({ min: 58, max: 64 });
    expect(
      yAxis
        .slice(dataset.axes.length)
        .map(({ id, show }) => ({ id, show })),
    ).toEqual([
      { id: "__y-boundary-mask-primary", show: true },
      { id: "__y-boundary-line-primary", show: true },
      { id: "__y-boundary-mask-secondary", show: true },
      { id: "__y-boundary-line-secondary", show: true },
    ]);
    expect(series.map((item) => item.id)).toEqual([
      "actual-temp",
      "set-temp",
      "actual-humidity",
      "set-humidity",
    ]);
    for (const item of series) {
      expect(item).not.toHaveProperty("data");
      expect(item).not.toHaveProperty("markLine");
    }
    expect(dataZoom).toEqual([
      {
        id: "inside-zoom",
        startValue: config.xMin,
        endValue: config.xMax,
      },
    ]);
  });

  it("switches horizontal grid line ownership when the primary axis visibility changes", () => {
    const splitLineState = (update: EChartsOption) =>
      ((update.yAxis as Array<{
        id: string;
        splitLine: { show: boolean };
      }>)
        .slice(0, dataset.axes.length)
        .map(({ id, splitLine }) => ({
          id,
          splitLine: splitLine.show,
        })));

    expect(
      splitLineState(buildChartUpdate(dataset, config, presentation)),
    ).toEqual([
      { id: "primary", splitLine: true },
      { id: "secondary", splitLine: false },
    ]);
    expect(
      splitLineState(
        buildChartUpdate(dataset, config, {
          visibleSeries: new Set(["actual-humidity", "set-humidity"]),
          previewSeriesId: null,
        }),
      ),
    ).toEqual([
      { id: "primary", splitLine: false },
      { id: "secondary", splitLine: true },
    ]);
    expect(
      splitLineState(
        buildChartUpdate(dataset, config, {
          visibleSeries: new Set(),
          previewSeriesId: null,
        }),
      ),
    ).toEqual([
      { id: "primary", splitLine: false },
      { id: "secondary", splitLine: false },
    ]);
  });

  it("moves horizontal grid line ownership to the pressure axis when only pressure remains visible", () => {
    const threeAxisDataset = prepareThreeAxisDataset();
    const splitLineState = (update: EChartsOption) =>
      ((update.yAxis as Array<{
        id: string;
        splitLine: { show: boolean };
      }>)
        .slice(0, threeAxisDataset.axes.length)
        .map(({ id, splitLine }) => ({
          id,
          splitLine: splitLine.show,
        })));

    expect(
      splitLineState(
        buildChartUpdate(threeAxisDataset, config, {
          visibleSeries: new Set(["actual-pressure", "set-pressure"]),
          previewSeriesId: null,
        }),
      ),
    ).toEqual([
      { id: "primary", splitLine: false },
      { id: "secondary", splitLine: false },
      { id: "pressure", splitLine: true },
    ]);
  });

  it("keeps horizontal grid lines when a legend switch moves them to the secondary axis", () => {
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(buildChartOptions(dataset, config, presentation));
      chart.setOption(
        buildChartUpdate(dataset, config, {
          visibleSeries: new Set(["actual-humidity", "set-humidity"]),
          previewSeriesId: null,
        }),
      );
      const horizontalGridLines = runtimeChart(chart)
        .getZr()
        .storage.getDisplayList(true, true)
        .filter(
          (element) =>
            element.style?.stroke === "#e0e0e0" &&
            isHorizontalLine(element),
        );

      expect(horizontalGridLines.length).toBeGreaterThan(0);
    } finally {
      chart.dispose();
    }
  });

  it("keeps horizontal grid lines when a legend switch leaves only the pressure group visible", () => {
    const threeAxisDataset = prepareThreeAxisDataset();
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(
        buildChartOptions(
          threeAxisDataset,
          config,
          presentationFor(threeAxisDataset),
        ),
      );
      chart.setOption(
        buildChartUpdate(threeAxisDataset, config, {
          visibleSeries: new Set(["actual-pressure", "set-pressure"]),
          previewSeriesId: null,
        }),
      );
      const horizontalGridLines = runtimeChart(chart)
        .getZr()
        .storage.getDisplayList(true, true)
        .filter(
          (element) =>
            element.style?.stroke === "#e0e0e0" &&
            isHorizontalLine(element),
        );

      expect(horizontalGridLines.length).toBeGreaterThan(0);
    } finally {
      chart.dispose();
    }
  });

  it("removes native vertical grid lines when all series hide", () => {
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    try {
      chart.setOption(buildChartOptions(dataset, config, presentation));
      const verticalGridLines = () =>
        runtimeChart(chart)
          .getZr()
          .storage.getDisplayList(true, true)
          .filter(
            (element) =>
              element.style?.stroke === "#e0e0e0" &&
              isVerticalLine(element),
          );

      expect(verticalGridLines().length).toBeGreaterThan(0);

      chart.setOption(
        buildChartUpdate(dataset, config, {
          visibleSeries: new Set(),
          previewSeriesId: null,
        }),
      );
      expect(verticalGridLines()).toHaveLength(0);

      chart.setOption(buildChartUpdate(dataset, config, presentation));
      expect(verticalGridLines().length).toBeGreaterThan(0);
    } finally {
      chart.dispose();
    }
  });

  it("restores real ECharts label layout through same-day and cross-day updates", () => {
    const wideDataset = prepareDataset(
      makeDataset({
        timeRange: {
          start: "2026-01-01 00:00:00",
          end: "2026-01-02 00:10:00",
        },
      }),
    );
    const widePresentation = presentationFor(wideDataset);
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 980,
      height: 800,
    });
    try {
      const secondsConfig = {
        ...config,
        xMax: config.xMin + 60_000,
        xGridCount: 6,
      };
      chart.setOption(
        buildChartOptions(wideDataset, secondsConfig, widePresentation),
      );
      expect(readRuntimeXAxisView(chart).labels).toEqual([
        "00:00:00\n01-01",
        "00:00:10",
        "00:00:20",
        "00:00:30",
        "00:00:40",
        "00:00:50",
        "00:01:00",
      ]);

      const crossDayConfig = {
        ...config,
        xMin: new Date("2026-01-01T23:59:00").getTime(),
        xMax: new Date("2026-01-02T00:01:00").getTime(),
        xGridCount: 6,
      };
      chart.setOption(
        buildChartUpdate(wideDataset, crossDayConfig, widePresentation),
      );
      const runtime = runtimeChart(chart);
      const crossDayAxis = runtime.getModel().getComponent("xAxis", 0);
      const crossDayLabels = readRuntimeXAxisView(chart).labels;
      const gridX = runtime
        .getModel()
        .getComponent("grid", 0).coordinateSystem.getRect().x;
      const crossDayFirst = runtime
        .getZr()
        .storage.getDisplayList(true, false)
        .find(
          (element) =>
            element.type === "tspan" &&
            element.style?.text === crossDayLabels[0],
        )!;
      const crossDayRect = transformedRect(crossDayFirst);

      expect(crossDayLabels[0]).toBe("01-01 23:59:00");
      expect(crossDayLabels.every((label) => !label.includes("\n"))).toBe(true);
      expect(crossDayAxis.get("axisLabel.alignMinLabel")).toBe("center");
      expect(crossDayAxis.get("axisLabel.showMinLabel")).not.toBe(true);
      expect(crossDayAxis.get("axisLabel.lineHeight")).toBeUndefined();
      expect(crossDayRect.x + crossDayRect.width / 2).toBeCloseTo(gridX, 5);

      chart.setOption(
        buildChartUpdate(wideDataset, secondsConfig, widePresentation),
      );
      const sameDayAxis = runtime.getModel().getComponent("xAxis", 0);
      const sameDayLabels = readRuntimeXAxisView(chart).labels;
      const tspans = runtime
        .getZr()
        .storage.getDisplayList(true, false)
        .filter(
          (element) =>
            element.type === "tspan" &&
            (element.style?.text === "00:00:00" ||
              element.style?.text === "01-01"),
        );
      expect(sameDayLabels[0]).toBe("00:00:00\n01-01");
      expect(sameDayAxis.get("axisLabel.alignMinLabel")).toBe("left");
      expect(sameDayAxis.get("axisLabel.showMinLabel")).toBe(true);
      expect(sameDayAxis.get("axisLabel.fontSize")).toBe(12);
      expect(sameDayAxis.get("axisLabel.lineHeight")).toBe(16);
      expect(
        transformedRect(
          tspans.find((element) => element.style?.text === "00:00:00")!,
        ).x,
      ).toBeCloseTo(gridX, 5);
      expect(
        transformedRect(
          tspans.find((element) => element.style?.text === "01-01")!,
        ).x,
      ).toBeCloseTo(gridX, 5);
    } finally {
      chart.dispose();
    }
  });

  it("uses null bounds to clear a previous automatic extent when all series hide", () => {
    const prepared = prepareOutlierDataset();
    const update = buildChartUpdate(prepared, config, {
      visibleSeries: new Set(),
      previewSeriesId: null,
    });
    const [primaryAxis] = update.yAxis as Array<Record<string, unknown>>;

    expect(primaryAxis).toMatchObject({ min: null, max: null });
  });

  it("injects render data only when it is explicitly provided", () => {
    const prepared = prepareSparseDataset();
    const renderData = prepared.series.map((series) => series.points);
    const update = buildChartUpdate(
      prepared,
      configForMinutes(9, 11),
      presentationFor(prepared),
      renderData,
    );
    const [series] = update.series as Array<Record<string, unknown>>;
    const yAxis = update.yAxis as Array<{ id: string }>;

    expect(series.data).toBe(renderData[0]);
    expect(series).not.toHaveProperty("markLine");
    expect(yAxis).toHaveLength(1);
    expect(yAxis[0].id).toBe("primary");
    expect(
      yAxis.some((axis) => axis.id.startsWith("__y-boundary-")),
    ).toBe(false);
  });

  it("preserves boundary axes when a render-data update omits them", () => {
    const initial = buildChartOptions(dataset, config, presentation);
    const initialAxisIds = (initial.yAxis as Array<{ id: string }>).map(
      (axis) => axis.id,
    );
    const renderData = dataset.series.map((series) => series.points);
    const update = buildChartUpdate(
      dataset,
      config,
      presentation,
      renderData,
    );
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 600,
    });

    const boundaryState = () => {
      const runtime = runtimeChart(chart);
      const displayList = runtime.getZr().storage.getDisplayList(true, true);
      const elements = displayList.filter(
        (element) => element.z === 4 || element.z === 5,
      );
      const lines = elements.filter(isVerticalLine);
      return {
        elements,
        lines,
        zOrder: lines.map((line) => line.z),
        maskIndexes: lines.flatMap((line) =>
          line.z === 4 ? [displayList.indexOf(line)] : [],
        ),
        edgeIndexes: lines.flatMap((line) =>
          line.z === 5 ? [displayList.indexOf(line)] : [],
        ),
      };
    };

    try {
      chart.setOption(initial);
      const before = boundaryState();
      expect(initialAxisIds).toHaveLength(dataset.axes.length * 3);
      expect(before.elements).toHaveLength(4);
      expect(before.lines).toHaveLength(4);
      expect(before.maskIndexes).toHaveLength(2);
      expect(before.edgeIndexes).toHaveLength(2);
      expect(Math.min(...before.edgeIndexes)).toBeGreaterThan(
        Math.max(...before.maskIndexes),
      );

      chart.setOption(update);
      const after = boundaryState();
      expect(
        (chart.getOption().yAxis as Array<{ id: string }>).map(
          (axis) => axis.id,
        ),
      ).toEqual(initialAxisIds);
      expect(after.elements).toHaveLength(4);
      expect(after.lines).toHaveLength(4);
      expect(after.maskIndexes).toHaveLength(2);
      expect(after.edgeIndexes).toHaveLength(2);
      expect(after.zOrder).toEqual(before.zOrder);
      expect(Math.min(...after.edgeIndexes)).toBeGreaterThan(
        Math.max(...after.maskIndexes),
      );
      for (
        let axisIndex = dataset.axes.length;
        axisIndex < initialAxisIds.length;
        axisIndex += 1
      ) {
        expect(
          runtimeChart(chart)
            .getModel()
            .getComponent("yAxis", axisIndex)
            .get("show"),
        ).toBe(true);
      }
    } finally {
      chart.dispose();
    }
  });
});
