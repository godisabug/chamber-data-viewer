import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHART_SETTINGS,
  type AppliedChartSettings,
} from "../chartSettings";
import { makeDataset } from "../test/fixtures";
import { ChartSettingsPanel } from "./ChartSettingsPanel";

const resizeObservers: ResizeObserverStub[] = [];

class ResizeObserverStub implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
}

function makeRect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  };
}

type HarnessProps = {
  mode?: "inline" | "window";
  axes?: ReturnType<typeof makeDataset>["axes"];
  applied?: AppliedChartSettings;
  displayedExtents?: ReadonlyMap<string, readonly [number, number] | null>;
  onApply?: (settings: AppliedChartSettings) => void;
  onClose?: () => void;
};

function Harness({
  mode = "inline",
  axes = makeDataset().axes,
  applied = DEFAULT_CHART_SETTINGS,
  displayedExtents = new Map([
    ["primary", [10, 80] as const],
    ["secondary", [40, 100] as const],
  ]),
  onApply = vi.fn(),
  onClose = vi.fn(),
}: HarnessProps) {
  return (
    <ChartSettingsPanel
      mode={mode}
      axes={axes}
      applied={applied}
      displayedExtents={displayedExtents}
      onApply={onApply}
      onClose={onClose}
    />
  );
}

beforeEach(() => {
  resizeObservers.length = 0;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChartSettingsPanel", () => {
  it("steps an automatic bound from the displayed value instead of zero", () => {
    render(<Harness displayedExtents={new Map([["primary", [10.5, 80.5]]])} />);
    const lower = screen.getByLabelText("温度下限");
    const upper = screen.getByLabelText("温度上限");
    expect(lower).toHaveValue(null);
    expect(lower).toHaveAttribute("placeholder", "10.5");

    // 10.5 先落到相邻整数 11，同时把另一端补成当前显示值。
    fireEvent.keyDown(lower, { key: "ArrowUp" });
    expect(lower).toHaveValue(11);
    expect(upper).toHaveValue(80.5);

    fireEvent.keyDown(lower, { key: "ArrowUp" });
    expect(lower).toHaveValue(12);
    fireEvent.keyDown(lower, { key: "ArrowDown" });
    fireEvent.keyDown(lower, { key: "ArrowDown" });
    expect(lower).toHaveValue(10);

    fireEvent.keyDown(upper, { key: "ArrowDown" });
    expect(upper).toHaveValue(80);
  });

  it("offers the same stepping through the stepper buttons", () => {
    render(<Harness />);
    const upper = screen.getByLabelText("湿度上限");
    const increase = screen.getByRole("button", { name: "增加湿度上限" });
    const decrease = screen.getByRole("button", { name: "减少湿度上限" });
    // 步进按钮只服务鼠标，不占用 Tab 顺序；键盘用上下方向键。
    expect(increase).toHaveAttribute("tabindex", "-1");
    expect(decrease).toHaveAttribute("tabindex", "-1");

    fireEvent.click(decrease);
    expect(upper).toHaveValue(99);
    expect(screen.getByLabelText("湿度下限")).toHaveValue(40);

    fireEvent.click(increase);
    fireEvent.click(increase);
    expect(upper).toHaveValue(101);
  });

  it("repeats a held stepper button and stops on release", () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      const lower = screen.getByLabelText("温度下限");
      const increase = screen.getByRole("button", { name: "增加温度下限" });

      fireEvent.pointerDown(increase, { button: 0 });
      expect(lower).toHaveValue(11);

      act(() => vi.advanceTimersByTime(399));
      expect(lower).toHaveValue(11);
      act(() => vi.advanceTimersByTime(1 + 60 * 3));
      expect(lower).toHaveValue(14);

      fireEvent.pointerUp(increase);
      // 真实指针的 click（detail ≥ 1）已在按下时处理，不应再步进一次。
      fireEvent.click(increase, { detail: 1 });
      act(() => vi.advanceTimersByTime(1_000));
      expect(lower).toHaveValue(14);

      fireEvent.pointerDown(increase, { button: 0 });
      fireEvent.pointerLeave(increase);
      act(() => vi.advanceTimersByTime(1_000));
      expect(lower).toHaveValue(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes wheel stepping on a focused field through the same rule", () => {
    render(<Harness />);
    const lower = screen.getByLabelText("温度下限");

    // 未聚焦时滚轮不改值，保持页面滚动。
    fireEvent.wheel(lower, { deltaY: -100 });
    expect(lower).toHaveValue(null);

    lower.focus();
    const wheelUp = new WheelEvent("wheel", {
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      lower.dispatchEvent(wheelUp);
    });
    expect(lower).toHaveValue(11);
    // 阻止浏览器原生的“从 0 起步”步进。
    expect(wheelUp.defaultPrevented).toBe(true);

    fireEvent.wheel(lower, { deltaY: 100 });
    fireEvent.wheel(lower, { deltaY: 100 });
    expect(lower).toHaveValue(9);
  });

  it("keeps grid counts between one and nine while stepping", () => {
    render(<Harness />);
    const yGrid = screen.getByLabelText("纵轴刻度格数");
    expect(yGrid).toHaveValue(6);

    for (let press = 0; press < 5; press += 1) {
      fireEvent.keyDown(yGrid, { key: "ArrowUp" });
    }
    expect(yGrid).toHaveValue(9);

    const decrease = screen.getByRole("button", { name: "减少横轴刻度格数" });
    for (let press = 0; press < 8; press += 1) fireEvent.click(decrease);
    expect(screen.getByLabelText("横轴刻度格数")).toHaveValue(1);
  });

  it("restores the draft to defaults and still leaves applying to the user", () => {
    const onApply = vi.fn();
    render(
      <Harness
        applied={{
          axes: { primary: { min: -40, max: 100 } },
          yGridCount: 4,
          xGridCount: 8,
        }}
        onApply={onApply}
      />,
    );
    const restore = screen.getByRole("button", { name: "恢复默认" });
    expect(restore).toBeEnabled();

    fireEvent.click(restore);

    expect(screen.getByLabelText("温度下限")).toHaveValue(null);
    expect(screen.getByLabelText("温度上限")).toHaveValue(null);
    expect(screen.getByLabelText("纵轴刻度格数")).toHaveValue(6);
    expect(screen.getByLabelText("横轴刻度格数")).toHaveValue(6);
    expect(restore).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onApply).toHaveBeenCalledWith({
      axes: { primary: {}, secondary: {} },
      yGridCount: 6,
      xGridCount: 6,
    });
  });

  it("disables restore while everything is already at its default", () => {
    render(<Harness />);
    const restore = screen.getByRole("button", { name: "恢复默认" });
    expect(restore).toBeDisabled();

    fireEvent.keyDown(screen.getByLabelText("纵轴刻度格数"), {
      key: "ArrowUp",
    });
    expect(restore).toBeEnabled();
  });

  it("renders in window mode in place with a native drag region", () => {
    render(<Harness mode="window" />);
    const panel = screen.getByRole("complementary", { name: "图表设置" });
    const heading = panel.querySelector<HTMLElement>(".settings-heading");
    expect(panel).toHaveClass("chart-settings--window");
    expect(panel.parentElement).not.toBe(document.body);
    expect(heading).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(panel).toHaveStyle({ transform: "translate(0px, 0px)" });
  });

  it("steps axis bounds by whole units and shows every axis without tabs", () => {
    render(<Harness />);
    for (const label of ["温度下限", "温度上限", "湿度下限", "湿度上限"]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("step", "1");
      expect(screen.getByLabelText(label)).toBeVisible();
    }
    expect(screen.queryByRole("group", { name: "选择坐标轴" })).toBeNull();
  });

  it("lists a third axis as another row of the same table", () => {
    const axes = [
      ...makeDataset().axes,
      { id: "pressure", role: "secondary", name: "气压", unit: "kPa" },
    ] as ReturnType<typeof makeDataset>["axes"];
    render(<Harness axes={axes} />);

    const table = screen.getByRole("group", { name: "纵坐标范围" });
    expect(table).toHaveClass("settings-grid");
    expect(within(table).getByText("温度")).toBeVisible();
    expect(within(table).getByText("°C")).toBeVisible();
    expect(within(table).getByText("气压")).toBeVisible();
    expect(within(table).getByLabelText("气压下限")).toBeVisible();
    expect(within(table).getByLabelText("气压上限")).toBeVisible();
    expect(screen.queryByRole("button", { name: "气压 kPa" })).toBeNull();
  });

  it("shows the current automatic range as placeholders", () => {
    render(
      <Harness
        displayedExtents={
          new Map([
            ["primary", [10, 80] as const],
            ["secondary", null],
          ])
        }
      />,
    );

    expect(screen.getByLabelText("温度下限")).toHaveAttribute(
      "placeholder",
      "10",
    );
    expect(screen.getByLabelText("温度上限")).toHaveAttribute(
      "placeholder",
      "80",
    );
    expect(screen.getByLabelText("湿度下限")).toHaveAttribute(
      "placeholder",
      "自动",
    );
    expect(screen.getByLabelText("湿度上限")).toHaveAttribute(
      "placeholder",
      "自动",
    );
    expect(
      screen.getByText("留空即自动，灰色数字为当前显示范围。"),
    ).toBeVisible();
  });

  it("applies when the form is submitted from a field", () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    const upperBound = screen.getByLabelText("湿度上限");

    fireEvent.change(upperBound, { target: { value: "90" } });
    fireEvent.submit(upperBound.closest("form")!);

    expect(onApply).toHaveBeenCalledWith({
      axes: { primary: {}, secondary: { min: 40, max: 90 } },
      yGridCount: 6,
      xGridCount: 6,
    });
  });

  it("freezes the displayed lower bound when only an automatic upper bound is edited", () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.change(screen.getByLabelText("温度上限"), {
      target: { value: "120" },
    });

    expect(screen.getByLabelText("温度下限")).toHaveValue(10);
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onApply).toHaveBeenCalledWith({
      axes: {
        primary: { min: 10, max: 120 },
        secondary: {},
      },
      yGridCount: 6,
      xGridCount: 6,
    });
  });

  it("freezes the secondary displayed upper bound when only its lower bound is edited", () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.change(screen.getByLabelText("湿度下限"), {
      target: { value: "35" },
    });

    expect(screen.getByLabelText("湿度上限")).toHaveValue(100);
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: {
          primary: {},
          secondary: { min: 35, max: 100 },
        },
      }),
    );
  });

  it("returns a manual axis to automatic after both endpoints are deleted", () => {
    const onApply = vi.fn();
    render(
      <Harness
        applied={{
          ...DEFAULT_CHART_SETTINGS,
          axes: { primary: { min: 10, max: 120 } },
        }}
        onApply={onApply}
      />,
    );

    fireEvent.change(screen.getByLabelText("温度下限"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("温度上限"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ axes: { primary: {}, secondary: {} } }),
    );
  });

  it("restores a single deleted manual endpoint when applying", () => {
    const onApply = vi.fn();
    render(
      <Harness
        applied={{
          ...DEFAULT_CHART_SETTINGS,
          axes: { primary: { min: 10, max: 120 } },
        }}
        displayedExtents={
          new Map([
            ["primary", [10, 120] as const],
            ["secondary", [40, 100] as const],
          ])
        }
        onApply={onApply}
      />,
    );

    fireEvent.change(screen.getByLabelText("温度上限"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        axes: { primary: { min: 10, max: 120 }, secondary: {} },
      }),
    );
  });

  it("keeps drafts for both axes and applies all settings atomically", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<Harness onApply={onApply} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText("温度下限"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("温度上限"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("湿度下限"), {
      target: { value: "40" },
    });
    fireEvent.change(screen.getByLabelText("湿度上限"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      axes: {
        primary: { min: 20, max: 30 },
        secondary: { min: 40, max: 100 },
      },
      yGridCount: 6,
      xGridCount: 6,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels without applying and has no separate settings reset", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <Harness
        applied={{
          axes: { primary: { min: 10, max: 50 } },
          yGridCount: 4,
          xGridCount: 7,
        }}
        onApply={onApply}
        onClose={onClose}
      />,
    );
    expect(screen.queryByRole("button", { name: "重置设置" })).toBeNull();

    fireEvent.change(screen.getByLabelText("温度下限"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByLabelText("温度下限")).toHaveValue(10);
  });

  it("syncs the draft to defaults when the applied settings change externally", () => {
    const view = render(
      <Harness
        applied={{
          axes: { primary: { min: 20, max: 30 } },
          yGridCount: 4,
          xGridCount: 7,
        }}
      />,
    );
    expect(screen.getByLabelText("温度下限")).toHaveValue(20);
    expect(screen.getByLabelText("纵轴刻度格数")).toHaveValue(4);
    expect(screen.getByLabelText("横轴刻度格数")).toHaveValue(7);

    view.rerender(<Harness applied={DEFAULT_CHART_SETTINGS} />);

    expect(screen.getByLabelText("温度下限")).toHaveValue(null);
    expect(screen.getByLabelText("温度上限")).toHaveValue(null);
    expect(screen.getByLabelText("纵轴刻度格数")).toHaveValue(6);
    expect(screen.getByLabelText("横轴刻度格数")).toHaveValue(6);
  });

  it("closes on Escape and restores the applied draft", () => {
    const onClose = vi.fn();
    render(
      <Harness
        applied={{
          axes: { primary: { min: 10, max: 50 } },
          yGridCount: 4,
          xGridCount: 7,
        }}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText("温度下限"), {
      target: { value: "20" },
    });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("温度下限")).toHaveValue(10);
  });

  it("closes on an outside pointer down without applying", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<Harness onApply={onApply} onClose={onClose} />);

    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("shows the missing paired bound when an empty axis has no displayed extent", () => {
    const onApply = vi.fn();
    render(
      <Harness
        displayedExtents={
          new Map([
            ["primary", null],
            ["secondary", null],
          ])
        }
        onApply={onApply}
      />,
    );

    fireEvent.change(screen.getByLabelText("温度下限"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    const upperBound = screen.getByLabelText("温度上限");
    const error = screen.getByText("请同时填写下限和上限");
    expect(upperBound).toHaveAttribute("aria-invalid", "true");
    expect(upperBound).toHaveAttribute("aria-describedby", error.id);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("clears both errors for an axis as soon as either bound changes", () => {
    render(<Harness />);

    const lowerBound = screen.getByLabelText("温度下限");
    const upperBound = screen.getByLabelText("温度上限");
    fireEvent.change(lowerBound, { target: { value: "20" } });
    fireEvent.change(upperBound, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(lowerBound).toHaveAttribute("aria-invalid", "false");
    expect(upperBound).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("上限必须大于下限")).toBeVisible();

    fireEvent.change(lowerBound, { target: { value: "5" } });

    expect(lowerBound).toHaveAttribute("aria-invalid", "false");
    expect(upperBound).toHaveAttribute("aria-invalid", "false");
    expect(lowerBound).not.toHaveAttribute("aria-describedby");
    expect(upperBound).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText("上限必须大于下限")).not.toBeInTheDocument();
  });

  it("keeps the panel inside the window while dragging, re-clamps on resize, and disconnects", () => {
    const viewport = { width: 1000, height: 700 };
    const panelSize = { width: 200, height: 300 };
    vi.spyOn(window, "innerWidth", "get").mockImplementation(
      () => viewport.width,
    );
    vi.spyOn(window, "innerHeight", "get").mockImplementation(
      () => viewport.height,
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const isPanel = this.classList.contains("chart-settings");
        return makeRect(
          isPanel ? panelSize.width : 0,
          isPanel ? panelSize.height : 0,
        );
      },
    );
    const view = render(<Harness />);
    const panel = screen.getByRole("complementary", { name: "图表设置" });
    const heading = panel.querySelector<HTMLElement>(".settings-heading");
    expect(heading).not.toBeNull();
    expect(panel.parentElement).toBe(document.body);

    fireEvent.pointerDown(heading!, {
      button: 0,
      buttons: 1,
      clientX: 380,
      clientY: 0,
    });
    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 0,
      clientY: 100,
    });
    fireEvent.pointerUp(document);
    expect(panel).toHaveStyle({ transform: "translate(400px, 100px)" });

    expect(resizeObservers.length).toBeGreaterThan(0);
    const observedTargets = resizeObservers.flatMap((observer) =>
      observer.observe.mock.calls.map(([target]) => target),
    );
    expect(observedTargets).toEqual(expect.arrayContaining([panel]));

    viewport.width = 350;
    viewport.height = 200;
    act(() => {
      for (const observer of resizeObservers) {
        observer.callback([], observer);
      }
    });

    expect(panel).toHaveStyle({ transform: "translate(150px, 0px)" });
    view.unmount();
    for (const observer of resizeObservers) {
      expect(observer.disconnect).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["window blur", () => fireEvent(window, new Event("blur"))],
    [
      "a pointer move with no pressed buttons",
      () =>
        fireEvent.pointerMove(document, {
          clientX: 40,
          clientY: 40,
          buttons: 0,
        }),
    ],
  ])("stops dragging after %s", (_reason, stopDrag) => {
    render(<Harness />);
    const panel = screen.getByRole("complementary", { name: "图表设置" });
    const heading = panel.querySelector<HTMLElement>(".settings-heading");
    expect(heading).not.toBeNull();
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      makeRect(200, 200),
    );

    fireEvent.pointerDown(heading!, {
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
    });
    stopDrag();
    const stoppedTransform = panel.style.transform;

    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 110,
      clientY: 90,
    });

    expect(panel.style.transform).toBe(stoppedTransform);
  });

  it("uses distinct described-by targets for errors in multiple panels", () => {
    render(
      <>
        <Harness />
        <Harness />
      </>,
    );

    const lowerBounds = screen.getAllByLabelText("温度下限");
    const upperBounds = screen.getAllByLabelText("温度上限");
    const applyButtons = screen.getAllByRole("button", { name: "应用" });
    for (let index = 0; index < upperBounds.length; index += 1) {
      fireEvent.change(lowerBounds[index], { target: { value: "20" } });
      fireEvent.change(upperBounds[index], { target: { value: "10" } });
      fireEvent.click(applyButtons[index]);
    }

    const firstErrorId = upperBounds[0].getAttribute("aria-describedby");
    const secondErrorId = upperBounds[1].getAttribute("aria-describedby");
    expect(firstErrorId).toBeTruthy();
    expect(secondErrorId).toBeTruthy();
    expect(firstErrorId).not.toBe(secondErrorId);
  });
});
