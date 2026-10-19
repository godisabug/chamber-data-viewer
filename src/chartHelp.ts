export type ChartHelpGesturePart = Readonly<{
  kind: "key" | "text";
  value: string;
}>;

export type ChartHelpMouse =
  "hover" | "scroll" | "middle-drag" | "left" | "right";

/** 速查里一格的图示：标题、按键与鼠标动作、作用位置。 */
export type ChartHelpVisual = Readonly<{
  keys?: readonly string[];
  mouse?: ChartHelpMouse;
  /** 图示下的一句话结果，比 result 更短。 */
  caption: string;
  /** 动作作用在哪里；作用于整个图表时省略。 */
  where?: string;
}>;

export type ChartHelpAction = Readonly<{
  id: string;
  gesture: readonly ChartHelpGesturePart[];
  result: string;
  visual: ChartHelpVisual;
}>;

export type ChartHelpSection = Readonly<{
  id: string;
  title: string;
  actions: readonly ChartHelpAction[];
}>;

const text = (value: string): ChartHelpGesturePart => ({
  kind: "text",
  value,
});

const key = (value: string): ChartHelpGesturePart => ({
  kind: "key",
  value,
});

export const CHART_HELP_SECTIONS: readonly ChartHelpSection[] = [
  {
    id: "view-and-time-axis",
    title: "查看与横轴",
    actions: [
      {
        id: "inspect-values",
        gesture: [text("悬停图表")],
        result: "查看时间与曲线读数",
        visual: { caption: "查看读数", mouse: "hover" },
      },
      {
        id: "zoom-time-axis",
        gesture: [text("滚轮")],
        result: "缩放时间轴",
        visual: { caption: "缩放时间轴", mouse: "scroll" },
      },
      {
        id: "pan-time-axis",
        gesture: [text("中键拖动")],
        result: "平移时间轴",
        visual: {
          caption: "平移时间轴",
          mouse: "middle-drag",
        },
      },
    ],
  },
  {
    id: "value-axis-and-locking",
    title: "纵轴与锁定",
    actions: [
      {
        id: "toggle-axis-lock",
        gesture: [key("Shift"), text(" + 左键单击曲线或图例组名")],
        result: "锁定或解除对应纵轴",
        visual: {
          caption: "锁定 / 解锁纵轴",
          keys: ["Shift"],
          mouse: "left",
          where: "曲线或图例名",
        },
      },
      {
        id: "zoom-value-axis",
        gesture: [key("Shift"), text(" + 滚轮")],
        result: "缩放纵轴",
        visual: {
          caption: "缩放纵轴",
          keys: ["Shift"],
          mouse: "scroll",
        },
      },
      {
        id: "pan-value-axis",
        gesture: [key("Shift"), text(" + 中键拖动")],
        result: "平移纵轴",
        visual: {
          caption: "平移纵轴",
          keys: ["Shift"],
          mouse: "middle-drag",
        },
      },
      {
        id: "clear-axis-locks",
        gesture: [key("Esc")],
        result: "解除纵轴锁定",
        visual: { caption: "解除锁定", keys: ["Esc"] },
      },
    ],
  },
  {
    id: "curves-and-images",
    title: "曲线与图像",
    actions: [
      {
        id: "toggle-curve-group",
        gesture: [text("左键单击图例组名")],
        result: "显示或隐藏整组曲线",
        visual: {
          caption: "显隐整组曲线",
          mouse: "left",
          where: "图例名",
        },
      },
      {
        id: "toggle-curve",
        gesture: [text("左键单击图例色条")],
        result: "显示或隐藏单条曲线",
        visual: {
          caption: "显隐单条曲线",
          mouse: "left",
          where: "图例线样",
        },
      },
      {
        id: "preview-curve",
        gesture: [text("悬停图例色条")],
        result: "突出对应曲线",
        visual: {
          caption: "突出该曲线",
          mouse: "hover",
          where: "图例线样",
        },
      },
      {
        id: "export-image",
        gesture: [text("右键单击图表")],
        result: "保存或复制图像",
        visual: { caption: "保存 / 复制图像", mouse: "right" },
      },
    ],
  },
] as const;
