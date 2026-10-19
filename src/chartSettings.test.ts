import { describe, expect, it } from "vitest";
import { makeDataset } from "./test/fixtures";
import {
  clampPanelPosition,
  createSettingsDraft,
  normalizeAxisDraft,
  stepAxisBoundText,
  stepGridCountText,
  updateAxisDraft,
  validateSettingsDraft,
} from "./chartSettings";

describe("chart settings stepping", () => {
  it("starts an automatic bound from the displayed value instead of zero", () => {
    expect(stepAxisBoundText("", "120", 1)).toBe("121");
    expect(stepAxisBoundText("", "120", -1)).toBe("119");
    expect(stepAxisBoundText("  ", "-60", 1)).toBe("-59");
  });

  it("lands a fractional value on the neighbouring whole number first", () => {
    expect(stepAxisBoundText("", "23.8", 1)).toBe("24");
    expect(stepAxisBoundText("", "23.8", -1)).toBe("23");
    expect(stepAxisBoundText("", "-63.8", 1)).toBe("-63");
    expect(stepAxisBoundText("", "-63.8", -1)).toBe("-64");
    expect(stepAxisBoundText("0.5", "99", 1)).toBe("1");
    expect(stepAxisBoundText("0.5", "99", -1)).toBe("0");
  });

  it("steps a typed bound by one and ignores the displayed value", () => {
    expect(stepAxisBoundText("24", "99", 1)).toBe("25");
    expect(stepAxisBoundText("24", "99", -1)).toBe("23");
    expect(stepAxisBoundText("-1", "99", 1)).toBe("0");
  });

  it("falls back to zero only when no range is displayed", () => {
    expect(stepAxisBoundText("", null, 1)).toBe("1");
    expect(stepAxisBoundText("", null, -1)).toBe("-1");
  });

  it("leaves text that is not a number untouched", () => {
    expect(stepAxisBoundText("abc", "10", 1)).toBeNull();
    expect(stepAxisBoundText("", "自动", 1)).toBeNull();
  });

  it("keeps grid counts inside one to nine", () => {
    expect(stepGridCountText("6", 1)).toBe("7");
    expect(stepGridCountText("6", -1)).toBe("5");
    expect(stepGridCountText("9", 1)).toBe("9");
    expect(stepGridCountText("1", -1)).toBe("1");
    expect(stepGridCountText("12", -1)).toBe("9");
    expect(stepGridCountText("2.5", 1)).toBe("3");
    expect(stepGridCountText("", 1)).toBe("1");
    expect(stepGridCountText("x", -1)).toBe("1");
  });
});

describe("chart settings", () => {
  it("creates an empty axis draft with the default grid counts", () => {
    expect(createSettingsDraft(makeDataset().axes)).toEqual({
      axes: {
        primary: { min: "", max: "" },
        secondary: { min: "", max: "" },
      },
      yGridCount: "6",
      xGridCount: "6",
    });
  });

  it("round-trips applied bounds and boundary grid counts into a draft", () => {
    expect(
      createSettingsDraft(makeDataset().axes, {
        axes: {
          primary: { min: -12.5, max: 40 },
          secondary: {},
        },
        yGridCount: 1,
        xGridCount: 9,
      }),
    ).toEqual({
      axes: {
        primary: { min: "-12.5", max: "40" },
        secondary: { min: "", max: "" },
      },
      yGridCount: "1",
      xGridCount: "9",
    });
  });

  it("keeps enough axis bound precision to preserve deep-zoom spans", () => {
    expect(
      createSettingsDraft(makeDataset().axes, {
        axes: {
          primary: { min: 14.285714285714285, max: 85.71428571428571 },
          secondary: {},
        },
        yGridCount: 5,
        xGridCount: 6,
      }),
    ).toEqual({
      axes: {
        primary: { min: "14.285714", max: "85.714286" },
        secondary: { min: "", max: "" },
      },
      yGridCount: "5",
      xGridCount: "6",
    });
  });

  it("preserves sub-tenth applied bounds so both endpoints stay distinct", () => {
    expect(
      createSettingsDraft(makeDataset().axes, {
        axes: {
          primary: { min: 24.02, max: 24.04 },
          secondary: {},
        },
        yGridCount: 5,
        xGridCount: 6,
      }),
    ).toEqual({
      axes: {
        primary: { min: "24.02", max: "24.04" },
        secondary: { min: "", max: "" },
      },
      yGridCount: "5",
      xGridCount: "6",
    });
  });

  it("creates independent drafts without mutating applied settings", () => {
    const axes = makeDataset().axes;
    const applied = {
      axes: {
        primary: { min: 10, max: 20 },
        secondary: {},
      },
      yGridCount: 1,
      xGridCount: 9,
    };
    const appliedBefore = structuredClone(applied);
    const first = createSettingsDraft(axes, applied);
    const second = createSettingsDraft(axes, applied);
    const secondBefore = structuredClone(second);

    first.axes.primary.min = "999";
    first.axes.secondary.max = "50";
    first.yGridCount = "8";

    expect(applied).toEqual(appliedBefore);
    expect(second).toEqual(secondBefore);
  });

  it("validates every axis and applies all settings atomically", () => {
    const axes = makeDataset().axes;
    const draft = createSettingsDraft(axes);
    draft.axes.primary = { min: "20", max: "30" };
    draft.axes.secondary = { min: "40", max: "100" };

    expect(validateSettingsDraft(axes, draft)).toEqual({
      ok: true,
      value: {
        axes: {
          primary: { min: 20, max: 30 },
          secondary: { min: 40, max: 100 },
        },
        yGridCount: 6,
        xGridCount: 6,
      },
    });
  });

  it("returns every axis and grid error without partially applying settings", () => {
    const axes = makeDataset().axes;
    const draft = createSettingsDraft(axes);
    draft.axes.primary = { min: "20", max: "" };
    draft.axes.secondary = { min: "100", max: "40" };
    draft.yGridCount = "2.5";
    draft.xGridCount = "10";

    expect(validateSettingsDraft(axes, draft)).toEqual({
      ok: false,
      errors: {
        "primary.max": "请同时填写下限和上限",
        "secondary.max": "上限必须大于下限",
        yGridCount: "纵轴刻度格数必须是 1 至 9 的整数",
        xGridCount: "横轴刻度格数必须是 1 至 9 的整数",
      },
    });
  });

  describe("axis validation", () => {
    it("freezes the displayed lower bound when an automatic upper bound is edited", () => {
      expect(
        updateAxisDraft({ min: "", max: "" }, "max", "120", [10, 80]),
      ).toEqual({ min: "10", max: "120" });
    });

    it("freezes the displayed upper bound when an automatic lower bound is edited", () => {
      expect(
        updateAxisDraft({ min: "", max: "" }, "min", "-5", [10, 80]),
      ).toEqual({ min: "-5", max: "80" });
    });

    it("restores a single cleared manual endpoint when applying", () => {
      expect(
        normalizeAxisDraft({ min: "10", max: "" }, [10, 120]),
      ).toEqual({ min: "10", max: "120" });
    });

    it("keeps both explicitly deleted endpoints automatic", () => {
      expect(normalizeAxisDraft({ min: "", max: "" }, [10, 120])).toEqual({
        min: "",
        max: "",
      });
    });

    it("formats a frozen displayed endpoint with the extent precision", () => {
      expect(
        updateAxisDraft({ min: "", max: "" }, "max", "120", [
          14.285714285714285,
          85.71428571428571,
        ]),
      ).toEqual({ min: "14.285714", max: "120" });
    });

    it("formats a restored displayed endpoint with the extent precision", () => {
      expect(
        normalizeAxisDraft({ min: "10", max: "" }, [
          14.285714285714285,
          85.71428571428571,
        ]),
      ).toEqual({ min: "10", max: "85.714286" });
    });

    it("applies a completed snapshot instead of persisting a half-automatic range", () => {
      const axes = makeDataset().axes;
      const draft = createSettingsDraft(axes);
      draft.axes.primary.max = "120";

      expect(
        validateSettingsDraft(
          axes,
          draft,
          new Map([
            ["primary", [10, 80] as const],
            ["secondary", [40, 100] as const],
          ]),
        ),
      ).toEqual({
        ok: true,
        value: {
          axes: {
            primary: { min: 10, max: 120 },
            secondary: {},
          },
          yGridCount: 6,
          xGridCount: 6,
        },
      });
    });

    it("treats whitespace-only bounds as automatic", () => {
      const axes = makeDataset().axes;
      const draft = createSettingsDraft(axes);
      draft.axes.primary = { min: "  ", max: "\t" };
      draft.axes.secondary = { min: "\n", max: "   " };

      expect(validateSettingsDraft(axes, draft)).toEqual({
        ok: true,
        value: {
          axes: { primary: {}, secondary: {} },
          yGridCount: 6,
          xGridCount: 6,
        },
      });
    });

    it("accepts scientific notation and negative zero as numeric bounds", () => {
      const axes = makeDataset().axes;
      const draft = createSettingsDraft(axes);
      draft.axes.primary = { min: "-0", max: "1e2" };

      const result = validateSettingsDraft(axes, draft);

      expect(result).toEqual({
        ok: true,
        value: {
          axes: {
            primary: { min: -0, max: 100 },
            secondary: {},
          },
          yGridCount: 6,
          xGridCount: 6,
        },
      });
    });

    it("rejects NaN and Infinity with errors on their exact fields", () => {
      const axes = makeDataset().axes;
      const draft = createSettingsDraft(axes);
      draft.axes.primary = { min: "NaN", max: "10" };
      draft.axes.secondary = { min: "0", max: "Infinity" };

      expect(validateSettingsDraft(axes, draft)).toEqual({
        ok: false,
        errors: {
          "primary.min": "请输入有效数字",
          "secondary.max": "请输入有效数字",
        },
      });
    });

    it("rejects equal lower and upper bounds", () => {
      const axes = makeDataset().axes;
      const draft = createSettingsDraft(axes);
      draft.axes.primary = { min: "20", max: "20" };

      expect(validateSettingsDraft(axes, draft)).toEqual({
        ok: false,
        errors: { "primary.max": "上限必须大于下限" },
      });
    });
  });

  describe("grid count validation", () => {
    it.each(["1", "9"])("accepts %s as a boundary", (input) => {
      const axes = makeDataset().axes;
      const draft = createSettingsDraft(axes);
      draft.yGridCount = input;
      draft.xGridCount = input;

      expect(validateSettingsDraft(axes, draft)).toEqual({
        ok: true,
        value: {
          axes: { primary: {}, secondary: {} },
          yGridCount: Number(input),
          xGridCount: Number(input),
        },
      });
    });

    it.each([
      ["blank", "   "],
      ["zero", "0"],
      ["ten", "10"],
      ["decimal", "2.5"],
    ])("rejects %s values", (_case, input) => {
      const axes = makeDataset().axes;
      const draft = createSettingsDraft(axes);
      draft.yGridCount = input;
      draft.xGridCount = input;

      expect(validateSettingsDraft(axes, draft)).toEqual({
        ok: false,
        errors: {
          yGridCount: "纵轴刻度格数必须是 1 至 9 的整数",
          xGridCount: "横轴刻度格数必须是 1 至 9 的整数",
        },
      });
    });
  });

  it("filters unknown applied and draft axes from current settings", () => {
    const axes = makeDataset().axes;
    const draft = createSettingsDraft(axes, {
      axes: {
        primary: { min: 1, max: 2 },
        secondary: {},
        legacy: { min: 100, max: 200 },
      },
      yGridCount: 5,
      xGridCount: 6,
    });

    expect(Object.keys(draft.axes)).toEqual(["primary", "secondary"]);
    draft.axes.legacy = { min: "100", max: "200" };
    expect(validateSettingsDraft(axes, draft)).toEqual({
      ok: true,
      value: {
        axes: {
          primary: { min: 1, max: 2 },
          secondary: {},
        },
        yGridCount: 5,
        xGridCount: 6,
      },
    });
  });

  it("does not mutate a draft while validating it", () => {
    const axes = makeDataset().axes;
    const draft = createSettingsDraft(axes);
    draft.axes.primary = { min: " 20 ", max: "" };
    draft.axes.unknown = { min: "0", max: "1" };
    draft.yGridCount = " 2.5 ";
    const before = structuredClone(draft);

    validateSettingsDraft(axes, draft);

    expect(draft).toEqual(before);
  });

  it("clamps the settings panel inside its container", () => {
    expect(
      clampPanelPosition(
        { x: 900, y: -20 },
        { width: 1000, height: 600 },
        { width: 320, height: 400 },
      ),
    ).toEqual({ x: 680, y: 0 });
  });

  it("clamps an oversized panel to the container origin", () => {
    expect(
      clampPanelPosition(
        { x: 100, y: 100 },
        { width: 200, height: 150 },
        { width: 320, height: 400 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });
});
