import type { Axis, Dataset, Series } from "./types";
import { prepareSeriesLodIndex } from "./chartLodIndex";

export type PreparedPoint = [number, number | null];

export type PreparedSeries = Omit<Series, "points"> & {
  /** Finite numeric timestamps, strictly ascending and unique; later raw duplicates win. */
  points: PreparedPoint[];
  /** Full-series finite numeric value extent after timestamp deduplication. */
  valueExtent: [min: number, max: number] | null;
};

export type PreparedDataset = Omit<Dataset, "series"> & {
  series: PreparedSeries[];
};

export type SeriesVisual = {
  color: string;
  width: number;
  opacity: number;
  z: number;
};

export const SERIES_BACKGROUND_OPACITY = 0.2;

type VisibilityBlock = {
  startUnit: number;
  endUnit: number;
  lows: number[];
  prefixMaxHighs: number[];
};

type VisibilityIndex = {
  blockSize: number;
  blocks: VisibilityBlock[];
};

const visibilityIndexByPoints = new WeakMap<
  PreparedPoint[],
  VisibilityIndex
>();

const PRIMARY_MEASURED_COLOR = "#1c69d4";
const PRIMARY_SETPOINT_COLOR = "#4a86dc";
const SECONDARY_MEASURED_COLOR = "#262626";
const SECONDARY_SETPOINT_COLOR = "#797979";
const TERTIARY_MEASURED_COLOR = "#0f6f78";
const TERTIARY_SETPOINT_COLOR = "#5f8f94";

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

const roleOrder = (series: Pick<Series, "role">): number => {
  if (series.role === "measured") return 0;
  if (series.role === "setpoint") return 1;
  return 2;
};

/**
 * 控制器规则描述格式可能支持的全部物理量，已成立的数据组则描述当前文件实际存在
 * 的时间序列。当全部有效曲线明确只属于一个轴组时，只保留该组并提升为主轴。
 * 无有效曲线、多组有效数据或无效轴契约保持原样，交由既有校验报告，而不在这里
 * 猜测或掩盖格式错误。
 */
function axesForEffectiveSeries(
  axes: Axis[],
  series: ReadonlyArray<Pick<PreparedSeries, "axisId" | "valueExtent">>,
): Axis[] {
  const effectiveAxisIds = new Set(
    series
      .filter((item) => item.valueExtent !== null)
      .map((item) => item.axisId),
  );
  if (effectiveAxisIds.size !== 1) return axes;

  const declaredAxisIds = new Set(axes.map((axis) => axis.id));
  const primaryCount = axes.filter((axis) => axis.role === "primary").length;
  const rolesAreValid = axes.every(
    (axis) => axis.role === "primary" || axis.role === "secondary",
  );
  if (
    declaredAxisIds.size !== axes.length ||
    primaryCount !== 1 ||
    !rolesAreValid
  ) {
    return axes;
  }

  const [effectiveAxisId] = effectiveAxisIds;
  const effectiveAxis = axes.find((axis) => axis.id === effectiveAxisId);
  return effectiveAxis ? [{ ...effectiveAxis, role: "primary" }] : axes;
}

/**
 * 读数是否有效由解析层按占位符、物理值域和控制器规则统一决定；这里仅判断这些
 * 有效读数是否足以声明当前文件中存在一个时间序列数据组。
 *
 * 多行文件中的一个孤立时间戳不足以构成时间序列，常见来源是通道停用后首行残留
 * 的控制器状态。判断不区分实测/设定角色：PV-only、SV-only 以及被 null 隔开的
 * 稀疏读数只要同一曲线覆盖两个不同时间戳都能成立。组一旦由任一曲线成立，保留
 * 组内全部含有效值的曲线，避免误删同组内有意义的单点事件；不同曲线上的无关孤点
 * 不会被拼成一条时间序列。单行文件只能提供一个时间戳，因此以一个有效读数成立，
 * 保持短文件语义完整。
 */
function seriesForEffectiveDataGroups(
  series: ReadonlyArray<PreparedSeries>,
  rowCount: number,
): PreparedSeries[] {
  const dataBearingSeries = series.filter(
    (item) => item.valueExtent !== null,
  );
  const requiredTimestamps = rowCount === 1 ? 1 : 2;
  const effectiveAxisIds = new Set<string>();

  for (const item of dataBearingSeries) {
    if (effectiveAxisIds.has(item.axisId)) continue;
    let numericTimestampCount = 0;
    for (const [, value] of item.points) {
      if (value === null) continue;
      numericTimestampCount += 1;
      if (numericTimestampCount >= requiredTimestamps) {
        effectiveAxisIds.add(item.axisId);
        break;
      }
    }
  }

  return dataBearingSeries.filter((item) =>
    effectiveAxisIds.has(item.axisId),
  );
}

function numericValueExtent(
  points: ReadonlyArray<PreparedPoint>,
): [min: number, max: number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const [, value] of points) {
    if (value === null) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  return min <= max ? [min, max] : null;
}

function firstPointIndex(
  points: ReadonlyArray<PreparedPoint>,
  time: number,
  after: boolean,
): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (after ? points[middle][0] <= time : points[middle][0] < time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function visiblePointsForRange(
  points: ReadonlyArray<PreparedPoint>,
  start: number,
  end: number,
): PreparedPoint[] {
  if (points.length === 0 || start > end) return [];

  const firstInside = firstPointIndex(points, start, false);
  const afterInside = firstPointIndex(points, end, true);
  const from = Math.max(0, firstInside - 1);
  const to = Math.min(points.length, afterInside + 1);
  return points.slice(from, to);
}

function segmentIntersectsYBounds(
  left: PreparedPoint,
  right: PreparedPoint,
  start: number,
  end: number,
  bounds: { min?: number; max?: number } | undefined,
): boolean {
  if (
    left[1] === null ||
    right[1] === null ||
    !Number.isFinite(left[0]) ||
    !Number.isFinite(right[0]) ||
    !Number.isFinite(left[1]) ||
    !Number.isFinite(right[1]) ||
    left[0] >= right[0]
  ) {
    return false;
  }
  const valueAt = (time: number): number => {
    const ratio = (time - left[0]) / (right[0] - left[0]);
    return left[1]! + (right[1]! - left[1]!) * ratio;
  };
  const startValue = valueAt(start);
  const endValue = valueAt(end);
  const segmentMin = Math.min(startValue, endValue);
  const segmentMax = Math.max(startValue, endValue);
  const min = bounds?.min ?? Number.NEGATIVE_INFINITY;
  const max = bounds?.max ?? Number.POSITIVE_INFINITY;
  return segmentMax >= min && segmentMin <= max;
}

function numericPointInYBounds(
  point: PreparedPoint,
  bounds: { min?: number; max?: number } | undefined,
): boolean {
  const [time, value] = point;
  return (
    value !== null &&
    Number.isFinite(time) &&
    Number.isFinite(value) &&
    (bounds?.min === undefined || value >= bounds.min) &&
    (bounds?.max === undefined || value <= bounds.max)
  );
}

function buildVisibilityIndex(points: PreparedPoint[]): VisibilityIndex {
  const unitCount = Math.max(0, points.length - 1);
  const blockSize = Math.max(32, Math.ceil(Math.sqrt(points.length)));
  const blocks: VisibilityBlock[] = [];

  for (let startUnit = 0; startUnit < unitCount; startUnit += blockSize) {
    const endUnit = Math.min(unitCount, startUnit + blockSize);
    const intervals: Array<[low: number, high: number]> = [];
    let runMin = Number.POSITIVE_INFINITY;
    let runMax = Number.NEGATIVE_INFINITY;
    const flushRun = () => {
      if (runMin <= runMax) intervals.push([runMin, runMax]);
      runMin = Number.POSITIVE_INFINITY;
      runMax = Number.NEGATIVE_INFINITY;
    };

    for (let unit = startUnit; unit < endUnit; unit += 1) {
      const left = points[unit];
      const right = points[unit + 1];
      const leftNumeric =
        Number.isFinite(left[0]) &&
        left[1] !== null &&
        Number.isFinite(left[1]);
      const rightNumeric =
        Number.isFinite(right[0]) &&
        right[1] !== null &&
        Number.isFinite(right[1]);
      if (!leftNumeric) {
        flushRun();
        continue;
      }

      runMin = Math.min(runMin, left[1]!);
      runMax = Math.max(runMax, left[1]!);
      if (rightNumeric && left[0] < right[0]) {
        runMin = Math.min(runMin, right[1]!);
        runMax = Math.max(runMax, right[1]!);
      } else {
        flushRun();
      }
    }
    flushRun();

    intervals.sort(([leftLow], [rightLow]) => leftLow - rightLow);
    const lows: number[] = [];
    const prefixMaxHighs: number[] = [];
    let prefixMaxHigh = Number.NEGATIVE_INFINITY;
    for (const [low, high] of intervals) {
      lows.push(low);
      prefixMaxHigh = Math.max(prefixMaxHigh, high);
      prefixMaxHighs.push(prefixMaxHigh);
    }
    blocks.push({ startUnit, endUnit, lows, prefixMaxHighs });
  }

  return { blockSize, blocks };
}

function blockIntersectsYBounds(
  block: VisibilityBlock,
  bounds: { min?: number; max?: number } | undefined,
): boolean {
  const min = bounds?.min ?? Number.NEGATIVE_INFINITY;
  const max = bounds?.max ?? Number.POSITIVE_INFINITY;
  let low = 0;
  let high = block.lows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (block.lows[middle] <= max) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > 0 && block.prefixMaxHighs[low - 1] >= min;
}

function unitIntersectsYBounds(
  points: ReadonlyArray<PreparedPoint>,
  unit: number,
  bounds: { min?: number; max?: number } | undefined,
): boolean {
  const left = points[unit];
  const right = points[unit + 1];
  return (
    numericPointInYBounds(left, bounds) ||
    segmentIntersectsYBounds(left, right, left[0], right[0], bounds)
  );
}

function indexedUnitsIntersectYBounds(
  points: ReadonlyArray<PreparedPoint>,
  index: VisibilityIndex,
  fromUnit: number,
  toUnit: number,
  bounds: { min?: number; max?: number } | undefined,
): boolean {
  let cursor = fromUnit;
  while (cursor < toUnit && cursor % index.blockSize !== 0) {
    if (unitIntersectsYBounds(points, cursor, bounds)) return true;
    cursor += 1;
  }
  while (cursor + index.blockSize <= toUnit) {
    const block = index.blocks[Math.floor(cursor / index.blockSize)];
    if (
      block?.startUnit === cursor &&
      block.endUnit === cursor + index.blockSize &&
      blockIntersectsYBounds(block, bounds)
    ) {
      return true;
    }
    cursor += index.blockSize;
  }
  while (cursor < toUnit) {
    if (unitIntersectsYBounds(points, cursor, bounds)) return true;
    cursor += 1;
  }
  return false;
}

function indexedSeriesHasVisibleData(
  points: PreparedPoint[],
  index: VisibilityIndex,
  range: { start: number; end: number },
  bounds: { min?: number; max?: number } | undefined,
): boolean {
  const firstInside = firstPointIndex(points, range.start, false);
  const afterInside = firstPointIndex(points, range.end, true);
  if (firstInside === afterInside) {
    if (firstInside === 0 || firstInside >= points.length) return false;
    return segmentIntersectsYBounds(
      points[firstInside - 1],
      points[firstInside],
      range.start,
      range.end,
      bounds,
    );
  }

  if (
    firstInside > 0 &&
    segmentIntersectsYBounds(
      points[firstInside - 1],
      points[firstInside],
      range.start,
      Math.min(range.end, points[firstInside][0]),
      bounds,
    )
  ) {
    return true;
  }

  const lastInside = afterInside - 1;
  if (
    indexedUnitsIntersectYBounds(
      points,
      index,
      firstInside,
      lastInside,
      bounds,
    )
  ) {
    return true;
  }
  if (numericPointInYBounds(points[lastInside], bounds)) return true;

  return (
    afterInside < points.length &&
    segmentIntersectsYBounds(
      points[lastInside],
      points[afterInside],
      Math.max(range.start, points[lastInside][0]),
      range.end,
      bounds,
    )
  );
}

export function prepareDataset(dataset: Dataset): PreparedDataset {
  const seriesIds = new Set<string>();
  for (const series of dataset.series) {
    if (seriesIds.has(series.id)) {
      throw new Error(`数据集存在重复的曲线 ID：${series.id}`);
    }
    seriesIds.add(series.id);
  }

  const preparedSeries = dataset.series.map<PreparedSeries>((item) => {
    const latestPointByTimestamp = new Map<number, number | null>();
    item.points.forEach(([time, value], pointIndex) => {
      const preparedTime = localTimestamp(time);
      if (!Number.isFinite(preparedTime)) {
        throw new Error(
          `曲线 ${item.name} 的第 ${pointIndex} 个数据点时间无效：${time}`,
        );
      }
      if (value !== null && !Number.isFinite(value)) {
        throw new Error(
          `曲线 ${item.name} 的第 ${pointIndex} 个数据点数值无效：${value}`,
        );
      }
      latestPointByTimestamp.set(preparedTime, value);
    });
    const points = Array.from(latestPointByTimestamp.entries()).sort(
      ([leftTime], [rightTime]) => leftTime - rightTime,
    );
    const valueExtent = numericValueExtent(points);
    if (valueExtent !== null) {
      visibilityIndexByPoints.set(points, buildVisibilityIndex(points));
      prepareSeriesLodIndex(points);
    }
    return { ...item, points, valueExtent };
  });
  const effectiveSeries = seriesForEffectiveDataGroups(
    preparedSeries,
    dataset.rowCount,
  );
  const axes = axesForEffectiveSeries(dataset.axes, effectiveSeries);
  const axisOrder = new Map(
    axes.map((axis, index) => [axis.id, index] as const),
  );
  const series = effectiveSeries.sort((left, right) => {
    const axisDifference =
      (axisOrder.get(left.axisId) ?? axes.length) -
      (axisOrder.get(right.axisId) ?? axes.length);
    return axisDifference || roleOrder(left) - roleOrder(right);
  });

  return { ...dataset, axes, series };
}

export function semanticSeriesVisual(
  series: PreparedSeries,
  axis: Axis,
  axisIndex: number,
  previewSeriesId: string | null,
  dimmedByAxisLock = false,
): SeriesVisual {
  const isSetpoint = series.role === "setpoint";
  const isPrimary = axis.role === "primary";
  const highlighted = previewSeriesId === series.id;
  const faded = previewSeriesId !== null && !highlighted;
  const baseOpacity = isSetpoint ? 0.86 : 1;
  const color = isPrimary
    ? isSetpoint
      ? PRIMARY_SETPOINT_COLOR
      : PRIMARY_MEASURED_COLOR
    : axisIndex >= 2
      ? isSetpoint
        ? TERTIARY_SETPOINT_COLOR
        : TERTIARY_MEASURED_COLOR
      : isSetpoint
        ? SECONDARY_SETPOINT_COLOR
        : SECONDARY_MEASURED_COLOR;

  return {
    color,
    width:
      highlighted && !isSetpoint ? 3.2 : isSetpoint ? 1.8 : 2.8,
    opacity: faded
      ? SERIES_BACKGROUND_OPACITY
      : highlighted
        ? baseOpacity
        : dimmedByAxisLock
          ? SERIES_BACKGROUND_OPACITY
          : baseOpacity,
    z: isSetpoint ? 3 : 2,
  };
}

export function hasVisibleData(
  dataset: PreparedDataset,
  visibleSeries: ReadonlySet<string>,
  range: { start: number; end: number },
  axes: Record<string, { min?: number; max?: number }>,
): boolean {
  if (
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    range.start > range.end
  ) {
    return false;
  }
  return dataset.series.some((series) => {
    if (!visibleSeries.has(series.id)) return false;
    const bounds = axes[series.axisId];
    const extent = series.valueExtent;
    if (!extent) return false;
    if (
      bounds?.min !== undefined &&
      bounds?.max !== undefined &&
      bounds.min > bounds.max
    ) {
      return false;
    }
    if (bounds?.min !== undefined && extent[1] < bounds.min) return false;
    if (bounds?.max !== undefined && extent[0] > bounds.max) return false;
    const points = series.points;
    if (points.length === 0) return false;
    const visibilityIndex = visibilityIndexByPoints.get(points);
    if (visibilityIndex) {
      return indexedSeriesHasVisibleData(
        points,
        visibilityIndex,
        range,
        bounds,
      );
    }

    let index = Math.max(0, firstPointIndex(points, range.start, false) - 1);
    let point = points[index];
    while (index < points.length) {
      const [time, value] = point;
      if (time > range.end) break;
      if (
        value !== null &&
        Number.isFinite(time) &&
        Number.isFinite(value) &&
        time >= range.start &&
        (bounds?.min === undefined || value >= bounds.min) &&
        (bounds?.max === undefined || value <= bounds.max)
      ) {
        return true;
      }

      const nextIndex = index + 1;
      if (nextIndex >= points.length) break;
      const next = points[nextIndex];
      const segmentStart = Math.max(range.start, time);
      const segmentEnd = Math.min(range.end, next[0]);
      if (
        segmentStart <= segmentEnd &&
        segmentIntersectsYBounds(
          point,
          next,
          segmentStart,
          segmentEnd,
          bounds,
        )
      ) {
        return true;
      }

      index = nextIndex;
      point = next;
    }
    return false;
  });
}
