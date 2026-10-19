import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartConfig } from "../chartOptions";
import { prepareDataset } from "../chartSeries";
import type { AppliedChartSettings } from "../chartSettings";
import { makeDataset } from "../test/fixtures";
import type { DataPoint } from "../types";
import { ChartWorkspace } from "./ChartWorkspace";

type ChartRenderRecord = {
  sourceId: string;
  config: ChartConfig;
  visibleCount: number;
  visibleSeries: string[];
  lockedAxisIds: string[];
  cursorVisible: boolean;
  preview: string | null;
  emptyWithinAxisRange: boolean;
  helpOpen: boolean;
  onVisibleRangeChange: (range: { start: number; end: number }) => void;
  onSettingsChange: (settings: AppliedChartSettings) => void;
  onToggleAxisLock: (axisId: string) => void;
  onClearAxisLocks: () => void;
};

const chartViewMock = vi.hoisted(() => ({
  renders: [] as ChartRenderRecord[],
}));

vi.mock("./ChartView", () => ({
  ChartView: ({
    dataset,
    config,
    visibleSeries,
    previewSeriesId,
    lockedAxisIds,
    cursorVisible,
    onToggleAxisLock,
    onClearAxisLocks,
    onVisibleRangeChange,
    onSettingsChange,
    emptyWithinAxisRange,
    helpOpen,
  }: {
    dataset: { sourceId: string };
    config: ChartConfig;
    visibleSeries: ReadonlySet<string>;
    previewSeriesId: string | null;
    lockedAxisIds: ReadonlySet<string>;
    cursorVisible: boolean;
    onToggleAxisLock: (axisId: string) => void;
    onClearAxisLocks: () => void;
    onVisibleRangeChange: (range: { start: number; end: number }) => void;
    onSettingsChange: (settings: AppliedChartSettings) => void;
    emptyWithinAxisRange: boolean;
    helpOpen: boolean;
  }) => {
    chartViewMock.renders.push({
      sourceId: dataset.sourceId,
      config,
      visibleCount: visibleSeries.size,
      visibleSeries: [...visibleSeries].sort(),
      lockedAxisIds: [...lockedAxisIds].sort(),
      cursorVisible,
      preview: previewSeriesId,
      emptyWithinAxisRange,
      helpOpen,
      onVisibleRangeChange,
      onSettingsChange,
      onToggleAxisLock,
      onClearAxisLocks,
    });

    return (
      <div data-testid="chart-view">
        <output data-testid="chart-config">{JSON.stringify(config)}</output>
        <output data-testid="chart-visible-count">{visibleSeries.size}</output>
        <output data-testid="chart-locked-axes">
          {[...lockedAxisIds].sort().join(",") || "none"}
        </output>
        <output data-testid="chart-preview">
          {previewSeriesId ?? "null"}
        </output>
        {emptyWithinAxisRange ? <span>当前坐标范围内无数据</span> : null}
        <button
          type="button"
          onClick={() => onToggleAxisLock("primary")}
        >
          模拟锁定温度轴
        </button>
        <button
          type="button"
          onClick={() => onToggleAxisLock("secondary")}
        >
          模拟锁定湿度轴
        </button>
        <button type="button" onClick={onClearAxisLocks}>
          模拟清除轴锁定
        </button>
        <button
          type="button"
          onClick={() =>
            onVisibleRangeChange({
              start: config.xMin + 60_000,
              end: config.xMax - 60_000,
            })
          }
        >
          模拟图表范围
        </button>
        <button
          type="button"
          onClick={() =>
            onSettingsChange({
              yGridCount: config.yGridCount,
              xGridCount: config.xGridCount,
              axes: { ...config.axes, primary: { min: 20, max: 30 } },
            })
          }
        >
          模拟纵轴设置
        </button>
      </div>
    );
  },
}));

const visibleCount = () =>
  Number(screen.getByTestId("chart-visible-count").textContent);

const makePreparedDataset = (...args: Parameters<typeof makeDataset>) =>
  prepareDataset(makeDataset(...args));

function applyPrimarySettings(
  min: number,
  max: number,
  yGridCount: number,
  xGridCount: number,
) {
  fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
  fireEvent.change(screen.getByLabelText("温度下限"), {
    target: { value: String(min) },
  });
  fireEvent.change(screen.getByLabelText("温度上限"), {
    target: { value: String(max) },
  });
  fireEvent.change(screen.getByLabelText("纵轴刻度格数"), {
    target: { value: String(yGridCount) },
  });
  fireEvent.change(screen.getByLabelText("横轴刻度格数"), {
    target: { value: String(xGridCount) },
  });
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
}

beforeEach(() => {
  chartViewMock.renders.length = 0;
  localStorage.clear();
});

describe("ChartWorkspace", () => {
  it("persists cursor visibility globally without letting reset change it", () => {
    const dataset = makePreparedDataset();
    const view = render(<ChartWorkspace dataset={dataset} />);

    const cursorToggle = () => screen.getByRole("button", { name: "游标" });
    expect(cursorToggle()).toHaveAttribute("aria-pressed", "true");
    expect(chartViewMock.renders.at(-1)?.cursorVisible).toBe(true);

    fireEvent.click(cursorToggle());
    expect(cursorToggle()).toHaveAttribute("aria-pressed", "false");
    expect(chartViewMock.renders.at(-1)?.cursorVisible).toBe(false);
    expect(
      localStorage.getItem("chamber-data-viewer:chart-cursor-visible"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "重置视图" }));
    expect(cursorToggle()).toHaveAttribute("aria-pressed", "false");

    view.unmount();
    render(<ChartWorkspace dataset={dataset} />);
    expect(cursorToggle()).toHaveAttribute("aria-pressed", "false");
    expect(chartViewMock.renders.at(-1)?.cursorVisible).toBe(false);
  });

  it("supplies the current displayed y-axis range to the settings panel", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);

    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    fireEvent.change(screen.getByLabelText("温度上限"), {
      target: { value: "50" },
    });

    const lowerBound = screen.getByLabelText<HTMLInputElement>("温度下限");
    expect(lowerBound).not.toHaveValue(null);
    expect(Number.isFinite(Number(lowerBound.value))).toBe(true);
  });

  it("opens help without discarding a settings draft or an axis lock", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "模拟锁定温度轴" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    const upperBound = screen.getByLabelText("温度上限");
    fireEvent.change(upperBound, { target: { value: "50" } });

    fireEvent.click(
      screen.getByRole("button", { name: "图表操作速查（F1）" }),
    );

    expect(
      screen.getByRole("dialog", { name: "图表操作速查" }),
    ).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "图表设置" }),
    ).toBeVisible();
    expect(screen.getByLabelText("温度上限")).toHaveValue(50);
    expect(chartViewMock.renders.at(-1)).toMatchObject({
      helpOpen: true,
      lockedAxisIds: ["primary"],
    });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: "图表操作速查" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("chart-locked-axes")).toHaveTextContent(
      "primary",
    );
    expect(screen.getByLabelText("温度上限")).toHaveValue(50);
  });

  it("preserves the chart workspace selector contract", () => {
    const { container } = render(
      <ChartWorkspace dataset={makePreparedDataset()} />,
    );

    const workspace = container.querySelector("section.workspace-panel");
    expect(workspace).toHaveAttribute(
      "data-od-id",
      "chart-workspace",
    );
    expect(workspace).toHaveAttribute(
      "data-applied-range-start",
      String(new Date("2025-12-31T23:59:42").getTime()),
    );
    expect(workspace).toHaveAttribute(
      "data-applied-range-end",
      String(new Date("2026-01-01T00:10:18").getTime()),
    );

    fireEvent.click(screen.getByRole("button", { name: "模拟图表范围" }));

    expect(workspace).toHaveAttribute(
      "data-applied-range-start",
      String(new Date("2026-01-01T00:00:42").getTime()),
    );
    expect(workspace).toHaveAttribute(
      "data-applied-range-end",
      String(new Date("2026-01-01T00:09:18").getTime()),
    );
  });

  it("does not show the empty overlay when a continuation crosses the range", () => {
    const raw = makeDataset();
    const actualTemperature = raw.series.find(
      (series) => series.id === "actual-temp",
    )!;
    const continuationDataset = makePreparedDataset({
      axes: [raw.axes[0]],
      series: [
        {
          ...actualTemperature,
          points: [
            ["2026-01-01 00:00:00", 0],
            ["2026-01-01 00:10:00", 10],
          ],
        },
      ],
    });
    render(<ChartWorkspace dataset={continuationDataset} />);

    fireEvent.click(screen.getByRole("button", { name: "模拟图表范围" }));

    expect(chartViewMock.renders.at(-1)?.emptyWithinAxisRange).toBe(false);
    expect(
      screen.queryByText("当前坐标范围内无数据"),
    ).not.toBeInTheDocument();
  });

  it("coordinates the minimal header, legend visibility, and preview", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);

    expect(screen.getByRole("region", { name: "数据曲线" })).toBeVisible();
    expect(screen.queryByText("趋势工作台")).not.toBeInTheDocument();
    expect(screen.queryByText(/条记录/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "实测温度" }));
    expect(visibleCount()).toBe(3);

    const setTemperature = screen.getByRole("button", { name: "设定温度" });
    fireEvent.mouseEnter(setTemperature);
    expect(screen.getByTestId("chart-preview")).toHaveTextContent("set-temp");
    fireEvent.mouseLeave(setTemperature);
    expect(screen.getByTestId("chart-preview")).toHaveTextContent("null");
  });

  it("toggles an entire legend group through its group label", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);

    const temperatureGroup = screen.getByRole("button", {
      name: "温度，点击切换整组显示",
    });
    expect(visibleCount()).toBe(4);

    fireEvent.click(temperatureGroup);
    expect(visibleCount()).toBe(2);
    expect(screen.getByRole("button", { name: "实测温度" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "设定温度" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.click(temperatureGroup);
    expect(visibleCount()).toBe(4);
  });

  it("locks one axis group at a time, independent from visibility", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);
    const lockedAxes = () =>
      screen.getByTestId("chart-locked-axes").textContent;

    fireEvent.click(
      screen.getByRole("button", { name: "模拟锁定温度轴" }),
    );
    expect(lockedAxes()).toBe("primary");

    // 锁定另一组时，原先锁定的组自动解除。
    fireEvent.click(
      screen.getByRole("button", { name: "模拟锁定湿度轴" }),
    );
    expect(lockedAxes()).toBe("secondary");
    expect(
      screen.queryByRole("button", { name: /温度，点击切换整组显示，已锁定/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /湿度，点击切换整组显示，已锁定/ }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "模拟锁定湿度轴" }),
    );
    expect(lockedAxes()).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: "模拟锁定温度轴" }));
    const temperatureGroup = screen.getByRole("button", {
      name: /温度，点击切换整组显示，已锁定/,
    });
    fireEvent.click(temperatureGroup);
    expect(visibleCount()).toBe(2);
    expect(lockedAxes()).toBe("primary");

    fireEvent.click(temperatureGroup);
    expect(visibleCount()).toBe(4);
    expect(lockedAxes()).toBe("primary");

    // 图例与曲线共用同一套换锁规则。
    fireEvent.click(screen.getByRole("button", { name: /^湿度，/ }), {
      shiftKey: true,
    });
    expect(lockedAxes()).toBe("secondary");

    fireEvent.click(screen.getByRole("button", { name: /^湿度，/ }), {
      shiftKey: true,
    });
    expect(lockedAxes()).toBe("none");
  });

  it("hides a previewed series without an intermediate stale preview", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);
    const actualTemperature = screen.getByRole("button", {
      name: "实测温度",
    });
    fireEvent.mouseEnter(actualTemperature);
    expect(chartViewMock.renders.at(-1)).toMatchObject({
      visibleCount: 4,
      preview: "actual-temp",
    });

    const firstToggleRender = chartViewMock.renders.length;
    fireEvent.click(actualTemperature);

    const toggleRenders = chartViewMock.renders.slice(firstToggleRender);
    expect(toggleRenders.length).toBeGreaterThan(0);
    for (const record of toggleRenders) {
      expect(record).toMatchObject({ visibleCount: 3, preview: null });
    }
  });

  it("never renders a new dataset with stale transient chart state", () => {
    const datasetA = makePreparedDataset();
    const view = render(<ChartWorkspace dataset={datasetA} />);
    fireEvent.click(screen.getByRole("button", { name: "实测温度" }));
    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "设定温度" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    fireEvent.click(screen.getByRole("button", { name: "模拟图表范围" }));
    expect(visibleCount()).toBe(3);
    expect(
      screen.getByRole("complementary", { name: "图表设置" }),
    ).toBeVisible();

    const rawB = makeDataset();
    const datasetB = makePreparedDataset({
      sourceId: "c:/fixtures/february.csv",
      sourceFile: "february.csv",
      timeRange: {
        start: "2026-02-01 00:00:00",
        end: "2026-02-01 00:20:00",
      },
      series: rawB.series.slice(0, 2).map((series, seriesIndex) => ({
        ...series,
        id: `february-${seriesIndex}`,
        points: series.points.map(
          ([, value], pointIndex) =>
            [
              pointIndex === 0
                ? "2026-02-01 00:00:00"
                : "2026-02-01 00:10:00",
              value,
            ] as DataPoint,
        ),
      })),
    });
    const firstDatasetBRender = chartViewMock.renders.length;

    view.rerender(<ChartWorkspace dataset={datasetB} />);

    const datasetBRenders = chartViewMock.renders.slice(firstDatasetBRender);
    expect(datasetBRenders.length).toBeGreaterThan(0);
    for (const record of datasetBRenders) {
      expect(record.sourceId).toBe(datasetB.sourceId);
      expect(record.visibleCount).toBe(datasetB.series.length);
      expect(record.preview).toBeNull();
      expect(record.config.axes).toEqual({});
      expect(record.config.xMin).toBe(
        new Date("2026-01-31T23:59:24").getTime(),
      );
      expect(record.config.xMax).toBe(
        new Date("2026-02-01T00:20:36").getTime(),
      );
    }
    expect(
      screen.queryByRole("complementary", { name: "图表设置" }),
    ).not.toBeInTheDocument();
  });

  it("clears an unapplied time draft for an equal-range dataset object", () => {
    const datasetA = makePreparedDataset();
    const view = render(<ChartWorkspace dataset={datasetA} />);
    const endInput = screen.getByLabelText("截止时间");

    fireEvent.change(endInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "应用范围" }));

    expect(endInput).toHaveValue("");
    expect(endInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("请输入截止时间")).toBeVisible();

    const replacement = makePreparedDataset();
    const firstReplacementRender = chartViewMock.renders.length;

    view.rerender(<ChartWorkspace dataset={replacement} />);

    const replacementRenders = chartViewMock.renders.slice(
      firstReplacementRender,
    );
    expect(replacementRenders.length).toBeGreaterThan(0);
    for (const record of replacementRenders) {
      expect(record.sourceId).toBe(replacement.sourceId);
      expect(record.visibleCount).toBe(4);
      expect(record.visibleSeries).toEqual([
        "actual-humidity",
        "actual-temp",
        "set-humidity",
        "set-temp",
      ]);
      expect(record.preview).toBeNull();
      expect(record.config.axes).toEqual({});
      expect(record.config.yGridCount).toBe(6);
      expect(record.config.xGridCount).toBe(6);
      expect(record.config.xMin).toBe(
        new Date("2025-12-31T23:59:42").getTime(),
      );
      expect(record.config.xMax).toBe(
        new Date("2026-01-01T00:10:18").getTime(),
      );
    }

    const startInput = screen.getByLabelText("开始时间");
    const replacementEndInput = screen.getByLabelText("截止时间");
    expect(startInput).toHaveValue("2025-12-31 23:59:42");
    expect(startInput).toHaveAttribute("aria-invalid", "false");
    expect(replacementEndInput).toHaveValue("2026-01-01 00:10:18");
    expect(replacementEndInput).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("请输入截止时间")).not.toBeInTheDocument();
  });

  it("ignores an escaped range callback from the previous dataset", () => {
    const datasetA = makePreparedDataset();
    const datasetB = makePreparedDataset({
      sourceId: "c:/fixtures/replacement.csv",
      sourceFile: "replacement.csv",
    });
    const view = render(<ChartWorkspace dataset={datasetA} />);
    const staleDatasetACallback =
      chartViewMock.renders.at(-1)!.onVisibleRangeChange;

    view.rerender(<ChartWorkspace dataset={datasetB} />);
    const currentDatasetBCallback =
      chartViewMock.renders.at(-1)!.onVisibleRangeChange;
    const workspace = view.container.querySelector("section.workspace-panel");
    const defaultStart = new Date("2025-12-31T23:59:42").getTime();
    const defaultEnd = new Date("2026-01-01T00:10:18").getTime();

    act(() => {
      staleDatasetACallback({
        start: defaultStart + 60_000,
        end: defaultEnd - 60_000,
      });
    });

    expect(workspace).toHaveAttribute(
      "data-applied-range-start",
      String(defaultStart),
    );
    expect(workspace).toHaveAttribute(
      "data-applied-range-end",
      String(defaultEnd),
    );

    act(() => {
      currentDatasetBCallback({
        start: defaultStart + 120_000,
        end: defaultEnd - 120_000,
      });
    });

    expect(workspace).toHaveAttribute(
      "data-applied-range-start",
      String(defaultStart + 120_000),
    );
    expect(workspace).toHaveAttribute(
      "data-applied-range-end",
      String(defaultEnd - 120_000),
    );
  });

  it("ignores an escaped range callback from a previous activation of the same dataset", () => {
    const datasetA = makePreparedDataset();
    const datasetB = makePreparedDataset({
      sourceId: "c:/fixtures/replacement.csv",
      sourceFile: "replacement.csv",
    });
    const view = render(<ChartWorkspace dataset={datasetA} />);
    const firstDatasetAActivationCallback =
      chartViewMock.renders.at(-1)!.onVisibleRangeChange;
    const workspace = view.container.querySelector("section.workspace-panel");
    const defaultStart = new Date("2026-01-01T00:00:00").getTime();
    const defaultEnd = new Date("2026-01-01T00:10:00").getTime();
    const restoredRange = {
      start: defaultStart + 60_000,
      end: defaultEnd - 60_000,
    };

    act(() => firstDatasetAActivationCallback(restoredRange));
    view.rerender(<ChartWorkspace dataset={datasetB} />);
    view.rerender(<ChartWorkspace dataset={datasetA} />);
    const currentDatasetAActivationCallback =
      chartViewMock.renders.at(-1)!.onVisibleRangeChange;

    expect(workspace).toHaveAttribute(
      "data-applied-range-start",
      String(restoredRange.start),
    );
    expect(workspace).toHaveAttribute(
      "data-applied-range-end",
      String(restoredRange.end),
    );

    act(() => {
      firstDatasetAActivationCallback({
        start: defaultStart + 120_000,
        end: defaultEnd - 120_000,
      });
    });

    expect(workspace).toHaveAttribute(
      "data-applied-range-start",
      String(restoredRange.start),
    );
    expect(workspace).toHaveAttribute(
      "data-applied-range-end",
      String(restoredRange.end),
    );

    act(() => {
      currentDatasetAActivationCallback({
        start: defaultStart + 180_000,
        end: defaultEnd - 180_000,
      });
    });

    expect(workspace).toHaveAttribute(
      "data-applied-range-start",
      String(defaultStart + 180_000),
    );
    expect(workspace).toHaveAttribute(
      "data-applied-range-end",
      String(defaultEnd - 180_000),
    );
  });

  it("restores durable chart state independently for each dataset", () => {
    const datasetA = makePreparedDataset();
    const rawB = makeDataset();
    const datasetB = makePreparedDataset({
      sourceId: "c:/fixtures/february.csv",
      sourceFile: "february.csv",
      timeRange: {
        start: "2026-02-01 00:00:00",
        end: "2026-02-01 00:20:00",
      },
      series: rawB.series.map((series) => ({
        ...series,
        points: series.points.map(
          ([, value], pointIndex) =>
            [
              pointIndex === 0
                ? "2026-02-01 00:00:00"
                : "2026-02-01 00:20:00",
              value,
            ] as DataPoint,
        ),
      })),
    });
    const allSeries = [
      "actual-humidity",
      "actual-temp",
      "set-humidity",
      "set-temp",
    ];
    const view = render(<ChartWorkspace dataset={datasetA} />);

    fireEvent.click(screen.getByRole("button", { name: "模拟图表范围" }));
    fireEvent.click(screen.getByRole("button", { name: "实测温度" }));
    applyPrimarySettings(20, 30, 4, 7);
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    fireEvent.change(screen.getByLabelText("温度下限"), {
      target: { value: "21" },
    });
    fireEvent.mouseEnter(screen.getByRole("button", { name: "设定温度" }));
    expect(screen.getByTestId("chart-preview")).toHaveTextContent("set-temp");

    const firstDatasetBRender = chartViewMock.renders.length;
    view.rerender(<ChartWorkspace dataset={datasetB} />);

    const datasetBRenders = chartViewMock.renders.slice(firstDatasetBRender);
    expect(datasetBRenders.length).toBeGreaterThan(0);
    for (const record of datasetBRenders) {
      expect(record.sourceId).toBe(datasetB.sourceId);
      expect(record.visibleSeries).toEqual(allSeries);
      expect(record.preview).toBeNull();
      expect(record.config.axes).toEqual({});
      expect(record.config.yGridCount).toBe(6);
      expect(record.config.xGridCount).toBe(6);
      expect(record.config.xMin).toBe(
        new Date("2026-01-31T23:59:24").getTime(),
      );
      expect(record.config.xMax).toBe(
        new Date("2026-02-01T00:20:36").getTime(),
      );
    }
    expect(
      screen.queryByRole("complementary", { name: "图表设置" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "模拟图表范围" }));
    fireEvent.click(screen.getByRole("button", { name: "设定湿度" }));
    applyPrimarySettings(5, 15, 3, 8);
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    fireEvent.change(screen.getByLabelText("温度下限"), {
      target: { value: "6" },
    });
    fireEvent.mouseEnter(screen.getByRole("button", { name: "实测湿度" }));
    expect(screen.getByTestId("chart-preview")).toHaveTextContent(
      "actual-humidity",
    );

    const firstRestoredARender = chartViewMock.renders.length;
    view.rerender(<ChartWorkspace dataset={datasetA} />);

    const restoredARenders = chartViewMock.renders.slice(firstRestoredARender);
    expect(restoredARenders.length).toBeGreaterThan(0);
    for (const record of restoredARenders) {
      expect(record.sourceId).toBe(datasetA.sourceId);
      expect(record.visibleSeries).toEqual([
        "actual-humidity",
        "set-humidity",
        "set-temp",
      ]);
      expect(record.preview).toBeNull();
      expect(record.config.axes).toEqual({
        primary: { min: 20, max: 30 },
        secondary: {},
      });
      expect(record.config.yGridCount).toBe(4);
      expect(record.config.xGridCount).toBe(7);
      expect(record.config.xMin).toBe(
        new Date("2026-01-01T00:00:42").getTime(),
      );
      expect(record.config.xMax).toBe(
        new Date("2026-01-01T00:09:18").getTime(),
      );
    }
    expect(
      screen.queryByRole("complementary", { name: "图表设置" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    expect(screen.getByLabelText("温度下限")).toHaveValue(20);
    expect(screen.getByLabelText("温度下限")).not.toHaveValue(21);
    fireEvent.click(
      screen.getByRole("button", { name: "关闭图表设置" }),
    );

    const firstRestoredBRender = chartViewMock.renders.length;
    view.rerender(<ChartWorkspace dataset={datasetB} />);

    const restoredBRenders = chartViewMock.renders.slice(firstRestoredBRender);
    expect(restoredBRenders.length).toBeGreaterThan(0);
    for (const record of restoredBRenders) {
      expect(record.sourceId).toBe(datasetB.sourceId);
      expect(record.visibleSeries).toEqual([
        "actual-humidity",
        "actual-temp",
        "set-temp",
      ]);
      expect(record.preview).toBeNull();
      expect(record.config.axes).toEqual({
        primary: { min: 5, max: 15 },
        secondary: {},
      });
      expect(record.config.yGridCount).toBe(3);
      expect(record.config.xGridCount).toBe(8);
      expect(record.config.xMin).toBe(
        new Date("2026-02-01T00:00:24").getTime(),
      );
      expect(record.config.xMax).toBe(
        new Date("2026-02-01T00:19:36").getTime(),
      );
    }
    expect(
      screen.queryByRole("complementary", { name: "图表设置" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    expect(screen.getByLabelText("温度下限")).toHaveValue(5);
    expect(screen.getByLabelText("温度下限")).not.toHaveValue(6);
  });

  it("uses defaults for replacement objects and after remount", () => {
    const dataset = makePreparedDataset();
    const view = render(<ChartWorkspace dataset={dataset} />);
    fireEvent.click(screen.getByRole("button", { name: "模拟图表范围" }));
    fireEvent.click(screen.getByRole("button", { name: "实测温度" }));
    applyPrimarySettings(20, 30, 4, 7);

    const replacement = makePreparedDataset();
    const firstReplacementRender = chartViewMock.renders.length;
    view.rerender(<ChartWorkspace dataset={replacement} />);

    const replacementRenders = chartViewMock.renders.slice(
      firstReplacementRender,
    );
    expect(replacementRenders.length).toBeGreaterThan(0);
    for (const record of replacementRenders) {
      expect(record.sourceId).toBe(replacement.sourceId);
      expect(record.visibleSeries).toEqual([
        "actual-humidity",
        "actual-temp",
        "set-humidity",
        "set-temp",
      ]);
      expect(record.preview).toBeNull();
      expect(record.config.axes).toEqual({});
      expect(record.config.yGridCount).toBe(6);
      expect(record.config.xGridCount).toBe(6);
      expect(record.config.xMin).toBe(
        new Date("2025-12-31T23:59:42").getTime(),
      );
      expect(record.config.xMax).toBe(
        new Date("2026-01-01T00:10:18").getTime(),
      );
    }

    view.unmount();
    const firstRemountRender = chartViewMock.renders.length;
    render(<ChartWorkspace dataset={dataset} />);

    const remountRenders = chartViewMock.renders.slice(firstRemountRender);
    expect(remountRenders.length).toBeGreaterThan(0);
    for (const record of remountRenders) {
      expect(record.sourceId).toBe(dataset.sourceId);
      expect(record.visibleSeries).toEqual([
        "actual-humidity",
        "actual-temp",
        "set-humidity",
        "set-temp",
      ]);
      expect(record.preview).toBeNull();
      expect(record.config.axes).toEqual({});
      expect(record.config.yGridCount).toBe(6);
      expect(record.config.xGridCount).toBe(6);
      expect(record.config.xMin).toBe(
        new Date("2025-12-31T23:59:42").getTime(),
      );
      expect(record.config.xMax).toBe(
        new Date("2026-01-01T00:10:18").getTime(),
      );
    }
  });

  it("commits panned y-axis bounds through the settings callback", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);

    fireEvent.click(screen.getByRole("button", { name: "模拟纵轴设置" }));

    const configOutput = JSON.parse(
      screen.getByTestId("chart-config").textContent ?? "{}",
    );
    expect(configOutput).toMatchObject({
      axes: { primary: { min: 20, max: 30 } },
    });
    expect(chartViewMock.renders.at(-1)?.onSettingsChange).toBeInstanceOf(
      Function,
    );
  });

  it("resets the time range, axis bounds and grid counts from the range reset", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "模拟锁定温度轴" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "模拟图表范围" }));
    applyPrimarySettings(20, 30, 4, 7);
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    expect(screen.getByLabelText("温度下限")).toHaveValue(20);

    fireEvent.click(screen.getByRole("button", { name: "重置视图" }));

    const config = JSON.parse(
      screen.getByTestId("chart-config").textContent ?? "{}",
    );
    expect(config.axes).toEqual({});
    expect(config.yGridCount).toBe(6);
    expect(config.xGridCount).toBe(6);
    expect(config.xMin).toBe(new Date("2025-12-31T23:59:42").getTime());
    expect(config.xMax).toBe(new Date("2026-01-01T00:10:18").getTime());
    expect(screen.getByTestId("chart-locked-axes")).toHaveTextContent(
      "none",
    );
    expect(screen.getByLabelText("开始时间")).toHaveValue(
      "2025-12-31 23:59:42",
    );
    expect(screen.getByLabelText("截止时间")).toHaveValue(
      "2026-01-01 00:10:18",
    );
  });
});
