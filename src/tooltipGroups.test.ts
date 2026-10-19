import { describe, expect, it } from "vitest";
import type { Axis } from "./types";
import { groupTooltipRows, type TooltipRow } from "./tooltipGroups";

function row(id: string, axisId: string): TooltipRow {
  return {
    id,
    axisId,
    name: id,
    unit: "",
    value: 1,
    format: null,
    color: "#000000",
    role: "measured",
  };
}

const axes: Axis[] = [
  { id: "primary", role: "primary", name: "温度", unit: "degC" },
  { id: "secondary", role: "secondary", name: "湿度", unit: "%RH" },
  { id: "pressure", role: "secondary", name: "气压", unit: "kPa" },
];

describe("groupTooltipRows", () => {
  it("groups rows by axis in dataset axis order and keeps within-group order", () => {
    const groups = groupTooltipRows(
      [
        row("set-humidity", "secondary"),
        row("actual-temp", "primary"),
        row("set-temp", "primary"),
        row("actual-humidity", "secondary"),
      ],
      axes,
    );
    expect(groups.map((group) => group.axisId)).toEqual([
      "primary",
      "secondary",
    ]);
    expect(groups[0].rows.map((item) => item.id)).toEqual([
      "actual-temp",
      "set-temp",
    ]);
    expect(groups[1].rows.map((item) => item.id)).toEqual([
      "set-humidity",
      "actual-humidity",
    ]);
  });

  it("skips axes without visible rows", () => {
    const groups = groupTooltipRows(
      [row("actual-temp", "primary"), row("set-temp", "primary")],
      axes,
    );
    expect(groups.map((group) => group.axisId)).toEqual(["primary"]);
  });

  it("appends rows with unknown axes as one trailing group", () => {
    const groups = groupTooltipRows(
      [
        row("actual-temp", "primary"),
        row("extra-1", "unknown-axis"),
        row("extra-2", "unknown-axis"),
      ],
      axes,
    );
    expect(groups.map((group) => group.axisId)).toEqual([
      "primary",
      "__unmatched",
    ]);
    expect(groups[1].rows.map((item) => item.id)).toEqual([
      "extra-1",
      "extra-2",
    ]);
  });

  it("returns no groups for empty rows", () => {
    expect(groupTooltipRows([], axes)).toEqual([]);
  });
});
