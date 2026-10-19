/**
 * 时间输入框的分段编辑模型：文本固定为 `YYYY-MM-DD HH:mm:ss`，
 * 年、月、日、时、分、秒各是一段，可以单独键入或步进。
 * 这里只有纯函数；选区与焦点由 DateTimeField 负责。
 */

export type TimeSegmentKey =
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "second";

export type TimeSegment = {
  key: TimeSegmentKey;
  /** 段在文本中的起止位置，[start, end)。 */
  start: number;
  end: number;
};

export const TIME_SEGMENTS: readonly TimeSegment[] = [
  { key: "year", start: 0, end: 4 },
  { key: "month", start: 5, end: 7 },
  { key: "day", start: 8, end: 10 },
  { key: "hour", start: 11, end: 13 },
  { key: "minute", start: 14, end: 16 },
  { key: "second", start: 17, end: 19 },
];

export type TimeParts = Record<TimeSegmentKey, number>;

export type SegmentTyping = {
  text: string;
  /** 本段已键入、还在等待下一位的数字；段已写满时为空串。 */
  pending: string;
  /** 本段已确定，应把选区移到下一段。 */
  advance: boolean;
};

const SEGMENTED_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** 文本是否正好是可分段编辑的固定写法（只看形状，不校验日期是否存在）。 */
export function isSegmentedTimeText(text: string): boolean {
  return SEGMENTED_TEXT.test(text);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function readTimeParts(text: string): TimeParts {
  return Object.fromEntries(
    TIME_SEGMENTS.map((segment) => [
      segment.key,
      Number(text.slice(segment.start, segment.end)),
    ]),
  ) as TimeParts;
}

export function writeTimeParts(parts: TimeParts): string {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/** 把每一段收进合法范围，日期按当月天数封顶。 */
function normalizeParts(parts: TimeParts): TimeParts {
  const year = clamp(parts.year, 1, 9999);
  const month = clamp(parts.month, 1, 12);
  return {
    year,
    month,
    day: clamp(parts.day, 1, daysInMonth(year, month)),
    hour: clamp(parts.hour, 0, 23),
    minute: clamp(parts.minute, 0, 59),
    second: clamp(parts.second, 0, 59),
  };
}

/**
 * 选区完全落在某一段内（含光标停在段首或段尾）时返回该段序号；
 * 选区跨段（例如全选）时返回 null，交回普通文本编辑。
 */
export function segmentIndexForSelection(
  selectionStart: number,
  selectionEnd: number,
): number | null {
  const index = TIME_SEGMENTS.findIndex(
    (segment) =>
      selectionStart >= segment.start && selectionEnd <= segment.end,
  );
  return index >= 0 ? index : null;
}

/**
 * 把一段向前或向后拨一格。时间是连续的：23 时再加一小时进到次日 00 时，
 * 而不是在本段内回绕；月、年步进时日期按目标月份的天数封顶。
 * 结果超出 0001–9999 年时保持原样。
 */
export function stepTimeSegment(
  text: string,
  index: number,
  direction: 1 | -1,
): string {
  const key = TIME_SEGMENTS[index].key;
  const parts = normalizeParts(readTimeParts(text));

  if (key === "year" || key === "month") {
    const monthIndex =
      parts.year * 12 + (parts.month - 1) + (key === "year" ? 12 : 1) * direction;
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    if (year < 1 || year > 9999) return writeTimeParts(parts);
    return writeTimeParts({
      ...parts,
      year,
      month,
      day: Math.min(parts.day, daysInMonth(year, month)),
    });
  }

  // setFullYear 不会像 Date 构造函数那样把 0–99 年映射到 19xx。
  const date = new Date(0);
  date.setFullYear(parts.year, parts.month - 1, parts.day);
  date.setHours(parts.hour, parts.minute, parts.second, 0);
  if (key === "day") date.setDate(date.getDate() + direction);
  else if (key === "hour") date.setHours(date.getHours() + direction);
  else if (key === "minute") date.setMinutes(date.getMinutes() + direction);
  else date.setSeconds(date.getSeconds() + direction);

  const year = date.getFullYear();
  if (year < 1 || year > 9999) return writeTimeParts(parts);
  return writeTimeParts({
    year,
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  });
}

/**
 * 键入时“日”一律允许到 31：用户可能先改日、再改月，
 * 此时按当前月份截断会把 29–31 日改坏。日期是否存在留给应用时校验。
 */
const TYPING_LIMITS: Record<TimeSegmentKey, readonly [number, number]> = {
  year: [1, 9999],
  month: [1, 12],
  day: [1, 31],
  hour: [0, 23],
  minute: [0, 59],
  second: [0, 59],
};

/**
 * 在一段里键入一位数字，行为与系统日期时间控件一致：
 * 第一位先以补零形式显示；当后面不可能再接出合法数值，或位数已满时，
 * 这一段即告确定并要求跳到下一段。超出范围的第二位视为重新开始键入。
 */
export function typeSegmentDigit(
  text: string,
  index: number,
  pending: string,
  digit: string,
): SegmentTyping {
  const segment = TIME_SEGMENTS[index];
  const length = segment.end - segment.start;
  const parts = readTimeParts(text);
  const [min, max] = TYPING_LIMITS[segment.key];

  let typed = pending.length >= length ? digit : pending + digit;
  if (Number(typed) > max) typed = digit;
  const complete = typed.length === length || Number(typed) * 10 > max;
  const value = complete ? Math.max(min, Number(typed)) : Number(typed);

  const next = { ...parts, [segment.key]: value };
  // 改了年或月之后，原来的日可能已不存在（例如 31 日改到 2 月）。
  if (segment.key === "year" || segment.key === "month") {
    const year = clamp(next.year, 1, 9999);
    const month = clamp(next.month, 1, 12);
    next.day = Math.min(next.day, daysInMonth(year, month));
  }

  return {
    text: writeTimeParts(next),
    pending: complete ? "" : typed,
    advance: complete,
  };
}

const FULL_WIDTH_PUNCTUATION: Record<string, string> = {
  "－": "-",
  "／": "/",
  "：": ":",
  "．": ".",
  "　": " ",
};

/** 中文输入法下可能键入全角数字和标点，统一折算成半角。 */
export function normalizeTimeTyping(text: string): string {
  return text.replace(/[０-９－／：．　]/g, (character) =>
    character >= "０" && character <= "９"
      ? String.fromCharCode(character.charCodeAt(0) - 0xfee0)
      : FULL_WIDTH_PUNCTUATION[character],
  );
}
