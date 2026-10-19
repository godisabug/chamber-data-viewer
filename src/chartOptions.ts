import { helper, number, type EChartsOption } from "echarts";
import {
  createXAxisTickValues,
  createXAxisLabelContext,
  formatXAxisLabel,
  MIN_VISIBLE_RANGE_MS,
  type NumericRange,
} from "./chartRange";
import type { AppliedChartSettings } from "./chartSettings";
import {
  semanticSeriesVisual,
  type PreparedDataset,
  type PreparedPoint,
  type PreparedSeries,
} from "./chartSeries";
import type { Axis } from "./types";
import { CHART_CANVAS_BACKGROUND, CHART_FONT_FAMILY } from "./chartTheme";

export type ChartConfig = AppliedChartSettings & {
  xMin: number;
  xMax: number;
};

export type ChartPresentation = {
  visibleSeries: ReadonlySet<string>;
  previewSeriesId: string | null;
  lockedAxisIds?: ReadonlySet<string>;
  cursorVisible?: boolean;
};

export type ChartRenderData = ReadonlyArray<ReadonlyArray<PreparedPoint>>;

const DATA_AXIS_Z = 0;
const Y_BOUNDARY_MASK_Z = 4;
const Y_BOUNDARY_LINE_Z = 5;
// ChartView owns hover, selection, and pan gestures. Keeping ECharts paths
// passive prevents ZRender's default link cursor from leaking into that state.
const PASSIVE_SERIES_INTERACTION = {
  cursor: "default" as const,
  silent: true,
};
const Y_BOUNDARY_MASK_OFFSET = 3;
const Y_BOUNDARY_MASK_WIDTH = 6;
const AXIS_LINE_COLOR = "#757575";
const AXIS_MASK_COLOR = CHART_CANVAS_BACKGROUND;
const GRID_LINE_COLOR = "#e0e0e0";
const GRID_LEFT = 78;
const GRID_RIGHT = 78;
/// 三纵轴（温度/湿度/气压）时右侧容纳第二条次轴（偏移一列）及其标签与轴名。
const GRID_RIGHT_THREE_AXES = 170;
const SECONDARY_AXIS_OFFSET_STEP = 60;
/// 外侧次轴刻度短线长度：与横向格线同色的“格线端点”语言，需在悬空槽内清晰可辨。
const OUTER_AXIS_TICK_LENGTH = 8;
/// 右侧存在两条次轴时，贴绘图区的高权重特征量（气压）优先于按定义顺序排列。
const EDGE_SECONDARY_AXIS_IDS: ReadonlySet<string> = new Set(["pressure"]);
const GRID_TOP = 54;
const GRID_BOTTOM = 68;
const X_AXIS_LABEL_MARGIN = 14;
const AXIS_POINTER_STROKE = "rgba(117, 117, 117, 0.42)";
const Y_BOUNDARY_ID_NAMESPACE = "__y-boundary-";

type BoundaryLayer = "mask" | "line";
const BOUNDARY_LAYERS: readonly BoundaryLayer[] = ["mask", "line"];

function boundaryAxisNamespace(
  axes: ReadonlyArray<Pick<Axis, "id">>,
): string {
  const realAxisIds = new Set(axes.map((axis) => axis.id));
  for (let salt = 0; salt <= axes.length; salt += 1) {
    const namespace =
      salt === 0
        ? Y_BOUNDARY_ID_NAMESPACE
        : `${Y_BOUNDARY_ID_NAMESPACE}${salt}-`;
    const collides = axes.some((axis) =>
      BOUNDARY_LAYERS.some((layer) =>
        realAxisIds.has(boundaryAxisId(namespace, axis.id, layer)),
      ),
    );
    if (!collides) {
      return namespace;
    }
  }

  throw new Error("无法分配纵坐标轴边界组件 ID");
}

function boundaryAxisId(
  namespace: string,
  axisId: string,
  layer: BoundaryLayer,
): string {
  return `${namespace}${layer}-${axisId}`;
}

function boundaryYAxisOptions(
  axis: Axis,
  show: boolean,
  namespace: string,
  layout: { position: "left" | "right"; offset: number },
) {
  const position = layout.position;
  const shared = {
    type: "value" as const,
    show,
    silent: true,
    name: "",
    position,
    min: 0,
    max: 1,
    scale: true,
    axisLabel: { show: false },
    axisTick: { show: false },
    splitLine: { show: false },
  };

  return [
    {
      ...shared,
      id: boundaryAxisId(namespace, axis.id, "mask"),
      z: Y_BOUNDARY_MASK_Z,
      offset: layout.offset + Y_BOUNDARY_MASK_OFFSET,
      axisLine: {
        show: true,
        onZero: false,
        lineStyle: { color: AXIS_MASK_COLOR, width: Y_BOUNDARY_MASK_WIDTH },
      },
    },
    {
      ...shared,
      id: boundaryAxisId(namespace, axis.id, "line"),
      z: Y_BOUNDARY_LINE_Z,
      offset: layout.offset,
      axisLine: {
        show: true,
        onZero: false,
        lineStyle: { color: AXIS_LINE_COLOR, width: 1 },
      },
    },
  ];
}

function validateRenderData(
  dataset: PreparedDataset,
  renderData: ChartRenderData,
): void {
  if (renderData.length !== dataset.series.length) {
    throw new Error("图表绘制数据与曲线数量不一致");
  }
}

function formatUnit(unit: string): string {
  if (unit === "degC") return "°C";
  return unit;
}

function formatAxisName(axis: Axis): string {
  const unit = formatUnit(axis.unit);
  return unit ? `${axis.name} ${unit}` : axis.name;
}

function axisNameAlign(layout: {
  position: "left" | "right";
  offset: number;
}): "left" | "right" {
  if (layout.position === "left") return "left";
  return layout.offset === 0 ? "right" : "left";
}

function axisIndexById(
  dataset: Pick<PreparedDataset, "axes">,
): Map<string, number> {
  if (dataset.axes.length === 0 || dataset.axes.length > 3) {
    throw new Error("数据集必须定义 1 至 3 条纵坐标轴");
  }

  const indexes = new Map<string, number>();
  const primaryCount = dataset.axes.filter(
    (axis) => axis.role === "primary",
  ).length;
  const secondaryCount = dataset.axes.filter(
    (axis) => axis.role === "secondary",
  ).length;
  if (primaryCount !== 1 || secondaryCount > 2) {
    throw new Error("数据集必须定义且只能定义一条主坐标轴，并最多定义两条次坐标轴");
  }
  if (primaryCount + secondaryCount !== dataset.axes.length) {
    throw new Error("数据集存在未知的纵坐标轴角色");
  }

  dataset.axes.forEach((axis, index) => {
    if (indexes.has(axis.id)) {
      throw new Error(`数据集存在重复的纵坐标轴 ID：${axis.id}`);
    }
    indexes.set(axis.id, index);
  });
  return indexes;
}

function axisLayout(
  dataset: Pick<PreparedDataset, "axes">,
): Map<string, { position: "left" | "right"; offset: number }> {
  const layout = new Map<
    string,
    { position: "left" | "right"; offset: number }
  >();
  for (const axis of dataset.axes) {
    if (axis.role === "primary") {
      layout.set(axis.id, { position: "left", offset: 0 });
      continue;
    }
  }
  // 右侧槽位：贴边优先级（EDGE_SECONDARY_AXIS_IDS）在前，其余按定义顺序依次外移；
  // 单条次轴始终贴绘图区，行为与既有双轴格式一致。
  const secondaryAxes = dataset.axes
    .filter((axis) => axis.role === "secondary")
    .sort((left, right) => {
      const leftEdge = EDGE_SECONDARY_AXIS_IDS.has(left.id) ? 1 : 0;
      const rightEdge = EDGE_SECONDARY_AXIS_IDS.has(right.id) ? 1 : 0;
      return rightEdge - leftEdge;
    });
  secondaryAxes.forEach((axis, secondaryIndex) => {
    layout.set(axis.id, {
      position: "right",
      offset: secondaryIndex * SECONDARY_AXIS_OFFSET_STEP,
    });
  });
  return layout;
}

function selectedById(
  dataset: PreparedDataset,
  visibleSeries: ReadonlySet<string>,
): Record<string, boolean> {
  return Object.fromEntries(
    dataset.series.map((series) => [series.id, visibleSeries.has(series.id)]),
  );
}

function visibleYAxisIds(
  dataset: PreparedDataset,
  presentation: ChartPresentation,
): ReadonlySet<string> {
  return new Set(
    dataset.series.flatMap((series) =>
      presentation.visibleSeries.has(series.id) && series.valueExtent !== null
        ? [series.axisId]
        : [],
    ),
  );
}

/**
 * 横向网格线是绘图区的参照线，不应随某根轴的显隐而消失：
 * 主轴可见时以主轴刻度对齐绘制；主轴不可见时移交给第一条可见次轴绘制；
 * 没有任何可见轴时不绘制。
 */
function horizontalGridOwnerAxisId(
  dataset: PreparedDataset,
  visibleAxisIds: ReadonlySet<string>,
): string | null {
  const primary = dataset.axes.find((axis) => axis.role === "primary");
  if (primary && visibleAxisIds.has(primary.id)) return primary.id;
  return (
    dataset.axes.find(
      (axis) => axis.role === "secondary" && visibleAxisIds.has(axis.id),
    )?.id ?? null
  );
}

/**
 * 竖向网格线与横向网格线共用同一显隐语义：只要还有一条可见且含有效数据的纵轴，
 * 网格就完整绘制；一条都没有时（全部曲线隐藏）网格整体消失，避免只剩竖向格线的残缺网格。
 */
function hasVisibleGridAxis(visibleAxisIds: ReadonlySet<string>): boolean {
  return visibleAxisIds.size > 0;
}

function localTimestamp(value: string): number {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/,
  );
  if (!match) return Number.NaN;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0"));
  const date = new Date(
    year,
    month - 1,
    day,
    hours,
    minutes,
    seconds,
    milliseconds,
  );

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes ||
    date.getSeconds() !== seconds ||
    date.getMilliseconds() !== milliseconds
  ) {
    return Number.NaN;
  }
  return date.getTime();
}

function datasetBounds(dataset: PreparedDataset): { start: number; end: number } {
  const start = localTimestamp(dataset.timeRange.start);
  const end = localTimestamp(dataset.timeRange.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("数据集时间范围无效");
  }
  if (start >= end) {
    throw new Error("数据集时间范围的开始时间必须早于结束时间");
  }
  return { start, end };
}

function validateConfigRange(config: ChartConfig): void {
  if (!Number.isFinite(config.xMin) || !Number.isFinite(config.xMax)) {
    throw new Error("图表时间范围无效");
  }
  if (config.xMin >= config.xMax) {
    throw new Error("图表时间范围的开始时间必须早于结束时间");
  }
}

export function xAxisExtentFor(
  xMin: number,
  xMax: number,
  bounds: NumericRange,
): NumericRange {
  const span = Math.max(0, xMax - xMin);
  return {
    start: Math.min(bounds.start, xMin - span),
    end: Math.max(bounds.end, xMax + span),
  };
}

function xAxisLabelOptions(
  config: ChartConfig,
  customValues: number[],
  clearMultilineStyle = false,
) {
  const context = createXAxisLabelContext(
    config.xMin,
    config.xMax,
    config.xGridCount,
  );
  return {
    customValues,
    formatter: (value: number, index: number) =>
      formatXAxisLabel(value, context, index === 0),
    ...(context.mode === "time"
      ? { fontSize: 12, lineHeight: 16 }
      : clearMultilineStyle
        ? {
            fontSize: null as unknown as number,
            lineHeight: null as unknown as number,
          }
        : {}),
    alignMinLabel: context.mode === "time" ? ("left" as const) : ("center" as const),
    showMinLabel:
      context.mode === "time" ? true : (null as unknown as boolean),
  };
}

function hasVisibleSeries(
  dataset: PreparedDataset,
  presentation: ChartPresentation,
): boolean {
  return (
    presentation.cursorVisible !== false &&
    dataset.series.some((series) =>
      presentation.visibleSeries.has(series.id),
    )
  );
}

function seriesVisualOption(
  series: PreparedSeries,
  axis: Axis,
  axisIndex: number,
  previewSeriesId: string | null,
  dimmedByAxisLock: boolean,
) {
  const visual = semanticSeriesVisual(
    series,
    axis,
    axisIndex,
    previewSeriesId,
    dimmedByAxisLock,
  );
  const baseWidth = series.role === "setpoint" ? 1.8 : 2.8;
  const baseOpacity = series.role === "setpoint" ? 0.86 : 1;
  return {
    id: series.id,
    lineStyle: {
      color: visual.color,
      width: visual.width,
      opacity: visual.opacity,
      type:
        series.role === "setpoint"
          ? ("dashed" as const)
          : ("solid" as const),
    },
    itemStyle: { color: visual.color, opacity: visual.opacity },
    emphasis: {
      // Normal line hover stays visually quiet. ChartView drives this state
      // explicitly only while Shift previews a curve group for lock selection.
      disabled: true,
      lineStyle: { width: baseWidth + 0.4, opacity: baseOpacity },
    },
    z: visual.z,
  };
}

function seriesPresentation(
  dataset: PreparedDataset,
  axisIndexes: ReadonlyMap<string, number>,
  presentation: ChartPresentation,
) {
  const hasAxisLocks = (presentation.lockedAxisIds?.size ?? 0) > 0;
  return dataset.series.map((series) => {
    const yAxisIndex = axisIndexes.get(series.axisId);
    if (yAxisIndex === undefined) {
      throw new Error(`曲线 ${series.name} 引用了不存在的纵坐标轴：${series.axisId}`);
    }
    return {
      ...seriesVisualOption(
        series,
        dataset.axes[yAxisIndex],
        yAxisIndex,
        presentation.previewSeriesId,
        hasAxisLocks &&
          presentation.lockedAxisIds?.has(series.axisId) !== true,
      ),
      yAxisIndex,
    };
  });
}

export type NumericExtent = [min: number, max: number];

/// 自动纵坐标范围的前后留白比例，与横向 `fitRangeWithBreathingSpace` 的 3% 对齐。
export const Y_AXIS_FIT_PADDING_RATIO = 0.03;

const MAX_Y_AXIS_LABEL_PRECISION = 20;
const MAX_Y_AXIS_LABEL_SIGNIFICANT_DIGITS = 17;

type YAxisTickPlan = {
  interval: number;
  values: number[];
  formatter: (value: number) => string;
  /** 固定小数位精度；为 null 时标签使用科学计数法。 */
  precision: number | null;
  /** 科学计数法模式下标签的有效数字位数；固定小数位模式下为 null。 */
  significantDigits: number | null;
};

function keepsYAxisLabelsDistinct(
  values: readonly number[],
  formatter: (value: number) => string,
): boolean {
  return new Set(values.map(formatter)).size === values.length;
}

function normalizeExponentialLabel(label: string): string {
  const [coefficient, exponent] = label.split("e");
  const conciseCoefficient = coefficient.replace(/\.?0+$/, "");
  return `${conciseCoefficient}e${Number(exponent)}`;
}

function formatShortestYAxisLabel(value: number): string {
  if (value === 0) return "0";
  const label = String(value);
  return label.includes("e") ? normalizeExponentialLabel(label) : label;
}

function createExponentialYAxisLabelFormatter(
  values: readonly number[],
): Pick<YAxisTickPlan, "formatter" | "significantDigits"> {
  for (
    let significantDigits = 1;
    significantDigits <= MAX_Y_AXIS_LABEL_SIGNIFICANT_DIGITS;
    significantDigits += 1
  ) {
    const formatter = (value: number) =>
      value === 0
        ? "0"
        : normalizeExponentialLabel(
            value.toExponential(significantDigits - 1),
          );
    if (keepsYAxisLabelsDistinct(values, formatter)) {
      return { formatter, significantDigits };
    }
  }

  return {
    formatter: formatShortestYAxisLabel,
    significantDigits: null,
  };
}

function createYAxisTickPlan(
  extent: NumericExtent,
  gridCount: number,
): YAxisTickPlan {
  const interval = (extent[1] - extent[0]) / gridCount;
  const values = Array.from({ length: gridCount + 1 }, (_, index) =>
    index === gridCount ? extent[1] : extent[0] + interval * index,
  );
  let precision = 1;
  let formatter = (value: number) => String(number.round(value, precision));

  while (
    precision < MAX_Y_AXIS_LABEL_PRECISION &&
    !keepsYAxisLabelsDistinct(values, formatter)
  ) {
    precision += 1;
    formatter = (value) => String(number.round(value, precision));
  }

  if (!keepsYAxisLabelsDistinct(values, formatter)) {
    const exponential = createExponentialYAxisLabelFormatter(values);
    return {
      interval,
      values,
      formatter: exponential.formatter,
      precision: null,
      significantDigits: exponential.significantDigits,
    };
  }

  return {
    interval,
    values,
    formatter,
    precision,
    significantDigits: null,
  };
}

/**
 * 生成游标卡片等数据展示用的数值格式化函数。
 * 卡片读数是网格线之间的精细读数，精度应比纵轴标签多一级：
 * 固定小数位模式下取标签的最大小数位数再加一位（标签为 `24.2` 时卡片显示到两位小数，
 * 如 `24.03`；标签为整数如 `0、2、4、6` 时卡片仍保留一位小数，如 `2.4`）；
 * 科学计数法模式下系数比标签多一位有效数字（如标签 `2e-21`，卡片 `2.4e-21`）。
 */
export function createYAxisValueFormatter(
  extent: NumericExtent,
  gridCount: number,
): (value: number) => string {
  const tickPlan = createYAxisTickPlan(extent, gridCount);
  if (tickPlan.precision === null) {
    if (tickPlan.significantDigits === null) {
      return tickPlan.formatter;
    }
    const coefficientDigits = tickPlan.significantDigits + 1;
    return (value) =>
      value === 0
        ? "0"
        : normalizeExponentialLabel(
            value.toExponential(coefficientDigits - 1),
          );
  }
  const precision =
    maxLabelDecimalPlaces(tickPlan.values, tickPlan.formatter) + 1;
  return (value) => value.toFixed(precision);
}

function maxLabelDecimalPlaces(
  values: readonly number[],
  formatter: (value: number) => string,
): number {
  let max = 0;
  for (const value of values) {
    const label = formatter(value);
    const dotIndex = label.indexOf(".");
    if (dotIndex < 0) continue;
    const fraction = label.slice(dotIndex + 1);
    if (fraction.length > 0 && /^\d+$/.test(fraction)) {
      max = Math.max(max, fraction.length);
    }
  }
  return max;
}

function isFiniteAscendingExtent(extent: NumericExtent): boolean {
  return (
    Number.isFinite(extent[0]) &&
    Number.isFinite(extent[1]) &&
    extent[0] < extent[1]
  );
}

function fixedPrecisionLosesInterval(
  extent: NumericExtent,
  gridCount: number,
): boolean {
  if (!isFiniteAscendingExtent(extent)) return false;
  const interval = (extent[1] - extent[0]) / gridCount;
  return number.round(interval, MAX_Y_AXIS_LABEL_PRECISION) !== interval;
}

/**
 * 次轴自动范围的“整数整格”解析：从 {1, 2, 5} × 10ⁿ 中选择
 * 能覆盖数据的最小整数步长 step，min 对齐到 step 整数倍、
 * 跨度恒为 格数 × step，使默认 6 格下湿度标签始终是整数。
 */
export function autoIntegerAlignedExtent(
  dataExtent: readonly [min: number, max: number],
  gridCount: number,
): NumericExtent {
  const [dataMin, dataMax] = dataExtent;
  const span = Math.max(0, dataMax - dataMin);
  const firstExponent = Math.max(
    0,
    Math.floor(Math.log10(Math.max(span, 1) / gridCount)),
  );
  for (let exponent = firstExponent; exponent <= 6; exponent += 1) {
    for (const factor of [1, 2, 5]) {
      const step = factor * 10 ** exponent;
      const min = Math.floor(dataMin / step) * step;
      const max = min + gridCount * step;
      if (max >= dataMax) return [min, max];
    }
  }
  return [dataMin, dataMax];
}

function fitYAxisDataExtent(extent: NumericExtent): NumericExtent {
  const span = Math.max(0, extent[1] - extent[0]);
  const padding = span * Y_AXIS_FIT_PADDING_RATIO;
  const min = extent[0] - padding;
  const max = extent[1] + padding;
  return min < max ? [min, max] : extent;
}

export function resolveYAxisExtents(
  dataset: PreparedDataset,
  config: Pick<ChartConfig, "axes" | "yGridCount">,
  presentation: ChartPresentation,
): Map<string, NumericExtent | null> {
  const dataExtents = new Map<string, NumericExtent>(
    dataset.axes.map((axis) => [
      axis.id,
      [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    ]),
  );

  // 自动范围由轴上全部曲线共同决定，与图例显隐无关：
  // 点击图例只切换曲线显示，不能让坐标轴刻度跟随可见曲线跳动。
  for (const series of dataset.series) {
    if (!series.valueExtent) continue;
    const axisExtent = dataExtents.get(series.axisId);
    if (!axisExtent) continue;
    axisExtent[0] = Math.min(axisExtent[0], series.valueExtent[0]);
    axisExtent[1] = Math.max(axisExtent[1], series.valueExtent[1]);
  }

  return new Map(
    dataset.axes.map((axis) => {
      const manualBounds = config.axes[axis.id];
      const dataExtent = dataExtents.get(axis.id)!;
      const manualMin = manualBounds?.min;
      const manualMax = manualBounds?.max;
      const autoFittedExtent =
        manualMin === undefined &&
        manualMax === undefined &&
        dataExtent[0] <= dataExtent[1]
          ? fitYAxisDataExtent(dataExtent)
          : dataExtent;
      const hasVisibleData = dataset.series.some(
        (series) =>
          series.axisId === axis.id &&
          presentation.visibleSeries.has(series.id) &&
          series.valueExtent !== null,
      );
      if (
        (!hasVisibleData || dataExtent[0] > dataExtent[1]) &&
        manualMin === undefined &&
        manualMax === undefined
      ) {
        return [axis.id, null];
      }
      if (manualMin !== undefined && manualMax !== undefined) {
        const manualExtent: NumericExtent = [manualMin, manualMax];
        if (!isFiniteAscendingExtent(manualExtent)) {
          throw new Error(`纵坐标轴 ${axis.id} 的手动范围无效`);
        }
        return [axis.id, manualExtent];
      }
      if (
        axis.role === "secondary" &&
        manualMin === undefined &&
        manualMax === undefined
      ) {
        return [
          axis.id,
          autoIntegerAlignedExtent(dataExtent, config.yGridCount),
        ];
      }
      const rawExtent: NumericExtent = [
        manualMin ?? autoFittedExtent[0],
        manualMax ?? autoFittedExtent[1],
      ];
      if (fixedPrecisionLosesInterval(rawExtent, config.yGridCount)) {
        return [axis.id, rawExtent];
      }
      const scale = helper.createScale(autoFittedExtent, {
        type: "value",
        scale: true,
        min: manualMin,
        max: manualMax,
        splitNumber: config.yGridCount,
      });
      return [axis.id, scale.getExtent() as NumericExtent];
    }),
  );
}

function boundaryYAxisVisibilityUpdates(
  dataset: PreparedDataset,
  visibleAxisIds: ReadonlySet<string>,
) {
  const namespace = boundaryAxisNamespace(dataset.axes);
  return dataset.axes.flatMap((axis) => {
    const show = visibleAxisIds.has(axis.id);
    return [
      { id: boundaryAxisId(namespace, axis.id, "mask"), show },
      { id: boundaryAxisId(namespace, axis.id, "line"), show },
    ];
  });
}

export function buildChartUpdate(
  dataset: PreparedDataset,
  config: ChartConfig,
  presentation: ChartPresentation,
  renderData?: ChartRenderData,
): EChartsOption {
  if (renderData !== undefined) validateRenderData(dataset, renderData);
  const axisIndexes = axisIndexById(dataset);
  datasetBounds(dataset);
  validateConfigRange(config);
  const presentedSeries = seriesPresentation(dataset, axisIndexes, presentation);
  const yAxisExtents = resolveYAxisExtents(dataset, config, presentation);
  const visibleAxisIds = visibleYAxisIds(dataset, presentation);
  const gridOwnerAxisId = horizontalGridOwnerAxisId(dataset, visibleAxisIds);
  const axisPointerVisible = hasVisibleSeries(dataset, presentation);
  const xTicks = createXAxisTickValues(
    config.xMin,
    config.xMax,
    config.xGridCount,
  );
  const dataYAxisUpdates = dataset.axes.map((axis) => {
    const extent = yAxisExtents.get(axis.id)!;
    const tickPlan = extent
      ? createYAxisTickPlan(extent, config.yGridCount)
      : null;
    return {
      id: axis.id,
      show: visibleAxisIds.has(axis.id),
      min: extent?.[0] ?? null,
      max: extent?.[1] ?? null,
      // ECharts setOption uses null to clear a merged explicit interval, but the
      // public option type omits this update-only clear value.
      interval: tickPlan
        ? tickPlan.interval
        : (null as unknown as number),
      splitNumber: config.yGridCount,
      splitLine: { show: axis.id === gridOwnerAxisId },
      axisTick: {
        customValues: tickPlan?.values ?? [],
      },
      axisLabel: {
        customValues: tickPlan?.values ?? [],
        ...(tickPlan ? { formatter: tickPlan.formatter } : {}),
      },
    };
  });

  return {
    legend: {
      selected: selectedById(dataset, presentation.visibleSeries),
    },
    dataZoom: [
      {
        id: "inside-zoom",
        startValue: config.xMin,
        endValue: config.xMax,
      },
    ],
    xAxis: {
      axisPointer: {
        show: axisPointerVisible,
        ...(!axisPointerVisible ? { status: "hide" as const } : {}),
      },
      axisTick: { show: false, customValues: xTicks },
      axisLabel: {
        ...xAxisLabelOptions(config, xTicks, true),
      },
      splitLine: { show: hasVisibleGridAxis(visibleAxisIds) },
    },
    yAxis:
      renderData === undefined
        ? [
            ...dataYAxisUpdates,
            ...boundaryYAxisVisibilityUpdates(dataset, visibleAxisIds),
          ]
        : dataYAxisUpdates,
    series: presentedSeries.map((series, index) => ({
      ...PASSIVE_SERIES_INTERACTION,
      id: series.id,
      lineStyle: series.lineStyle,
      itemStyle: series.itemStyle,
      emphasis: series.emphasis,
      z: series.z,
      ...(renderData === undefined
        ? {}
        : { data: renderData[index] as PreparedPoint[] }),
    })),
  };
}

export function buildChartOptions(
  dataset: PreparedDataset,
  config: ChartConfig,
  presentation: ChartPresentation,
  renderData: ChartRenderData = dataset.series.map((series) => series.points),
): EChartsOption {
  validateRenderData(dataset, renderData);
  const axisIndexes = axisIndexById(dataset);
  const bounds = datasetBounds(dataset);
  validateConfigRange(config);
  const xExtent = xAxisExtentFor(config.xMin, config.xMax, bounds);
  const presentedSeries = seriesPresentation(dataset, axisIndexes, presentation);
  const yAxisExtents = resolveYAxisExtents(dataset, config, presentation);
  const visibleAxisIds = visibleYAxisIds(dataset, presentation);
  const gridOwnerAxisId = horizontalGridOwnerAxisId(dataset, visibleAxisIds);
  const axisPointerVisible = hasVisibleSeries(dataset, presentation);
  const layout = axisLayout(dataset);
  const xTicks = createXAxisTickValues(
    config.xMin,
    config.xMax,
    config.xGridCount,
  );
  const dataYAxes = dataset.axes.map((axis) => {
    const extent = yAxisExtents.get(axis.id)!;
    const tickPlan = extent
      ? createYAxisTickPlan(extent, config.yGridCount)
      : null;
    const axisPlacement = layout.get(axis.id)!;
    return {
      id: axis.id,
      type: "value" as const,
      show: visibleAxisIds.has(axis.id),
      z: DATA_AXIS_Z,
      name: formatAxisName(axis),
      position: axisPlacement.position,
      offset: axisPlacement.offset,
      scale: true,
      ...(tickPlan
        ? {
            min: extent[0],
            max: extent[1],
            interval: tickPlan.interval,
          }
        : {}),
      splitNumber: config.yGridCount,
      nameTextStyle: {
        color: AXIS_LINE_COLOR,
        fontFamily: CHART_FONT_FAMILY,
        fontSize: 12,
        align: axisNameAlign(axisPlacement),
        padding: [0, 0, 8, 0],
      },
      axisLine: {
        show: true,
        lineStyle: { color: AXIS_LINE_COLOR, width: 1 },
      },
      axisTick: {
        show: axisPlacement.offset > 0,
        customValues: tickPlan?.values ?? [],
        ...(axisPlacement.offset > 0
          ? {
              inside: true,
              length: OUTER_AXIS_TICK_LENGTH,
              lineStyle: { color: GRID_LINE_COLOR },
            }
          : {}),
      },
      axisLabel: {
        color: AXIS_LINE_COLOR,
        fontFamily: CHART_FONT_FAMILY,
        customValues: tickPlan?.values ?? [],
        ...(tickPlan ? { formatter: tickPlan.formatter } : {}),
      },
      splitLine: {
        show: axis.id === gridOwnerAxisId,
        lineStyle: { color: GRID_LINE_COLOR, width: 1 },
      },
    };
  });
  const boundaryNamespace = boundaryAxisNamespace(dataset.axes);
  const boundaryYAxes = dataset.axes.flatMap((axis) =>
    boundaryYAxisOptions(
      axis,
      visibleAxisIds.has(axis.id),
      boundaryNamespace,
      layout.get(axis.id)!,
    ),
  );

  return {
    animation: false,
    tooltip: { show: false },
    // 游标轴线不跟随 ECharts 自带的鼠标监听，由 ChartView 连同读数卡片一起显隐。
    axisPointer: { triggerOn: "none" },
    legend: {
      show: false,
      data: dataset.series.map((series) => series.id),
      selected: selectedById(dataset, presentation.visibleSeries),
    },
    grid: {
      left: GRID_LEFT,
      right:
        dataset.axes.length > 2 ? GRID_RIGHT_THREE_AXES : GRID_RIGHT,
      top: GRID_TOP,
      bottom: GRID_BOTTOM,
    },
    xAxis: {
      type: "time",
      z: DATA_AXIS_Z,
      min: xExtent.start,
      max: xExtent.end,
      axisPointer: {
        show: axisPointerVisible,
        type: "line",
        snap: false,
        label: { show: false },
        triggerTooltip: false,
        triggerEmphasis: false,
        animation: false,
        lineStyle: {
          color: AXIS_POINTER_STROKE,
          width: 1,
          type: "solid",
        },
      },
      axisLine: {
        onZero: false,
        lineStyle: { color: AXIS_LINE_COLOR, width: 1 },
      },
      axisTick: { show: false, customValues: xTicks },
      axisLabel: {
        color: "#757575",
        fontFamily: CHART_FONT_FAMILY,
        hideOverlap: true,
        margin: X_AXIS_LABEL_MARGIN,
        ...xAxisLabelOptions(config, xTicks),
      },
      splitLine: {
        show: hasVisibleGridAxis(visibleAxisIds),
        lineStyle: { color: GRID_LINE_COLOR, width: 1 },
      },
    },
    yAxis: [...dataYAxes, ...boundaryYAxes],
    dataZoom: [
      {
        id: "inside-zoom",
        type: "inside",
        startValue: config.xMin,
        endValue: config.xMax,
        minValueSpan: MIN_VISIBLE_RANGE_MS,
        filterMode: "none",
        disabled: true,
        zoomOnMouseWheel: false,
        moveOnMouseWheel: false,
        moveOnMouseMove: false,
      },
    ],
    series: presentedSeries.map((series, index) => ({
      ...PASSIVE_SERIES_INTERACTION,
      id: series.id,
      name: dataset.series[index].id,
      type: "line",
      sampling: "none",
      clip: true,
      showSymbol: false,
      connectNulls: false,
      smooth: false,
      yAxisIndex: series.yAxisIndex,
      lineStyle: series.lineStyle,
      itemStyle: series.itemStyle,
      emphasis: series.emphasis,
      z: series.z,
      data: renderData[index] as PreparedPoint[],
    })),
  };
}
