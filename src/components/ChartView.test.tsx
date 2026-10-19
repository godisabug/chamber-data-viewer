import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartConfig } from "../chartOptions";
import {
  CHART_INTERACTION_IDLE_MS,
  LOD_PREFETCH_VIEWPORTS,
  lodPointBudget,
} from "../chartLod";
import { CHART_INPUT_FRAME_FALLBACK_MS } from "../chartInputScheduler";
import { zoomRangeFromWheel, type NumericRange } from "../chartRange";
import { prepareDataset, type PreparedDataset } from "../chartSeries";
import {
  DEFAULT_CHART_SETTINGS,
  type AppliedChartSettings,
} from "../chartSettings";
import { makeDataset } from "../test/fixtures";
import { panYAxisRange, zoomYAxisToGrid } from "../chartYRange";
import { ChartView } from "./ChartView";

type EChartsHandler = (event: Record<string, unknown>) => void;

const echartsMock = vi.hoisted(() => {
  const chartHandlers = new Map<string, EChartsHandler>();
  const zrHandlers = new Map<string, EChartsHandler>();
  const zr = {
    flush: vi.fn(),
    on: vi.fn((eventName: string, handler: EChartsHandler) => {
      zrHandlers.set(eventName, handler);
    }),
    off: vi.fn((eventName: string, handler: EChartsHandler) => {
      if (zrHandlers.get(eventName) === handler) zrHandlers.delete(eventName);
    }),
  };
  const chart = {
    setOption: vi.fn(),
    on: vi.fn((eventName: string, handler: EChartsHandler) => {
      chartHandlers.set(eventName, handler);
    }),
    off: vi.fn((eventName: string, handler: EChartsHandler) => {
      if (chartHandlers.get(eventName) === handler) chartHandlers.delete(eventName);
    }),
    getOption: vi.fn(() => ({})),
    containPixel: vi.fn(() => true),
    convertFromPixel: vi.fn(() => [0, 0]),
    convertToPixel: vi.fn((_finder: unknown, _value: unknown) => 240),
    getZr: vi.fn(() => zr),
    dispatchAction: vi.fn(
      (
        action: Record<string, unknown>,
        options?: { flush?: boolean; silent?: boolean },
      ) => {
        if (action.type !== "dataZoom") return;
        if (!options?.silent) {
          chartHandlers.get("datazoom")?.({
            startValue: action.startValue,
            endValue: action.endValue,
          });
        }
        if (options?.flush) zr.flush();
      },
    ),
    getDataURL: vi.fn(() => "data:image/png;base64,Y2hhcnQ="),
    resize: vi.fn(),
    dispose: vi.fn(),
  };
  const init = vi.fn(() => chart);

  return { chart, chartHandlers, init, zr, zrHandlers };
});

const tauriMock = vi.hoisted(() => ({
  saveChartImage: vi.fn(),
}));

const chartExportMock = vi.hoisted(() => ({
  CHART_EXPORT_PIXEL_RATIO: 2,
  createChartExportDataUrl: vi.fn(),
  createChartImageFileName: vi.fn(),
}));

vi.mock("echarts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("echarts")>()),
  init: echartsMock.init,
}));

vi.mock("../tauri", () => ({
  saveChartImage: tauriMock.saveChartImage,
}));

vi.mock("../chartExport", () => ({
  CHART_EXPORT_PIXEL_RATIO: chartExportMock.CHART_EXPORT_PIXEL_RATIO,
  createChartExportDataUrl: chartExportMock.createChartExportDataUrl,
  createChartImageFileName: chartExportMock.createChartImageFileName,
}));

const dataset = prepareDataset(makeDataset());
const bounds = {
  start: new Date("2026-01-01T00:00:00").getTime(),
  end: new Date("2026-01-01T00:10:00").getTime(),
};
const config: ChartConfig = {
  ...DEFAULT_CHART_SETTINGS,
  xMin: bounds.start,
  xMax: bounds.end,
};
const allSeries = new Set(dataset.series.map((series) => series.id));

function formatLocalTimestamp(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function makeLargeDataset(pointCount = 20_000): PreparedDataset {
  const start = bounds.start;
  const end = start + (pointCount - 1) * 1_000;
  return {
    ...dataset,
    sourceId: "c:/fixtures/large.csv",
    sourceFile: "large.csv",
    rowCount: pointCount,
    timeRange: {
      start: formatLocalTimestamp(start),
      end: formatLocalTimestamp(end),
    },
    series: dataset.series.map((series, seriesIndex) => {
      const points = Array.from(
        { length: pointCount },
        (_, pointIndex) =>
          [
            start + pointIndex * 1_000,
            seriesIndex * 100_000 + Math.sin(pointIndex / 10),
          ] as [number, number],
      );
      return {
        ...series,
        points,
        valueExtent: [
          seriesIndex * 100_000 - 1,
          seriesIndex * 100_000 + 1,
        ] as [number, number],
      };
    }),
  };
}

function dataBearingSetOptionCalls(): Array<{
  option: {
    dataZoom?: Array<Record<string, unknown>>;
    series?: Array<Record<string, unknown>>;
    xAxis?: Record<string, unknown>;
    yAxis?: Array<Record<string, unknown>>;
  };
  options: unknown;
}> {
  return echartsMock.chart.setOption.mock.calls
    .map(([option, options]) => ({
      option: option as {
        dataZoom?: Array<Record<string, unknown>>;
        series?: Array<Record<string, unknown>>;
        xAxis?: Record<string, unknown>;
      },
      options,
    }))
    .filter(({ option }) =>
      option.series?.some((series) => "data" in series),
    );
}

type ChartViewProps = {
  dataset: PreparedDataset;
  config: ChartConfig;
  visibleSeries: ReadonlySet<string>;
  previewSeriesId: string | null;
  lockedAxisIds: ReadonlySet<string>;
  cursorVisible: boolean;
  onToggleAxisLock: (axisId: string) => void;
  onClearAxisLocks: () => void;
  onVisibleRangeChange: (range: NumericRange) => void;
  onSettingsChange: (settings: AppliedChartSettings) => void;
  emptyWithinAxisRange: boolean;
};

type PropsChange = (props: ChartViewProps) => ChartViewProps;

/** 指针仍停在图上时，这些变化应让游标按最新状态重算，而不是等下一次鼠标移动。 */
const cursorRefreshes: Array<[string, PropsChange]> = [
  [
    "config",
    (props) => ({
      ...props,
      config: { ...props.config, xMin: props.config.xMin + 1_000 },
    }),
  ],
  [
    "preview series",
    (props) => ({ ...props, previewSeriesId: "actual-temp" }),
  ],
  [
    "empty-range state",
    (props) => ({ ...props, emptyWithinAxisRange: true }),
  ],
];

/** 这些变化之后没有可显示的游标：轴线和读数卡片必须一起消失。 */
const cursorDismissals: Array<[string, PropsChange]> = [
  ["dataset", (props) => ({ ...props, dataset: { ...props.dataset } })],
  ["visible series", (props) => ({ ...props, visibleSeries: new Set() })],
  ["cursor switch", (props) => ({ ...props, cursorVisible: false })],
];

type AxisPointerAction = {
  type: string;
  currTrigger?: string;
  x?: number;
  y?: number;
};

/** ChartView 发给 ECharts 的游标轴线指令，按先后顺序。 */
function axisPointerActions(): AxisPointerAction[] {
  return echartsMock.chart.dispatchAction.mock.calls
    .map(([action]) => action as AxisPointerAction)
    .filter((action) => action.type === "updateAxisPointer");
}

const resizeObservers: ResizeObserverStub[] = [];
const clipboardWrite = vi.fn<Clipboard["write"]>();
const clipboardPayloads: Array<Record<string, Blob>> = [];
const animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 1;
let settleFrameTimestamp = 0;
let nowValue = 0;
const PAN_FRAME_FALLBACK_MS = CHART_INPUT_FRAME_FALLBACK_MS;

function flushAnimationFrame(timestamp = 16): void {
  const pending = [...animationFrames.entries()];
  for (const [frameId, callback] of pending) {
    animationFrames.delete(frameId);
    callback(timestamp);
  }
}

function flushSettleFrames(frameCount = 14, stepMs = 16): void {
  for (let frame = 1; frame <= frameCount; frame += 1) {
    settleFrameTimestamp += stepMs;
    act(() => flushAnimationFrame(settleFrameTimestamp));
  }
}

function emitWheel(wheelDelta: number, inside = true, shiftKey = false) {
  const preventDefault = vi.fn();
  echartsMock.chart.containPixel.mockReturnValue(inside);
  act(() => {
    echartsMock.zrHandlers.get("mousewheel")?.({
      offsetX: 500,
      offsetY: 240,
      wheelDelta,
      event: { preventDefault, shiftKey },
    });
  });
  return preventDefault;
}

function mockCurveHitAxis(axisId: "primary" | "secondary" | null): void {
  echartsMock.chart.convertToPixel.mockImplementation((finder, value) => {
    const axisIndex = Number(
      (finder as { yAxisIndex?: number }).yAxisIndex ?? 0,
    );
    const numericValue = Number(value);
    if (axisIndex === 0 && axisId === "primary") {
      return 280 - numericValue * 1.6;
    }
    if (axisIndex === 1 && axisId === "secondary") {
      return 357 - numericValue * 2;
    }
    return 500 - numericValue * 2;
  });
}

class ClipboardItemStub {
  readonly presentationStyle = "unspecified" as PresentationStyle;
  readonly types: string[];
  readonly payload: Record<string, Blob>;

  constructor(payload: Record<string, Blob>) {
    this.payload = payload;
    this.types = Object.keys(payload);
    clipboardPayloads.push(payload);
  }

  getType(type: string): Promise<Blob> {
    return Promise.resolve(this.payload[type]);
  }
}

class ResizeObserverStub implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
}

function makeQueuedChart() {
  const chartHandlers = new Map<string, EChartsHandler>();
  const zrHandlers = new Map<string, EChartsHandler>();
  let disposed = false;
  let queuedDataZoom:
    | { event: Record<string, unknown>; handler?: EChartsHandler }
    | undefined;
  const zr = {
    flush: vi.fn(),
    on: vi.fn((eventName: string, handler: EChartsHandler) => {
      zrHandlers.set(eventName, handler);
    }),
    off: vi.fn((eventName: string, handler: EChartsHandler) => {
      if (zrHandlers.get(eventName) === handler) zrHandlers.delete(eventName);
    }),
  };
  const chart = {
    setOption: vi.fn(),
    on: vi.fn((eventName: string, handler: EChartsHandler) => {
      chartHandlers.set(eventName, handler);
    }),
    off: vi.fn((eventName: string, handler: EChartsHandler) => {
      if (chartHandlers.get(eventName) === handler) chartHandlers.delete(eventName);
    }),
    getOption: vi.fn(() => ({})),
    containPixel: vi.fn(() => true),
    convertFromPixel: vi.fn(() => [0, 0]),
    convertToPixel: vi.fn((_finder: unknown, _value: unknown) => 240),
    getZr: vi.fn(() => zr),
    dispatchAction: vi.fn(),
    getDataURL: vi.fn(() => "data:image/png;base64,Y2hhcnQ="),
    resize: vi.fn(),
    dispose: vi.fn(() => {
      disposed = true;
    }),
  };

  return {
    chart,
    queueDataZoom(event: Record<string, unknown>) {
      queuedDataZoom = {
        event,
        handler: chartHandlers.get("datazoom"),
      };
    },
    flushDataZoom() {
      if (disposed) return;
      queuedDataZoom?.handler?.(queuedDataZoom.event);
      queuedDataZoom = undefined;
    },
  };
}

function makeProps(overrides: Partial<ChartViewProps> = {}): ChartViewProps {
  return {
    dataset,
    config,
    visibleSeries: allSeries,
    previewSeriesId: null,
    lockedAxisIds: new Set(),
    cursorVisible: true,
    onToggleAxisLock: vi.fn(),
    onClearAxisLocks: vi.fn(),
    onVisibleRangeChange: vi.fn(),
    onSettingsChange: vi.fn(),
    emptyWithinAxisRange: false,
    ...overrides,
  };
}

beforeEach(() => {
  echartsMock.init.mockReset();
  echartsMock.init.mockReturnValue(echartsMock.chart);
  echartsMock.chartHandlers.clear();
  echartsMock.zrHandlers.clear();
  resizeObservers.length = 0;
  echartsMock.chart.containPixel.mockReturnValue(true);
  echartsMock.chart.convertFromPixel.mockReturnValue([
    new Date("2026-01-01T00:05:00").getTime(),
    0,
  ]);
  echartsMock.chart.convertToPixel.mockReset();
  echartsMock.chart.convertToPixel.mockReturnValue(240);
  echartsMock.chart.getDataURL.mockReturnValue(
    "data:image/png;base64,Y2hhcnQ=",
  );
  tauriMock.saveChartImage.mockReset();
  tauriMock.saveChartImage.mockResolvedValue("D:\\exports\\chart.png");
  chartExportMock.createChartExportDataUrl.mockReset();
  chartExportMock.createChartExportDataUrl.mockReturnValue(
    "data:image/png;base64,Y29tYmluZWQ=",
  );
  chartExportMock.createChartImageFileName.mockReset();
  chartExportMock.createChartImageFileName.mockReturnValue(
    "sample.csv-曲线-20260719-140305.png",
  );
  clipboardWrite.mockReset();
  clipboardWrite.mockResolvedValue(undefined);
  clipboardPayloads.length = 0;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write: clipboardWrite },
  });
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: ClipboardItemStub,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  animationFrames.clear();
  nextAnimationFrameId = 1;
  settleFrameTimestamp = 0;
  nowValue = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowValue);
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      const frameId = nextAnimationFrameId++;
      animationFrames.set(frameId, callback);
      return frameId;
    }),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: vi.fn((frameId: number) => animationFrames.delete(frameId)),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChartView", () => {
  it("applies the first wheel zoom immediately and coalesces trailing zooms", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    const initial = { start: config.xMin, end: config.xMax };
    const anchorTime = new Date("2026-01-01T00:05:00").getTime();
    const first = zoomRangeFromWheel(initial, bounds, anchorTime, 4)!;
    const second = zoomRangeFromWheel(first, bounds, anchorTime, 4)!;
    const third = zoomRangeFromWheel(second, bounds, anchorTime, 4)!;

    render(
      <ChartView
        {...makeProps({ onVisibleRangeChange })}
      />,
    );
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    const firstPreventDefault = emitWheel(4);

    expect(firstPreventDefault).toHaveBeenCalledTimes(1);
    const interactiveCalls = dataBearingSetOptionCalls();
    expect(interactiveCalls).toHaveLength(1);
    expect(interactiveCalls[0].options).toEqual({
      lazyUpdate: false,
      silent: true,
    });
    expect(interactiveCalls[0].option.dataZoom).toEqual([
      {
        id: "inside-zoom",
        startValue: first.start,
        endValue: first.end,
      },
    ]);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);

    emitWheel(4);
    emitWheel(4);

    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(dataBearingSetOptionCalls()).toHaveLength(1);
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledWith(
      {
        type: "dataZoom",
        dataZoomId: "inside-zoom",
        startValue: third.start,
        endValue: third.end,
        animation: { duration: 0 },
      },
      { flush: true, silent: true },
    );
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith(third);
  });

  it("maps a moving wheel cursor from the displayed range into the pending range", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const initial = { start: config.xMin, end: config.xMax };
    const initialMidpoint = initial.start + (initial.end - initial.start) * 0.5;
    const first = zoomRangeFromWheel(initial, bounds, initialMidpoint, 4)!;
    const firstSpan = first.end - first.start;
    const secondDisplayedAnchor = first.start + firstSpan * 0.25;
    const second = zoomRangeFromWheel(
      first,
      bounds,
      secondDisplayedAnchor,
      4,
    )!;
    const thirdDisplayedAnchor = first.start + firstSpan * 0.75;
    const thirdMappedAnchor =
      second.start + (second.end - second.start) * 0.75;
    const third = zoomRangeFromWheel(
      second,
      bounds,
      thirdMappedAnchor,
      4,
    )!;

    render(<ChartView {...makeProps()} />);
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    echartsMock.chart.convertFromPixel.mockReturnValue([initialMidpoint, 0]);
    const firstPreventDefault = emitWheel(4);
    echartsMock.chart.convertFromPixel.mockReturnValue([
      secondDisplayedAnchor,
      0,
    ]);
    const secondPreventDefault = emitWheel(4);
    echartsMock.chart.convertFromPixel.mockReturnValue([
      thirdDisplayedAnchor,
      0,
    ]);
    const thirdPreventDefault = emitWheel(4);

    expect(firstPreventDefault).toHaveBeenCalledTimes(1);
    expect(secondPreventDefault).toHaveBeenCalledTimes(1);
    expect(thirdPreventDefault).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledWith(
      {
        type: "dataZoom",
        dataZoomId: "inside-zoom",
        startValue: third.start,
        endValue: third.end,
        animation: { duration: 0 },
      },
      { flush: true, silent: true },
    );
  });

  it("lets wheel zoom take over an active middle-button pan", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    const initialConfig = {
      ...config,
      xMin: bounds.start + 60_000,
      xMax: bounds.end - 60_000,
    };
    const firstPanRange = {
      start: bounds.start + 36_000,
      end: bounds.start + 516_000,
    };
    const anchorTime = new Date("2026-01-01T00:05:00").getTime();
    const wheelRange = zoomRangeFromWheel(
      firstPanRange,
      bounds,
      anchorTime,
      4,
    )!;
    render(
      <ChartView
        {...makeProps({
          config: initialConfig,
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    const stalePanFrame = [...animationFrames.values()][0];

    const preventDefault = emitWheel(4);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(dataBearingSetOptionCalls()).toHaveLength(1);
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledWith(
      {
        type: "dataZoom",
        dataZoomId: "inside-zoom",
        startValue: wheelRange.start,
        endValue: wheelRange.end,
        animation: { duration: 0 },
      },
      { flush: true, silent: true },
    );
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);

    fireEvent.pointerMove(window, { clientX: 650, buttons: 4 });
    fireEvent.pointerUp(window, { clientX: 650 });
    act(() => {
      stalePanFrame?.(16);
      vi.advanceTimersByTime(CHART_INPUT_FRAME_FALLBACK_MS);
      flushAnimationFrame();
    });

    expect(dataBearingSetOptionCalls()).toHaveLength(1);
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(dataBearingSetOptionCalls()).toHaveLength(2);
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith(wheelRange);
  });

  it("leaves wheel input outside the plot to the browser", () => {
    render(<ChartView {...makeProps()} />);
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.chart.convertFromPixel.mockClear();
    echartsMock.zr.flush.mockClear();

    const preventDefault = emitWheel(4, false);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(echartsMock.chart.convertFromPixel).not.toHaveBeenCalled();
    expect(dataBearingSetOptionCalls()).toHaveLength(0);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).not.toHaveBeenCalled();
  });

  it("ignores invalid wheel input without scheduling a chart range", () => {
    render(<ChartView {...makeProps()} />);
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    const zeroPreventDefault = emitWheel(0);
    const invalidPreventDefault = emitWheel(Number.NaN);
    echartsMock.chart.convertFromPixel.mockReturnValue([Number.NaN, 0]);
    const invalidAnchorPreventDefault = emitWheel(4);

    expect(zeroPreventDefault).not.toHaveBeenCalled();
    expect(invalidPreventDefault).not.toHaveBeenCalled();
    expect(invalidAnchorPreventDefault).not.toHaveBeenCalled();
    expect(dataBearingSetOptionCalls()).toHaveLength(0);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).not.toHaveBeenCalled();
  });

  it("zooms out past the complete-range limit and widens the axis extent", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(<ChartView {...makeProps({ onVisibleRangeChange })} />);
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    const anchorTime = new Date("2026-01-01T00:05:00").getTime();
    let expected = { start: config.xMin, end: config.xMax };
    const preventDefaults = Array.from({ length: 4 }, () => emitWheel(-4));
    for (let index = 0; index < preventDefaults.length; index += 1) {
      expected = zoomRangeFromWheel(expected, bounds, anchorTime, -4)!;
    }

    for (const preventDefault of preventDefaults) {
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
    expect(dataBearingSetOptionCalls()).toHaveLength(1);

    act(() => flushAnimationFrame());
    const calls = dataBearingSetOptionCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].options).toEqual({ lazyUpdate: false, silent: true });
    expect(calls[1].option.dataZoom).toEqual([
      {
        id: "inside-zoom",
        startValue: expected.start,
        endValue: expected.end,
      },
    ]);
    const xAxis = calls[1].option.xAxis as {
      min: number;
      max: number;
    };
    const viewportSpan = expected.end - expected.start;
    expect(xAxis.min).toBe(
      Math.min(bounds.start, expected.start - viewportSpan),
    );
    expect(xAxis.max).toBe(expected.end + viewportSpan);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith(expected);
  });

  it("ignores a stale wheel owner after dataset replacement", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const datasetB = prepareDataset(
      makeDataset({
        sourceId: "c:/fixtures/wheel-owner-b.csv",
        sourceFile: "wheel-owner-b.csv",
      }),
    );
    const initial = { start: config.xMin, end: config.xMax };
    const anchorTime = new Date("2026-01-01T00:05:00").getTime();
    const expectedRange = zoomRangeFromWheel(
      initial,
      bounds,
      anchorTime,
      4,
    )!;
    const props = makeProps();
    const view = render(<ChartView {...props} />);
    const staleWheelHandler = echartsMock.zrHandlers.get("mousewheel");
    expect(staleWheelHandler).toEqual(expect.any(Function));

    view.rerender(
      <ChartView
        {...props}
        dataset={datasetB}
        visibleSeries={new Set(datasetB.series.map((series) => series.id))}
      />,
    );
    const currentWheelHandler = echartsMock.zrHandlers.get("mousewheel");
    expect(currentWheelHandler).toEqual(expect.any(Function));
    expect(currentWheelHandler).not.toBe(staleWheelHandler);
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    const stalePreventDefault = vi.fn();
    act(() => {
      staleWheelHandler?.({
        offsetX: 500,
        offsetY: 240,
        wheelDelta: 4,
        event: { preventDefault: stalePreventDefault },
      });
    });

    expect(stalePreventDefault).not.toHaveBeenCalled();
    expect(dataBearingSetOptionCalls()).toHaveLength(0);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).not.toHaveBeenCalled();

    const currentPreventDefault = emitWheel(4);
    expect(currentPreventDefault).toHaveBeenCalledTimes(1);
    expect(dataBearingSetOptionCalls()).toHaveLength(1);
    expect(dataBearingSetOptionCalls()[0].option.dataZoom).toEqual([
      {
        id: "inside-zoom",
        startValue: expectedRange.start,
        endValue: expectedRange.end,
      },
    ]);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);
  });

  it("removes the wheel handler and cancels pending zoom on unmount", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const view = render(<ChartView {...makeProps()} />);
    const wheelHandler = echartsMock.zrHandlers.get("mousewheel");
    expect(wheelHandler).toEqual(expect.any(Function));

    emitWheel(4);
    emitWheel(4);
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    view.unmount();
    expect(echartsMock.zr.off).toHaveBeenCalledWith(
      "mousewheel",
      wheelHandler,
    );
    const stalePreventDefault = vi.fn();
    act(() => {
      wheelHandler?.({
        offsetX: 500,
        offsetY: 240,
        wheelDelta: 4,
        event: { preventDefault: stalePreventDefault },
      });
      flushAnimationFrame();
      vi.advanceTimersByTime(CHART_INPUT_FRAME_FALLBACK_MS);
    });

    expect(stalePreventDefault).not.toHaveBeenCalled();
    expect(dataBearingSetOptionCalls()).toHaveLength(0);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).not.toHaveBeenCalled();
  });

  it("keeps initial, interactive, and settled render data pixel-bounded", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(942);
    const largeDataset = makeLargeDataset();
    const largeStart = new Date(
      largeDataset.timeRange.start.replace(" ", "T"),
    ).getTime();
    const narrowConfig = {
      ...config,
      xMin: largeStart + 60_000,
      xMax: largeStart + 660_000,
    };
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: narrowConfig,
          dataset: largeDataset,
          onVisibleRangeChange,
          visibleSeries: new Set(
            largeDataset.series.map((series) => series.id),
          ),
        })}
      />,
    );
    act(() => flushAnimationFrame());

    const initialCall = dataBearingSetOptionCalls().at(-1)!;
    const prefetchedWidth = 942 * (1 + 2 * LOD_PREFETCH_VIEWPORTS);
    initialCall.option.series?.forEach((series) => {
      expect((series.data as unknown[]).length).toBeLessThanOrEqual(
        lodPointBudget(prefetchedWidth, "settled"),
      );
    });
    expect(dataBearingSetOptionCalls()).toHaveLength(1);

    echartsMock.chart.setOption.mockClear();
    const latestRange = {
      startValue: largeStart + 5_000_000,
      endValue: largeStart + 5_600_000,
    };
    act(() => {
      echartsMock.chartHandlers.get("datazoom")?.(latestRange);
      echartsMock.chartHandlers.get("datazoom")?.({
        startValue: latestRange.startValue + 1_000,
        endValue: latestRange.endValue + 1_000,
      });
    });
    const interactiveCalls = dataBearingSetOptionCalls();
    expect(interactiveCalls).toHaveLength(1);
    expect(interactiveCalls[0].options).toEqual({
      lazyUpdate: false,
      silent: true,
    });
    interactiveCalls[0].option.series?.forEach((series) => {
      expect((series.data as unknown[]).length).toBeLessThanOrEqual(
        lodPointBudget(prefetchedWidth, "interactive"),
      );
    });
    act(() => flushAnimationFrame());

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    const settledCall = dataBearingSetOptionCalls().at(-1)!;
    settledCall.option.series?.forEach((series) => {
      expect((series.data as unknown[]).length).toBeLessThanOrEqual(
        lodPointBudget(prefetchedWidth, "settled"),
      );
    });
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
  });

  it("rebuilds settled LOD for a programmatic zoom-in inside prefetch", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    const largeDataset = makeLargeDataset();
    const largeStart = new Date(
      largeDataset.timeRange.start.replace(" ", "T"),
    ).getTime();
    const visibleSeries = new Set(
      largeDataset.series.map((series) => series.id),
    );
    const wideConfig = {
      ...config,
      xMin: largeStart + 60_000,
      xMax: largeStart + 1_260_000,
    };
    const props = makeProps({
      config: wideConfig,
      dataset: largeDataset,
      visibleSeries,
    });
    const view = render(<ChartView {...props} />);
    act(() => flushAnimationFrame());
    const initialSettledData = dataBearingSetOptionCalls()
      .at(-1)!
      .option.series!.map((series) => series.data);
    echartsMock.chart.setOption.mockClear();

    view.rerender(
      <ChartView
        {...props}
        config={{
          ...wideConfig,
          xMin: largeStart + 360_000,
          xMax: largeStart + 660_000,
        }}
      />,
    );

    const calls = dataBearingSetOptionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({ lazyUpdate: false });
    calls[0].option.series?.forEach((series, seriesIndex) => {
      expect(series.data).not.toBe(initialSettledData[seriesIndex]);
    });
  });

  it("switches to motion LOD when settled prefetch contains an equal-span pan", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    const largeDataset = makeLargeDataset();
    const largeStart = new Date(
      largeDataset.timeRange.start.replace(" ", "T"),
    ).getTime();
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: largeStart + 60_000,
            xMax: largeStart + 660_000,
          },
          dataset: largeDataset,
          onVisibleRangeChange,
          visibleSeries: new Set(
            largeDataset.series.map((series) => series.id),
          ),
        })}
      />,
    );
    act(() => flushAnimationFrame());
    const initialSettledData = dataBearingSetOptionCalls()
      .at(-1)!
      .option.series!.map((series) => series.data);
    echartsMock.chart.setOption.mockClear();
    const finalRange = {
      startValue: largeStart + 300_000,
      endValue: largeStart + 900_000,
    };

    act(() => echartsMock.chartHandlers.get("datazoom")?.(finalRange));

    const [interactive] = dataBearingSetOptionCalls();
    expect(interactive).toBeDefined();
    expect(interactive.options).toEqual({
      lazyUpdate: false,
      silent: true,
    });
    interactive.option.series?.forEach((series, seriesIndex) => {
      expect(series.data).not.toBe(initialSettledData[seriesIndex]);
      expect((series.data as unknown[]).length).toBeLessThanOrEqual(
        lodPointBudget(
          320 * (1 + 2 * LOD_PREFETCH_VIEWPORTS),
          "interactive",
        ),
      );
    });

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    const calls = dataBearingSetOptionCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].options).toEqual({ lazyUpdate: false });
    calls[1].option.series?.forEach((series, seriesIndex) => {
      expect(series.data).toBe(initialSettledData[seriesIndex]);
      expect((series.data as unknown[]).length).toBeLessThanOrEqual(
        lodPointBudget(
          320 * (1 + 2 * LOD_PREFETCH_VIEWPORTS),
          "settled",
        ),
      );
    });
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: finalRange.startValue,
      end: finalRange.endValue,
    });
  });

  it("recomputes settled LOD once at the latest resized width", () => {
    let chartWidth = 320;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => chartWidth,
    );
    const largeDataset = makeLargeDataset();
    render(
      <ChartView
        {...makeProps({
          dataset: largeDataset,
          config: {
            ...config,
            xMin: bounds.start,
            xMax: bounds.start + 19_999_000,
          },
          visibleSeries: new Set(
            largeDataset.series.map((series) => series.id),
          ),
        })}
      />,
    );
    act(() => flushAnimationFrame());
    const initialData = dataBearingSetOptionCalls().at(-1)!.option.series?.[0]
      .data;
    echartsMock.chart.setOption.mockClear();

    chartWidth = 480;
    resizeObservers[0].callback([], resizeObservers[0]);
    chartWidth = 640;
    resizeObservers[0].callback([], resizeObservers[0]);
    expect(dataBearingSetOptionCalls()).toHaveLength(0);
    act(() => flushAnimationFrame());

    const calls = dataBearingSetOptionCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].option.series?.[0].data).not.toBe(initialData);
    calls[0].option.series?.forEach((series) => {
      expect((series.data as unknown[]).length).toBeLessThanOrEqual(
        lodPointBudget(640, "settled"),
      );
    });
  });

  it("settles the last applied pan after resize discards a pending batch", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    expect(dataBearingSetOptionCalls()).toHaveLength(2);
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });

    act(() => resizeObservers[0].callback([], resizeObservers[0]));
    act(() => flushAnimationFrame());
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));

    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 36_000,
      end: bounds.start + 516_000,
    });
  });

  it("cancels pending frame and idle work on unmount", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    const view = render(
      <ChartView {...makeProps({ onVisibleRangeChange })} />,
    );
    act(() => {
      echartsMock.chartHandlers.get("datazoom")?.({
        startValue: bounds.start + 60_000,
        endValue: bounds.end - 60_000,
      });
    });

    view.unmount();
    act(() => flushAnimationFrame());
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));

    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    expect(echartsMock.chart.dispose).toHaveBeenCalledTimes(1);
  });

  it("exports at 2x LOD density and restores the settled render data", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(942);
    const largeDataset = makeLargeDataset();
    const largeConfig = {
      ...config,
      xMin: bounds.start,
      xMax: bounds.start + 19_999_000,
    };
    render(
      <ChartView
        {...makeProps({
          config: largeConfig,
          dataset: largeDataset,
          visibleSeries: new Set(
            largeDataset.series.map((series) => series.id),
          ),
        })}
      />,
    );
    act(() => flushAnimationFrame());
    const settledCall = dataBearingSetOptionCalls().at(-1)!;
    echartsMock.chart.setOption.mockClear();

    fireEvent.contextMenu(screen.getByTestId("chart-canvas"), {
      clientX: 120,
      clientY: 80,
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "将图像另存为" }),
    );

    const exportCalls = dataBearingSetOptionCalls();
    expect(exportCalls).toHaveLength(2);
    exportCalls[0].option.series?.forEach((series) => {
      expect((series.data as unknown[]).length).toBeLessThanOrEqual(
        lodPointBudget(942, "export", 2),
      );
    });
    exportCalls[1].option.series?.forEach((series, seriesIndex) => {
      expect(series.data).toBe(
        settledCall.option.series?.[seriesIndex].data,
      );
    });
  });

  it("restores settled render data when image capture throws", () => {
    render(<ChartView {...makeProps()} />);
    const settledCall = dataBearingSetOptionCalls().at(-1)!;
    chartExportMock.createChartExportDataUrl.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    echartsMock.chart.setOption.mockClear();

    fireEvent.contextMenu(screen.getByTestId("chart-canvas"), {
      clientX: 120,
      clientY: 80,
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "将图像另存为" }),
    );

    const exportCalls = dataBearingSetOptionCalls();
    expect(exportCalls).toHaveLength(2);
    exportCalls[1].option.series?.forEach((series, seriesIndex) => {
      expect(series.data).toBe(
        settledCall.option.series?.[seriesIndex].data,
      );
    });
    expect(tauriMock.saveChartImage).not.toHaveBeenCalled();
  });

  it.each([
    ["successful", false],
    ["throwing", true],
  ])(
    "settles the last applied pan after a %s export discards a pending batch",
    (_label, shouldThrow) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const onVisibleRangeChange = vi.fn();
      if (shouldThrow) {
        chartExportMock.createChartExportDataUrl.mockImplementationOnce(() => {
          throw new Error("capture failed");
        });
      }
      render(
        <ChartView
          {...makeProps({
            config: {
              ...config,
              xMin: bounds.start + 60_000,
              xMax: bounds.end - 60_000,
            },
            onVisibleRangeChange,
          })}
        />,
      );
      const canvas = screen.getByTestId("chart-canvas");
      Object.defineProperty(canvas, "clientWidth", {
        configurable: true,
        value: 1_000,
      });

      fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
      fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
      expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);
      fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });

      fireEvent.contextMenu(canvas, { clientX: 120, clientY: 80 });
      fireEvent.click(
        screen.getByRole("menuitem", { name: "将图像另存为" }),
      );
      act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));

      expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
      expect(echartsMock.chart.dispatchAction).toHaveBeenCalledWith({
        type: "updateAxisPointer",
        currTrigger: "leave",
      });
      expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
      expect(onVisibleRangeChange).toHaveBeenCalledWith({
        start: bounds.start + 36_000,
        end: bounds.start + 516_000,
      });
    },
  );

  it("coalesces native datazoom work per frame and commits only the latest range after idle", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(<ChartView {...makeProps({ onVisibleRangeChange })} />);
    const dataZoom = echartsMock.chartHandlers.get("datazoom");
    echartsMock.chart.setOption.mockClear();
    const latestRange = {
      startValue: bounds.start + 180_000,
      endValue: bounds.end - 120_000,
    };

    act(() => {
      dataZoom?.({
        startValue: bounds.start + 60_000,
        endValue: bounds.end - 60_000,
      });
      dataZoom?.(latestRange);
    });

    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    expect(dataBearingSetOptionCalls()).toHaveLength(1);
    expect(dataBearingSetOptionCalls()[0].options).toEqual({
      lazyUpdate: false,
      silent: true,
    });
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(99));
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: latestRange.startValue,
      end: latestRange.endValue,
    });
  });

  it("does not replay native datazoom when interactive LOD is already installed", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const dataZoom = echartsMock.chartHandlers.get("datazoom");
    const firstRange = {
      startValue: bounds.start + 120_000,
      endValue: bounds.end - 120_000,
    };
    const secondRange = {
      startValue: bounds.start + 150_000,
      endValue: bounds.end - 150_000,
    };

    act(() => dataZoom?.(firstRange));
    act(() => flushAnimationFrame());
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();
    onVisibleRangeChange.mockClear();

    act(() => dataZoom?.(secondRange));
    act(() => flushAnimationFrame());

    expect(dataBearingSetOptionCalls()).toHaveLength(0);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: secondRange.startValue,
      end: secondRange.endValue,
    });
  });

  it("flushes the first pan move synchronously and the latest trailing move per frame", () => {
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    const firstPanCalls = dataBearingSetOptionCalls();
    expect(firstPanCalls).toHaveLength(1);
    const [firstPanCall] = firstPanCalls;
    expect(firstPanCall).toBeDefined();
    expect(firstPanCall.options).toEqual({
      lazyUpdate: false,
      silent: true,
    });
    expect(firstPanCall.option).toEqual(
      expect.objectContaining({
        dataZoom: expect.arrayContaining([
          expect.objectContaining({
            id: "inside-zoom",
            startValue: bounds.start + 36_000,
            endValue: bounds.start + 516_000,
          }),
        ]),
      }),
    );
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);

    fireEvent.pointerMove(window, { clientX: 575, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.dispatchAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "dataZoom",
        startValue: bounds.start + 12_000,
        endValue: bounds.start + 492_000,
        animation: { duration: 0 },
      }),
      { flush: true, silent: true },
    );
  });

  it("does not render or commit a middle click without movement", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerUp(window, { clientX: 500 });

    expect(dataBearingSetOptionCalls()).toHaveLength(0);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
  });

  it("takes pan ownership from a stale zrender curve cursor", () => {
    render(<ChartView {...makeProps()} />);
    const chart = screen.getByTestId("chart-canvas");
    const zrenderLayer = document.createElement("canvas");
    zrenderLayer.style.cursor = "pointer";
    chart.append(zrenderLayer);
    const pointerDown = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 1,
      buttons: 4,
      cancelable: true,
      clientX: 500,
      clientY: 240,
      pointerId: 7,
    });

    act(() => {
      zrenderLayer.dispatchEvent(pointerDown);
    });

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(chart).toHaveClass("is-panning");

    fireEvent.pointerUp(window, {
      button: 1,
      clientX: 500,
      clientY: 240,
      pointerId: 7,
    });
    expect(chart).not.toHaveClass("is-panning");
  });

  it("settles the applied range when a later pan move returns to it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    echartsMock.chart.dispatchAction.mockClear();

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    const staleFrame = [...animationFrames.values()][0];
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerUp(window, { clientX: 550 });

    act(() => staleFrame?.(16));
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 36_000,
      end: bounds.start + 516_000,
    });
  });

  it("reapplies an old scheduler range after a programmatic range change", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    const initialConfig = {
      ...config,
      xMin: bounds.start + 60_000,
      xMax: bounds.end - 60_000,
    };
    const props = makeProps({ config: initialConfig, onVisibleRangeChange });
    const view = render(<ChartView {...props} />);
    const dataZoom = echartsMock.chartHandlers.get("datazoom");
    const oldRange = {
      startValue: bounds.start + 120_000,
      endValue: bounds.end - 120_000,
    };

    act(() => dataZoom?.(oldRange));
    act(() => flushAnimationFrame());
    view.rerender(
      <ChartView
        {...props}
        config={{
          ...initialConfig,
          xMin: bounds.start + 180_000,
          xMax: bounds.end - 180_000,
        }}
      />,
    );
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();
    onVisibleRangeChange.mockClear();

    act(() => dataZoom?.(oldRange));

    const reappliedCalls = dataBearingSetOptionCalls();
    expect(reappliedCalls).toHaveLength(1);
    const [reappliedCall] = reappliedCalls;
    expect(reappliedCall).toBeDefined();
    expect(reappliedCall.options).toEqual({
      lazyUpdate: false,
      silent: true,
    });
    expect(reappliedCall.option).toEqual(
      expect.objectContaining({
        dataZoom: expect.arrayContaining([
          expect.objectContaining({
            id: "inside-zoom",
            startValue: oldRange.startValue,
            endValue: oldRange.endValue,
          }),
        ]),
      }),
    );
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: oldRange.startValue,
      end: oldRange.endValue,
    });
  });

  it("silences a synchronous datazoom emitted by the leading setOption", () => {
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();
    echartsMock.chart.setOption.mockImplementationOnce(
      (
        option: {
          dataZoom?: Array<{
            id?: string;
            startValue?: number;
            endValue?: number;
          }>;
        },
        options?: { silent?: boolean },
      ) => {
        if (options?.silent) return;
        const inside = option.dataZoom?.find(
          (candidate) => candidate.id === "inside-zoom",
        );
        if (!inside) return;
        echartsMock.chartHandlers.get("datazoom")?.({
          startValue: inside.startValue,
          endValue: inside.endValue,
        });
      },
    );

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });

    const setOptionCalls = dataBearingSetOptionCalls();
    expect(setOptionCalls).toHaveLength(1);
    expect(setOptionCalls[0].options).toEqual({
      lazyUpdate: false,
      silent: true,
    });
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);
  });

  it("flushes a winning pan frame synchronously instead of waiting for another rAF", () => {
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    echartsMock.zr.flush.mockClear();

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    act(() => flushAnimationFrame());

    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dataZoom",
        animation: { duration: 0 },
      }),
      { flush: true, silent: true },
    );
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);
  });

  it("falls back after 32ms when a pan animation frame is starved", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    echartsMock.chart.setOption.mockClear();
    echartsMock.zr.flush.mockClear();

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    const lateFrame = [...animationFrames.values()][0];
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS - 1));
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledWith(
      {
        type: "dataZoom",
        dataZoomId: "inside-zoom",
        startValue: bounds.start + 12_000,
        endValue: bounds.start + 492_000,
        animation: { duration: 0 },
      },
      { flush: true, silent: true },
    );
    const motionLodCalls = dataBearingSetOptionCalls();
    expect(motionLodCalls).toHaveLength(1);
    const [motionLodCall] = motionLodCalls;
    expect(motionLodCall).toBeDefined();
    expect(motionLodCall.options).toEqual({
      lazyUpdate: false,
      silent: true,
    });
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    act(() => lateFrame?.(PAN_FRAME_FALLBACK_MS + 1));
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);

    fireEvent.pointerUp(window, { clientX: 600 });
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 12_000,
      end: bounds.start + 492_000,
    });
  });

  it("preserves a fallback dispatch error without forcing a paint", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dispatchError = new Error("dispatch failed");
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    echartsMock.zr.flush.mockClear();
    echartsMock.chart.dispatchAction.mockImplementationOnce(() => {
      throw dispatchError;
    });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });

    expect(() => {
      act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    }).toThrow(dispatchError);
    expect(echartsMock.zr.flush).not.toHaveBeenCalled();
  });

  it("does not let a stale frame from pan batch A consume batch B", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 525, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    const staleFrameA = [...animationFrames.values()][0];
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);

    fireEvent.pointerMove(window, { clientX: 575, buttons: 4 });
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(2);
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    act(() => staleFrameA?.(PAN_FRAME_FALLBACK_MS + 1));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS - 1));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(3);
    expect(echartsMock.chart.dispatchAction).toHaveBeenLastCalledWith(
      {
        type: "dataZoom",
        dataZoomId: "inside-zoom",
        startValue: bounds.start + 12_000,
        endValue: bounds.start + 492_000,
        animation: { duration: 0 },
      },
      { flush: true, silent: true },
    );
  });

  it("cancels the fallback when rAF wins and starts a fresh next batch", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    echartsMock.zr.flush.mockClear();

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 575, buttons: 4 });
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);

    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(2);
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(3);
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(2);
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(3);
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(2);
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(3);
  });

  it("does not flush again when pointerup follows a completed fallback", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(window, { clientX: 600 });
    act(() => flushAnimationFrame());
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("does not flush again when pointerup follows a completed animation frame", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(window, { clientX: 600 });
    act(() => flushAnimationFrame());
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("lets native datazoom take over a pending pan batch", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    const stalePanFrame = [...animationFrames.values()][0];
    act(() => {
      echartsMock.chartHandlers.get("datazoom")?.({
        startValue: bounds.start + 120_000,
        endValue: bounds.end - 120_000,
      });
    });
    act(() => stalePanFrame?.(16));
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    act(() => flushAnimationFrame());

    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 120_000,
      end: bounds.end - 120_000,
    });
  });

  it("settles the applied pan when native datazoom takes over with the same range", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    const stalePanFrame = [...animationFrames.values()][0];
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    act(() => {
      echartsMock.chartHandlers.get("datazoom")?.({
        startValue: bounds.start + 36_000,
        endValue: bounds.start + 516_000,
      });
    });

    act(() => stalePanFrame?.(16));
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 36_000,
      end: bounds.start + 516_000,
    });
  });

  it("cancels a starved pan batch when the dataset changes", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const datasetB = prepareDataset(
      makeDataset({
        sourceId: "c:/fixtures/b.csv",
        sourceFile: "b.csv",
      }),
    );
    const props = makeProps({
      config: {
        ...config,
        xMin: bounds.start + 60_000,
        xMax: bounds.end - 60_000,
      },
    });
    const view = render(<ChartView {...props} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    const staleFrame = [...animationFrames.values()][0];
    view.rerender(
      <ChartView
        {...props}
        dataset={datasetB}
        visibleSeries={new Set(datasetB.series.map((series) => series.id))}
      />,
    );
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    act(() => staleFrame?.(PAN_FRAME_FALLBACK_MS + 1));

    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
  });

  it("flushes the final middle-button move when pointerup arrives in the same frame", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    echartsMock.zr.flush.mockClear();

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 575, buttons: 4 });
    const staleFrame = [...animationFrames.values()][0];
    fireEvent.pointerUp(window, { clientX: 600 });

    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.dispatchAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "dataZoom",
        startValue: bounds.start + 12_000,
        endValue: bounds.start + 492_000,
        animation: { duration: 0 },
      }),
      { flush: true, silent: true },
    );
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);
    act(() => staleFrame?.(16));
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(2);
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 12_000,
      end: bounds.start + 492_000,
    });
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
  });

  it.each(["pointercancel", "lostpointercapture", "blur"] as const)(
    "cancels a starved pan fallback on %s",
    (eventName) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const onVisibleRangeChange = vi.fn();
      render(
        <ChartView
          {...makeProps({
            config: {
              ...config,
              xMin: bounds.start + 60_000,
              xMax: bounds.end - 60_000,
            },
            onVisibleRangeChange,
          })}
        />,
      );
      const canvas = screen.getByTestId("chart-canvas");
      Object.defineProperty(canvas, "clientWidth", {
        configurable: true,
        value: 1_000,
      });

      fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
      fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
      fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
      if (eventName === "pointercancel") {
        fireEvent.pointerCancel(window);
      } else if (eventName === "lostpointercapture") {
        fireEvent.lostPointerCapture(canvas);
      } else {
        window.dispatchEvent(new Event("blur"));
      }
      act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
      act(() => flushAnimationFrame());

      expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
      expect(onVisibleRangeChange).not.toHaveBeenCalled();
    },
  );

  it.each(["pointercancel", "lostpointercapture", "blur"] as const)(
    "settles the last applied pan after pending work is discarded by %s",
    (eventName) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const onVisibleRangeChange = vi.fn();
      render(
        <ChartView
          {...makeProps({
            config: {
              ...config,
              xMin: bounds.start + 60_000,
              xMax: bounds.end - 60_000,
            },
            onVisibleRangeChange,
          })}
        />,
      );
      const canvas = screen.getByTestId("chart-canvas");
      Object.defineProperty(canvas, "clientWidth", {
        configurable: true,
        value: 1_000,
      });

      fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
      fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
      expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);
      fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
      if (eventName === "pointercancel") {
        fireEvent.pointerCancel(window);
      } else if (eventName === "lostpointercapture") {
        fireEvent.lostPointerCapture(canvas);
      } else {
        window.dispatchEvent(new Event("blur"));
      }

      act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
      expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
      expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
      expect(onVisibleRangeChange).toHaveBeenCalledWith({
        start: bounds.start + 36_000,
        end: bounds.start + 516_000,
      });
    },
  );

  it("cancels a starved pan fallback on unmount", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    const view = render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    view.unmount();
    act(() => vi.advanceTimersByTime(PAN_FRAME_FALLBACK_MS));
    act(() => flushAnimationFrame());

    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
  });

  it("suppresses tooltip React work while middle-button panning", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });

    expect(screen.queryByText("24.5 °C")).not.toBeInTheDocument();
  });
  it("reuses one ECharts instance for presentation updates and disposes it on unmount", () => {
    const initialProps = makeProps();
    const view = render(<ChartView {...initialProps} />);

    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    const fullCall = echartsMock.chart.setOption.mock.calls.find(
      ([option]) => (option.series as Array<Record<string, unknown>>).some((series) => "data" in series),
    );
    expect(fullCall?.[1]).toEqual({ notMerge: true, lazyUpdate: false });

    const rangedConfig = { ...config, xMin: config.xMin + 60_000 };
    view.rerender(<ChartView {...initialProps} config={rangedConfig} />);
    view.rerender(
      <ChartView
        {...initialProps}
        config={rangedConfig}
        visibleSeries={new Set(["actual-temp"])}
      />,
    );
    view.rerender(
      <ChartView
        {...initialProps}
        config={rangedConfig}
        visibleSeries={new Set(["actual-temp"])}
        previewSeriesId="actual-temp"
      />,
    );

    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.dispose).not.toHaveBeenCalled();
    const lastPatch = echartsMock.chart.setOption.mock.calls.at(-1)?.[0] as {
      series: Array<Record<string, unknown>>;
    };
    expect(lastPatch.series.every((series) => !("data" in series))).toBe(true);
    expect(echartsMock.chart.setOption.mock.calls.at(-1)?.[1]).toEqual({
      lazyUpdate: true,
    });

    const dataZoomHandler = echartsMock.chartHandlers.get("datazoom");
    const mouseMoveHandler = echartsMock.zrHandlers.get("mousemove");
    const mouseOutHandler = echartsMock.zrHandlers.get("mouseout");
    view.unmount();

    expect(echartsMock.chart.dispose).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.off).toHaveBeenCalledWith("datazoom", dataZoomHandler);
    expect(echartsMock.zr.off).toHaveBeenCalledWith("mousemove", mouseMoveHandler);
    expect(echartsMock.zr.off).toHaveBeenCalledWith("mouseout", mouseOutHandler);
    expect(resizeObservers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("disposes a replaced dataset instance before its queued datazoom can escape", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const datasetA = prepareDataset(makeDataset());
    const datasetB = prepareDataset(makeDataset());
    const onDatasetARangeChange = vi.fn();
    const onDatasetBRangeChange = vi.fn();
    const chartA = makeQueuedChart();
    const chartB = makeQueuedChart();
    echartsMock.init
      .mockReturnValueOnce(chartA.chart)
      .mockReturnValueOnce(chartB.chart);
    const initialProps = makeProps({
      dataset: datasetA,
      onVisibleRangeChange: onDatasetARangeChange,
    });
    const view = render(<ChartView {...initialProps} />);
    const staleRange = {
      startValue: bounds.start + 60_000,
      endValue: bounds.end - 60_000,
    };
    chartA.queueDataZoom(staleRange);

    view.rerender(
      <ChartView
        {...initialProps}
        dataset={datasetB}
        onVisibleRangeChange={onDatasetBRangeChange}
      />,
    );
    act(() => chartA.flushDataZoom());

    expect(onDatasetARangeChange).not.toHaveBeenCalled();
    expect(onDatasetBRangeChange).not.toHaveBeenCalled();
    expect(echartsMock.init).toHaveBeenCalledTimes(2);
    expect(chartA.chart.dispose).toHaveBeenCalledTimes(1);

    const currentRange = {
      startValue: bounds.start + 120_000,
      endValue: bounds.end - 120_000,
    };
    chartB.queueDataZoom(currentRange);
    act(() => chartB.flushDataZoom());
    act(() => vi.advanceTimersByTime(100));

    expect(onDatasetBRangeChange).toHaveBeenCalledWith({
      start: currentRange.startValue,
      end: currentRange.endValue,
    });
  });

  it("removes the download arrow and opens the native PNG save flow from the chart context menu", async () => {
    render(<ChartView {...makeProps()} />);

    expect(
      screen.queryByRole("button", { name: "导出图片" }),
    ).not.toBeInTheDocument();
    const canvas = screen.getByTestId("chart-canvas");
    expect(
      fireEvent.contextMenu(canvas, { clientX: 120, clientY: 80 }),
    ).toBe(false);

    const menu = screen.getByRole("menu", { name: "图表操作" });
    const actions = within(menu).getAllByRole("menuitem");
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.textContent)).toEqual([
      "将图像另存为",
      "复制图像",
    ]);

    fireEvent.click(actions[0]);

    const pointerLeaveCallIndex =
      echartsMock.chart.dispatchAction.mock.calls.findIndex(
        ([action]) =>
          action.type === "updateAxisPointer" && action.currTrigger === "leave",
      );
    expect(pointerLeaveCallIndex).toBeGreaterThanOrEqual(0);
    const pointerLeaveOrder =
      echartsMock.chart.dispatchAction.mock.invocationCallOrder[
        pointerLeaveCallIndex
      ];
    const exportFlushOrder =
      echartsMock.zr.flush.mock.invocationCallOrder.at(-1)!;
    const rasterizeOrder =
      chartExportMock.createChartExportDataUrl.mock.invocationCallOrder[0];
    expect(pointerLeaveOrder).toBeLessThan(exportFlushOrder);
    expect(exportFlushOrder).toBeLessThan(rasterizeOrder);

    expect(chartExportMock.createChartExportDataUrl).toHaveBeenCalledWith(
      echartsMock.chart,
      expect.arrayContaining([
        expect.objectContaining({
          axisId: "primary",
          axisName: "温度",
          name: "实测温度",
          color: "#1c69d4",
          measured: true,
          visible: true,
        }),
        expect.objectContaining({
          axisId: "secondary",
          axisName: "湿度",
          name: "设定湿度",
          color: "#797979",
          measured: false,
          visible: true,
        }),
      ]),
    );
    await waitFor(() =>
      expect(tauriMock.saveChartImage).toHaveBeenCalledWith(
        "sample.csv-曲线-20260719-140305.png",
        "data:image/png;base64,Y29tYmluZWQ=",
      ),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("copies the chart PNG from the context menu and closes it with Escape", async () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");

    fireEvent.contextMenu(canvas, { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("menuitem", { name: "复制图像" }));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(chartExportMock.createChartExportDataUrl).toHaveBeenCalledTimes(1);
    expect(clipboardPayloads).toHaveLength(1);
    expect(clipboardPayloads[0]["image/png"]).toEqual(
      expect.objectContaining({ size: 8, type: "image/png" }),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(canvas, { clientX: 120, clientY: 80 });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the transient chart menu when the help layer opens", () => {
    const props = makeProps();
    const view = render(<ChartView {...props} helpOpen={false} />);
    const canvas = screen.getByTestId("chart-canvas");
    fireEvent.contextMenu(canvas, { clientX: 120, clientY: 80 });
    expect(screen.getByRole("menu", { name: "图表操作" })).toBeVisible();

    view.rerender(<ChartView {...props} helpOpen />);

    expect(
      screen.queryByRole("menu", { name: "图表操作" }),
    ).not.toBeInTheDocument();
  });

  it("maps a batched datazoom percentage to the complete dataset bounds", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(<ChartView {...makeProps({ onVisibleRangeChange })} />);

    act(() => {
      echartsMock.chartHandlers.get("datazoom")?.({
        batch: [{ start: 25, end: 75 }],
      });
    });

    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));

    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 150_000,
      end: bounds.start + 450_000,
    });
  });

  it.each([
    [
      "top-level",
      {
        startValue: config.xMin + 12_000,
        endValue: config.xMax - 108_000,
      },
    ],
    [
      "batched",
      {
        batch: [
          {
            startValue: config.xMin + 12_000,
            endValue: config.xMax - 108_000,
          },
        ],
      },
    ],
  ])("accepts %s value-based datazoom events", (_label, event) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(<ChartView {...makeProps({ onVisibleRangeChange })} />);

    act(() => {
      echartsMock.chartHandlers.get("datazoom")?.(event);
    });

    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));

    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: config.xMin + 12_000,
      end: config.xMax - 108_000,
    });
  });

  it("clamps value-based datazoom endpoints and ignores reversed ranges", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            xMin: bounds.start + 60_000,
            xMax: bounds.end - 60_000,
          },
          onVisibleRangeChange,
        })}
      />,
    );
    const dataZoom = echartsMock.chartHandlers.get("datazoom");

    act(() => {
      dataZoom?.({
        startValue: bounds.start - 60_000,
        endValue: bounds.end + 60_000,
      });
    });
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(onVisibleRangeChange).toHaveBeenLastCalledWith(bounds);

    onVisibleRangeChange.mockClear();
    act(() => {
      dataZoom?.({ startValue: bounds.end, endValue: bounds.start });
    });
    act(() => vi.advanceTimersByTime(100));
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
  });

  it("pans the current range with a middle-button drag", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    const panConfig = {
      ...config,
      xMin: bounds.start + 60_000,
      xMax: bounds.end - 60_000,
    };
    render(
      <ChartView
        {...makeProps({ config: panConfig, onVisibleRangeChange })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    expect(
      fireEvent.pointerDown(canvas, { button: 1, clientX: 500 }),
    ).toBe(false);
    echartsMock.chart.setOption.mockClear();
    echartsMock.zr.flush.mockClear();
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    fireEvent.pointerUp(window, { clientX: 600 });

    expect(dataBearingSetOptionCalls()).toHaveLength(1);
    expect(dataBearingSetOptionCalls()[0].options).toEqual({
      lazyUpdate: false,
      silent: true,
    });
    expect(echartsMock.zr.flush).toHaveBeenCalledTimes(1);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 12_000,
      end: bounds.start + 492_000,
    });
    const actionCount = echartsMock.chart.dispatchAction.mock.calls.length;
    fireEvent.pointerMove(window, { clientX: 700, buttons: 4 });
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledTimes(actionCount);
  });

  it("keeps a middle-button pan active across the idle threshold and commits after release", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const panConfig = {
      ...config,
      xMin: bounds.start + 60_000,
      xMax: bounds.end - 60_000,
    };
    let view: ReturnType<typeof render>;
    const onVisibleRangeChange = vi.fn((range: NumericRange) => {
      view.rerender(
        <ChartView
          {...props}
          config={{ ...panConfig, xMin: range.start, xMax: range.end }}
        />,
      );
    });
    const props = makeProps({ config: panConfig, onVisibleRangeChange });
    view = render(<ChartView {...props} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      pointerId: 7,
    });
    fireEvent.pointerMove(window, {
      clientX: 550,
      buttons: 4,
      pointerId: 7,
    });
    expect(canvas).toHaveClass("is-panning");

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));

    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    expect(canvas).toHaveClass("is-panning");

    fireEvent.pointerMove(window, {
      clientX: 600,
      buttons: 4,
      pointerId: 7,
    });
    fireEvent.pointerUp(window, { clientX: 600, pointerId: 7 });
    expect(canvas).not.toHaveClass("is-panning");

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));

    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 12_000,
      end: bounds.start + 492_000,
    });
  });

  it("captures the pan pointer and ignores events from unrelated pointers", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    const setPointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    const releasePointerCapture = vi.fn();
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 1_000 },
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: hasPointerCapture },
      releasePointerCapture: {
        configurable: true,
        value: releasePointerCapture,
      },
    });

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      pointerId: 7,
    });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(window, {
      clientX: 550,
      buttons: 0,
      pointerId: 8,
    });
    fireEvent.pointerUp(window, { clientX: 550, pointerId: 8 });
    expect(canvas).toHaveClass("is-panning");

    fireEvent.pointerMove(window, {
      clientX: 600,
      buttons: 4,
      pointerId: 7,
    });
    fireEvent.pointerUp(window, { clientX: 600, pointerId: 7 });

    expect(canvas).not.toHaveClass("is-panning");
    expect(hasPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("pans beyond the data bounds and commits the out-of-range viewport", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onVisibleRangeChange = vi.fn();
    render(<ChartView {...makeProps({ onVisibleRangeChange })} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    const span = config.xMax - config.xMin;
    const beyond = {
      start: bounds.start - 1.3 * span,
      end: bounds.end - 1.3 * span,
    };

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    echartsMock.chart.setOption.mockClear();
    echartsMock.zr.flush.mockClear();
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    fireEvent.pointerMove(window, { clientX: 1_800, buttons: 4 });
    fireEvent.pointerUp(window, { clientX: 1_800 });

    const calls = dataBearingSetOptionCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].options).toEqual({ lazyUpdate: false, silent: true });
    expect(calls[1].options).toEqual({ lazyUpdate: false, silent: true });
    expect(calls[0].option.dataZoom).toEqual([
      {
        id: "inside-zoom",
        startValue: bounds.start - 0.1 * span,
        endValue: bounds.end - 0.1 * span,
      },
    ]);
    expect(calls[1].option.dataZoom).toEqual([
      {
        id: "inside-zoom",
        startValue: beyond.start,
        endValue: beyond.end,
      },
    ]);
    const xAxis = calls[1].option.xAxis as { min: number; max: number };
    expect(xAxis.min).toBe(beyond.start - span);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(onVisibleRangeChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledWith(beyond);
  });

  it("ends a middle-button drag on pointercancel", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });

    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
  });

  it("ends a middle-button drag when the move no longer has button 4 pressed", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 550, buttons: 0 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });

    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
  });

  it("shows a grabbing cursor while a middle-button drag is active", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    expect(canvas).not.toHaveClass("is-panning");
    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    expect(canvas).toHaveClass("is-panning");
    fireEvent.pointerMove(window, { clientX: 550, buttons: 4 });
    expect(canvas).toHaveClass("is-panning");
  });

  it("restores the chart cursor when the middle-button drag ends", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 600, buttons: 4 });
    expect(canvas).toHaveClass("is-panning");
    fireEvent.pointerUp(window, { clientX: 600 });
    expect(canvas).not.toHaveClass("is-panning");
  });

  it.each(["pointercancel", "lostpointercapture", "blur"] as const)(
    "restores the chart cursor when pan is aborted by %s",
    (eventName) => {
      render(<ChartView {...makeProps()} />);
      const canvas = screen.getByTestId("chart-canvas");
      Object.defineProperty(canvas, "clientWidth", {
        configurable: true,
        value: 1_000,
      });

      fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
      expect(canvas).toHaveClass("is-panning");
      if (eventName === "pointercancel") {
        fireEvent.pointerCancel(window);
      } else if (eventName === "lostpointercapture") {
        fireEvent.lostPointerCapture(canvas);
      } else {
        window.dispatchEvent(new Event("blur"));
      }
      expect(canvas).not.toHaveClass("is-panning");
    },
  );

  it("restores the chart cursor when wheel zoom takes over an active pan", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    expect(canvas).toHaveClass("is-panning");
    emitWheel(4);
    expect(canvas).not.toHaveClass("is-panning");
  });

  it("restores the chart cursor when the dataset changes during a pan", () => {
    const props = makeProps();
    const view = render(<ChartView {...props} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500 });
    expect(canvas).toHaveClass("is-panning");
    view.rerender(
      <ChartView {...props} dataset={{ ...props.dataset }} />,
    );
    expect(canvas).not.toHaveClass("is-panning");
  });

  it("shows interpolated visible values and the empty-range status", () => {
    const props = makeProps();
    const view = render(<ChartView {...props} />);

    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });

    const tooltip = screen.getByRole("status");
    expect(tooltip).toHaveClass("chart-tooltip");
    expect(document.querySelector(".chart-cursor")).not.toBeInTheDocument();
    expect(tooltip).toHaveTextContent("24.50 °C");
    for (const series of dataset.series) {
      expect(within(tooltip).getByText(series.name)).toBeInTheDocument();
    }
    const actualTemperatureRow = within(tooltip)
      .getByText("实测温度")
      .closest(".tooltip-row");
    const measuredSwatch = actualTemperatureRow?.querySelector(".series-swatch");
    expect(measuredSwatch).toHaveClass("is-measured");
    expect(measuredSwatch).toHaveStyle({ color: "#1c69d4" });
    const setpointSwatch = within(tooltip)
      .getByText("设定温度")
      .closest(".tooltip-row")
      ?.querySelector(".series-swatch");
    expect(setpointSwatch).toHaveClass("is-setpoint");

    view.rerender(<ChartView {...props} emptyWithinAxisRange />);
    expect(document.querySelector(".chart-cursor")).not.toBeInTheDocument();
    expect(screen.getByText("当前坐标范围内无数据")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("stops hover calculations and hides the pointer and readout when disabled", () => {
    const props = makeProps();
    const view = render(<ChartView {...props} />);

    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });
    expect(screen.getByRole("status")).toHaveClass("chart-tooltip");

    view.rerender(<ChartView {...props} cursorVisible={false} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    echartsMock.chart.convertFromPixel.mockClear();

    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });

    expect(echartsMock.chart.convertFromPixel).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(echartsMock.chart.setOption.mock.calls.at(-1)?.[0]).toMatchObject({
      xAxis: { axisPointer: { show: false, status: "hide" } },
    });
  });

  it("groups tooltip rows by axis in axis order", () => {
    render(<ChartView {...makeProps()} />);
    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });

    const tooltip = screen.getByRole("status");
    const groups = tooltip.querySelectorAll(".tooltip-group");
    expect(groups).toHaveLength(2);

    const firstGroup = groups[0] as HTMLElement;
    expect(within(firstGroup).getByText("设定温度")).toBeInTheDocument();
    expect(within(firstGroup).getByText("实测温度")).toBeInTheDocument();
    expect(within(firstGroup).queryByText("设定湿度")).not.toBeInTheDocument();

    const secondGroup = groups[1] as HTMLElement;
    expect(within(secondGroup).getByText("设定湿度")).toBeInTheDocument();
    expect(within(secondGroup).getByText("实测湿度")).toBeInTheDocument();
    expect(within(secondGroup).queryByText("设定温度")).not.toBeInTheDocument();
  });

  it("skips tooltip groups whose series are all hidden", () => {
    render(
      <ChartView
        {...makeProps({
          visibleSeries: new Set(["set-temp", "actual-temp"]),
        })}
      />,
    );
    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });

    const tooltip = screen.getByRole("status");
    expect(tooltip.querySelectorAll(".tooltip-group")).toHaveLength(1);
    expect(within(tooltip).getByText("实测温度")).toBeInTheDocument();
    expect(within(tooltip).queryByText("实测湿度")).not.toBeInTheDocument();
  });

  it("shows tooltip values one decimal beyond the y-axis label precision after y zoom", () => {
    const rawDataset = makeDataset();
    const rawActualTemperature = rawDataset.series.find(
      (series) => series.id === "actual-temp",
    );
    if (!rawActualTemperature) {
      throw new Error("missing actual-temp fixture series");
    }
    rawActualTemperature.points = [
      ["2026-01-01 00:00:00", 24.0],
      ["2026-01-01 00:10:00", 24.1],
    ];
    const zoomedDataset = prepareDataset(rawDataset);
    const zoomedConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 24, max: 24.05 } },
    };

    render(
      <ChartView
        {...makeProps({
          dataset: zoomedDataset,
          config: zoomedConfig,
        })}
      />,
    );

    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });

    const tooltip = screen.getByRole("status");
    const actualTemperatureRow = within(tooltip)
      .getByText("实测温度")
      .closest(".tooltip-row");
    expect(actualTemperatureRow?.querySelector("strong")?.textContent).toBe(
      "24.0500 °C",
    );
  });

  it("keeps the extra tooltip decimal when the value rounds to an integer", () => {
    const rawDataset = makeDataset();
    const rawActualTemperature = rawDataset.series.find(
      (series) => series.id === "actual-temp",
    );
    if (!rawActualTemperature) {
      throw new Error("missing actual-temp fixture series");
    }
    rawActualTemperature.points = [
      ["2026-01-01 00:00:00", 24.0],
      ["2026-01-01 00:10:00", 24.06],
    ];

    render(
      <ChartView {...makeProps({ dataset: prepareDataset(rawDataset) })} />,
    );

    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });

    const tooltip = screen.getByRole("status");
    const actualTemperatureRow = within(tooltip)
      .getByText("实测温度")
      .closest(".tooltip-row");
    expect(actualTemperatureRow?.querySelector("strong")?.textContent).toBe(
      "24.03 °C",
    );
  });

  it("shows hover times at second precision without milliseconds", () => {
    render(<ChartView {...makeProps()} />);
    const wholeSecond = new Date("2026-01-01T00:05:00").getTime();

    echartsMock.chart.convertFromPixel.mockReturnValue([wholeSecond, 0]);
    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });
    const wholeSecondLabel = screen.getByRole("status").querySelector("time")
      ?.textContent;
    expect(wholeSecondLabel).toBeTruthy();
    expect(wholeSecondLabel).not.toContain(".000");

    echartsMock.chart.convertFromPixel.mockReturnValue([wholeSecond + 500, 0]);
    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });
    expect(screen.getByRole("status").querySelector("time")).toHaveTextContent(
      wholeSecondLabel ?? "",
    );
  });

  it("shows a missing interpolated value as an em dash in the tooltip", () => {
    const rawDataset = makeDataset();
    const rawActualTemperature = rawDataset.series.find(
      (series) => series.id === "actual-temp",
    );
    if (!rawActualTemperature) {
      throw new Error("missing actual-temp fixture series");
    }
    rawActualTemperature.points = [
      ["2026-01-01 00:00:00", 24],
      ["2026-01-01 00:10:00", null],
    ];
    const missingValueDataset = prepareDataset(rawDataset);

    render(
      <ChartView
        {...makeProps({
          dataset: missingValueDataset,
          visibleSeries: new Set(
            missingValueDataset.series.map((series) => series.id),
          ),
        })}
      />,
    );

    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });

    const tooltip = screen.getByRole("status");
    const actualTemperatureRow = within(tooltip)
      .getByText("实测温度")
      .closest(".tooltip-row");
    expect(actualTemperatureRow).not.toBeNull();
    const value = actualTemperatureRow!.querySelector("strong");
    expect(value?.textContent).toBe("—");
    expect(value?.textContent).not.toContain("0");
    expect(value?.textContent).not.toMatch(/\d|°C/);
  });

  it.each(cursorRefreshes)(
    "re-derives the cursor from the resting pointer when %s changes",
    (_label, changeProps) => {
      const props = makeProps();
      const view = render(<ChartView {...props} />);
      act(() => {
        echartsMock.zrHandlers.get("mousemove")?.({
          offsetX: 500,
          offsetY: 240,
        });
      });
      expect(screen.getByText("24.50 °C")).toBeInTheDocument();
      echartsMock.chart.dispatchAction.mockClear();

      // 同一像素在变化后对应另一时刻：读数必须来自重算，而不是沿用旧值。
      echartsMock.chart.convertFromPixel.mockReturnValue([
        new Date("2026-01-01T00:07:30").getTime(),
        0,
      ]);
      view.rerender(<ChartView {...changeProps(props)} />);

      expect(screen.queryByText("24.50 °C")).not.toBeInTheDocument();
      expect(screen.getByText("24.75 °C")).toBeInTheDocument();
      expect(axisPointerActions().at(-1)).toEqual({
        type: "updateAxisPointer",
        currTrigger: "mousemove",
        x: 500,
        y: 240,
      });
    },
  );

  it.each(cursorDismissals)(
    "hides the pointer line together with the readout when %s changes",
    (_label, changeProps) => {
      const props = makeProps();
      const view = render(<ChartView {...props} />);
      act(() => {
        echartsMock.zrHandlers.get("mousemove")?.({
          offsetX: 500,
          offsetY: 240,
        });
      });
      expect(screen.getByRole("status")).toHaveClass("chart-tooltip");
      echartsMock.chart.dispatchAction.mockClear();

      view.rerender(<ChartView {...changeProps(props)} />);

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(
        axisPointerActions().some(
          (action) => action.currTrigger === "mousemove",
        ),
      ).toBe(false);
    },
  );

  it("stops showing the cursor once the pointer has left the plot", () => {
    const props = makeProps();
    const view = render(<ChartView {...props} />);
    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
      });
    });
    echartsMock.chart.dispatchAction.mockClear();

    act(() => echartsMock.zrHandlers.get("mouseout")?.({}));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(axisPointerActions()).toEqual([
      { type: "updateAxisPointer", currTrigger: "leave" },
    ]);

    // 指针已离开：之后的范围变化不能把游标凭空带回来。
    echartsMock.chart.dispatchAction.mockClear();
    view.rerender(
      <ChartView
        {...props}
        config={{ ...props.config, xMin: props.config.xMin + 1_000 }}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(axisPointerActions()).toEqual([]);
  });

  it("hides the pointer line and the readout the moment Shift is pressed", () => {
    render(<ChartView {...makeProps()} />);
    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
        event: { shiftKey: false },
      });
    });
    expect(screen.getByRole("status")).toHaveClass("chart-tooltip");
    expect(axisPointerActions().at(-1)).toMatchObject({
      currTrigger: "mousemove",
      x: 500,
      y: 240,
    });

    // 只按下 Shift、不移动鼠标：轴线与卡片同时让位。
    fireEvent.keyDown(window, { key: "Shift" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(axisPointerActions().at(-1)).toEqual({
      type: "updateAxisPointer",
      currTrigger: "leave",
    });

    // 按住 Shift 滚轮缩放纵轴期间保持隐藏。
    echartsMock.chart.dispatchAction.mockClear();
    emitWheel(4, true, true);
    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 520,
        offsetY: 250,
        event: { shiftKey: true },
      });
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(axisPointerActions()).toEqual([]);

    // 松开 Shift：不必移动鼠标，游标回到指针所在位置。
    fireEvent.keyUp(window, { key: "Shift" });
    expect(screen.getByRole("status")).toHaveClass("chart-tooltip");
    expect(axisPointerActions().at(-1)).toEqual({
      type: "updateAxisPointer",
      currTrigger: "mousemove",
      x: 520,
      y: 250,
    });
  });

  it("keeps the cursor hidden while dragging and restores it at the release point", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1_000,
      bottom: 480,
      width: 1_000,
      height: 480,
      toJSON: () => ({}),
    });
    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 240,
        event: { shiftKey: false },
      });
    });
    expect(screen.getByRole("status")).toHaveClass("chart-tooltip");

    fireEvent.pointerDown(canvas, {
      button: 1,
      pointerId: 7,
      clientX: 500,
      clientY: 240,
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(axisPointerActions().at(-1)).toEqual({
      type: "updateAxisPointer",
      currTrigger: "leave",
    });

    // 指针被捕获后 zr 会先报一次 mouseout，拖动期间也收不到 mousemove。
    act(() => echartsMock.zrHandlers.get("mouseout")?.({}));
    echartsMock.chart.dispatchAction.mockClear();
    fireEvent.pointerMove(window, {
      pointerId: 7,
      clientX: 420,
      clientY: 260,
      buttons: 4,
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(axisPointerActions()).toEqual([]);

    fireEvent.pointerUp(window, {
      button: 1,
      pointerId: 7,
      clientX: 420,
      clientY: 260,
    });
    expect(screen.getByRole("status")).toHaveClass("chart-tooltip");
    expect(axisPointerActions().at(-1)).toEqual({
      type: "updateAxisPointer",
      currTrigger: "mousemove",
      x: 420,
      y: 260,
    });
  });

  it("observes the chart canvas with ResizeObserver instead of window resize", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");

    expect(resizeObservers).toHaveLength(1);
    expect(resizeObservers[0].observe).toHaveBeenCalledWith(canvas);
    window.dispatchEvent(new Event("resize"));
    expect(echartsMock.chart.resize).not.toHaveBeenCalled();

    resizeObservers[0].callback([], resizeObservers[0]);
    act(() => flushAnimationFrame());
    expect(echartsMock.chart.resize).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".chart-date-context")).not.toBeInTheDocument();
  });

  it("never renders the legacy DOM cursor before pointer interaction", () => {
    render(<ChartView {...makeProps()} />);

    expect(document.querySelector(".chart-cursor")).not.toBeInTheDocument();
  });

  it("zooms all visible y axes with Shift+wheel on the plot background", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    const onVisibleRangeChange = vi.fn();
    const zoomConfig: ChartConfig = {
      ...config,
      axes: {
        primary: { min: 0, max: 100 },
        secondary: { min: 0, max: 50 },
      },
    };
    render(
      <ChartView
        {...makeProps({
          config: zoomConfig,
          onSettingsChange,
          onVisibleRangeChange,
        })}
      />,
    );
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.convertToPixel.mockClear();
    echartsMock.chart.convertToPixel.mockImplementation(
      (finder, value) => {
        const axisIndex =
          typeof finder === "object" && finder !== null
            ? Number((finder as { yAxisIndex?: number }).yAxisIndex ?? 0)
            : 0;
        return 280 - (value as number) * (axisIndex === 0 ? 0.8 : 1.6);
      },
    );

    const preventDefault = emitWheel(4, true, true);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    const interactiveCalls = dataBearingSetOptionCalls();
    expect(interactiveCalls).toHaveLength(1);
    const yAxes =
      (
        interactiveCalls[0].option as {
          yAxis?: Array<{ min?: number; max?: number }>;
        }
      ).yAxis ?? [];
    const primary = zoomYAxisToGrid([0, 100], 0.5, 4, 6, 4)!;
    const secondary = zoomYAxisToGrid([0, 50], 0.5, 4, 6, 4)!;
    expect(yAxes[0].min).toBeCloseTo(primary[0], 12);
    expect(yAxes[0].max).toBeCloseTo(primary[1], 12);
    expect(yAxes[1].min).toBeCloseTo(secondary[0], 12);
    expect(yAxes[1].max).toBeCloseTo(secondary[1], 12);
    expect(onSettingsChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: {
          primary: { min: primary[0], max: primary[1] },
          secondary: { min: secondary[0], max: secondary[1] },
        },
      }),
    );
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
  });

  it("zooms only the explicitly locked axis and keeps sibling axes automatic", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          lockedAxisIds: new Set(["primary"]),
          onSettingsChange,
        })}
      />,
    );
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    mockCurveHitAxis("primary");

    const preventDefault = emitWheel(4, true, true);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("chart-canvas")).not.toHaveClass(
      "is-curve-group-target",
    );

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    const committed = onSettingsChange.mock.calls[0][0];
    expect(Object.keys(committed.axes)).toEqual(["primary"]);
  });

  it("zooms only a locked secondary axis", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: {
              primary: { min: 0, max: 100 },
              secondary: { min: 0, max: 100 },
            },
          },
          lockedAxisIds: new Set(["secondary"]),
          onSettingsChange,
        })}
      />,
    );
    echartsMock.chart.setOption.mockClear();
    mockCurveHitAxis("secondary");

    emitWheel(4, true, true);

    const yAxes = dataBearingSetOptionCalls()[0].option.yAxis as Array<{
      min?: number;
      max?: number;
    }>;
    expect(yAxes[0]).toMatchObject({ min: 0, max: 100 });
    expect(yAxes[1].max).not.toBe(100);

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    const committed = onSettingsChange.mock.calls[0][0];
    expect(committed.axes.primary).toEqual({ min: 0, max: 100 });
    expect(committed.axes.secondary.min).not.toBe(0);
    expect(committed.axes.secondary.max).not.toBe(100);
  });

  it("zooms every member of a multi-axis lock set", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: {
              primary: { min: 0, max: 100 },
              secondary: { min: 0, max: 100 },
            },
          },
          lockedAxisIds: new Set(["primary", "secondary"]),
        })}
      />,
    );
    echartsMock.chart.setOption.mockClear();

    nowValue = 0;
    mockCurveHitAxis("primary");
    emitWheel(4, true, true);

    nowValue = 100;
    mockCurveHitAxis("secondary");
    emitWheel(4, true, true);
    act(() => flushAnimationFrame());

    const yAxes = dataBearingSetOptionCalls().at(-1)!.option.yAxis as Array<{
      min?: number;
      max?: number;
    }>;
    expect(yAxes[0].min).not.toBe(0);
    expect(yAxes[0].max).not.toBe(100);
    expect(yAxes[1].max).not.toBe(100);
  });

  it("does not let the curve under the pointer replace the locked scope", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: {
              primary: { min: 0, max: 100 },
              secondary: { min: 0, max: 100 },
            },
          },
          lockedAxisIds: new Set(["primary"]),
        })}
      />,
    );
    echartsMock.chart.setOption.mockClear();

    nowValue = 0;
    mockCurveHitAxis("primary");
    emitWheel(4, true, true);

    nowValue = 181;
    mockCurveHitAxis("secondary");
    emitWheel(4, true, true);
    act(() => flushAnimationFrame());

    const yAxes = dataBearingSetOptionCalls().at(-1)!.option.yAxis as Array<{
      min?: number;
      max?: number;
    }>;
    expect(yAxes[0].min).not.toBe(0);
    expect(yAxes[0].max).not.toBe(100);
    expect(yAxes[1]).toMatchObject({ min: 0, max: 100 });
  });

  it("retains the explicit lock when Shift is released", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: {
              primary: { min: 0, max: 100 },
              secondary: { min: 0, max: 100 },
            },
          },
          lockedAxisIds: new Set(["primary"]),
        })}
      />,
    );
    echartsMock.chart.setOption.mockClear();

    nowValue = 0;
    mockCurveHitAxis("primary");
    emitWheel(4, true, true);
    fireEvent.keyUp(window, { key: "Shift" });

    nowValue = 100;
    mockCurveHitAxis("secondary");
    emitWheel(4, true, true);
    act(() => flushAnimationFrame());

    const yAxes = dataBearingSetOptionCalls().at(-1)!.option.yAxis as Array<{
      min?: number;
      max?: number;
    }>;
    expect(yAxes[0].min).not.toBe(0);
    expect(yAxes[0].max).not.toBe(100);
    expect(yAxes[1]).toMatchObject({ min: 0, max: 100 });
  });

  it("retains the explicit lock when the pointer leaves the plot", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: {
              primary: { min: 0, max: 100 },
              secondary: { min: 0, max: 100 },
            },
          },
          lockedAxisIds: new Set(["primary"]),
        })}
      />,
    );
    echartsMock.chart.setOption.mockClear();

    nowValue = 0;
    mockCurveHitAxis("primary");
    emitWheel(4, true, true);
    act(() => echartsMock.zrHandlers.get("mouseout")?.({}));

    nowValue = 100;
    mockCurveHitAxis("secondary");
    emitWheel(4, true, true);
    act(() => flushAnimationFrame());

    const yAxes = dataBearingSetOptionCalls().at(-1)!.option.yAxis as Array<{
      max?: number;
    }>;
    expect(yAxes[0].max).not.toBe(100);
    expect(yAxes[1].max).toBe(100);
  });

  it("retains the explicit lock after an ordinary time zoom", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: {
              primary: { min: 0, max: 100 },
              secondary: { min: 0, max: 100 },
            },
          },
          lockedAxisIds: new Set(["primary"]),
        })}
      />,
    );
    echartsMock.chart.setOption.mockClear();

    nowValue = 0;
    mockCurveHitAxis("primary");
    emitWheel(4, true, true);
    emitWheel(1, true, false);

    nowValue = 100;
    mockCurveHitAxis("secondary");
    emitWheel(4, true, true);
    act(() => flushAnimationFrame());

    const yAxes = dataBearingSetOptionCalls().at(-1)!.option.yAxis as Array<{
      max?: number;
    }>;
    expect(yAxes[0].max).not.toBe(100);
    expect(yAxes[1].max).toBe(100);
  });

  it("keeps a hidden axis locked, does not fall back, and restores it when shown", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const secondarySeries = new Set(
      dataset.series
        .filter((series) => series.axisId === "secondary")
        .map((series) => series.id),
    );
    const props = makeProps({
      config: {
        ...config,
        axes: {
          primary: { min: 0, max: 100 },
          secondary: { min: 0, max: 100 },
        },
      },
      lockedAxisIds: new Set(["primary"]),
      visibleSeries: secondarySeries,
    });
    const view = render(<ChartView {...props} />);
    echartsMock.chart.setOption.mockClear();

    const hiddenPreventDefault = emitWheel(4, true, true);

    expect(hiddenPreventDefault).not.toHaveBeenCalled();
    expect(dataBearingSetOptionCalls()).toHaveLength(0);

    view.rerender(
      <ChartView
        {...props}
        visibleSeries={allSeries}
      />,
    );
    echartsMock.chart.setOption.mockClear();
    mockCurveHitAxis("primary");

    emitWheel(4, true, true);

    const yAxes = dataBearingSetOptionCalls()[0].option.yAxis as Array<{
      min?: number;
      max?: number;
    }>;
    expect(yAxes[0].min).not.toBe(0);
    expect(yAxes[0].max).not.toBe(100);
    expect(yAxes[1]).toMatchObject({ min: 0, max: 100 });
  });

  it("ignores Shift+wheel when no axis has a visible extent", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({ visibleSeries: new Set(), onSettingsChange })}
      />,
    );
    echartsMock.chart.setOption.mockClear();

    const preventDefault = emitWheel(4, true, true);

    expect(preventDefault).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("preserves a manually configured axis when all of its series are hidden", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    const secondarySeries = new Set(
      dataset.series
        .filter((series) => series.axisId === "secondary")
        .map((series) => series.id),
    );
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: {
              primary: { min: 0, max: 100 },
              secondary: { min: 0, max: 100 },
            },
          },
          visibleSeries: secondarySeries,
          onSettingsChange,
        })}
      />,
    );
    mockCurveHitAxis(null);

    emitWheel(4, true, true);
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));

    const committed = onSettingsChange.mock.calls[0][0];
    expect(committed.axes.primary).toEqual({ min: 0, max: 100 });
    expect(committed.axes.secondary.max).not.toBe(100);
  });

  it("reuses the interactive LOD while zooming y", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: { primary: { min: 0, max: 100 } },
          },
        })}
      />,
    );
    echartsMock.chart.convertToPixel.mockImplementation(
      (finder, value) => {
        const axisIndex =
          typeof finder === "object" && finder !== null
            ? Number((finder as { yAxisIndex?: number }).yAxisIndex ?? 0)
            : 0;
        return 280 - (value as number) * (axisIndex === 0 ? 0.8 : 1.6);
      },
    );
    echartsMock.chart.setOption.mockClear();

    emitWheel(4, true, true);
    const first = dataBearingSetOptionCalls();
    expect(first).toHaveLength(1);
    const firstData = (
      first[0].option.series as Array<{ data: unknown }>
    )[0].data;

    emitWheel(4, true, true);
    act(() => flushAnimationFrame());
    const later = dataBearingSetOptionCalls();
    expect(later).toHaveLength(2);
    expect(
      (later[1].option.series as Array<{ data: unknown }>)[0].data,
    ).toBe(firstData);
  });

  it("accumulates small Shift+wheel deltas before stepping the y-axis grid", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const zoomConfig: ChartConfig = {
      ...config,
      axes: { primary: { min: 0, max: 100 } },
    };
    render(
      <ChartView
        {...makeProps({
          config: zoomConfig,
        })}
      />,
    );
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.convertToPixel.mockImplementation(
      (finder, value) => {
        const axisIndex =
          typeof finder === "object" && finder !== null
            ? Number((finder as { yAxisIndex?: number }).yAxisIndex ?? 0)
            : 0;
        return 280 - (value as number) * (axisIndex === 0 ? 0.8 : 1.6);
      },
    );

    nowValue = 0;
    emitWheel(0.4, true, true);
    expect(dataBearingSetOptionCalls()).toHaveLength(0);

    nowValue = 16;
    emitWheel(0.4, true, true);
    expect(dataBearingSetOptionCalls()).toHaveLength(0);

    nowValue = 32;
    emitWheel(0.4, true, true);
    const calls = dataBearingSetOptionCalls();
    expect(calls).toHaveLength(1);
    const expected = zoomYAxisToGrid([0, 100], 0.5, 1, 5)!;
    const yAxes = (
      calls[0].option as { yAxis?: Array<{ min?: number; max?: number }> }
    ).yAxis ?? [];
    expect(yAxes[0].min).toBeCloseTo(expected[0], 12);
    expect(yAxes[0].max).toBeCloseTo(expected[1], 12);
  });

  it("previews the nearest axis group on Shift hover and clears it on key release", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.chart.convertToPixel.mockImplementation((finder, value) => {
      const axisIndex = Number(
        (finder as { yAxisIndex?: number }).yAxisIndex ?? 0,
      );
      return axisIndex === 0
        ? 250 - Number(value) * 2
        : 500 - Number(value) * 2;
    });

    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 201,
        event: { shiftKey: false },
      });
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 201,
        event: { shiftKey: true },
      });
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(axisPointerActions().at(-1)).toEqual({
      type: "updateAxisPointer",
      currTrigger: "leave",
    });
    expect(canvas).toHaveClass("is-curve-group-target");
    expect(echartsMock.chart.dispatchAction.mock.calls).toEqual(
      expect.arrayContaining([
        [{ type: "highlight", seriesId: "actual-temp" }, { silent: true }],
        [{ type: "highlight", seriesId: "set-temp" }, { silent: true }],
      ]),
    );

    fireEvent.keyUp(window, { key: "Shift" });

    expect(screen.getByRole("status")).toHaveClass("chart-tooltip");
    expect(canvas).not.toHaveClass("is-curve-group-target");
    expect(echartsMock.chart.dispatchAction.mock.calls).toEqual(
      expect.arrayContaining([
        [{ type: "downplay", seriesId: "actual-temp" }, { silent: true }],
        [{ type: "downplay", seriesId: "set-temp" }, { silent: true }],
      ]),
    );
  });

  it("shows pan readiness on Shift over chart background and grabbing only while pressed", () => {
    render(<ChartView {...makeProps()} />);
    const canvas = screen.getByTestId("chart-canvas");
    echartsMock.chart.convertToPixel.mockReturnValue(500);

    act(() => {
      echartsMock.zrHandlers.get("mousemove")?.({
        offsetX: 500,
        offsetY: 100,
        event: { shiftKey: false },
      });
    });
    expect(canvas).not.toHaveClass("is-y-pan-ready");
    expect(canvas).not.toHaveClass("is-curve-group-target");

    fireEvent.keyDown(window, { key: "Shift" });

    expect(canvas).toHaveClass("is-y-pan-ready");
    expect(canvas).not.toHaveClass("is-curve-group-target");
    expect(canvas).not.toHaveClass("is-panning");

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 100,
      shiftKey: true,
    });
    expect(canvas).toHaveClass("is-y-pan-ready");
    expect(canvas).toHaveClass("is-panning");

    fireEvent.pointerUp(window, {
      clientX: 500,
      clientY: 100,
      shiftKey: true,
    });
    expect(canvas).toHaveClass("is-y-pan-ready");
    expect(canvas).not.toHaveClass("is-panning");

    fireEvent.keyUp(window, { key: "Shift" });
    expect(canvas).not.toHaveClass("is-y-pan-ready");
  });

  it("toggles the hit axis lock with Shift+left click without starting a pan", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    const onVisibleRangeChange = vi.fn();
    const onToggleAxisLock = vi.fn();
    const panConfig: ChartConfig = {
      ...config,
      axes: {
        primary: { min: 0, max: 100 },
        secondary: { min: 0, max: 100 },
      },
    };
    render(
      <ChartView
        {...makeProps({
          config: panConfig,
          onToggleAxisLock,
          onSettingsChange,
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });
    echartsMock.chart.convertToPixel.mockImplementation((finder, value) => {
      const axisIndex = Number(
        (finder as { yAxisIndex?: number }).yAxisIndex ?? 0,
      );
      return axisIndex === 0
        ? 250 - Number(value) * 2
        : 500 - Number(value) * 2;
    });
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();

    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 500,
      clientY: 201,
      shiftKey: true,
    });
    expect(canvas).not.toHaveClass("is-panning");
    fireEvent.pointerUp(window, {
      clientX: 500,
      clientY: 201,
      shiftKey: true,
    });

    expect(dataBearingSetOptionCalls()).toHaveLength(0);
    expect(onToggleAxisLock).toHaveBeenCalledTimes(1);
    expect(onToggleAxisLock).toHaveBeenCalledWith("primary");
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(canvas).not.toHaveClass("is-panning");
    expect(canvas).toHaveClass("is-curve-group-target");
  });

  it("does not start Shift+left panning away from every visible curve", () => {
    const onSettingsChange = vi.fn();
    render(<ChartView {...makeProps({ onSettingsChange })} />);
    const canvas = screen.getByTestId("chart-canvas");
    echartsMock.chart.convertToPixel.mockReturnValue(500);

    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 500,
      clientY: 100,
      shiftKey: true,
    });
    fireEvent.pointerMove(window, {
      clientX: 500,
      clientY: 200,
      buttons: 1,
    });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 200 });

    expect(canvas).not.toHaveClass("is-panning");
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("clears every axis lock on Escape", () => {
    const onClearAxisLocks = vi.fn();
    render(<ChartView {...makeProps({ onClearAxisLocks })} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClearAxisLocks).toHaveBeenCalledTimes(1);
  });

  it("pans both y axes with Shift+middle drag and commits manual bounds on idle", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    const onVisibleRangeChange = vi.fn();
    const panConfig: ChartConfig = {
      ...config,
      axes: {
        primary: { min: 0, max: 100 },
        secondary: { min: 0, max: 50 },
      },
    };
    render(
      <ChartView
        {...makeProps({
          config: panConfig,
          onSettingsChange,
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });
    echartsMock.chart.setOption.mockClear();
    echartsMock.chart.dispatchAction.mockClear();
    echartsMock.zr.flush.mockClear();

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 400, buttons: 4 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 400 });

    const rawPrimary = panYAxisRange([0, 100], -1 / 6)!;
    const primary = [-18, 82] as const;
    const secondary = [-9, 41] as const;
    expect(dataBearingSetOptionCalls()).toHaveLength(1);
    expect(echartsMock.chart.dispatchAction).not.toHaveBeenCalled();
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();

    flushSettleFrames();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: {
          primary: { min: primary[0], max: primary[1] },
          secondary: { min: secondary[0], max: secondary[1] },
        },
      }),
    );
    expect(onVisibleRangeChange).not.toHaveBeenCalled();
    expect(rawPrimary[0]).toBeGreaterThan(-20);
  });

  it("pans only locked axes with Shift+middle and leaves siblings automatic", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: { primary: { min: 0, max: 100 } },
          },
          lockedAxisIds: new Set(["primary"]),
          onSettingsChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });
    echartsMock.chart.setOption.mockClear();

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 400, buttons: 4 });

    const rawPrimary = panYAxisRange([0, 100], -1 / 6)!;
    const interactiveCalls = dataBearingSetOptionCalls();
    expect(interactiveCalls).toHaveLength(1);
    const yAxes = interactiveCalls[0].option.yAxis as Array<{
      min?: number;
      max?: number;
    }>;
    expect(yAxes[0].min).toBeCloseTo(rawPrimary[0], 12);
    expect(yAxes[0].max).toBeCloseTo(rawPrimary[1], 12);
    expect(onSettingsChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { clientX: 500, clientY: 400 });
    flushSettleFrames();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));

    expect(Object.keys(onSettingsChange.mock.calls[0][0].axes)).toEqual([
      "primary",
    ]);
  });

  it("returns to the start grid line only when released within the back threshold", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: { primary: { min: 0, max: 100 } },
          },
          onSettingsChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    nowValue += 100;
    fireEvent.pointerMove(window, { clientX: 500, clientY: 470, buttons: 4 });
    nowValue += 100;
    fireEvent.pointerUp(window, { clientX: 500, clientY: 470 });

    flushSettleFrames();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: expect.objectContaining({
          primary: { min: 0, max: 100 },
        }),
      }),
    );
  });

  it("advances to the next grid line once the drag passes the threshold", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: { primary: { min: 0, max: 100 } },
          },
          onSettingsChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    nowValue += 100;
    fireEvent.pointerMove(window, { clientX: 500, clientY: 455, buttons: 4 });
    nowValue += 100;
    fireEvent.pointerUp(window, { clientX: 500, clientY: 455 });

    flushSettleFrames();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: expect.objectContaining({
          primary: { min: -18, max: 82 },
        }),
      }),
    );
  });

  it("continues one row in the flick direction when released while moving", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: { primary: { min: 0, max: 100 } },
          },
          onSettingsChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    nowValue += 16;
    fireEvent.pointerMove(window, { clientX: 500, clientY: 470, buttons: 4 });
    nowValue += 16;
    fireEvent.pointerUp(window, { clientX: 500, clientY: 470 });

    flushSettleFrames();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: expect.objectContaining({
          primary: { min: -18, max: 82 },
        }),
      }),
    );
  });

  it("animates the settle toward aligned bounds after release and commits on idle", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: { primary: { min: 0, max: 100 } },
          },
          onSettingsChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });
    echartsMock.chart.setOption.mockClear();

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 400, buttons: 4 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 400 });
    echartsMock.chart.setOption.mockClear();

    flushSettleFrames(2);
    const firstSettleCall = dataBearingSetOptionCalls();
    expect(firstSettleCall).toHaveLength(1);
    const intermediateMin = (
      firstSettleCall[0].option.yAxis as Array<{ min?: number }>
    )[0].min!;
    expect(intermediateMin).toBeLessThan(
      panYAxisRange([0, 100], -1 / 6)![0],
    );
    expect(intermediateMin).toBeGreaterThan(-20);
    expect(onSettingsChange).not.toHaveBeenCalled();

    flushSettleFrames(10);
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: expect.objectContaining({
          primary: { min: -18, max: 82 },
        }),
      }),
    );
  });

  it("cancels the settle animation when a new gesture starts", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: { primary: { min: 0, max: 100 } },
          },
          onSettingsChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 400, buttons: 4 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 400 });
    expect(animationFrames.size).toBeGreaterThan(0);

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    expect(animationFrames.size).toBe(0);
    fireEvent.pointerUp(window, { clientX: 500, clientY: 500 });

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: expect.objectContaining({
          primary: {
            min: expect.closeTo(panYAxisRange([0, 100], -1 / 6)![0], 6),
            max: expect.closeTo(panYAxisRange([0, 100], -1 / 6)![1], 6),
          },
        }),
      }),
    );
  });

  it("moves y content with the pointer when dragging downward", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: { primary: { min: 0, max: 100 } },
          },
          onSettingsChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });
    echartsMock.chart.setOption.mockClear();

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 600, buttons: 4 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 600 });

    flushSettleFrames();
    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: expect.objectContaining({
          primary: { min: 18, max: 118 },
        }),
      }),
    );
  });

  it("keeps plain middle-button drag on the x axis", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    const onVisibleRangeChange = vi.fn();
    const panConfig = {
      ...config,
      xMin: bounds.start + 60_000,
      xMax: bounds.end - 60_000,
    };
    render(
      <ChartView
        {...makeProps({
          config: panConfig,
          onSettingsChange,
          onVisibleRangeChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });

    fireEvent.pointerDown(canvas, { button: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(window, {
      clientX: 600,
      clientY: 400,
      buttons: 4,
    });
    fireEvent.pointerUp(window, { clientX: 600, clientY: 400 });

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onVisibleRangeChange).toHaveBeenCalledTimes(1);
    expect(onVisibleRangeChange).toHaveBeenCalledWith({
      start: bounds.start + 12_000,
      end: bounds.start + 492_000,
    });
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("ignores Shift+middle drag when no axis has a visible extent", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({ visibleSeries: new Set(), onSettingsChange })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });

    fireEvent.pointerDown(canvas, {
      button: 1,
      clientX: 500,
      clientY: 500,
      shiftKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 400, buttons: 4 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 400 });
    expect(canvas).not.toHaveClass("is-panning");

    act(() => vi.advanceTimersByTime(CHART_INTERACTION_IDLE_MS));
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("exports with the transient y-axis bounds merged into the option", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onSettingsChange = vi.fn();
    render(
      <ChartView
        {...makeProps({
          config: {
            ...config,
            axes: { primary: { min: 0, max: 100 } },
          },
          onSettingsChange,
        })}
      />,
    );
    const canvas = screen.getByTestId("chart-canvas");
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: 1_000,
    });
    Object.defineProperty(canvas, "clientHeight", {
      configurable: true,
      value: 600,
    });
    echartsMock.chart.convertToPixel.mockImplementation(
      (finder, value) => {
        const axisIndex =
          typeof finder === "object" && finder !== null
            ? Number((finder as { yAxisIndex?: number }).yAxisIndex ?? 0)
            : 0;
        return 280 - (value as number) * (axisIndex === 0 ? 0.8 : 1.6);
      },
    );
    emitWheel(4, true, true);

    const exportCallIndex = echartsMock.chart.setOption.mock.calls.length;
    fireEvent.contextMenu(canvas, { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("menuitem", { name: "将图像另存为" }));

    const exportOption = echartsMock.chart.setOption.mock.calls
      .slice(exportCallIndex)
      .map(([option]) => option as { yAxis?: Array<Record<string, unknown>> })
      .find((option) => Array.isArray(option.yAxis) && option.yAxis.length > 0);
    expect(exportOption).toBeTruthy();
    const primary = zoomYAxisToGrid([0, 100], 0.5, 4, 6, 4)!;
    expect(exportOption!.yAxis![0].min).toBeCloseTo(primary[0], 12);
    expect(exportOption!.yAxis![0].max).toBeCloseTo(primary[1], 12);
  });
});
