import { describe, expect, it } from "vitest";
import {
  MIN_VISIBLE_RANGE_MS,
  createXAxisTickValues,
  createXAxisLabelContext,
  formatTimeRangeInput,
  formatXAxisLabel,
  fitRangeWithBreathingSpace,
  panRange,
  validateTimeRange,
  X_AXIS_FIT_PADDING_RATIO,
  zoomRange,
  zoomRangeFromWheel,
  parseTimeRangeInput,
} from "./chartRange";

const timestamp = (value: string) => new Date(value.replace(" ", "T")).getTime();

const bounds = {
  start: timestamp("2026-01-01 00:00:00"),
  end: timestamp("2026-01-03 00:00:00"),
};

describe("fitRangeWithBreathingSpace", () => {
  it("adds the configured padding ratio on both sides of the bounds", () => {
    const span = bounds.end - bounds.start;
    const padding = span * X_AXIS_FIT_PADDING_RATIO;

    expect(fitRangeWithBreathingSpace(bounds)).toEqual({
      start: bounds.start - padding,
      end: bounds.end + padding,
    });
  });

  it("returns a degenerate range unchanged", () => {
    const degenerate = { start: bounds.start, end: bounds.start };
    expect(fitRangeWithBreathingSpace(degenerate)).toEqual(degenerate);
  });
});

describe("createXAxisTickValues", () => {
  it.each([1, 6, 9])("creates exactly %s equal grid intervals", (gridCount) => {
    const start = timestamp("2026-05-25 04:54:00");
    const end = timestamp("2026-06-23 05:06:56");
    const ticks = createXAxisTickValues(start, end, gridCount);

    expect(ticks).toHaveLength(gridCount + 1);
    expect(ticks[0]).toBe(start);
    expect(ticks.at(-1)).toBe(end);
    const expectedStep = (end - start) / gridCount;
    for (let index = 1; index < ticks.length; index += 1) {
      expect(
        Math.abs(ticks[index] - ticks[index - 1] - expectedStep),
      ).toBeLessThanOrEqual(1);
    }
  });
});

describe("formatTimeRangeInput", () => {
  it("writes a local timestamp in the axis order with dashes and 24-hour time", () => {
    expect(formatTimeRangeInput(Date.parse("2026-01-01T08:09:10"))).toBe(
      "2026-01-01 08:09:10",
    );
    expect(formatTimeRangeInput(Date.parse("2026-12-31T23:59:59"))).toBe(
      "2026-12-31 23:59:59",
    );
  });

  it("truncates sub-second values to whole seconds for start and end inputs", () => {
    expect(formatTimeRangeInput(Date.parse("2026-01-01T08:09:10.500"))).toBe(
      "2026-01-01 08:09:10",
    );
    expect(formatTimeRangeInput(Date.parse("2026-01-01T08:09:10.005"))).toBe(
      "2026-01-01 08:09:10",
    );
  });
});

describe("parseTimeRangeInput", () => {
  it("round-trips the fixed format", () => {
    const time = Date.parse("2026-05-02T07:57:49");
    expect(parseTimeRangeInput(formatTimeRangeInput(time))).toBe(time);
  });

  it.each([
    ["2026-05-02T07:57:49", "2026-05-02T07:57:49"],
    ["2026/5/2 7:57:49", "2026-05-02T07:57:49"],
    ["2026.05.02 07:57", "2026-05-02T07:57:00"],
    ["  2026-05-02   07:57  ", "2026-05-02T07:57:00"],
    ["2026-05-02", "2026-05-02T00:00:00"],
    ["2026-05-02 07:57:49.250", "2026-05-02T07:57:49.250"],
  ])("accepts the pasted spelling %s", (text, expected) => {
    expect(parseTimeRangeInput(text)).toBe(Date.parse(expected));
  });

  it.each([
    "",
    "not-a-date",
    "2026-02-30 00:00:00",
    "2026-13-01 00:00:00",
    "2026-05-02 24:00:00",
    "2026-05-02 07:60:00",
    "26-05-02 07:57:49",
    "2026-05-02 07",
    "2026-05-02 07:57:49 extra",
  ])("rejects %j instead of guessing", (text) => {
    expect(parseTimeRangeInput(text)).toBeNaN();
  });
});

describe("validateTimeRange", () => {
  it("rejects empty and invalid input with Chinese field errors", () => {
    const empty = validateTimeRange("", "", bounds);
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors.start).toMatch(/[\u4e00-\u9fff]/);
      expect(empty.errors.end).toMatch(/[\u4e00-\u9fff]/);
    }

    const invalid = validateTimeRange("not-a-date", "still-not-a-date", bounds);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.start).toMatch(/[\u4e00-\u9fff]/);
      expect(invalid.errors.end).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("rejects calendar overflow instead of accepting Date normalization", () => {
    const broadBounds = {
      start: timestamp("2026-01-01 00:00:00"),
      end: timestamp("2026-04-01 00:00:00"),
    };
    const result = validateTimeRange(
      "2026-02-30T00:00:00",
      "2026-03-02T00:02:00",
      broadBounds,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.start).toMatch(/[\u4e00-\u9fff]/);
  });

  it("rejects a reversed range", () => {
    const result = validateTimeRange(
      "2026-01-02 00:00:00",
      "2026-01-01 00:00:00",
      bounds,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.end).toMatch(/[\u4e00-\u9fff]/);
  });

  it("rejects a positive range shorter than one minute", () => {
    const result = validateTimeRange(
      "2026-01-01 00:00:00",
      "2026-01-01 00:00:30",
      bounds,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.end).toMatch(/[\u4e00-\u9fff]/);
  });

  it("accepts start and end values outside the bounds once roaming is supported", () => {
    const result = validateTimeRange(
      "2025-12-31 23:59:59",
      "2026-01-03 00:00:01",
      bounds,
    );

    expect(result).toEqual({
      ok: true,
      range: {
        start: timestamp("2025-12-31 23:59:59"),
        end: timestamp("2026-01-03 00:00:01"),
      },
    });
  });

  it("still reports a reversed range when its start lies beyond the bounds", () => {
    const result = validateTimeRange(
      "2026-01-04 00:00:00",
      "2026-01-02 00:00:00",
      bounds,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.start).toBeUndefined();
      expect(result.errors.end).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("accepts the complete range when the bounds are shorter than one minute", () => {
    const shortBounds = {
      start: timestamp("2026-01-01 00:00:00"),
      end: timestamp("2026-01-01 00:00:30"),
    };

    expect(
      validateTimeRange("2026-01-01 00:00:00", "2026-01-01 00:00:30", shortBounds),
    ).toEqual({ ok: true, range: shortBounds });
  });

  it("still rejects a selection shorter than short bounds", () => {
    const shortBounds = {
      start: timestamp("2026-01-01 00:00:00"),
      end: timestamp("2026-01-01 00:00:30"),
    };

    expect(
      validateTimeRange("2026-01-01 00:00:00", "2026-01-01 00:00:20", shortBounds).ok,
    ).toBe(false);
  });

  it("returns the numeric range for valid input", () => {
    expect(
      validateTimeRange("2026-01-01 06:00:00", "2026-01-02 06:00:00", bounds),
    ).toEqual({
      ok: true,
      range: {
        start: timestamp("2026-01-01 06:00:00"),
        end: timestamp("2026-01-02 06:00:00"),
      },
    });
  });
});

describe("free chart range navigation", () => {
  it("zooms around the anchor and pans freely beyond the lower bound", () => {
    const zoomed = zoomRange(bounds, bounds, 0.5, -1);

    expect(zoomed.end - zoomed.start).toBe((bounds.end - bounds.start) * 0.8);
    expect(zoomed.end - zoomed.start).toBeGreaterThanOrEqual(MIN_VISIBLE_RANGE_MS);
    const panned = panRange(zoomed, -10);
    expect(panned.start).toBeLessThan(bounds.start);
    expect(panned.end - panned.start).toBe(zoomed.end - zoomed.start);
  });

  it("does not zoom below the minimum visible range", () => {
    const range = {
      start: bounds.start,
      end: bounds.start + MIN_VISIBLE_RANGE_MS,
    };

    expect(zoomRange(range, bounds, 0.5, -1).end - range.start).toBe(
      MIN_VISIBLE_RANGE_MS,
    );
  });

  it("keeps the range unchanged when the wheel direction is zero", () => {
    const range = {
      start: timestamp("2025-12-31 22:00:00"),
      end: timestamp("2026-01-01 10:00:00"),
    };

    expect(zoomRange(range, bounds, 0.5, 0)).toEqual(range);
  });

  it("zooms out beyond the complete data bounds", () => {
    const zoomed = zoomRange(bounds, bounds, 0.5, 1);

    expect(zoomed.start).toBeLessThan(bounds.start);
    expect(zoomed.end).toBeGreaterThan(bounds.end);
    expect(zoomed.end - zoomed.start).toBe((bounds.end - bounds.start) * 1.25);
  });

  it("pans a range entirely outside the data bounds", () => {
    const outside = {
      start: bounds.end + 3 * 60 * 60 * 1_000,
      end: bounds.end + 9 * 60 * 60 * 1_000,
    };

    expect(panRange(outside, 0.5)).toEqual({
      start: outside.start + (outside.end - outside.start) * 0.5,
      end: outside.end + (outside.end - outside.start) * 0.5,
    });
  });

  it("returns the range unchanged for invalid pan input", () => {
    const range = { start: bounds.start, end: bounds.end };
    expect(panRange(range, Number.NaN)).toEqual(range);
  });
});

describe("x-axis labels", () => {
  it("uses time labels and a date context for a four-hour same-day range", () => {
    expect(
      createXAxisLabelContext(
        timestamp("2026-01-01 00:00:00"),
        timestamp("2026-01-01 04:00:00"),
        6,
      ),
    ).toEqual({ mode: "time", dateContext: "01-01", includeSeconds: false });
  });

  it.each([1, 6, 9])(
    "shows the same-day date only under the first minute label with %i grid intervals",
    (gridCount) => {
      const start = timestamp("2026-05-18 04:54:07");
      const context = createXAxisLabelContext(
        start,
        start + gridCount * 60_000,
        gridCount,
      );
      const labels = [start, start + 60_000].map((value, index) =>
        formatXAxisLabel(value, context, index === 0),
      );

      expect(context).toEqual({
        mode: "time",
        dateContext: "05-18",
        includeSeconds: false,
      });
      expect(labels).toEqual(["04:54\n05-18", "04:55"]);
    },
  );

  it.each([1, 6, 9])(
    "shows the same-day date only under the first seconds label with %i grid intervals",
    (gridCount) => {
      const start = timestamp("2026-05-18 04:54:07");
      const context = createXAxisLabelContext(
        start,
        start + gridCount * (60_000 - 1),
        gridCount,
      );
      const labels = [start, start + 1_000].map((value, index) =>
        formatXAxisLabel(value, context, index === 0),
      );

      expect(context.includeSeconds).toBe(true);
      expect(labels).toEqual(["04:54:07\n05-18", "04:54:08"]);
    },
  );

  it("uses date-time labels for a twelve-hour range crossing midnight", () => {
    expect(
      createXAxisLabelContext(
        timestamp("2026-01-01 18:00:00"),
        timestamp("2026-01-02 06:00:00"),
        6,
      ),
    ).toEqual({ mode: "date-time", dateContext: null, includeSeconds: false });
  });

  it("uses month-day labels for a two-month same-year range", () => {
    expect(
      createXAxisLabelContext(
        timestamp("2026-01-01 00:00:00"),
        timestamp("2026-03-01 00:00:00"),
        6,
      ),
    ).toEqual({ mode: "date", dateContext: null, includeSeconds: false });
  });

  it("uses year-month-day labels for a two-day cross-year range", () => {
    expect(
      createXAxisLabelContext(
        timestamp("2025-12-31 00:00:00"),
        timestamp("2026-01-02 00:00:00"),
        6,
      ),
    ).toEqual({ mode: "year-date", dateContext: null, includeSeconds: false });
  });

  it("includes seconds when a three-minute same-day range has six grid intervals", () => {
    const context = createXAxisLabelContext(
      timestamp("2026-01-01 00:00:00"),
      timestamp("2026-01-01 00:03:00"),
      6,
    );

    expect(context.includeSeconds).toBe(true);
    expect(formatXAxisLabel(timestamp("2026-01-01 00:00:30"), context, false)).toBe(
      "00:00:30",
    );
  });

  it("includes seconds in date-time labels for a short range crossing midnight", () => {
    const context = createXAxisLabelContext(
      timestamp("2026-01-01 23:59:30"),
      timestamp("2026-01-02 00:00:30"),
      6,
    );

    expect(context).toEqual({ mode: "date-time", dateContext: null, includeSeconds: true });
    expect(formatXAxisLabel(timestamp("2026-01-01 23:59:40"), context, true)).toBe(
      "01-01 23:59:40",
    );
    expect(
      formatXAxisLabel(timestamp("2026-01-02 00:00:20"), context, false),
    ).toBe("01-02 00:00:20");
  });
});

describe("normalized wheel range navigation", () => {
  const current = {
    start: bounds.start + 6 * 60 * 60 * 1_000,
    end: bounds.start + 30 * 60 * 60 * 1_000,
  };
  const anchor = current.start + (current.end - current.start) * 0.25;

  it.each([
    ["small zoom-in", 1, 1 / 1.1],
    ["medium zoom-in", 2, 1 / 1.2],
    ["large zoom-in", 4, 1 / 1.4],
    ["large zoom-out", -4, 1.4],
  ])("matches ECharts for %s", (_label, wheelDelta, spanScale) => {
    const next = zoomRangeFromWheel(current, bounds, anchor, wheelDelta);

    expect(next).not.toBeNull();
    const currentSpan = current.end - current.start;
    expect((next!.end - next!.start) / currentSpan).toBeCloseTo(spanScale, 10);
    expect(
      (anchor - next!.start) / (next!.end - next!.start),
    ).toBeCloseTo(0.25, 10);
  });

  it("uses the current start for a left out-of-range anchor", () => {
    const next = zoomRangeFromWheel(
      current,
      bounds,
      current.start - 60 * 60 * 1_000,
      4,
    );

    expect(next).toEqual(
      zoomRangeFromWheel(current, bounds, current.start, 4),
    );
    expect(next!.start).toBe(current.start);
  });

  it("uses the current end for a right out-of-range anchor", () => {
    const next = zoomRangeFromWheel(
      current,
      bounds,
      current.end + 60 * 60 * 1_000,
      4,
    );

    expect(next).toEqual(zoomRangeFromWheel(current, bounds, current.end, 4));
    expect(next!.end).toBe(current.end);
  });

  it.each([1, 2, 4])(
    "preserves the exact current end for a large right out-of-range anchor with wheel delta %s",
    (wheelDelta) => {
      const largeRange = { start: -1e16, end: 1 };
      const largeBounds = { start: -1e16, end: 1e16 };
      const next = zoomRangeFromWheel(largeRange, largeBounds, 2, wheelDelta);

      expect(next).not.toBeNull();
      expect(next!.end).toBe(largeRange.end);
    },
  );

  it("zooms out past the complete data bounds", () => {
    const zoomed = zoomRangeFromWheel(bounds, bounds, bounds.start, -4)!;
    expect(zoomed.start).toBe(bounds.start);
    expect(zoomed.end).toBe(
      bounds.start + (bounds.end - bounds.start) * 1.4,
    );
  });

  it("keeps zooming out beyond large bounds without clamping", () => {
    const largeBounds = { start: -1e16, end: 1 };

    const zoomed = zoomRangeFromWheel(
      largeBounds,
      largeBounds,
      largeBounds.end,
      -4,
    )!;
    const expectedSpan = (largeBounds.end - largeBounds.start) * 1.4;
    expect(zoomed.end - zoomed.start).toBeGreaterThan(
      largeBounds.end - largeBounds.start,
    );
    expect(
      Math.abs(zoomed.end - zoomed.start - expectedSpan) / expectedSpan,
    ).toBeLessThan(1e-12);
  });

  it("does not zoom below the minimum visible span", () => {
    const minimum = {
      start: bounds.start,
      end: bounds.start + MIN_VISIBLE_RANGE_MS,
    };

    expect(
      zoomRangeFromWheel(minimum, bounds, minimum.start, 4),
    ).toEqual(minimum);
  });

  it("keeps the complete minimum range fixed around its midpoint", () => {
    const minimum = {
      start: bounds.start,
      end: bounds.start + MIN_VISIBLE_RANGE_MS,
    };
    const midpoint = minimum.start + MIN_VISIBLE_RANGE_MS / 2;

    expect(zoomRangeFromWheel(minimum, bounds, midpoint, 4)).toEqual(minimum);
  });

  it.each([
    [
      "current range",
      { start: -Number.MAX_VALUE, end: Number.MAX_VALUE },
      bounds,
      0,
    ],
    [
      "complete bounds",
      current,
      { start: -Number.MAX_VALUE, end: Number.MAX_VALUE },
      anchor,
    ],
  ])(
    "rejects finite %s endpoints whose derived span overflows",
    (_label, range, completeBounds, anchorTime) => {
      expect(
        zoomRangeFromWheel(range, completeBounds, anchorTime, 4),
      ).toBeNull();
    },
  );

  it.each([
    ["zero wheel delta", current, bounds, anchor, 0],
    ["invalid anchor", current, bounds, Number.NaN, 4],
    [
      "reversed current range",
      { start: current.end, end: current.start },
      bounds,
      anchor,
      4,
    ],
    [
      "reversed bounds",
      current,
      { start: bounds.end, end: bounds.start },
      anchor,
      4,
    ],
  ])("rejects %s", (_label, range, completeBounds, anchorTime, wheelDelta) => {
    expect(
      zoomRangeFromWheel(range, completeBounds, anchorTime, wheelDelta),
    ).toBeNull();
  });
});
