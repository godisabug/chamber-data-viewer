import type { Axis, Series } from "./types";

export type TooltipRow = {
  id: string;
  axisId: string;
  name: string;
  unit: string;
  value: number | null;
  format: ((value: number) => string) | null;
  color: string;
  /** Drives the line sample: measured solid, setpoint dashed, as in the legend. */
  role: Series["role"];
};

export type TooltipGroup = {
  axisId: string;
  rows: TooltipRow[];
};

export const UNMATCHED_AXIS_ID = "__unmatched";

export function groupTooltipRows(
  rows: readonly TooltipRow[],
  axes: readonly Axis[],
): TooltipGroup[] {
  const knownAxisIds = new Set(axes.map((axis) => axis.id));
  const groups: TooltipGroup[] = [];
  for (const axis of axes) {
    const axisRows = rows.filter((row) => row.axisId === axis.id);
    if (axisRows.length > 0) {
      groups.push({ axisId: axis.id, rows: axisRows });
    }
  }
  const unmatchedRows = rows.filter((row) => !knownAxisIds.has(row.axisId));
  if (unmatchedRows.length > 0) {
    groups.push({ axisId: UNMATCHED_AXIS_ID, rows: unmatchedRows });
  }
  return groups;
}
