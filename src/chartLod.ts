import type { NumericRange } from "./chartRange";
import {
  getOrPrepareSeriesLodIndex,
  runBounds,
  runIdAt,
  summarizeIndexedRange,
  visibleRunCounts,
  type SeriesLodIndex,
} from "./chartLodIndex";
import type { PreparedDataset, PreparedPoint } from "./chartSeries";

export type LodQuality = "interactive" | "settled" | "export";

export type ChartLodWindow = {
  range: NumericRange;
  seriesData: PreparedPoint[][];
};

export const CHART_INTERACTION_IDLE_MS = 100;
export const LOD_PREFETCH_VIEWPORTS = 1;

type LodCacheEntry = {
  key: string;
  window: ChartLodWindow;
};

const lodWindowCache = new WeakMap<PreparedDataset, LodCacheEntry>();

const bucketPixels = (quality: LodQuality): number => {
  if (quality === "interactive") return 4;
  if (quality === "settled") return 2;
  return 1;
};

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

export function lodPointBudget(
  pixelWidth: number,
  quality: LodQuality,
  pixelRatio = 1,
): number {
  if (
    !Number.isFinite(pixelWidth) ||
    pixelWidth <= 0 ||
    !Number.isFinite(pixelRatio) ||
    pixelRatio <= 0
  ) {
    return 0;
  }

  const outputPixelRatio = quality === "interactive" ? 1 : pixelRatio;
  const bucketCount = Math.max(
    1,
    Math.ceil((pixelWidth * outputPixelRatio) / bucketPixels(quality)),
  );
  return bucketCount * 4 + 2;
}

export function lodHardPointBudget(
  pixelWidth: number,
  quality: LodQuality,
  pixelRatio = 1,
): number {
  const budget = lodPointBudget(pixelWidth, quality, pixelRatio);
  return budget === 0 ? 0 : Math.max(25, budget * 2);
}

export function containsRange(
  outer: NumericRange,
  inner: NumericRange,
): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

export function expandRange(
  range: NumericRange,
  viewportCount = LOD_PREFETCH_VIEWPORTS,
): NumericRange {
  const span = Math.max(0, range.end - range.start);
  const padding = span * Math.max(0, viewportCount);
  return {
    start: range.start - padding,
    end: range.end + padding,
  };
}

function forEachTimeBucket(
  points: ReadonlyArray<PreparedPoint>,
  firstInside: number,
  afterInside: number,
  range: NumericRange,
  bucketCount: number,
  visit: (from: number, to: number) => void,
): void {
  let from = firstInside;
  const span = range.end - range.start;
  for (let bucket = 0; bucket < bucketCount && from < afterInside; bucket += 1) {
    const to = Math.max(
      from,
      bucket === bucketCount - 1
        ? afterInside
        : Math.min(
            afterInside,
            firstPointIndex(
              points,
              range.start + (span * (bucket + 1)) / bucketCount,
              false,
            ),
          ),
    );
    if (from < to) visit(from, to);
    from = to;
  }
}

function addSummaryIndices(
  selected: Set<number>,
  points: ReadonlyArray<PreparedPoint>,
  index: SeriesLodIndex,
  from: number,
  to: number,
): void {
  const summary = summarizeIndexedRange(points, index, from, to);
  for (const pointIndex of [
    summary.firstIndex,
    summary.minIndex,
    summary.maxIndex,
    summary.lastIndex,
  ]) {
    if (pointIndex >= 0) selected.add(pointIndex);
  }
}

function addBoundaryNeighbor(
  points: ReadonlyArray<PreparedPoint>,
  pointIndex: number,
  numeric: Set<number>,
  nulls: Set<number>,
): void {
  if (pointIndex < 0 || pointIndex >= points.length) return;
  if (points[pointIndex][1] === null) {
    nulls.add(pointIndex);
  } else {
    numeric.add(pointIndex);
  }
}

function addNullsBetweenSelectedRuns(
  points: ReadonlyArray<PreparedPoint>,
  index: SeriesLodIndex,
  numeric: ReadonlySet<number>,
  nulls: Set<number>,
): void {
  const ordered = [...numeric].sort((left, right) => left - right);
  let previousRun = -1;
  for (const pointIndex of ordered) {
    const currentRun = runIdAt(index, pointIndex);
    if (previousRun >= 0 && currentRun !== previousRun) {
      const gap = runBounds(index, previousRun + 1);
      if (
        gap &&
        !gap.numeric &&
        gap.start < pointIndex &&
        points[gap.start][1] === null
      ) {
        nulls.add(gap.start);
      }
    }
    previousRun = currentRun;
  }
}

function materializeSelection(
  points: ReadonlyArray<PreparedPoint>,
  numeric: ReadonlySet<number>,
  nulls: ReadonlySet<number>,
): PreparedPoint[] {
  return [...numeric, ...nulls]
    .sort((left, right) => left - right)
    .map((pointIndex) => points[pointIndex]);
}

export function selectLodPoints(
  points: ReadonlyArray<PreparedPoint>,
  range: NumericRange,
  pixelWidth: number,
  quality: LodQuality,
  pixelRatio = 1,
): PreparedPoint[] {
  if (
    points.length === 0 ||
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    range.start >= range.end ||
    !Number.isFinite(pixelWidth) ||
    pixelWidth <= 0 ||
    !Number.isFinite(pixelRatio) ||
    pixelRatio <= 0
  ) {
    return [];
  }

  const firstInside = firstPointIndex(points, range.start, false);
  const afterInside = firstPointIndex(points, range.end, true);
  const from = Math.max(0, firstInside - 1);
  const to = Math.min(points.length, afterInside + 1);
  if (from >= to) return [];

  const budget = lodPointBudget(pixelWidth, quality, pixelRatio);
  if (to - from <= budget) return points.slice(from, to);
  const hardBudget = lodHardPointBudget(pixelWidth, quality, pixelRatio);
  const index = getOrPrepareSeriesLodIndex(points);
  const { numericRuns, nullRuns } = visibleRunCounts(index, from, to);
  const preserveAllRuns =
    budget + numericRuns * 2 + nullRuns <= hardBudget;
  const numeric = new Set<number>();
  const nulls = new Set<number>();
  addBoundaryNeighbor(points, firstInside - 1, numeric, nulls);
  addBoundaryNeighbor(points, afterInside, numeric, nulls);

  if (preserveAllRuns) {
    const bucketCount = Math.max(1, Math.floor((budget - 2) / 4));
    forEachTimeBucket(
      points,
      firstInside,
      afterInside,
      range,
      bucketCount,
      (bucketFrom, bucketTo) => {
        addSummaryIndices(numeric, points, index, bucketFrom, bucketTo);
      },
    );

    const firstRun = runIdAt(index, from);
    const lastRun = runIdAt(index, to - 1);
    for (let runId = firstRun; runId <= lastRun; runId += 1) {
      const run = runBounds(index, runId);
      if (!run) continue;
      const runFrom = Math.max(from, run.start);
      const runTo = Math.min(to, run.end);
      if (runFrom >= runTo) continue;
      if (run.numeric) {
        numeric.add(runFrom);
        numeric.add(runTo - 1);
      } else {
        nulls.add(runFrom);
      }
    }
  } else {
    const coarseBucketCount = Math.max(
      1,
      Math.floor((hardBudget - 5) / 20),
    );
    forEachTimeBucket(
      points,
      firstInside,
      afterInside,
      range,
      coarseBucketCount,
      (bucketFrom, bucketTo) => {
        const bucketSummary = summarizeIndexedRange(
          points,
          index,
          bucketFrom,
          bucketTo,
        );
        const representativeRuns = new Set<number>();
        for (const pointIndex of [
          bucketSummary.firstIndex,
          bucketSummary.minIndex,
          bucketSummary.maxIndex,
          bucketSummary.lastIndex,
        ]) {
          if (pointIndex >= 0) representativeRuns.add(runIdAt(index, pointIndex));
        }

        for (const runId of representativeRuns) {
          const run = runBounds(index, runId);
          if (!run?.numeric) continue;
          const renderRunFrom = Math.max(from, run.start);
          const renderRunTo = Math.min(to, run.end);
          if (renderRunTo - renderRunFrom < 2) continue;
          const runFrom = Math.max(bucketFrom, renderRunFrom);
          const runTo = Math.min(bucketTo, renderRunTo);
          if (runFrom >= runTo) continue;
          const before = numeric.size;
          addSummaryIndices(numeric, points, index, runFrom, runTo);
          if (numeric.size === before + 1) {
            const only = summarizeIndexedRange(
              points,
              index,
              runFrom,
              runTo,
            ).firstIndex;
            const neighbor =
              only > renderRunFrom ? only - 1 : Math.min(renderRunTo - 1, only + 1);
            if (neighbor >= renderRunFrom && neighbor < renderRunTo) {
              numeric.add(neighbor);
            }
          }
        }
      },
    );
  }

  addNullsBetweenSelectedRuns(points, index, numeric, nulls);
  return materializeSelection(points, numeric, nulls);
}

export function buildLodWindow(
  dataset: PreparedDataset,
  viewport: NumericRange,
  bounds: NumericRange,
  pixelWidth: number,
  quality: LodQuality,
  pixelRatio = 1,
): ChartLodWindow {
  const key = [
    viewport.start,
    viewport.end,
    bounds.start,
    bounds.end,
    pixelWidth,
    quality,
    pixelRatio,
  ].join(":");
  const cached = lodWindowCache.get(dataset);
  if (cached?.key === key) return cached.window;

  const range = quality === "export" ? viewport : expandRange(viewport);
  const viewportSpan = viewport.end - viewport.start;
  const renderRangeSpan = range.end - range.start;
  const densityWidth =
    pixelWidth *
    (viewportSpan > 0
      ? Math.max(1, renderRangeSpan / viewportSpan)
      : 1);
  const window = {
    range,
    seriesData: dataset.series.map((series) =>
      selectLodPoints(series.points, range, densityWidth, quality, pixelRatio),
    ),
  };
  lodWindowCache.set(dataset, { key, window });
  return window;
}
