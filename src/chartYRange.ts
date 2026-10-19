import type { AxisExtent } from "./chartSettings";

function isFiniteAscendingExtent(extent: AxisExtent): boolean {
  const [min, max] = extent;
  return Number.isFinite(min) && Number.isFinite(max) && min < max;
}

export function panYAxisRange(
  extent: AxisExtent,
  deltaRatio: number,
): AxisExtent | null {
  if (!isFiniteAscendingExtent(extent) || !Number.isFinite(deltaRatio)) {
    return null;
  }
  const [min, max] = extent;
  const offset = (max - min) * deltaRatio;
  const nextMin = min + offset;
  const nextMax = max + offset;
  if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax)) return null;
  return [nextMin, nextMax];
}

export function zoomYAxisRange(
  extent: AxisExtent,
  anchorRatio: number,
  wheelDelta: number,
): AxisExtent | null {
  if (
    !isFiniteAscendingExtent(extent) ||
    !Number.isFinite(anchorRatio) ||
    !Number.isFinite(wheelDelta) ||
    wheelDelta === 0
  ) {
    return null;
  }
  const [min, max] = extent;
  const ratio = Math.min(1, Math.max(0, anchorRatio));
  const magnitude = Math.abs(wheelDelta);
  const step = magnitude > 3 ? 1.4 : magnitude > 1 ? 1.2 : 1.1;
  const scale = wheelDelta > 0 ? 1 / step : step;
  const span = max - min;
  const nextSpan = span * scale;
  if (!Number.isFinite(nextSpan) || nextSpan <= 0) return null;
  const anchor = min + span * ratio;
  const nextMin = anchor - nextSpan * ratio;
  const nextMax = nextMin + nextSpan;
  if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax)) return null;
  return [nextMin, nextMax];
}

/**
 * 整格步长阶梯：1 → 1.1 → 1.2 → 1.4 → 1.5 → 1.8 → 2 → … → 9（再乘 10ⁿ）。
 * 相邻档位倍率约 1.1～1.2，缩放逐档切换手感接近连续缩放；
 * 10 即下一十进制的 1，由 gridStepLadder 跨十进制包裹自然衔接。
 * 而 span = 格数 × step 时所有刻度（含边界）都是整齐值。
 */
const GRID_STEP_FACTORS = [
  1, 1.1, 1.2, 1.4, 1.5, 1.8, 2, 2.2, 2.5, 3,
  3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 9,
] as const;

function stepParts(
  step: number,
): { factorIndex: number; exponent: number } | null {
  if (!Number.isFinite(step) || step <= 0) return null;
  const exponent = Math.floor(Math.log10(step));
  const factor = step / 10 ** exponent;
  let factorIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  GRID_STEP_FACTORS.forEach((candidate, index) => {
    const distance = Math.abs(candidate - factor);
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      factorIndex = index;
    }
  });
  return { factorIndex, exponent };
}

/**
 * 取与 span / gridCount 最接近的整格步长。
 */
export function nearestGridStep(span: number, gridCount: number): number | null {
  if (
    !Number.isFinite(span) ||
    span <= 0 ||
    !Number.isInteger(gridCount) ||
    gridCount < 1 ||
    gridCount > 9
  ) {
    return null;
  }
  const parts = stepParts(span / gridCount);
  if (!parts) return null;
  return Number(
    (GRID_STEP_FACTORS[parts.factorIndex] * 10 ** parts.exponent).toPrecision(
      12,
    ),
  );
}

/**
 * 在整格阶梯上移动一档：direction = -1 缩小（放大视图），+1 增大（缩小视图）。
 */
export function gridStepLadder(step: number, direction: -1 | 1): number | null {
  const parts = stepParts(step);
  if (!parts) return null;
  let index = parts.factorIndex + direction;
  let exponent = parts.exponent;
  if (index < 0) {
    index = GRID_STEP_FACTORS.length - 1;
    exponent -= 1;
  } else if (index >= GRID_STEP_FACTORS.length) {
    index = 0;
    exponent += 1;
  }
  return Number(
    (GRID_STEP_FACTORS[index] * 10 ** exponent).toPrecision(12),
  );
}

/**
 * 整格缩放：以指针像素为锚点，跨度切换为 格数 × 下一档 step，
 * 并把 min 对齐到 step 的整数倍，使缩放后视图始终处于整格态。
 * steps 为沿 wheelDelta 方向一次跨过的阶梯档数（默认 1 档）。
 */
export function zoomYAxisToGrid(
  extent: AxisExtent,
  anchorRatio: number,
  wheelDelta: number,
  gridCount: number,
  steps = 1,
): AxisExtent | null {
  if (
    !isFiniteAscendingExtent(extent) ||
    !Number.isFinite(anchorRatio) ||
    !Number.isFinite(wheelDelta) ||
    wheelDelta === 0 ||
    !Number.isInteger(steps) ||
    steps < 1
  ) {
    return null;
  }
  const [min, max] = extent;
  const span = max - min;
  const currentStep = nearestGridStep(span, gridCount);
  if (!currentStep) return null;
  const direction = wheelDelta > 0 ? -1 : 1;
  let nextStep = currentStep;
  for (let index = 0; index < steps; index += 1) {
    const candidate = gridStepLadder(nextStep, direction);
    if (!candidate) return null;
    nextStep = candidate;
  }
  const nextSpan = gridCount * nextStep;
  const ratio = Math.min(1, Math.max(0, anchorRatio));
  const anchor = min + span * ratio;
  const rawMin = anchor - nextSpan * ratio;
  const nextMin = Number(
    (Math.round(rawMin / nextStep) * nextStep).toPrecision(12),
  );
  const nextMax = Number((nextMin + nextSpan).toPrecision(12));
  if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax)) return null;
  if (nextMin >= nextMax) return null;
  return [nextMin, nextMax];
}

export type PanSample = { y: number; t: number };

const PAN_VELOCITY_WINDOW_MS = 120;

/**
 * 计算松手瞬间的指针速度（px/ms）。只取松手前 120ms 内的采样，
 * 时间跨度或位移不足时视为静止（返回 0），避免噪声触发甩动分支。
 */
export function panReleaseVelocity(
  samples: readonly PanSample[],
  releaseY: number,
  releaseT: number,
  minElapsedMs = 30,
  minDistancePx = 8,
): number {
  const all = [...samples, { y: releaseY, t: releaseT }];
  const windowed = all.filter(
    (sample) => releaseT - sample.t <= PAN_VELOCITY_WINDOW_MS,
  );
  if (windowed.length < 2) return 0;
  const first = windowed[0];
  const last = windowed[windowed.length - 1];
  const elapsed = last.t - first.t;
  const distance = last.y - first.y;
  if (elapsed < minElapsedMs || Math.abs(distance) < minDistancePx) return 0;
  return distance / elapsed;
}

/**
 * 松手归位目标（整格对齐）：
 * - 甩动（|velocity| ≥ flickVelocity）：沿速度方向继续一格，绝不回弹；
 * - 静止/慢速：以拖动起点最近的整数倍为基准做方向偏置——回弹距离
 *   超过 backThreshold × step 时沿拖动方向进到下一格，避免长距离拖动被弹回。
 */
export function gridPanSnapTarget(
  min: number,
  step: number,
  initialMin: number,
  velocity: number,
  backThreshold = 0.35,
  flickVelocity = 0.4,
): number | null {
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(step) ||
    step <= 0 ||
    !Number.isFinite(initialMin) ||
    !Number.isFinite(velocity)
  ) {
    return null;
  }
  if (Math.abs(velocity) >= flickVelocity) {
    const flickTarget =
      velocity > 0
        ? Math.ceil(min / step) * step
        : Math.floor(min / step) * step;
    return Number(flickTarget.toPrecision(12));
  }
  const threshold = Math.min(0.5, Math.max(0, backThreshold));
  const refMin = Math.round(initialMin / step) * step;
  const delta = min - refMin;
  const k =
    delta >= 0
      ? Math.ceil(delta / step - threshold)
      : Math.floor(delta / step + threshold);
  return Number((refMin + k * step).toPrecision(12));
}

export type YZoomWheelAccumulator = {
  value: number;
  sign: 1 | -1;
  time: number;
};

export const Y_ZOOM_RUNG_THRESHOLD = 1;
export const Y_ZOOM_MAX_RUNGS_PER_EVENT = 4;
export const Y_ZOOM_ACCUMULATOR_RESET_MS = 200;

/**
 * 把滚轮增量累加为整格缩放档数：慢速触控板的小 delta 跨事件累积，
 * 每满一个阈值消费一档（鼠标一格 = 阈值 = 1 档），大 delta 单次可跨多档
 * （上限 maxRungs），方向改变或超过 resetMs 未滚动时清零重计。
 */
export function yZoomRungs(
  accumulator: YZoomWheelAccumulator | null,
  wheelDelta: number,
  now: number,
  threshold = Y_ZOOM_RUNG_THRESHOLD,
  maxRungs = Y_ZOOM_MAX_RUNGS_PER_EVENT,
  resetMs = Y_ZOOM_ACCUMULATOR_RESET_MS,
): { accumulator: YZoomWheelAccumulator; rungs: number } | null {
  if (
    !Number.isFinite(wheelDelta) ||
    wheelDelta === 0 ||
    !Number.isFinite(now) ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    !Number.isInteger(maxRungs) ||
    maxRungs < 1 ||
    !Number.isFinite(resetMs) ||
    resetMs <= 0
  ) {
    return null;
  }
  const sign = wheelDelta > 0 ? 1 : -1;
  const magnitude = Math.abs(wheelDelta);
  const fresh =
    accumulator === null ||
    accumulator.sign !== sign ||
    now - accumulator.time > resetMs;
  const total = (fresh ? 0 : accumulator.value) + magnitude;
  const fullRungs = Math.floor(total / threshold);
  const rungs = Math.min(maxRungs, fullRungs);
  const remainder = fullRungs > maxRungs ? 0 : total - rungs * threshold;
  return {
    accumulator: { value: remainder, sign, time: now },
    rungs,
  };
}
