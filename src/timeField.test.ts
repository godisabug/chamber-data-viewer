import { describe, expect, it } from "vitest";
import {
  TIME_SEGMENTS,
  daysInMonth,
  isSegmentedTimeText,
  normalizeTimeTyping,
  segmentIndexForSelection,
  stepTimeSegment,
  typeSegmentDigit,
} from "./timeField";

const YEAR = 0;
const MONTH = 1;
const DAY = 2;
const HOUR = 3;
const MINUTE = 4;
const SECOND = 5;

/** 依次在同一段键入若干数字，返回最后的状态。 */
function typeDigits(text: string, index: number, digits: string) {
  let state = { text, pending: "", advance: false };
  for (const digit of digits) {
    state = typeSegmentDigit(state.text, index, state.pending, digit);
  }
  return state;
}

describe("time field segments", () => {
  it("maps each segment onto the fixed YYYY-MM-DD HH:mm:ss text", () => {
    const text = "2026-05-02 07:57:49";
    expect(
      TIME_SEGMENTS.map((segment) => text.slice(segment.start, segment.end)),
    ).toEqual(["2026", "05", "02", "07", "57", "49"]);
  });

  it("recognises only the fixed spelling as segmented text", () => {
    expect(isSegmentedTimeText("2026-05-02 07:57:49")).toBe(true);
    // 形状对就可以分段编辑；日期是否存在由应用时的校验负责。
    expect(isSegmentedTimeText("2026-02-31 07:57:49")).toBe(true);
    expect(isSegmentedTimeText("2026-05-02T07:57:49")).toBe(false);
    expect(isSegmentedTimeText("2026-5-2 7:57:49")).toBe(false);
    expect(isSegmentedTimeText("2026--02 07:57:49")).toBe(false);
    expect(isSegmentedTimeText("")).toBe(false);
  });

  it("finds the segment a selection or caret sits in", () => {
    expect(segmentIndexForSelection(0, 4)).toBe(YEAR);
    expect(segmentIndexForSelection(4, 4)).toBe(YEAR);
    expect(segmentIndexForSelection(5, 5)).toBe(MONTH);
    expect(segmentIndexForSelection(6, 6)).toBe(MONTH);
    expect(segmentIndexForSelection(8, 10)).toBe(DAY);
    expect(segmentIndexForSelection(11, 13)).toBe(HOUR);
    expect(segmentIndexForSelection(19, 19)).toBe(SECOND);
  });

  it("hands a selection that spans segments back to plain text editing", () => {
    expect(segmentIndexForSelection(0, 19)).toBeNull();
    expect(segmentIndexForSelection(3, 6)).toBeNull();
    expect(segmentIndexForSelection(11, 19)).toBeNull();
  });

  it("knows month lengths including leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe("stepping a time segment", () => {
  it("moves a single segment by one unit", () => {
    const text = "2026-05-02 07:57:49";
    expect(stepTimeSegment(text, YEAR, 1)).toBe("2027-05-02 07:57:49");
    expect(stepTimeSegment(text, MONTH, -1)).toBe("2026-04-02 07:57:49");
    expect(stepTimeSegment(text, DAY, 1)).toBe("2026-05-03 07:57:49");
    expect(stepTimeSegment(text, HOUR, -1)).toBe("2026-05-02 06:57:49");
    expect(stepTimeSegment(text, MINUTE, 1)).toBe("2026-05-02 07:58:49");
    expect(stepTimeSegment(text, SECOND, -1)).toBe("2026-05-02 07:57:48");
  });

  it("carries into the next unit because time is continuous", () => {
    expect(stepTimeSegment("2026-05-02 23:30:00", HOUR, 1)).toBe(
      "2026-05-03 00:30:00",
    );
    expect(stepTimeSegment("2026-05-01 00:00:00", SECOND, -1)).toBe(
      "2026-04-30 23:59:59",
    );
    expect(stepTimeSegment("2026-12-31 08:00:00", DAY, 1)).toBe(
      "2027-01-01 08:00:00",
    );
    expect(stepTimeSegment("2026-12-15 08:00:00", MONTH, 1)).toBe(
      "2027-01-15 08:00:00",
    );
    expect(stepTimeSegment("2026-01-15 08:00:00", MONTH, -1)).toBe(
      "2025-12-15 08:00:00",
    );
  });

  it("caps the day at the target month's length", () => {
    expect(stepTimeSegment("2026-01-31 08:00:00", MONTH, 1)).toBe(
      "2026-02-28 08:00:00",
    );
    expect(stepTimeSegment("2028-02-29 08:00:00", YEAR, 1)).toBe(
      "2029-02-28 08:00:00",
    );
  });

  it("repairs out-of-range segments before stepping", () => {
    expect(stepTimeSegment("2026-02-31 08:00:00", HOUR, 1)).toBe(
      "2026-02-28 09:00:00",
    );
    expect(stepTimeSegment("2026-00-10 25:61:61", DAY, 1)).toBe(
      "2026-01-11 23:59:59",
    );
  });

  it("stays put at the supported year limits", () => {
    expect(stepTimeSegment("9999-12-31 23:59:59", SECOND, 1)).toBe(
      "9999-12-31 23:59:59",
    );
    expect(stepTimeSegment("0001-01-01 00:00:00", YEAR, -1)).toBe(
      "0001-01-01 00:00:00",
    );
    expect(stepTimeSegment("0050-06-15 12:00:00", DAY, 1)).toBe(
      "0050-06-16 12:00:00",
    );
  });
});

describe("typing into a time segment", () => {
  const text = "2026-05-02 07:57:49";

  it("shows the first digit zero-padded and waits for a second one", () => {
    expect(typeSegmentDigit(text, MONTH, "", "1")).toEqual({
      text: "2026-01-02 07:57:49",
      pending: "1",
      advance: false,
    });
    expect(typeSegmentDigit("2026-01-02 07:57:49", MONTH, "1", "2")).toEqual({
      text: "2026-12-02 07:57:49",
      pending: "",
      advance: true,
    });
  });

  it("advances at once when no second digit could follow", () => {
    expect(typeSegmentDigit(text, MONTH, "", "2")).toMatchObject({
      text: "2026-02-02 07:57:49",
      advance: true,
    });
    expect(typeSegmentDigit(text, DAY, "", "4")).toMatchObject({
      text: "2026-05-04 07:57:49",
      advance: true,
    });
    expect(typeSegmentDigit(text, HOUR, "", "3")).toMatchObject({
      text: "2026-05-02 03:57:49",
      advance: true,
    });
    expect(typeSegmentDigit(text, MINUTE, "", "6")).toMatchObject({
      text: "2026-05-02 07:06:49",
      advance: true,
    });
    expect(typeSegmentDigit(text, SECOND, "", "5")).toMatchObject({
      text: "2026-05-02 07:57:05",
      pending: "5",
      advance: false,
    });
  });

  it("restarts the segment when the second digit would overflow it", () => {
    expect(typeDigits(text, MONTH, "13")).toEqual({
      text: "2026-03-02 07:57:49",
      pending: "",
      advance: true,
    });
    expect(typeDigits(text, HOUR, "25")).toEqual({
      text: "2026-05-02 05:57:49",
      pending: "",
      advance: true,
    });
    expect(typeDigits(text, DAY, "32")).toEqual({
      text: "2026-05-02 07:57:49",
      pending: "2",
      advance: false,
    });
  });

  it("fills the year across four digits", () => {
    expect(typeDigits(text, YEAR, "2")).toMatchObject({
      text: "0002-05-02 07:57:49",
      pending: "2",
      advance: false,
    });
    expect(typeDigits(text, YEAR, "2027")).toEqual({
      text: "2027-05-02 07:57:49",
      pending: "",
      advance: true,
    });
  });

  it("turns a zero month or day into the first one, but keeps zero o'clock", () => {
    expect(typeDigits(text, MONTH, "00")).toMatchObject({
      text: "2026-01-02 07:57:49",
      advance: true,
    });
    expect(typeDigits(text, DAY, "00")).toMatchObject({
      text: "2026-05-01 07:57:49",
      advance: true,
    });
    expect(typeDigits(text, HOUR, "00")).toMatchObject({
      text: "2026-05-02 00:57:49",
      advance: true,
    });
  });

  it("lets the day be typed before the month it belongs to", () => {
    // 2 月里先键入 30 日，再把月份改成 3 月：30 日不能被提前截断。
    const day = typeDigits("2026-02-15 08:00:00", DAY, "30");
    expect(day.text).toBe("2026-02-30 08:00:00");
    expect(typeDigits(day.text, MONTH, "03").text).toBe("2026-03-30 08:00:00");
  });

  it("caps the day once the month or year makes it impossible", () => {
    expect(typeDigits("2026-01-31 08:00:00", MONTH, "02").text).toBe(
      "2026-02-28 08:00:00",
    );
    expect(typeDigits("2026-01-31 08:00:00", MONTH, "11").text).toBe(
      "2026-11-30 08:00:00",
    );
    expect(typeDigits("2028-02-29 08:00:00", YEAR, "2026").text).toBe(
      "2026-02-28 08:00:00",
    );
  });
});

describe("normalising typed characters", () => {
  it("folds full-width digits and punctuation from a Chinese IME", () => {
    expect(normalizeTimeTyping("２０２６－０５－０２　０７：５７：４９")).toBe(
      "2026-05-02 07:57:49",
    );
    expect(normalizeTimeTyping("２０２６／５／２")).toBe("2026/5/2");
    expect(normalizeTimeTyping("2026-05-02 07:57:49")).toBe(
      "2026-05-02 07:57:49",
    );
  });
});
