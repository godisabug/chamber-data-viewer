import * as echarts from "echarts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  buildChartOptions,
  buildChartUpdate,
  createYAxisValueFormatter,
  resolveYAxisExtents,
  xAxisExtentFor,
  type ChartConfig,
} from "../chartOptions";
import {
  effectiveYAxisIds,
  interpolateSeries,
  isAxisLockClick,
  pickNearestCurveGroup,
  placeTooltip,
  rangeFromPercent,
} from "../chartInteraction";
import { groupTooltipRows, type TooltipRow } from "../tooltipGroups";
import {
  buildLodWindow,
  CHART_INTERACTION_IDLE_MS,
} from "../chartLod";
import {
  panRange,
  type NumericRange,
  zoomRangeFromWheel,
} from "../chartRange";
import type { AppliedChartSettings, AxisBounds } from "../chartSettings";
import { browserChartInputClock } from "../chartInputScheduler";
import {
  gridPanSnapTarget,
  nearestGridStep,
  panYAxisRange,
  panReleaseVelocity,
  yZoomRungs,
  zoomYAxisToGrid,
  type PanSample,
  type YZoomWheelAccumulator,
} from "../chartYRange";
import {
  ChartViewportSession,
  type ChartViewport,
  type ChartViewportInput,
  type ChartViewportRenderQuality,
  type ChartViewportRenderWindow,
} from "../chartViewportSession";
import {
  CHART_EXPORT_PIXEL_RATIO,
  createChartExportDataUrl,
  createChartImageFileName,
} from "../chartExport";
import {
  semanticSeriesVisual,
  type PreparedDataset,
} from "../chartSeries";
import { saveChartImage } from "../tauri";

/** 超过该点数后，图表首帧渲染让位给后续交互（如打开文件对话框）。 */
const LARGE_DATASET_POINTS = 50_000;

type Props = {
  dataset: PreparedDataset;
  config: ChartConfig;
  visibleSeries: ReadonlySet<string>;
  previewSeriesId: string | null;
  lockedAxisIds: ReadonlySet<string>;
  cursorVisible?: boolean;
  helpOpen?: boolean;
  onToggleAxisLock: (axisId: string) => void;
  onClearAxisLocks: () => void;
  onVisibleRangeChange: (range: NumericRange) => void;
  onSettingsChange: (settings: AppliedChartSettings) => void;
  emptyWithinAxisRange: boolean;
};

type TooltipState = {
  x: number;
  y: number;
  time: number;
  rows: TooltipRow[];
};

type DataZoomPayload = {
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
  batch?: DataZoomPayload[];
};

type ZrPointerEvent = {
  offsetX: number;
  offsetY: number;
  event?: { shiftKey?: boolean };
};

type ZrWheelEvent = ZrPointerEvent & {
  wheelDelta: number;
  event?: { preventDefault?: () => void; shiftKey?: boolean };
};

type PanState = {
  mode: "x" | "y";
  buttonMask: 4;
  pointerId: number;
  initialRange: NumericRange;
  clientX: number;
  clientY: number;
  width: number;
  height: number;
  initialAxes: Record<string, AxisBounds> | null;
  preservedAxes: Record<string, AxisBounds> | null;
  gridAxisId: string | null;
  step: number | null;
  samples: PanSample[];
};

type AxisLockPointerState = {
  axisId: string;
  pointerId: number;
  clientX: number;
  clientY: number;
};

type InteractionState = {
  viewportSession: ChartViewportSession | null;
  xAxisExtent: NumericRange | null;
  resizeFrame: number | null;
  dispatchingInputDataZoom: boolean;
};

type ContextMenuState = {
  x: number;
  y: number;
};

type CurveCandidateState = {
  axisId: string;
  seriesIds: string[];
};

/** 游标 = 轴线 + 读数卡片；两者只经由这一个入口一起显示或隐藏。 */
type CursorControl = {
  hide: () => void;
  /** 按指针当前位置和最新状态重算；不该显示时（Shift、拖动、指针已离开）隐藏。 */
  refresh: () => void;
};

const Y_PAN_SETTLE_MIN_MS = 120;
const Y_PAN_SETTLE_MAX_MS = 200;
const Y_PAN_SETTLE_MS_PER_PX = 0.9;
const Y_PAN_SAMPLE_LIMIT = 32;

function easeOutQuad(t: number): number {
  return 1 - (1 - t) ** 2;
}

function numericDatasetBounds(dataset: PreparedDataset): NumericRange {
  return {
    start: new Date(dataset.timeRange.start.replace(" ", "T")).getTime(),
    end: new Date(dataset.timeRange.end.replace(" ", "T")).getTime(),
  };
}

function rangeKey(range: NumericRange): string {
  return `${range.start}:${range.end}`;
}

const rangesEqual = (left: NumericRange, right: NumericRange) =>
  left.start === right.start && left.end === right.end;

const axesEqual = (
  left: Record<string, AxisBounds> | null,
  right: Record<string, AxisBounds> | null,
): boolean => {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      right[key]?.min === left[key].min && right[key]?.max === left[key].max,
  );
};

function formatTooltipTime(time: number): string {
  const date = new Date(time);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replaceAll("/", "-");
}

function formatValue(
  value: number | null,
  unit: string,
  format: ((value: number) => string) | null,
): string {
  if (value == null) return "—";
  const shownUnit = unit === "degC" ? "°C" : unit;
  const shownValue = format ? format(value) : value.toFixed(1);
  return `${shownValue} ${shownUnit}`.trim();
}

export function ChartView({
  dataset,
  config,
  visibleSeries,
  previewSeriesId,
  lockedAxisIds,
  cursorVisible = true,
  helpOpen = false,
  onToggleAxisLock,
  onClearAxisLocks,
  onVisibleRangeChange,
  onSettingsChange,
  emptyWithinAxisRange,
}: Props) {
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const firstContextActionRef = useRef<HTMLButtonElement | null>(null);
  const interactionRef = useRef<InteractionState>({
    viewportSession: null,
    xAxisExtent: null,
    resizeFrame: null,
    dispatchingInputDataZoom: false,
  });
  const panStateRef = useRef<PanState | null>(null);
  const cursorControlRef = useRef<CursorControl | null>(null);
  const axisLockPointerRef = useRef<AxisLockPointerState | null>(null);
  const settleAnimationRef = useRef<{ frame: number | null } | null>(null);
  const yZoomAccumulatorRef = useRef<YZoomWheelAccumulator | null>(null);
  const latestRef = useRef<Props>({
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
  });
  const curveCandidateRef = useRef<CurveCandidateState | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useLayoutEffect(() => {
    latestRef.current = {
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
    };
  }, [
    config,
    dataset,
    emptyWithinAxisRange,
    lockedAxisIds,
    cursorVisible,
    onClearAxisLocks,
    onVisibleRangeChange,
    onSettingsChange,
    onToggleAxisLock,
    previewSeriesId,
    visibleSeries,
  ]);

  const currentViewport = (): ChartViewport =>
    interactionRef.current.viewportSession?.displayedViewport() ?? {
      range: { start: latestRef.current.config.xMin, end: latestRef.current.config.xMax },
      axes: null,
    };

  const targetViewport = (): ChartViewport =>
    interactionRef.current.viewportSession?.targetViewport() ?? currentViewport();

  const currentTransientConfig = (viewport = currentViewport()) => {
    const current = latestRef.current;
    const config = {
      ...current.config,
      xMin: viewport.range.start,
      xMax: viewport.range.end,
    };
    if (!viewport.axes) return config;
    return {
      ...config,
      axes: { ...current.config.axes, ...viewport.axes },
    };
  };

  const snapshotDisplayedAxes = (): Record<string, AxisBounds> | null => {
    const current = latestRef.current;
    const extents = resolveYAxisExtents(
      current.dataset,
      currentTransientConfig(),
      {
        visibleSeries: current.visibleSeries,
        previewSeriesId: current.previewSeriesId,
      },
    );
    const visibleAxisIds = new Set(
      current.dataset.series.flatMap((series) =>
        current.visibleSeries.has(series.id) && series.valueExtent !== null
          ? [series.axisId]
          : [],
      ),
    );
    const snapshot: Record<string, AxisBounds> = {};
    for (const axis of current.dataset.axes) {
      if (!visibleAxisIds.has(axis.id)) continue;
      const extent = extents.get(axis.id);
      if (!extent) continue;
      snapshot[axis.id] = { min: extent[0], max: extent[1] };
    }
    return Object.keys(snapshot).length === 0 ? null : snapshot;
  };

  const setCurveGroupCandidate = (axisId: string | null) => {
    const chart = chartRef.current;
    const container = containerRef.current;
    const current = latestRef.current;
    const seriesIds =
      axisId === null
        ? []
        : current.dataset.series
            .filter(
              (series) =>
                series.axisId === axisId &&
                current.visibleSeries.has(series.id),
            )
            .map((series) => series.id);
    const nextAxisId = seriesIds.length > 0 ? axisId : null;
    const previous = curveCandidateRef.current;
    if (
      (previous === null && nextAxisId === null) ||
      (previous !== null &&
        previous.axisId === nextAxisId &&
        previous.seriesIds.length === seriesIds.length &&
        previous.seriesIds.every(
          (seriesId, index) => seriesId === seriesIds[index],
        ))
    ) {
      return;
    }

    if (chart && previous) {
      for (const seriesId of previous.seriesIds) {
        chart.dispatchAction(
          { type: "downplay", seriesId },
          { silent: true },
        );
      }
    }
    if (chart && nextAxisId !== null) {
      for (const seriesId of seriesIds) {
        chart.dispatchAction(
          { type: "highlight", seriesId },
          { silent: true },
        );
      }
    }
    curveCandidateRef.current =
      nextAxisId === null ? null : { axisId: nextAxisId, seriesIds };
    container?.classList.toggle(
      "is-curve-group-target",
      nextAxisId !== null,
    );
  };

  const cancelSettleAnimation = () => {
    const settle = settleAnimationRef.current;
    if (settle?.frame !== null && settle?.frame !== undefined) {
      browserChartInputClock.cancelFrame(settle.frame);
    }
    settleAnimationRef.current = null;
    interactionRef.current.viewportSession?.endGesture();
  };

  const cancelPendingInput = () => {
    interactionRef.current.viewportSession?.interrupt(false);
  };

  const cancelPendingResize = () => {
    const interaction = interactionRef.current;
    if (interaction.resizeFrame === null) return;
    browserChartInputClock.cancelFrame(interaction.resizeFrame);
    interaction.resizeFrame = null;
  };

  const clearYZoomAccumulator = () => {
    yZoomAccumulatorRef.current = null;
  };

  const prepareLod = (
    range: NumericRange,
    quality: ChartViewportRenderQuality,
  ): ChartViewportRenderWindow | null => {
    const container = containerRef.current;
    if (!container) return null;
    const current = latestRef.current;
    const pixelWidth = Math.max(1, container.clientWidth);
    return {
      window: buildLodWindow(
        current.dataset,
        range,
        numericDatasetBounds(current.dataset),
        pixelWidth,
        quality,
      ),
      quality,
      pixelWidth,
      viewportRange: { ...range },
    };
  };

  const captureInteractionPointer = (pointerId: number) => {
    const container = containerRef.current;
    if (!container) return;
    try {
      container.setPointerCapture?.(pointerId);
    } catch {
      // The pointer can already be inactive when the host delivers the event.
    }
  };

  const releaseInteractionPointer = (pointerId: number | null) => {
    const container = containerRef.current;
    if (!container || pointerId === null) return;
    try {
      if (
        container.hasPointerCapture &&
        !container.hasPointerCapture(pointerId)
      ) {
        return;
      }
      container.releasePointerCapture?.(pointerId);
    } catch {
      // Pointer capture may already have been released implicitly by the host.
    }
  };

  const discardPendingInput = (): number | null => {
    const pointerId = panStateRef.current?.pointerId ?? null;
    panStateRef.current = null;
    releaseInteractionPointer(pointerId);
    setPanningCursor(false);
    return interactionRef.current.viewportSession?.interrupt(true) ?? null;
  };

  const resumeDiscardedPanCommit = (generation: number | null) => {
    interactionRef.current.viewportSession?.resumeCommit(generation);
  };

  const cancelInteractionWork = () => {
    cancelSettleAnimation();
    cancelPendingInput();
    cancelPendingResize();
    const panPointerId = panStateRef.current?.pointerId ?? null;
    const lockPointerId = axisLockPointerRef.current?.pointerId ?? null;
    panStateRef.current = null;
    axisLockPointerRef.current = null;
    releaseInteractionPointer(panPointerId);
    releaseInteractionPointer(lockPointerId);
    clearYZoomAccumulator();
    setPanningCursor(false);
    setYPanReadyCursor(false);
    setCurveGroupCandidate(null);
  };

  const setPanningCursor = (active: boolean) => {
    const container = containerRef.current;
    if (!container) return;
    container.classList.toggle("is-panning", active);
  };

  const setYPanReadyCursor = (active: boolean) => {
    const container = containerRef.current;
    if (!container) return;
    container.classList.toggle("is-y-pan-ready", active);
  };

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = echarts.init(container);
    const zr = chart.getZr();
    const mountedDataset = dataset;
    const mountedBounds = numericDatasetBounds(mountedDataset);
    const mountedInteraction = interactionRef.current;
    chartRef.current = chart;

    let viewportSession: ChartViewportSession;
    const renderViewport = (
      viewport: ChartViewport,
      quality: ChartViewportRenderQuality,
      source: ChartViewportInput["source"],
      renderWindow: ChartViewportRenderWindow | null,
      renderDataChanged: boolean,
    ) => {
      const { range, axes } = viewport;
      const current = latestRef.current;
      const interaction = interactionRef.current;
      if (
        current.dataset !== mountedDataset ||
        chartRef.current !== chart ||
        interaction.viewportSession !== viewportSession
      ) {
        return false;
      }
      if (!renderWindow) return false;

      const neededExtent = xAxisExtentFor(
        range.start,
        range.end,
        mountedBounds,
      );
      const currentExtent = interaction.xAxisExtent;
      const needsWidenedExtent =
        currentExtent === null ||
        range.start < currentExtent.start ||
        range.end > currentExtent.end;

      interaction.dispatchingInputDataZoom = true;
      try {
        if (
          quality === "settled" ||
          renderDataChanged ||
          axes !== null ||
          needsWidenedExtent
        ) {
          const update = buildChartUpdate(
            current.dataset,
            {
              ...current.config,
              xMin: range.start,
              xMax: range.end,
              ...(axes
                ? {
                    axes: {
                      ...current.config.axes,
                      ...axes,
                    },
                  }
                : {}),
            },
            {
              visibleSeries: current.visibleSeries,
              previewSeriesId: current.previewSeriesId,
              lockedAxisIds: current.lockedAxisIds,
              cursorVisible: current.cursorVisible,
            },
            renderWindow.window.seriesData,
          );
          const widenedExtent =
            currentExtent === null
              ? neededExtent
              : {
                  start: Math.min(neededExtent.start, currentExtent.start),
                  end: Math.max(neededExtent.end, currentExtent.end),
                };
          const option = needsWidenedExtent
            ? {
                ...update,
                xAxis: {
                  ...(update.xAxis as Record<string, unknown>),
                  min: widenedExtent.start,
                  max: widenedExtent.end,
                },
              }
            : update;
          if (needsWidenedExtent) {
            interaction.xAxisExtent = widenedExtent;
          }
          chart.setOption(
            option,
            quality === "interactive"
              ? { lazyUpdate: false, silent: true }
              : { lazyUpdate: false },
          );
          if (quality === "interactive") chart.getZr().flush();
        } else if (source === "command") {
          chart.dispatchAction(
            {
              type: "dataZoom",
              dataZoomId: "inside-zoom",
              startValue: range.start,
              endValue: range.end,
              animation: { duration: 0 },
            },
            { flush: true, silent: true },
          );
        }
      } finally {
        interaction.dispatchingInputDataZoom = false;
      }
      return true;
    };
    viewportSession = new ChartViewportSession({
      initial: {
        range: { start: latestRef.current.config.xMin, end: latestRef.current.config.xMax },
        axes: latestRef.current.config.axes,
      },
      render: renderViewport,
      prepareWindow: prepareLod,
      clock: browserChartInputClock,
      commit: ({ range, axes: committedAxes }) => {
        const current = latestRef.current;
        if (
          current.config.xMin !== range.start ||
          current.config.xMax !== range.end
        ) {
          current.onVisibleRangeChange(range);
        }
        if (!axesEqual(current.config.axes, committedAxes)) {
          current.onSettingsChange({ ...current.config, axes: committedAxes });
        }
      },
      idleMs: CHART_INTERACTION_IDLE_MS,
    });
    mountedInteraction.viewportSession = viewportSession;

    const enqueueInputRange = (request: ChartViewportInput) => {
      viewportSession.push({
        range: { ...request.range },
        axes: request.axes ? { ...request.axes } : undefined,
        source: request.source,
      });
    };

    const startSettleAnimation = (
      fromAxes: Record<string, AxisBounds>,
      toAxes: Record<string, AxisBounds>,
      height: number,
    ) => {
      cancelSettleAnimation();
      const range = { ...currentViewport().range };
      let maxDistancePx = 0;
      for (const [axisId, target] of Object.entries(toAxes)) {
        const from = fromAxes[axisId];
        const targetMin = target.min;
        if (
          !from ||
          from.min === undefined ||
          from.max === undefined ||
          targetMin === undefined
        ) {
          continue;
        }
        const span = from.max - from.min;
        if (!Number.isFinite(span) || span <= 0) continue;
        maxDistancePx = Math.max(
          maxDistancePx,
          (Math.abs(targetMin - from.min) / span) * height,
        );
      }
      const duration = Math.min(
        Y_PAN_SETTLE_MAX_MS,
        Math.max(
          Y_PAN_SETTLE_MIN_MS,
          Math.round(Y_PAN_SETTLE_MS_PER_PX * maxDistancePx + 110),
        ),
      );
      let settleStart: number | null = null;
      const animate = (timestamp: number) => {
        if (settleStart === null) settleStart = timestamp;
        const elapsed = Math.min(duration, timestamp - settleStart);
        const progress = easeOutQuad(elapsed / duration);
        const interpolated: Record<string, AxisBounds> = {};
        for (const [axisId, target] of Object.entries(toAxes)) {
          const from = fromAxes[axisId];
          const targetMin = target.min;
          const targetMax = target.max;
          if (
            !from ||
            from.min === undefined ||
            from.max === undefined ||
            targetMin === undefined ||
            targetMax === undefined
          ) {
            continue;
          }
          interpolated[axisId] = {
            min: from.min + (targetMin - from.min) * progress,
            max: from.max + (targetMax - from.max) * progress,
          };
        }
        if (Object.keys(interpolated).length === 0) {
          settleAnimationRef.current = null;
          return;
        }
        enqueueInputRange({
          range,
          axes: interpolated,
          source: "command",
        });
        if (elapsed >= duration) {
          settleAnimationRef.current = null;
          viewportSession.settle({
            range,
            axes: toAxes,
            source: "command",
          });
          viewportSession.endGesture();
          return;
        }
        settleAnimationRef.current = {
          frame: browserChartInputClock.requestFrame(animate),
        };
      };
      settleAnimationRef.current = {
        frame: browserChartInputClock.requestFrame(animate),
      };
    };

    const yZoom = (event: ZrWheelEvent) => {
      const chartInstance = chartRef.current;
      if (!chartInstance) return;
      const current = latestRef.current;
      const displayedAxes = snapshotDisplayedAxes();
      if (!displayedAxes) return;
      const targetAxisIds = effectiveYAxisIds(
        current.dataset.axes.map((axis) => axis.id),
        new Set(Object.keys(displayedAxes)),
        current.lockedAxisIds,
      );
      // 锁定集合存在但当前没有可见交集时，安全地不执行，绝不回退到全轴。
      if (targetAxisIds.length === 0) return;
      const controlledAxes = { ...(targetViewport().axes ?? {}) };
      const boundsFor = (axisId: string) =>
        controlledAxes[axisId] ?? displayedAxes[axisId];
      const now = browserChartInputClock.now();
      const accumulated = yZoomRungs(
        yZoomAccumulatorRef.current,
        event.wheelDelta,
        now,
      );
      if (!accumulated) return;
      yZoomAccumulatorRef.current = accumulated.accumulator;
      if (accumulated.rungs === 0) {
        event.event?.preventDefault?.();
        return;
      }
      const axisIndexes = new Map(
        current.dataset.axes.map((axis, index) => [axis.id, index] as const),
      );
      const nextControlledAxes: Record<string, AxisBounds> = {
        ...controlledAxes,
      };
      let processedAxisCount = 0;
      let changed = false;
      for (const axisId of targetAxisIds) {
        const bounds = boundsFor(axisId);
        const displayedBounds = displayedAxes[axisId];
        const axisIndex = axisIndexes.get(axisId);
        if (!bounds || !displayedBounds || axisIndex === undefined) continue;
        const min = bounds.min;
        const max = bounds.max;
        const displayedMin = displayedBounds.min;
        const displayedMax = displayedBounds.max;
        if (
          min === undefined ||
          max === undefined ||
          displayedMin === undefined ||
          displayedMax === undefined
        ) {
          continue;
        }
        const pixelMin = chartInstance.convertToPixel(
          { yAxisIndex: axisIndex },
          displayedMin,
        );
        const pixelMax = chartInstance.convertToPixel(
          { yAxisIndex: axisIndex },
          displayedMax,
        );
        if (
          !Number.isFinite(pixelMin) ||
          !Number.isFinite(pixelMax) ||
          pixelMin === pixelMax
        ) {
          continue;
        }
        const anchorRatio = Math.min(
          1,
          Math.max(0, (pixelMax - event.offsetY) / (pixelMax - pixelMin)),
        );
        const zoomed = zoomYAxisToGrid(
          [min, max],
          anchorRatio,
          event.wheelDelta,
          current.config.yGridCount,
          accumulated.rungs,
        );
        if (!zoomed) continue;
        const nextBounds = { min: zoomed[0], max: zoomed[1] };
        nextControlledAxes[axisId] = nextBounds;
        processedAxisCount += 1;
        changed ||= nextBounds.min !== min || nextBounds.max !== max;
      }
      if (processedAxisCount !== targetAxisIds.length) return;
      event.event?.preventDefault?.();
      if (panStateRef.current !== null) {
        resumeDiscardedPanCommit(discardPendingInput());
      }
      if (!changed) return;
      enqueueInputRange({
        range: { ...currentViewport().range },
        axes: nextControlledAxes,
        source: "command",
      });
    };

    let lastPointerPoint: [number, number] | null = null;
    let shiftKeyActive = false;
    let cursorShown = false;

    const hideCursor = () => {
      setTooltip(null);
      if (!cursorShown) return;
      cursorShown = false;
      chart.dispatchAction({ type: "updateAxisPointer", currTrigger: "leave" });
    };

    const showCursorAt = (point: [number, number]) => {
      const current = latestRef.current;
      if (
        !current.cursorVisible ||
        !chart.containPixel({ gridIndex: 0 }, point)
      ) {
        hideCursor();
        return;
      }

      const converted = chart.convertFromPixel({ gridIndex: 0 }, point);
      const convertedTime = Number(
        Array.isArray(converted) ? converted[0] : converted,
      );
      if (!Number.isFinite(convertedTime)) {
        hideCursor();
        return;
      }

      const transientRange = currentViewport().range;
      const time = Math.min(
        transientRange.end,
        Math.max(transientRange.start, convertedTime),
      );
      const displayedConfig = currentTransientConfig();
      const axisExtents = resolveYAxisExtents(
        current.dataset,
        displayedConfig,
        {
          visibleSeries: current.visibleSeries,
          previewSeriesId: current.previewSeriesId,
        },
      );
      const valueFormatters = new Map<
        string,
        ((value: number) => string) | null
      >(
        current.dataset.axes.map((axis) => {
          const extent = axisExtents.get(axis.id);
          return [
            axis.id,
            extent
              ? createYAxisValueFormatter(extent, displayedConfig.yGridCount)
              : null,
          ];
        }),
      );
      const rows = current.dataset.series
        .filter((series) => current.visibleSeries.has(series.id))
        .map((series) => {
          const axisIndex = current.dataset.axes.findIndex(
            (candidate) => candidate.id === series.axisId,
          );
          const axis =
            axisIndex >= 0 ? current.dataset.axes[axisIndex] : undefined;
          return {
            id: series.id,
            axisId: series.axisId,
            name: series.name,
            unit: series.unit,
            value: interpolateSeries(series, time),
            format: valueFormatters.get(series.axisId) ?? null,
            role: series.role,
            color: axis
              ? semanticSeriesVisual(
                  series,
                  axis,
                  axisIndex,
                  current.previewSeriesId,
                ).color
              : "#757575",
          };
        });
      if (rows.length === 0) {
        hideCursor();
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const tooltipRect = tooltipRef.current?.getBoundingClientRect();
      const position = placeTooltip(
        { x: point[0], y: point[1] },
        {
          width: container.clientWidth || containerRect.width,
          height: container.clientHeight || containerRect.height,
        },
        {
          width: tooltipRect?.width || 220,
          height: tooltipRect?.height || 154,
        },
      );
      setTooltip({
        ...position,
        time,
        rows,
      });
      cursorShown = true;
      chart.dispatchAction({
        type: "updateAxisPointer",
        currTrigger: "mousemove",
        x: point[0],
        y: point[1],
      });
    };

    const refreshCursor = () => {
      if (
        lastPointerPoint === null ||
        shiftKeyActive ||
        panStateRef.current !== null ||
        axisLockPointerRef.current !== null
      ) {
        hideCursor();
        return;
      }
      showCursorAt(lastPointerPoint);
    };
    cursorControlRef.current = { hide: hideCursor, refresh: refreshCursor };

    const wheelZoom = (event: ZrWheelEvent) => {
      if (
        chartRef.current !== chart ||
        interactionRef.current.viewportSession !== viewportSession ||
        latestRef.current.dataset !== mountedDataset
      ) {
        return;
      }
      if (
        !Number.isFinite(event.wheelDelta) ||
        event.wheelDelta === 0 ||
        !chart.containPixel(
          { gridIndex: 0 },
          [event.offsetX, event.offsetY],
        )
      ) {
        return;
      }
      cancelSettleAnimation();
      if (event.event?.shiftKey) {
        shiftKeyActive = true;
        hideCursor();
        yZoom(event);
        return;
      }
      clearYZoomAccumulator();
      setCurveGroupCandidate(null);

      const converted = chart.convertFromPixel(
        { gridIndex: 0 },
        [event.offsetX, event.offsetY],
      );
      const anchorTime = Number(
        Array.isArray(converted) ? converted[0] : converted,
      );
      if (!Number.isFinite(anchorTime)) return;
      if (panStateRef.current !== null) {
        resumeDiscardedPanCommit(discardPendingInput());
      }
      const displayedRange = currentViewport().range;
      const baseRange = targetViewport().range;
      const displayedSpan = displayedRange.end - displayedRange.start;
      const baseSpan = baseRange.end - baseRange.start;
      if (
        !Number.isFinite(displayedSpan) ||
        displayedSpan <= 0 ||
        !Number.isFinite(baseSpan) ||
        baseSpan <= 0
      ) {
        return;
      }
      const anchorRatio = Math.min(
        1,
        Math.max(0, (anchorTime - displayedRange.start) / displayedSpan),
      );
      const baseAnchor = baseRange.start + baseSpan * anchorRatio;
      if (!Number.isFinite(baseAnchor)) return;
      const nextRange = zoomRangeFromWheel(
        baseRange,
        mountedBounds,
        baseAnchor,
        event.wheelDelta,
      );
      if (!nextRange) return;
      event.event?.preventDefault?.();
      enqueueInputRange({ range: nextRange, source: "command" });
    };

    const dataZoomHandler = (event: unknown) => {
      if (interactionRef.current.dispatchingInputDataZoom) return;
      clearYZoomAccumulator();
      if (typeof event !== "object" || event === null) return;
      const current = latestRef.current;
      if (current.dataset !== mountedDataset) return;
      const dataZoomEvent = event as DataZoomPayload;
      const payload = dataZoomEvent.batch?.[0] ?? dataZoomEvent;
      const bounds = numericDatasetBounds(current.dataset);
      if (
        !Number.isFinite(bounds.start) ||
        !Number.isFinite(bounds.end) ||
        bounds.start >= bounds.end
      ) {
        return;
      }

      let range: NumericRange;
      if (
        Number.isFinite(payload.startValue) &&
        Number.isFinite(payload.endValue)
      ) {
        range = {
          start: Math.min(
            bounds.end,
            Math.max(bounds.start, payload.startValue!),
          ),
          end: Math.min(
            bounds.end,
            Math.max(bounds.start, payload.endValue!),
          ),
        };
      } else if (
        Number.isFinite(payload.start) &&
        Number.isFinite(payload.end)
      ) {
        range = rangeFromPercent(
          bounds,
          Math.min(100, Math.max(0, payload.start!)),
          Math.min(100, Math.max(0, payload.end!)),
        );
      } else {
        return;
      }
      if (range.start >= range.end) return;

      if (panStateRef.current !== null) {
        resumeDiscardedPanCommit(discardPendingInput());
      }
      enqueueInputRange({ range, source: "native" });
    };

    const curveGroupAtPoint = (point: [number, number]) => {
      if (!chart.containPixel({ gridIndex: 0 }, point)) return null;
      const converted = chart.convertFromPixel({ gridIndex: 0 }, point);
      const time = Number(Array.isArray(converted) ? converted[0] : converted);
      if (!Number.isFinite(time)) return null;
      const current = latestRef.current;
      const renderData = viewportSession.currentRenderData();
      if (!renderData) return null;
      const axisIndexes = new Map(
        current.dataset.axes.map((axis, index) => [axis.id, index] as const),
      );
      return pickNearestCurveGroup(
        current.dataset.series.map((series, seriesIndex) => {
          const axisIndex = axisIndexes.get(series.axisId);
          const axis =
            axisIndex === undefined
              ? undefined
              : current.dataset.axes[axisIndex];
          return {
            id: series.id,
            axisId: series.axisId,
            points: renderData[seriesIndex] ?? [],
            z:
              axis && axisIndex !== undefined
                ? semanticSeriesVisual(
                    series,
                    axis,
                    axisIndex,
                    current.previewSeriesId,
                  ).z
                : 0,
          };
        }),
        current.visibleSeries,
        time,
        point[1],
        (axisId, value) => {
          const axisIndex = axisIndexes.get(axisId);
          if (axisIndex === undefined) return Number.NaN;
          const pixel = chart.convertToPixel({ yAxisIndex: axisIndex }, value);
          if (typeof pixel === "number") return pixel;
          return Array.isArray(pixel)
            ? Number(pixel[1] ?? pixel[0])
            : Number.NaN;
        },
      );
    };

    const previewCurveGroupAtPoint = (point: [number, number]) => {
      hideCursor();
      setCurveGroupCandidate(curveGroupAtPoint(point)?.axisId ?? null);
    };

    const pointerMove = (event: ZrPointerEvent) => {
      if (panStateRef.current || axisLockPointerRef.current) return;
      const point: [number, number] = [event.offsetX, event.offsetY];
      lastPointerPoint = point;
      shiftKeyActive = event.event?.shiftKey === true;
      setYPanReadyCursor(shiftKeyActive);
      if (shiftKeyActive) {
        previewCurveGroupAtPoint(point);
        return;
      }
      setCurveGroupCandidate(null);
      showCursorAt(point);
    };
    const pointerLeave = () => {
      lastPointerPoint = null;
      clearYZoomAccumulator();
      setYPanReadyCursor(false);
      hideCursor();
      setCurveGroupCandidate(null);
    };
    const modifierKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        axisLockPointerRef.current = null;
        if (panStateRef.current !== null) {
          resumeDiscardedPanCommit(discardPendingInput());
        }
        latestRef.current.onClearAxisLocks();
        clearYZoomAccumulator();
        setCurveGroupCandidate(null);
        return;
      }
      if (event.key !== "Shift") return;
      shiftKeyActive = true;
      // Shift 用来调整纵轴：游标的轴线与读数卡片在按下的瞬间一起让位。
      hideCursor();
      if (lastPointerPoint === null || panStateRef.current !== null) return;
      setYPanReadyCursor(true);
      previewCurveGroupAtPoint(lastPointerPoint);
    };
    const modifierKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Shift") return;
      shiftKeyActive = false;
      clearYZoomAccumulator();
      setYPanReadyCursor(false);
      if (panStateRef.current === null) setCurveGroupCandidate(null);
      refreshCursor();
    };

    const pointerDown = (event: PointerEvent) => {
      const axisLockClick = event.button === 0 && event.shiftKey;
      const middlePan = event.button === 1;
      if (!axisLockClick && !middlePan) return;
      const containerRect = container.getBoundingClientRect();
      if (axisLockClick) {
        const hit = curveGroupAtPoint([
          event.clientX - containerRect.left,
          event.clientY - containerRect.top,
        ]);
        if (hit === null) return;
        event.preventDefault();
        clearYZoomAccumulator();
        hideCursor();
        setCurveGroupCandidate(hit.axisId);
        axisLockPointerRef.current = {
          axisId: hit.axisId,
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
        };
        captureInteractionPointer(event.pointerId);
        return;
      }

      const yPan = event.shiftKey;
      const displayedAxes = yPan ? snapshotDisplayedAxes() : null;
      const targetAxisIds = displayedAxes
        ? effectiveYAxisIds(
            latestRef.current.dataset.axes.map((axis) => axis.id),
            new Set(Object.keys(displayedAxes)),
            latestRef.current.lockedAxisIds,
          )
        : [];
      if (yPan && targetAxisIds.length === 0) return;
      const initialAxes = displayedAxes
        ? Object.fromEntries(
            targetAxisIds.map((axisId) => [
              axisId,
              { ...displayedAxes[axisId] },
            ]),
          )
        : null;
      event.preventDefault();
      cancelSettleAnimation();
      cancelPendingInput();
      viewportSession.beginGesture();
      clearYZoomAccumulator();
      // 拖动平移期间读数没有意义，轴线和卡片一起收起，松手后恢复。
      hideCursor();
      setCurveGroupCandidate(null);
      const current = latestRef.current;
      const viewport = currentViewport();
      let gridAxisId: string | null = null;
      let step: number | null = null;
      if (initialAxes !== null) {
        const gridAxis = current.dataset.axes.find(
          (axis) => initialAxes[axis.id] !== undefined,
        );
        gridAxisId = gridAxis?.id ?? null;
        const gridBounds = gridAxisId ? initialAxes[gridAxisId] : undefined;
        if (gridBounds?.min !== undefined && gridBounds.max !== undefined) {
          step = nearestGridStep(
            gridBounds.max - gridBounds.min,
            current.config.yGridCount,
          );
        }
      }
      panStateRef.current = {
        mode: yPan ? "y" : "x",
        buttonMask: 4,
        pointerId: event.pointerId,
        initialRange: { ...viewport.range },
        clientX: event.clientX,
        clientY: event.clientY,
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight),
        initialAxes,
        preservedAxes:
          yPan && viewport.axes !== null
            ? { ...viewport.axes }
            : null,
        gridAxisId,
        step,
        samples: [{ y: event.clientY, t: browserChartInputClock.now() }],
      };
      captureInteractionPointer(event.pointerId);
      setPanningCursor(true);
    };

    const nextYAxesForClientY = (
      clientY: number,
    ): Record<string, AxisBounds> | null => {
      const panState = panStateRef.current;
      if (panState?.mode !== "y" || panState.initialAxes === null) return null;
      const deltaRatio = (clientY - panState.clientY) / panState.height;
      const next: Record<string, AxisBounds> = {
        ...(panState.preservedAxes ?? {}),
      };
      for (const [axisId, bounds] of Object.entries(panState.initialAxes)) {
        const { min, max } = bounds;
        if (min === undefined || max === undefined) return null;
        const panned = panYAxisRange([min, max], deltaRatio);
        if (!panned) return null;
        next[axisId] = { min: panned[0], max: panned[1] };
      }
      return next;
    };

    const snappedYAxesForClientY = (
      clientY: number,
    ): Record<string, AxisBounds> | null => {
      const panState = panStateRef.current;
      if (panState?.mode !== "y" || panState.initialAxes === null) return null;
      const raw = nextYAxesForClientY(clientY);
      if (raw === null) return null;
      if (panState.gridAxisId === null || panState.step === null) return raw;
      const gridRaw = raw[panState.gridAxisId];
      const gridMin = gridRaw?.min;
      const gridMax = gridRaw?.max;
      if (gridMin === undefined || gridMax === undefined) return raw;
      const gridSpan = gridMax - gridMin;
      if (!Number.isFinite(gridSpan) || gridSpan <= 0) return raw;
      const gridBounds = panState.initialAxes[panState.gridAxisId];
      const gridInitialMin = gridBounds?.min;
      if (gridInitialMin === undefined) return raw;
      const velocity = panReleaseVelocity(
        panState.samples,
        clientY,
        browserChartInputClock.now(),
      );
      const targetMin = gridPanSnapTarget(
        gridMin,
        panState.step,
        gridInitialMin,
        velocity,
      );
      if (targetMin === null) return raw;
      const offset = targetMin - gridMin;
      const pixelDelta = (offset * panState.height) / gridSpan;
      const next: Record<string, AxisBounds> = {
        ...(panState.preservedAxes ?? {}),
      };
      for (const [axisId] of Object.entries(panState.initialAxes)) {
        const { min, max } = raw[axisId];
        if (min === undefined || max === undefined) return null;
        const span = max - min;
        const dataDelta = (pixelDelta * span) / panState.height;
        next[axisId] = { min: min + dataDelta, max: max + dataDelta };
      }
      return next;
    };

    const nextRangeForClientX = (clientX: number): NumericRange | null => {
      const panState = panStateRef.current;
      if (panState === null) return null;
      return panRange(
        panState.initialRange,
        -(clientX - panState.clientX) / Math.max(1, panState.width),
      );
    };
    /**
     * 指针被捕获期间 zr 收不到 mousemove，还会先收到一次 mouseout；
     * 手势结束时若仍停在图上，用松手位置恢复指针坐标。
     */
    const syncPointerPoint = (event: PointerEvent) => {
      const containerRect = container.getBoundingClientRect();
      const x = event.clientX - containerRect.left;
      const y = event.clientY - containerRect.top;
      if (
        x >= 0 &&
        y >= 0 &&
        x <= containerRect.width &&
        y <= containerRect.height
      ) {
        lastPointerPoint = [x, y];
      }
    };
    const abortPan = () => {
      // 手势被打断后指针位置不再可信，等下一次移动再恢复游标。
      if (panStateRef.current !== null || axisLockPointerRef.current !== null) {
        lastPointerPoint = null;
      }
      const lockPointerId = axisLockPointerRef.current?.pointerId ?? null;
      axisLockPointerRef.current = null;
      releaseInteractionPointer(lockPointerId);
      clearYZoomAccumulator();
      resumeDiscardedPanCommit(discardPendingInput());
      setCurveGroupCandidate(null);
    };
    const abortPointer = (event: PointerEvent) => {
      const activePointerId =
        axisLockPointerRef.current?.pointerId ??
        panStateRef.current?.pointerId;
      if (activePointerId === undefined || event.pointerId !== activePointerId) {
        return;
      }
      abortPan();
    };
    const pointerPan = (event: PointerEvent) => {
      const panState = panStateRef.current;
      if (!panState) return;
      if (event.pointerId !== panState.pointerId) return;
      if (
        typeof event.buttons === "number" &&
        (event.buttons & panState.buttonMask) === 0
      ) {
        abortPan();
        return;
      }
      if (panState.mode === "y") {
        panState.samples.push({
          y: event.clientY,
          t: browserChartInputClock.now(),
        });
        if (panState.samples.length > Y_PAN_SAMPLE_LIMIT) {
          panState.samples.splice(0, panState.samples.length - Y_PAN_SAMPLE_LIMIT);
        }
        const nextAxes = nextYAxesForClientY(event.clientY);
        if (nextAxes !== null) {
          enqueueInputRange({
            range: { ...currentViewport().range },
            axes: nextAxes,
            source: "command",
          });
        }
        return;
      }
      const nextRange = nextRangeForClientX(event.clientX);
      if (nextRange !== null) {
        enqueueInputRange({ range: nextRange, source: "command" });
      }
    };
    const finishPointer = (event: PointerEvent) => {
      const lockPointer = axisLockPointerRef.current;
      if (lockPointer !== null) {
        if (event.pointerId !== lockPointer.pointerId) return;
        axisLockPointerRef.current = null;
        releaseInteractionPointer(lockPointer.pointerId);
        const containerRect = container.getBoundingClientRect();
        const endX = event.clientX - containerRect.left;
        const endY = event.clientY - containerRect.top;
        const endHit = curveGroupAtPoint([endX, endY]);
        if (
          isAxisLockClick(
            {
              x: lockPointer.clientX,
              y: lockPointer.clientY,
              axisId: lockPointer.axisId,
            },
            {
              x: event.clientX,
              y: event.clientY,
              axisId: endHit?.axisId ?? null,
            },
          )
        ) {
          latestRef.current.onToggleAxisLock(lockPointer.axisId);
        }
        shiftKeyActive = event.shiftKey;
        syncPointerPoint(event);
        setYPanReadyCursor(shiftKeyActive && lastPointerPoint !== null);
        setCurveGroupCandidate(
          shiftKeyActive ? endHit?.axisId ?? null : null,
        );
        refreshCursor();
        return;
      }

      const panState = panStateRef.current;
      if (panState === null) return;
      if (event.pointerId !== panState.pointerId) return;
      shiftKeyActive = event.shiftKey;
      syncPointerPoint(event);
      setYPanReadyCursor(shiftKeyActive && lastPointerPoint !== null);
      const displayedViewport = currentViewport();
      const finalRange =
        panState.mode === "y"
          ? { ...displayedViewport.range }
          : nextRangeForClientX(event.clientX);
      const movedY = panState.mode === "y" && event.clientY !== panState.clientY;
      const finalAxes =
        panState.mode === "y"
          ? movedY
            ? snappedYAxesForClientY(event.clientY)
            : displayedViewport.axes
          : null;
      if (finalRange === null) {
        abortPan();
        return;
      }
      if (panState.mode === "y" && finalAxes === null) {
        panStateRef.current = null;
        releaseInteractionPointer(panState.pointerId);
        setPanningCursor(false);
        setCurveGroupCandidate(null);
        viewportSession.endGesture();
        refreshCursor();
        return;
      }
      panStateRef.current = null;
      releaseInteractionPointer(panState.pointerId);
      setPanningCursor(false);
      setCurveGroupCandidate(null);
      if (
        panState.mode === "y" &&
        movedY &&
        finalAxes !== null
      ) {
        const currentAxes = displayedViewport.axes ?? snapshotDisplayedAxes();
        if (currentAxes !== null && !axesEqual(currentAxes, finalAxes)) {
          startSettleAnimation(currentAxes, finalAxes, panState.height);
          refreshCursor();
          return;
        }
      }
      viewportSession.settle({
        range: { ...finalRange },
        axes: finalAxes ?? undefined,
        source: "command",
      });
      viewportSession.endGesture();
      refreshCursor();
    };

    chart.on("datazoom", dataZoomHandler);
    zr.on("mousewheel", wheelZoom);
    zr.on("mousemove", pointerMove);
    zr.on("mouseout", pointerLeave);
    container.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointermove", pointerPan);
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", abortPointer);
    container.addEventListener("lostpointercapture", abortPointer);
    window.addEventListener("blur", abortPan);
    window.addEventListener("keydown", modifierKeyDown);
    window.addEventListener("keyup", modifierKeyUp);

    let resizePanSettlement: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      lastPointerPoint = null;
      hideCursor();
      setCurveGroupCandidate(null);
      cancelSettleAnimation();
      clearYZoomAccumulator();
      resizePanSettlement =
        discardPendingInput() ?? resizePanSettlement;
      const interaction = interactionRef.current;
      if (interaction.resizeFrame !== null) return;
      interaction.resizeFrame = browserChartInputClock.requestFrame(() => {
        const scheduledInteraction = interactionRef.current;
        scheduledInteraction.resizeFrame = null;
        resizePanSettlement =
          discardPendingInput() ?? resizePanSettlement;
        chart.resize();
        viewportSession.invalidateWindows();
        viewportSession.refreshSettled();
        const completedSettlement = resizePanSettlement;
        resizePanSettlement = null;
        resumeDiscardedPanCommit(completedSettlement);
      });
    });
    resizeObserver.observe(container);

    return () => {
      cancelInteractionWork();
      cursorControlRef.current = null;
      viewportSession.dispose();
      if (mountedInteraction.viewportSession === viewportSession) {
        mountedInteraction.viewportSession = null;
      }
      resizeObserver.disconnect();
      chart.off("datazoom", dataZoomHandler);
      zr.off("mousewheel", wheelZoom);
      zr.off("mousemove", pointerMove);
      zr.off("mouseout", pointerLeave);
      container.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointermove", pointerPan);
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", abortPointer);
      container.removeEventListener("lostpointercapture", abortPointer);
      window.removeEventListener("blur", abortPan);
      window.removeEventListener("keydown", modifierKeyDown);
      window.removeEventListener("keyup", modifierKeyUp);
      chart.dispose();
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, [dataset]);

  useEffect(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;
    cancelInteractionWork();
    const install = () => {
      const interaction = interactionRef.current;
      const current = latestRef.current;
      const range = { start: current.config.xMin, end: current.config.xMax };
      const settledLod = prepareLod(range, "settled");
      if (!settledLod) return;
      chart.setOption(
        buildChartOptions(
          current.dataset,
          current.config,
          {
            visibleSeries: current.visibleSeries,
            previewSeriesId: current.previewSeriesId,
            lockedAxisIds: current.lockedAxisIds,
            cursorVisible: current.cursorVisible,
          },
          settledLod.window.seriesData,
        ),
        { notMerge: true, lazyUpdate: false },
      );
      interaction.viewportSession?.primeSettledWindow(settledLod);
      interaction.xAxisExtent = xAxisExtentFor(
        current.config.xMin,
        current.config.xMax,
        numericDatasetBounds(current.dataset),
      );
    };
    const totalPoints = latestRef.current.dataset.series.reduce(
      (total, series) => total + series.points.length,
      0,
    );
    if (totalPoints < LARGE_DATASET_POINTS) {
      install();
      return undefined;
    }
    // 大数据集首帧后再渲染，避免加载完成后主线程被 LOD 抽样与 setOption 占住，
    // 让紧接着的点击（例如打开文件对话框）先被处理；小数据集同步渲染无感知延迟。
    // 先把初始范围登记为稳定状态，range 效果在挂载时看到已匹配从而跳过重复渲染。
    const frame = browserChartInputClock.requestFrame(() => {
      if (chartRef.current !== chart || containerRef.current !== container) {
        return;
      }
      install();
    });
    return () => browserChartInputClock.cancelFrame(frame);
  }, [dataset]);

  useEffect(() => {
    const committedRange = { start: config.xMin, end: config.xMax };
    const viewportSession = interactionRef.current.viewportSession;
    if (
      !viewportSession ||
      rangesEqual(viewportSession.stableViewport().range, committedRange)
    ) {
      return;
    }
    cancelInteractionWork();
    viewportSession.replaceStable({ range: committedRange, axes: config.axes });
    viewportSession.refreshSettled();
  }, [config.axes, config.xMax, config.xMin]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const viewportSession = interactionRef.current.viewportSession;
    const transientRange = currentViewport().range;
    if (
      viewportSession &&
      !axesEqual(viewportSession.stableViewport().axes, config.axes)
    ) {
      cancelInteractionWork();
      viewportSession.replaceStable({ range: transientRange, axes: config.axes });
    }
    chart.setOption(
      buildChartUpdate(
        dataset,
        {
          axes: config.axes,
          xGridCount: config.xGridCount,
          yGridCount: config.yGridCount,
          xMin: transientRange.start,
          xMax: transientRange.end,
        },
        { visibleSeries, previewSeriesId, lockedAxisIds, cursorVisible },
      ),
      { lazyUpdate: true },
    );
  }, [
    config.axes,
    config.xGridCount,
    config.yGridCount,
    dataset,
    cursorVisible,
    lockedAxisIds,
    previewSeriesId,
    visibleSeries,
  ]);

  useLayoutEffect(() => {
    setTooltip(null);
    setContextMenu(null);
  }, [dataset]);

  useEffect(() => {
    if (helpOpen) setContextMenu(null);
  }, [helpOpen]);

  useEffect(() => {
    if (panStateRef.current !== null) {
      resumeDiscardedPanCommit(discardPendingInput());
    }
    clearYZoomAccumulator();
    setContextMenu(null);
    setCurveGroupCandidate(null);
    // 视口或显示内容变了：按最新状态重算游标，既不留下旧读数，
    // 也不让仍停在图上的指针在缩放结束后丢掉读数。
    cursorControlRef.current?.refresh();
  }, [
    config,
    emptyWithinAxisRange,
    cursorVisible,
    lockedAxisIds,
    previewSeriesId,
    visibleSeries,
  ]);

  useLayoutEffect(() => {
    if (!contextMenu) return;
    const frame = frameRef.current;
    const menu = contextMenuRef.current;
    if (!frame || !menu) return;

    const inset = 8;
    const nextX = Math.max(
      inset,
      Math.min(contextMenu.x, frame.clientWidth - menu.offsetWidth - inset),
    );
    const nextY = Math.max(
      inset,
      Math.min(contextMenu.y, frame.clientHeight - menu.offsetHeight - inset),
    );
    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu({ x: nextX, y: nextY });
      return;
    }
    firstContextActionRef.current?.focus();
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const chartImageDataUrl = () => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return undefined;
    const current = latestRef.current;
    const exportSession = interactionRef.current.viewportSession;
    if (!exportSession) return undefined;
    if (!exportSession.currentRenderData()) return undefined;
    const exportViewport = exportSession.displayedViewport();
    const range = { ...exportViewport.range };
    const pixelWidth = Math.max(1, container.clientWidth);
    const panSettlement = discardPendingInput();
    cursorControlRef.current?.hide();
    try {
      const exportWindow = buildLodWindow(
        current.dataset,
        range,
        numericDatasetBounds(current.dataset),
        pixelWidth,
        "export",
        CHART_EXPORT_PIXEL_RATIO,
      );
      const exportConfig = {
        ...current.config,
        xMin: range.start,
        xMax: range.end,
        ...(exportViewport.axes
          ? {
              axes: {
                ...current.config.axes,
                ...exportViewport.axes,
              },
            }
          : {}),
      };
      const presentation = {
        visibleSeries: current.visibleSeries,
        previewSeriesId: null,
        lockedAxisIds: new Set<string>(),
        cursorVisible: false,
      };
      const legendItems = current.dataset.series.map((series) => {
        const axisIndex = current.dataset.axes.findIndex(
          (candidate) => candidate.id === series.axisId,
        );
        const axis =
          axisIndex >= 0 ? current.dataset.axes[axisIndex] : undefined;
        const visual = axis
          ? semanticSeriesVisual(series, axis, axisIndex, null)
          : { color: "#757575", width: 2 };
        return {
          axisId: series.axisId,
          axisName: axis?.name ?? "其他",
          name: series.name,
          color: visual.color,
          width: visual.width,
          measured: series.role === "measured",
          visible: current.visibleSeries.has(series.id),
        };
      });
      chart.setOption(
        buildChartUpdate(
          current.dataset,
          exportConfig,
          presentation,
          exportWindow.seriesData,
        ),
        { lazyUpdate: false },
      );
      chart.dispatchAction({
        type: "updateAxisPointer",
        currTrigger: "leave",
      });
      chart.getZr().flush();
      return createChartExportDataUrl(chart, legendItems);
    } finally {
      const restoreChart = chartRef.current;
      const restoreInteraction = interactionRef.current;
      try {
        if (
          restoreChart === chart &&
          restoreInteraction.viewportSession === exportSession &&
          rangeKey(exportSession.displayedViewport().range) === rangeKey(range)
        ) {
          exportSession.restoreDisplayed();
        }
      } finally {
        resumeDiscardedPanCommit(panSettlement);
      }
    }
  };

  const saveImage = async () => {
    setContextMenu(null);
    try {
      const dataUrl = chartImageDataUrl();
      if (!dataUrl) return;
      await saveChartImage(
        createChartImageFileName(dataset.sourceFile),
        dataUrl,
      );
    } catch {
      // The native dialog or filesystem permission can be denied by the OS.
    }
  };

  const copyImage = async () => {
    setContextMenu(null);
    try {
      const dataUrl = chartImageDataUrl();
      if (!dataUrl || !navigator.clipboard?.write) return;
      const response = await fetch(dataUrl);
      const sourceBlob = await response.blob();
      const pngBlob =
        sourceBlob.type === "image/png"
          ? sourceBlob
          : new Blob([sourceBlob], { type: "image/png" });
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob }),
      ]);
    } catch {
      // Clipboard access can be denied by the host WebView or OS policy.
    }
  };

  const openContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const frame = frameRef.current;
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    cursorControlRef.current?.hide();
    setCurveGroupCandidate(null);
    setContextMenu({
      x: event.clientX - frameRect.left,
      y: event.clientY - frameRect.top,
    });
  };

  return (
    <div
      className="chart-frame"
      data-od-id="chart-frame"
      onContextMenu={openContextMenu}
      ref={frameRef}
    >
      <div className="chart" data-testid="chart-canvas" ref={containerRef} />
      {contextMenu ? (
        <div
          aria-label="图表操作"
          className="chart-context-menu"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          ref={contextMenuRef}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => void saveImage()}
            ref={firstContextActionRef}
            role="menuitem"
            type="button"
          >
            将图像另存为
          </button>
          <button
            onClick={() => void copyImage()}
            role="menuitem"
            type="button"
          >
            复制图像
          </button>
        </div>
      ) : null}
      {emptyWithinAxisRange ? (
        <div className="chart-empty" role="status">
          当前坐标范围内无数据
        </div>
      ) : null}
      {tooltip ? (
        <div
          className="chart-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
          ref={tooltipRef}
          role="status"
        >
          <time>{formatTooltipTime(tooltip.time)}</time>
          {groupTooltipRows(tooltip.rows, dataset.axes).map((group) => (
            <div className="tooltip-group" key={group.axisId}>
              {group.rows.map((row) => (
                <div className="tooltip-row" key={row.id}>
                  <span>
                    <i
                      aria-hidden="true"
                      className={`series-swatch is-${row.role}`}
                      style={{ color: row.color }}
                    />
                    {row.name}
                  </span>
                  <strong>{formatValue(row.value, row.unit, row.format)}</strong>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
