import type { NumericRange } from "./chartRange";
import type { PreparedPoint, PreparedSeries } from "./chartSeries";

export const CURVE_GROUP_HIT_RADIUS_PX = 14;
export const AXIS_LOCK_CLICK_SLOP_PX = 6;

export type CurveHitSeries = Pick<PreparedSeries, "id" | "axisId"> & {
  points: ReadonlyArray<PreparedPoint>;
  z: number;
};

export type CurveGroupHit = {
  seriesId: string;
  axisId: string;
  distancePx: number;
};

/** 同一时间只锁定一组纵轴：点已锁定的组解除锁定，点另一组则直接换锁。 */
export function toggleLockedAxis(
  lockedAxisIds: ReadonlySet<string>,
  axisId: string,
): Set<string> {
  return lockedAxisIds.has(axisId) ? new Set() : new Set([axisId]);
}

export function effectiveYAxisIds(
  axisOrder: readonly string[],
  visibleAxisIds: ReadonlySet<string>,
  lockedAxisIds: ReadonlySet<string>,
): string[] {
  return axisOrder.filter(
    (axisId) =>
      visibleAxisIds.has(axisId) &&
      (lockedAxisIds.size === 0 || lockedAxisIds.has(axisId)),
  );
}

export function isAxisLockClick(
  start: { x: number; y: number; axisId: string | null },
  end: { x: number; y: number; axisId: string | null },
  maxDistancePx = AXIS_LOCK_CLICK_SLOP_PX,
): boolean {
  if (
    start.axisId === null ||
    end.axisId !== start.axisId ||
    !Number.isFinite(maxDistancePx) ||
    maxDistancePx < 0
  ) {
    return false;
  }
  return Math.hypot(end.x - start.x, end.y - start.y) <= maxDistancePx;
}

function interpolatePoints(
  points: ReadonlyArray<PreparedPoint>,
  time: number,
): number | null {
  if (!Number.isFinite(time)) return null;
  if (points.length === 0) return null;
  if (time < points[0][0] || time > points[points.length - 1][0]) return null;
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const midTime = points[mid][0];
    if (midTime < time) low = mid + 1;
    else if (midTime > time) high = mid - 1;
    else return points[mid][1];
  }

  const left = points[Math.max(0, high)];
  const right = points[Math.min(points.length - 1, low)];
  const leftTime = left[0];
  const rightTime = right[0];
  if (left[1] == null || right[1] == null) return null;
  if (leftTime === rightTime) return left[1];
  const ratio = Math.min(1, Math.max(0, (time - leftTime) / (rightTime - leftTime)));
  return left[1] + (right[1] - left[1]) * ratio;
}

export function pickNearestCurveGroup(
  series: ReadonlyArray<CurveHitSeries>,
  visibleSeries: ReadonlySet<string>,
  time: number,
  pointerY: number,
  valueToPixel: (axisId: string, value: number) => number,
  maxDistancePx = CURVE_GROUP_HIT_RADIUS_PX,
): CurveGroupHit | null {
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(pointerY) ||
    !Number.isFinite(maxDistancePx) ||
    maxDistancePx < 0
  ) {
    return null;
  }

  let best:
    | (CurveGroupHit & { z: number; renderOrder: number })
    | null = null;
  for (let renderOrder = 0; renderOrder < series.length; renderOrder += 1) {
    const candidate = series[renderOrder];
    if (!visibleSeries.has(candidate.id)) continue;
    const value = interpolatePoints(candidate.points, time);
    if (value === null || !Number.isFinite(value)) continue;
    const pixelY = valueToPixel(candidate.axisId, value);
    if (!Number.isFinite(pixelY)) continue;
    const distancePx = Math.abs(pixelY - pointerY);
    if (distancePx > maxDistancePx) continue;

    const closer = best === null || distancePx < best.distancePx;
    const visuallyAbove =
      best !== null &&
      distancePx === best.distancePx &&
      (candidate.z > best.z ||
        (candidate.z === best.z && renderOrder > best.renderOrder));
    if (!closer && !visuallyAbove) continue;
    best = {
      seriesId: candidate.id,
      axisId: candidate.axisId,
      distancePx,
      z: candidate.z,
      renderOrder,
    };
  }

  if (best === null) return null;
  return {
    seriesId: best.seriesId,
    axisId: best.axisId,
    distancePx: best.distancePx,
  };
}

export function interpolateSeries(
  series: PreparedSeries,
  time: number,
): number | null {
  return interpolatePoints(series.points, time);
}

export function placeTooltip(
  pointer: { x: number; y: number },
  container: { width: number; height: number },
  card: { width: number; height: number },
): { x: number; y: number } {
  const preferredX =
    pointer.x + 14 + card.width > container.width
      ? pointer.x - card.width - 14
      : pointer.x + 14;
  const preferredY =
    pointer.y + 12 + card.height > container.height
      ? pointer.y - card.height - 12
      : pointer.y + 12;

  return {
    x: Math.min(
      Math.max(8, preferredX),
      Math.max(8, container.width - card.width - 8),
    ),
    y: Math.min(
      Math.max(8, preferredY),
      Math.max(8, container.height - card.height - 8),
    ),
  };
}

export function rangeFromPercent(
  bounds: NumericRange,
  startPercent: number,
  endPercent: number,
): NumericRange {
  if (
    ![bounds.start, bounds.end, startPercent, endPercent].every(Number.isFinite)
  ) {
    throw new Error("图表范围与百分比必须是有限数值");
  }
  if (bounds.start > bounds.end) {
    throw new Error("图表范围起点不能晚于终点");
  }

  const span = bounds.end - bounds.start;
  return {
    start: bounds.start + (span * startPercent) / 100,
    end: bounds.start + (span * endPercent) / 100,
  };
}
