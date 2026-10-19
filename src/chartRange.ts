export const MIN_VISIBLE_RANGE_MS = 60_000;
export const X_AXIS_FIT_PADDING_RATIO = 0.03;

export type NumericRange = { start: number; end: number };
export type RangeErrors = { start?: string; end?: string };
export type XAxisLabelContext = {
  mode: "time" | "date-time" | "date" | "year-date";
  dateContext: string | null;
  includeSeconds: boolean;
};

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * 生成“完整视图”时间范围：在数据前后各留出一点空白，
 * 避免曲线首尾紧贴绘图区左右边缘，方便观察数据开始和结尾部分。
 */
export function fitRangeWithBreathingSpace(
  bounds: NumericRange,
): NumericRange {
  const span = Math.max(0, bounds.end - bounds.start);
  const padding = span * X_AXIS_FIT_PADDING_RATIO;
  return { start: bounds.start - padding, end: bounds.end + padding };
}

export function createXAxisTickValues(
  start: number,
  end: number,
  gridCount: number,
): number[] {
  const count = Math.max(1, Math.trunc(gridCount));
  return Array.from({ length: count + 1 }, (_, index) => {
    if (index === 0) return start;
    if (index === count) return end;
    return Math.round(start + ((end - start) * index) / count);
  });
}

/**
 * 时间范围输入的固定写法 `YYYY-MM-DD HH:mm:ss`：与横轴刻度、读数卡片
 * 使用同一套年月日顺序、分隔符和 24 小时制，不随系统区域设置变化。
 */
export function formatTimeRangeInput(value: number): string {
  const date = new Date(value);
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const TIME_RANGE_INPUT =
  /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:(?:\s+|T)(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?\s*$/;

/**
 * 解析时间范围输入，得到本地时间戳；无法解析或日期不存在时返回 NaN。
 * 除固定写法外，也接受从表格、报告里粘贴来的常见写法：
 * “/” 或 “.” 分隔、不补零、省略秒，或只写日期（按当天 00:00:00）。
 */
export function parseTimeRangeInput(value: string): number {
  const match = value.match(TIME_RANGE_INPUT);
  if (!match) return Number.NaN;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4] ?? 0);
  const minutes = Number(match[5] ?? 0);
  const seconds = Number(match[6] ?? 0);
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0"));
  // setFullYear 不会像 Date 构造函数那样把 0–99 年映射到 19xx。
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, seconds, milliseconds);

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

const sanitizeRange = (range: NumericRange): NumericRange => {
  const span = Math.max(MIN_VISIBLE_RANGE_MS, range.end - range.start);
  return { start: range.start, end: range.start + span };
};

export function validateTimeRange(
  startInput: string,
  endInput: string,
  bounds: NumericRange,
): { ok: true; range: NumericRange } | { ok: false; errors: RangeErrors } {
  const errors: RangeErrors = {};
  const start = parseTimeRangeInput(startInput);
  const end = parseTimeRangeInput(endInput);

  // 写法对但解析不出时间，说明日期或时刻本身不存在（如 2 月 30 日、25 时）。
  const invalidTime = (input: string, label: string) =>
    TIME_RANGE_INPUT.test(input) ? "日期或时间不存在" : `${label}格式无效`;

  if (!startInput.trim()) errors.start = "请输入开始时间";
  else if (!Number.isFinite(start)) {
    errors.start = invalidTime(startInput, "开始时间");
  }

  if (!endInput.trim()) errors.end = "请输入截止时间";
  else if (!Number.isFinite(end)) {
    errors.end = invalidTime(endInput, "截止时间");
  }

  if (!errors.start && !errors.end) {
    const minimumSpan = Math.min(
      MIN_VISIBLE_RANGE_MS,
      Math.max(0, bounds.end - bounds.start),
    );
    if (start >= end) errors.end ??= "截止时间必须晚于开始时间";
    else if (end - start < minimumSpan) errors.end ??= "可见时间范围不能短于 1 分钟";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, range: { start, end } };
}

export function zoomRange(
  range: NumericRange,
  bounds: NumericRange,
  anchorRatio: number,
  wheelDirection: number,
): NumericRange {
  if (wheelDirection === 0) return sanitizeRange(range);
  const factor = wheelDirection < 0 ? 0.8 : 1.25;
  const ratio = Math.min(1, Math.max(0, anchorRatio));
  const currentSpan = range.end - range.start;
  const boundsSpan = bounds.end - bounds.start;
  const span = Math.max(
    Math.min(MIN_VISIBLE_RANGE_MS, boundsSpan),
    currentSpan * factor,
  );
  const anchor = range.start + currentSpan * ratio;
  const start = anchor - span * ratio;
  return { start, end: start + span };
}

export function zoomRangeFromWheel(
  range: NumericRange,
  bounds: NumericRange,
  anchorTime: number,
  wheelDelta: number,
): NumericRange | null {
  if (
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    !Number.isFinite(bounds.start) ||
    !Number.isFinite(bounds.end) ||
    !Number.isFinite(anchorTime) ||
    !Number.isFinite(wheelDelta) ||
    wheelDelta === 0
  ) {
    return null;
  }

  const currentSpan = range.end - range.start;
  const boundsSpan = bounds.end - bounds.start;
  if (
    !Number.isFinite(currentSpan) ||
    currentSpan <= 0 ||
    !Number.isFinite(boundsSpan) ||
    boundsSpan <= 0
  ) {
    return null;
  }

  const anchorRatio = Math.min(
    1,
    Math.max(0, (anchorTime - range.start) / currentSpan),
  );
  const magnitude = Math.abs(wheelDelta);
  const step = magnitude > 3 ? 1.4 : magnitude > 1 ? 1.2 : 1.1;
  const scale = wheelDelta > 0 ? 1 / step : step;
  const scaledSpan = currentSpan * scale;
  if (!Number.isFinite(scaledSpan)) return null;

  const nextSpan = Math.max(
    Math.min(MIN_VISIBLE_RANGE_MS, boundsSpan),
    scaledSpan,
  );
  if (anchorRatio === 1) {
    const anchoredStart = range.end - nextSpan;
    if (Number.isFinite(anchoredStart)) {
      return { start: anchoredStart, end: range.end };
    }
    return null;
  }
  if (anchorRatio === 0) {
    const anchoredEnd = range.start + nextSpan;
    if (Number.isFinite(anchoredEnd)) {
      return { start: range.start, end: anchoredEnd };
    }
    return null;
  }

  const effectiveAnchor =
    range.start + currentSpan * anchorRatio;
  const start = effectiveAnchor - nextSpan * anchorRatio;
  const end = start + nextSpan;
  if (
    !Number.isFinite(effectiveAnchor) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  ) {
    return null;
  }

  return { start, end };
}

export function panRange(
  range: NumericRange,
  deltaRatio: number,
): NumericRange {
  const span = range.end - range.start;
  const offset = span * deltaRatio;
  const next = { start: range.start + offset, end: range.end + offset };
  if (
    !Number.isFinite(span) ||
    span <= 0 ||
    !Number.isFinite(offset) ||
    !Number.isFinite(next.start) ||
    !Number.isFinite(next.end)
  ) {
    return range;
  }
  return next;
}

export function createXAxisLabelContext(
  start: number,
  end: number,
  gridCount: number,
): XAxisLabelContext {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  const sameDay =
    sameYear &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate();
  const includeSeconds = (end - start) / Math.max(1, gridCount) < MIN_VISIBLE_RANGE_MS;

  if (sameDay) {
    return {
      mode: "time",
      dateContext: `${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`,
      includeSeconds,
    };
  }
  if (end - start < 48 * 60 * 60 * 1_000) {
    return { mode: "date-time", dateContext: null, includeSeconds };
  }
  if (sameYear) return { mode: "date", dateContext: null, includeSeconds };
  return { mode: "year-date", dateContext: null, includeSeconds };
}

export function formatXAxisLabel(
  value: number,
  context: XAxisLabelContext,
  isFirstTick: boolean,
): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  if (context.mode === "time") {
    const time = context.includeSeconds
      ? `${hours}:${minutes}:${seconds}`
      : `${hours}:${minutes}`;
    return isFirstTick && context.dateContext
      ? `${time}\n${context.dateContext}`
      : time;
  }
  if (context.mode === "date-time") {
    return context.includeSeconds
      ? `${month}-${day} ${hours}:${minutes}:${seconds}`
      : `${month}-${day} ${hours}:${minutes}`;
  }
  if (context.mode === "year-date") return `${year}-${month}-${day}`;
  return `${month}-${day}`;
}
