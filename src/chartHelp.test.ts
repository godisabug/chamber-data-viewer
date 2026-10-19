import { describe, expect, it } from "vitest";
import { CHART_HELP_SECTIONS } from "./chartHelp";

describe("chart help content", () => {
  it("keeps the confirmed three groups and eleven actions in one typed source", () => {
    expect(CHART_HELP_SECTIONS.map((section) => section.title)).toEqual([
      "查看与横轴",
      "纵轴与锁定",
      "曲线与图像",
    ]);
    expect(
      CHART_HELP_SECTIONS.flatMap((section) => section.actions),
    ).toHaveLength(11);
  });

  it("uses the confirmed concise action results", () => {
    const actions = CHART_HELP_SECTIONS.flatMap((section) => section.actions);
    expect(actions.map((action) => action.result)).toEqual([
      "查看时间与曲线读数",
      "缩放时间轴",
      "平移时间轴",
      "锁定或解除对应纵轴",
      "缩放纵轴",
      "平移纵轴",
      "解除纵轴锁定",
      "显示或隐藏整组曲线",
      "显示或隐藏单条曲线",
      "突出对应曲线",
      "保存或复制图像",
    ]);
  });

  it("pairs every action with a short caption and a pictured gesture", () => {
    const actions = CHART_HELP_SECTIONS.flatMap((section) => section.actions);
    expect(actions.map((action) => action.visual.caption)).toEqual([
      "查看读数",
      "缩放时间轴",
      "平移时间轴",
      "锁定 / 解锁纵轴",
      "缩放纵轴",
      "平移纵轴",
      "解除锁定",
      "显隐整组曲线",
      "显隐单条曲线",
      "突出该曲线",
      "保存 / 复制图像",
    ]);
    for (const action of actions) {
      expect(Boolean(action.visual.mouse) || Boolean(action.visual.keys)).toBe(
        true,
      );
    }
  });
});
