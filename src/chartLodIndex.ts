export type IndexedPoint = readonly [time: number, value: number | null];

type AggregateLevel = {
  blockSize: number;
  minIndices: Int32Array;
  maxIndices: Int32Array;
};

export type SeriesLodIndex = {
  pointCount: number;
  levels: AggregateLevel[];
  runStarts: Int32Array;
  firstRunNumeric: boolean;
};

export type IndexedRangeSummary = {
  firstIndex: number;
  lastIndex: number;
  minIndex: number;
  maxIndex: number;
};

export type IndexedRunBounds = {
  runId: number;
  start: number;
  end: number;
  numeric: boolean;
};

const seriesLodIndexes = new WeakMap<
  ReadonlyArray<IndexedPoint>,
  SeriesLodIndex
>();

function numericValue(points: ReadonlyArray<IndexedPoint>, index: number) {
  const point = points[index];
  if (!point) return null;
  const value = point[1];
  return value !== null && Number.isFinite(value) ? value : null;
}

function preferredIndex(
  points: ReadonlyArray<IndexedPoint>,
  left: number,
  right: number,
  mode: "min" | "max",
): number {
  if (left < 0) return right;
  if (right < 0) return left;
  const leftValue = numericValue(points, left);
  const rightValue = numericValue(points, right);
  if (leftValue === null) return rightValue === null ? -1 : right;
  if (rightValue === null) return left;
  if (leftValue === rightValue) return Math.min(left, right);
  if (mode === "min") return leftValue < rightValue ? left : right;
  return leftValue > rightValue ? left : right;
}

function pointIsNumeric(point: IndexedPoint | undefined): boolean {
  return (
    point !== undefined &&
    Number.isFinite(point[0]) &&
    point[1] !== null &&
    Number.isFinite(point[1])
  );
}

export function prepareSeriesLodIndex(
  points: ReadonlyArray<IndexedPoint>,
): SeriesLodIndex {
  const existing = seriesLodIndexes.get(points);
  if (existing) return existing;

  const runStarts: number[] = [];
  if (points.length > 0) {
    runStarts.push(0);
    let previousNumeric = pointIsNumeric(points[0]);
    for (let index = 1; index < points.length; index += 1) {
      const numeric = pointIsNumeric(points[index]);
      if (numeric !== previousNumeric) {
        runStarts.push(index);
        previousNumeric = numeric;
      }
    }
  }

  const levels: AggregateLevel[] = [];
  let previousMin: Int32Array | null = null;
  let previousMax: Int32Array | null = null;
  for (let blockSize = 2; blockSize <= points.length; blockSize *= 2) {
    const blockCount = Math.ceil(points.length / blockSize);
    const minIndices = new Int32Array(blockCount);
    const maxIndices = new Int32Array(blockCount);
    minIndices.fill(-1);
    maxIndices.fill(-1);
    for (let block = 0; block < blockCount; block += 1) {
      if (blockSize === 2) {
        const left = block * 2;
        const right = left + 1 < points.length ? left + 1 : -1;
        const leftNumeric = numericValue(points, left) === null ? -1 : left;
        const rightNumeric = numericValue(points, right) === null ? -1 : right;
        minIndices[block] = preferredIndex(
          points,
          leftNumeric,
          rightNumeric,
          "min",
        );
        maxIndices[block] = preferredIndex(
          points,
          leftNumeric,
          rightNumeric,
          "max",
        );
      } else {
        const leftBlock = block * 2;
        const rightBlock = leftBlock + 1;
        minIndices[block] = preferredIndex(
          points,
          previousMin?.[leftBlock] ?? -1,
          previousMin?.[rightBlock] ?? -1,
          "min",
        );
        maxIndices[block] = preferredIndex(
          points,
          previousMax?.[leftBlock] ?? -1,
          previousMax?.[rightBlock] ?? -1,
          "max",
        );
      }
    }
    levels.push({ blockSize, minIndices, maxIndices });
    previousMin = minIndices;
    previousMax = maxIndices;
    if (blockSize > Number.MAX_SAFE_INTEGER / 2) break;
  }

  const index = {
    pointCount: points.length,
    levels,
    runStarts: Int32Array.from(runStarts),
    firstRunNumeric: pointIsNumeric(points[0]),
  };
  seriesLodIndexes.set(points, index);
  return index;
}

export function getSeriesLodIndex(
  points: ReadonlyArray<IndexedPoint>,
): SeriesLodIndex | undefined {
  return seriesLodIndexes.get(points);
}

export function getOrPrepareSeriesLodIndex(
  points: ReadonlyArray<IndexedPoint>,
): SeriesLodIndex {
  return getSeriesLodIndex(points) ?? prepareSeriesLodIndex(points);
}

export function runIdAt(index: SeriesLodIndex, pointIndex: number): number {
  if (pointIndex < 0 || pointIndex >= index.pointCount) return -1;
  let low = 0;
  let high = index.runStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (index.runStarts[middle] <= pointIndex) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

export function runBounds(
  index: SeriesLodIndex,
  runId: number,
): IndexedRunBounds | null {
  if (runId < 0 || runId >= index.runStarts.length) return null;
  return {
    runId,
    start: index.runStarts[runId],
    end:
      runId + 1 < index.runStarts.length
        ? index.runStarts[runId + 1]
        : index.pointCount,
    numeric: index.firstRunNumeric ? runId % 2 === 0 : runId % 2 === 1,
  };
}

export function visibleRunCounts(
  index: SeriesLodIndex,
  from: number,
  to: number,
): { numericRuns: number; nullRuns: number } {
  if (from >= to || from < 0 || to > index.pointCount) {
    return { numericRuns: 0, nullRuns: 0 };
  }
  const firstRun = runIdAt(index, from);
  const lastRun = runIdAt(index, to - 1);
  const total = lastRun - firstRun + 1;
  const firstNumeric = runBounds(index, firstRun)?.numeric ?? false;
  const numericRuns = firstNumeric ? Math.ceil(total / 2) : Math.floor(total / 2);
  return { numericRuns, nullRuns: total - numericRuns };
}

function firstNumericIndex(
  index: SeriesLodIndex,
  from: number,
  to: number,
): number {
  if (from >= to) return -1;
  const firstRun = runIdAt(index, from);
  const bounds = runBounds(index, firstRun);
  if (!bounds) return -1;
  if (bounds.numeric) return from;
  const next = runBounds(index, firstRun + 1);
  return next?.numeric && next.start < to ? next.start : -1;
}

function lastNumericIndex(
  index: SeriesLodIndex,
  from: number,
  to: number,
): number {
  if (from >= to) return -1;
  const lastRun = runIdAt(index, to - 1);
  const bounds = runBounds(index, lastRun);
  if (!bounds) return -1;
  if (bounds.numeric) return to - 1;
  const previous = runBounds(index, lastRun - 1);
  return previous?.numeric && previous.end > from
    ? Math.min(previous.end, to) - 1
    : -1;
}

function largestAlignedBlock(cursor: number, remaining: number): number {
  let blockSize = 1;
  while (
    blockSize * 2 <= remaining &&
    cursor % (blockSize * 2) === 0
  ) {
    blockSize *= 2;
  }
  return blockSize;
}

export function summarizeIndexedRange(
  points: ReadonlyArray<IndexedPoint>,
  index: SeriesLodIndex,
  from: number,
  to: number,
): IndexedRangeSummary {
  if (from >= to || from < 0 || to > points.length) {
    return { firstIndex: -1, lastIndex: -1, minIndex: -1, maxIndex: -1 };
  }

  let minIndex = -1;
  let maxIndex = -1;
  let cursor = from;
  while (cursor < to) {
    const blockSize = largestAlignedBlock(cursor, to - cursor);
    let blockMin = -1;
    let blockMax = -1;
    if (blockSize === 1) {
      if (numericValue(points, cursor) !== null) {
        blockMin = cursor;
        blockMax = cursor;
      }
    } else {
      const level = index.levels[Math.log2(blockSize) - 1];
      const block = Math.floor(cursor / blockSize);
      blockMin = level?.minIndices[block] ?? -1;
      blockMax = level?.maxIndices[block] ?? -1;
    }
    minIndex = preferredIndex(points, minIndex, blockMin, "min");
    maxIndex = preferredIndex(points, maxIndex, blockMax, "max");
    cursor += blockSize;
  }

  return {
    firstIndex: firstNumericIndex(index, from, to),
    lastIndex: lastNumericIndex(index, from, to),
    minIndex,
    maxIndex,
  };
}

export function seriesLodIndexByteLength(index: SeriesLodIndex): number {
  return (
    index.runStarts.byteLength +
    index.levels.reduce(
      (total, level) =>
        total + level.minIndices.byteLength + level.maxIndices.byteLength,
      0,
    )
  );
}
