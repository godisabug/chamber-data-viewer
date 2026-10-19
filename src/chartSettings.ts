import type { Axis } from "./types";

export type AxisBounds = {
  min?: number;
  max?: number;
};

export type AppliedChartSettings = {
  axes: Record<string, AxisBounds>;
  yGridCount: number;
  xGridCount: number;
};

export type AxisDraft = {
  min: string;
  max: string;
};

export type AxisExtent = readonly [min: number, max: number];

export type ChartSettingsDraft = {
  axes: Record<string, AxisDraft>;
  yGridCount: string;
  xGridCount: string;
};

export type SettingsErrors = Record<string, string>;

export type StepDirection = 1 | -1;

const AXIS_BOUND_DECIMALS = 1;
const MAX_AXIS_BOUND_DECIMALS = 6;
const GRID_COUNT_MIN = 1;
const GRID_COUNT_MAX = 9;

export const DEFAULT_CHART_SETTINGS: AppliedChartSettings = {
  axes: {},
  yGridCount: 6,
  xGridCount: 6,
};

function axisBoundDecimals(min: number, max: number): number {
  let decimals = AXIS_BOUND_DECIMALS;
  for (const value of [min, max]) {
    if (!Number.isFinite(value)) continue;
    const text = String(value);
    const dot = text.indexOf(".");
    if (dot >= 0 && !text.includes("e")) {
      decimals = Math.max(
        decimals,
        Math.min(MAX_AXIS_BOUND_DECIMALS, text.length - dot - 1),
      );
    }
  }
  return decimals;
}

export function formatAxisBound(value: number, peer?: number): string {
  const decimals = axisBoundDecimals(value, peer ?? value);
  return String(Number(value.toFixed(decimals)));
}

export function createSettingsDraft(
  axes: Axis[],
  applied: AppliedChartSettings = DEFAULT_CHART_SETTINGS,
): ChartSettingsDraft {
  return {
    axes: Object.fromEntries(
      axes.map((axis) => {
        const bounds = applied.axes[axis.id];
        return [
          axis.id,
          {
            min:
              bounds?.min === undefined
                ? ""
                : formatAxisBound(bounds.min, bounds?.max),
            max:
              bounds?.max === undefined
                ? ""
                : formatAxisBound(bounds.max, bounds?.min),
          },
        ];
      }),
    ),
    yGridCount: String(applied.yGridCount),
    xGridCount: String(applied.xGridCount),
  };
}

export function updateAxisDraft(
  current: AxisDraft,
  field: keyof AxisDraft,
  value: string,
  displayedExtent: AxisExtent | null,
): AxisDraft {
  const next = { ...current, [field]: value };
  if (value.trim() === "") return next;
  if (current.min.trim() !== "" || current.max.trim() !== "") return next;
  if (!displayedExtent) return next;
  return {
    min: formatAxisBound(displayedExtent[0], displayedExtent[1]),
    max: formatAxisBound(displayedExtent[1], displayedExtent[0]),
    [field]: value,
  };
}

export function normalizeAxisDraft(
  draft: AxisDraft,
  displayedExtent: AxisExtent | null,
): AxisDraft {
  const minMissing = draft.min.trim() === "";
  const maxMissing = draft.max.trim() === "";
  if (minMissing && maxMissing) return { min: "", max: "" };
  if (!displayedExtent) return draft;
  return {
    min: minMissing
      ? formatAxisBound(displayedExtent[0], displayedExtent[1])
      : draft.min,
    max: maxMissing
      ? formatAxisBound(displayedExtent[1], displayedExtent[0])
      : draft.max,
  };
}

/** 以 1 为单位落到相邻的整数：23.8 向上为 24、向下为 23，24 向上为 25。 */
function stepToWholeNumber(value: number, direction: StepDirection): number {
  return direction > 0 ? Math.floor(value) + 1 : Math.ceil(value) - 1;
}

/**
 * 步进一次纵轴边界。留空（自动）时以当前显示的范围为起点，而不是从 0 开始；
 * 没有可显示的范围时才退回 0。文本不是数字时返回 null，表示不改动。
 */
export function stepAxisBoundText(
  current: string,
  displayed: string | null,
  direction: StepDirection,
): string | null {
  const source = current.trim() === "" ? (displayed ?? "0") : current;
  const base = Number(source);
  if (source.trim() === "" || !Number.isFinite(base)) return null;
  return String(stepToWholeNumber(base, direction));
}

export function stepGridCountText(
  current: string,
  direction: StepDirection,
): string {
  const base = Number(current);
  if (current.trim() === "" || !Number.isFinite(base)) {
    return String(GRID_COUNT_MIN);
  }
  return String(
    Math.min(
      GRID_COUNT_MAX,
      Math.max(GRID_COUNT_MIN, stepToWholeNumber(base, direction)),
    ),
  );
}

function gridValue(
  input: string,
  label: string,
  key: "yGridCount" | "xGridCount",
  errors: SettingsErrors,
): number {
  const value = Number(input);
  if (
    !Number.isInteger(value) ||
    value < GRID_COUNT_MIN ||
    value > GRID_COUNT_MAX
  ) {
    errors[key] = `${label}刻度格数必须是 ${GRID_COUNT_MIN} 至 ${GRID_COUNT_MAX} 的整数`;
  }
  return value;
}

export function validateSettingsDraft(
  axes: Axis[],
  draft: ChartSettingsDraft,
  displayedExtents?: ReadonlyMap<string, AxisExtent | null>,
):
  | { ok: true; value: AppliedChartSettings }
  | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const appliedAxes: Record<string, AxisBounds> = {};

  for (const axis of axes) {
    const currentDraft = draft.axes[axis.id] ?? { min: "", max: "" };
    const axisDraft = displayedExtents
      ? normalizeAxisDraft(
          currentDraft,
          displayedExtents.get(axis.id) ?? null,
        )
      : currentDraft;
    const minMissing = axisDraft.min.trim() === "";
    const maxMissing = axisDraft.max.trim() === "";

    if (minMissing && maxMissing) {
      appliedAxes[axis.id] = {};
      continue;
    }
    if (minMissing) errors[`${axis.id}.min`] = "请同时填写下限和上限";
    if (maxMissing) errors[`${axis.id}.max`] = "请同时填写下限和上限";
    if (minMissing || maxMissing) continue;

    const min = Number(axisDraft.min);
    const max = Number(axisDraft.max);
    if (!Number.isFinite(min)) errors[`${axis.id}.min`] = "请输入有效数字";
    if (!Number.isFinite(max)) errors[`${axis.id}.max`] = "请输入有效数字";
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;

    if (min >= max) {
      errors[`${axis.id}.max`] = "上限必须大于下限";
      continue;
    }
    appliedAxes[axis.id] = { min, max };
  }

  const yGridCount = gridValue(draft.yGridCount, "纵轴", "yGridCount", errors);
  const xGridCount = gridValue(draft.xGridCount, "横轴", "xGridCount", errors);

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { axes: appliedAxes, yGridCount, xGridCount },
  };
}

type Point = { x: number; y: number };
type Size = { width: number; height: number };

export function clampPanelPosition(point: Point, container: Size, panel: Size): Point {
  const maxX = Math.max(0, container.width - panel.width);
  const maxY = Math.max(0, container.height - panel.height);
  return {
    x: Math.min(maxX, Math.max(0, point.x)),
    y: Math.min(maxY, Math.max(0, point.y)),
  };
}
