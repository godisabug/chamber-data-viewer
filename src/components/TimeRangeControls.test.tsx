import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimeRangeControls } from "./TimeRangeControls";

const bounds = {
  start: Date.parse("2026-01-01T00:00:00"),
  end: Date.parse("2026-01-02T00:00:00"),
};

describe("TimeRangeControls", () => {
  it("groups apply with the end input and exposes the cursor as a toggle button", () => {
    const onToggleCursor = vi.fn();
    render(
      <TimeRangeControls
        bounds={bounds}
        value={bounds}
        settingsOpen={false}
        cursorVisible
        onApply={vi.fn()}
        onReset={vi.fn()}
        onToggleCursor={onToggleCursor}
        onToggleSettings={vi.fn()}
      />,
    );

    const apply = screen.getByRole("button", { name: "应用范围" });
    const inputGroup = apply.closest(".range-input-group");
    expect(inputGroup).not.toBeNull();
    expect(inputGroup).toContainElement(screen.getByLabelText("截止时间"));
    expect(inputGroup).not.toContainElement(
      screen.getByRole("button", { name: "重置视图" }),
    );
    expect(apply).toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "重置视图" })).toHaveClass(
      "tertiary-button",
    );
    const settings = screen.getByRole("button", { name: "图表设置" });
    expect(settings).toHaveClass("tertiary-button", "chart-settings-toggle");
    expect(settings).not.toHaveClass("secondary-button");
    expect(
      screen.getByRole("button", { name: "图表操作速查（F1）" }),
    ).toHaveClass("chart-help-trigger");

    expect(screen.queryByRole("switch")).toBeNull();
    const cursor = screen.getByRole("button", { name: "游标", pressed: true });
    expect(cursor).toHaveClass("tertiary-button");
    expect(cursor).toHaveAttribute("data-tip", "隐藏游标和读数");
    fireEvent.click(cursor);
    expect(onToggleCursor).toHaveBeenCalledOnce();
  });

  it("shows the hidden cursor as an unpressed toggle", () => {
    render(
      <TimeRangeControls
        bounds={bounds}
        value={bounds}
        settingsOpen={false}
        cursorVisible={false}
        onApply={vi.fn()}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );

    const cursor = screen.getByRole("button", { name: "游标", pressed: false });
    expect(cursor).toHaveAttribute("data-tip", "显示游标和读数");
  });

  it("presents the four chart tools as one row of icon-only buttons", () => {
    render(
      <TimeRangeControls
        bounds={bounds}
        value={bounds}
        settingsOpen={false}
        onApply={vi.fn()}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );

    const tools = document.querySelector(".control-actions") as HTMLElement;
    const buttons = within(tools).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "游标",
      "重置视图",
      "图表设置",
      "图表操作速查（F1）",
    ]);
    for (const button of buttons) {
      // 同一形制：只有图标，名称放在悬停提示与朗读文本里。
      expect(button).toHaveClass("tertiary-button", "tool-button");
      expect(button).toHaveTextContent("");
      expect(button.querySelectorAll("svg.ui-icon")).toHaveLength(1);
      // 名称用自绘提示，不再用出现得慢的系统提示。
      expect(button).toHaveAttribute("data-tip");
      expect(button).not.toHaveAttribute("title");
      expect(button.querySelector("svg")).toHaveAttribute("width", "18");
    }
    const resetView = screen.getByRole("button", { name: "重置视图" });
    expect(resetView).toHaveAttribute(
      "data-tip",
      "重置视图：时间范围与纵轴回到默认",
    );
    expect(resetView.querySelector("svg")).toHaveClass("lucide-maximize");
    expect(screen.getByRole("button", { name: "图表设置" })).toHaveAttribute(
      "data-tip",
      "图表设置",
    );
  });

  it("shows the fixed axis-style time format with whole seconds", () => {
    const subsecondBounds = {
      start: Date.parse("2026-01-01T00:10:00.500"),
      end: Date.parse("2026-01-02T00:20:00.005"),
    };
    render(
      <TimeRangeControls
        bounds={subsecondBounds}
        value={subsecondBounds}
        settingsOpen={false}
        onApply={vi.fn()}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );

    const startInput = screen.getByLabelText("开始时间");
    const endInput = screen.getByLabelText("截止时间");
    expect(startInput).toHaveValue("2026-01-01 00:10:00");
    expect(endInput).toHaveValue("2026-01-02 00:20:00");
    expect(startInput).not.toHaveAttribute("min");
    expect(startInput).not.toHaveAttribute("max");
    expect(endInput).not.toHaveAttribute("min");
    expect(endInput).not.toHaveAttribute("max");
    // 不再使用随系统区域变化、自带“清除”的原生日期时间控件。
    expect(startInput).toHaveAttribute("type", "text");
    expect(endInput).toHaveAttribute("placeholder", "年-月-日 时:分:秒");
  });

  it("applies a draft whose times lie outside the data bounds", () => {
    const onApply = vi.fn();
    render(
      <TimeRangeControls
        bounds={bounds}
        value={bounds}
        settingsOpen={false}
        onApply={onApply}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2025-12-31T23:59:59" },
    });
    fireEvent.change(screen.getByLabelText("截止时间"), {
      target: { value: "2026-01-03T00:00:01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用范围" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      start: Date.parse("2025-12-31T23:59:59"),
      end: Date.parse("2026-01-03T00:00:01"),
    });
    expect(screen.getByLabelText("开始时间")).not.toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("marks a visible range shorter than one minute as invalid", () => {
    const onApply = vi.fn();
    render(
      <TimeRangeControls
        bounds={bounds}
        value={bounds}
        settingsOpen={false}
        onApply={onApply}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("截止时间"), {
      target: { value: "2026-01-01T00:00:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用范围" }));

    expect(screen.getByLabelText("截止时间")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByText("可见时间范围不能短于 1 分钟")).toBeVisible();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("shows the error in the field's label row and restores the label on edit", () => {
    render(
      <TimeRangeControls
        bounds={bounds}
        value={bounds}
        settingsOpen={false}
        onApply={vi.fn()}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );
    const startInput = screen.getByLabelText("开始时间");
    const startField = startInput.closest(".range-field") as HTMLElement;
    const endField = screen
      .getByLabelText("截止时间")
      .closest(".range-field") as HTMLElement;
    expect(startField).not.toHaveClass("is-invalid");

    fireEvent.change(startInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "应用范围" }));

    expect(startField).toHaveClass("is-invalid");
    expect(endField).not.toHaveClass("is-invalid");
    expect(within(startField).getByRole("alert")).toHaveTextContent(
      "请输入开始时间",
    );
    expect(startInput.closest(".time-field")).toHaveAttribute("data-invalid");
    // 字段名仍在，朗读与点击标签聚焦不受影响。
    expect(screen.getByLabelText("开始时间")).toBe(startInput);

    fireEvent.change(startInput, { target: { value: "2026-01-01 00:00:00" } });
    expect(startField).not.toHaveClass("is-invalid");
    expect(within(startField).queryByRole("alert")).toBeNull();
    expect(startInput.closest(".time-field")).not.toHaveAttribute(
      "data-invalid",
    );
  });

  it("tells a nonexistent date apart from an unreadable one", () => {
    render(
      <TimeRangeControls
        bounds={bounds}
        value={bounds}
        settingsOpen={false}
        onApply={vi.fn()}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2026-02-30 00:00:00" },
    });
    fireEvent.change(screen.getByLabelText("截止时间"), {
      target: { value: "明天" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用范围" }));

    expect(screen.getByText("日期或时间不存在")).toBeVisible();
    expect(screen.getByText("截止时间格式无效")).toBeVisible();
  });

  it("uses distinct described-by targets for errors in multiple instances", () => {
    render(
      <>
        <TimeRangeControls
          bounds={bounds}
          value={bounds}
          settingsOpen={false}
          onApply={vi.fn()}
          onReset={vi.fn()}
          onToggleSettings={vi.fn()}
        />
        <TimeRangeControls
          bounds={bounds}
          value={bounds}
          settingsOpen={false}
          onApply={vi.fn()}
          onReset={vi.fn()}
          onToggleSettings={vi.fn()}
        />
      </>,
    );

    const endInputs = screen.getAllByLabelText("截止时间");
    const applyButtons = screen.getAllByRole("button", { name: "应用范围" });
    fireEvent.change(endInputs[0], {
      target: { value: "2026-01-01T00:00:30" },
    });
    fireEvent.change(endInputs[1], { target: { value: "" } });
    fireEvent.click(applyButtons[0]);
    fireEvent.click(applyButtons[1]);

    const firstErrorId = endInputs[0].getAttribute("aria-describedby");
    const secondErrorId = endInputs[1].getAttribute("aria-describedby");
    expect(firstErrorId).toBeTruthy();
    expect(secondErrorId).toBeTruthy();
    expect(firstErrorId).not.toBe(secondErrorId);
    expect(document.getElementById(firstErrorId!)?.textContent).toBe(
      "可见时间范围不能短于 1 分钟",
    );
    expect(document.getElementById(secondErrorId!)?.textContent).toBe(
      "请输入截止时间",
    );
  });

  it.each([
    ["开始时间", "2026-01-01T00:00:01"],
    ["截止时间", "2026-01-01T00:02:00"],
  ])(
    "clears validation errors immediately when %s changes",
    (label, nextValue) => {
      render(
        <TimeRangeControls
          bounds={bounds}
          value={bounds}
          settingsOpen={false}
          onApply={vi.fn()}
          onReset={vi.fn()}
          onToggleSettings={vi.fn()}
        />,
      );

      const endInput = screen.getByLabelText("截止时间");
      fireEvent.change(endInput, {
        target: { value: "2026-01-01T00:00:30" },
      });
      fireEvent.click(screen.getByRole("button", { name: "应用范围" }));
      expect(endInput).toHaveAttribute("aria-invalid", "true");

      fireEvent.change(screen.getByLabelText(label), {
        target: { value: nextValue },
      });

      expect(endInput).toHaveAttribute("aria-invalid", "false");
      expect(
        screen.queryByText("可见时间范围不能短于 1 分钟"),
      ).not.toBeInTheDocument();
    },
  );

  it("resets draft and errors when only bounds change", () => {
    const props = {
      value: bounds,
      settingsOpen: false,
      onApply: vi.fn(),
      onReset: vi.fn(),
      onToggleSettings: vi.fn(),
    };
    const view = render(<TimeRangeControls {...props} bounds={bounds} />);

    const endInput = screen.getByLabelText("截止时间");
    fireEvent.change(endInput, {
      target: { value: "2026-01-01T00:00:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用范围" }));
    expect(endInput).toHaveAttribute("aria-invalid", "true");

    view.rerender(
      <TimeRangeControls
        {...props}
        bounds={{ start: bounds.start - 60_000, end: bounds.end + 60_000 }}
      />,
    );

    expect(screen.getByLabelText("开始时间")).toHaveValue(
      "2026-01-01 00:00:00",
    );
    expect(endInput).toHaveValue("2026-01-02 00:00:00");
    expect(endInput).toHaveAttribute("aria-invalid", "false");
    expect(
      screen.queryByText("可见时间范围不能短于 1 分钟"),
    ).not.toBeInTheDocument();
  });

  it("applies a valid draft as a numeric range", () => {
    const onApply = vi.fn();
    render(
      <TimeRangeControls
        bounds={bounds}
        value={bounds}
        settingsOpen={false}
        onApply={onApply}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("开始时间"), {
      target: { value: "2026-01-01T06:00:00" },
    });
    fireEvent.change(screen.getByLabelText("截止时间"), {
      target: { value: "2026-01-01T07:00:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用范围" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      start: Date.parse("2026-01-01T06:00:00"),
      end: Date.parse("2026-01-01T07:00:00"),
    });
  });

  it("applies with Enter and writes loosely typed times back in the fixed format", () => {
    const onApply = vi.fn();
    render(
      <TimeRangeControls
        bounds={bounds}
        value={bounds}
        settingsOpen={false}
        onApply={onApply}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );
    const startInput = screen.getByLabelText("开始时间");
    const endInput = screen.getByLabelText("截止时间");

    // 从表格里抄来的写法：斜杠分隔、不补零、省略秒。
    fireEvent.change(startInput, { target: { value: "2026/1/1 6:05" } });
    fireEvent.change(endInput, { target: { value: "2026/1/1 18:30:15" } });
    fireEvent.keyDown(endInput, { key: "Enter" });

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      start: Date.parse("2026-01-01T06:05:00"),
      end: Date.parse("2026-01-01T18:30:15"),
    });
    expect(startInput).toHaveValue("2026-01-01 06:05:00");
    expect(endInput).toHaveValue("2026-01-01 18:30:15");
  });

  it("restores one end to its default time and applies at once", () => {
    const onApply = vi.fn();
    const onReset = vi.fn();
    render(
      <TimeRangeControls
        bounds={bounds}
        value={{ start: bounds.start + 3_600_000, end: bounds.end - 3_600_000 }}
        settingsOpen={false}
        onApply={onApply}
        onReset={onReset}
        onToggleSettings={vi.fn()}
      />,
    );
    const startInput = screen.getByLabelText("开始时间");
    const endInput = screen.getByLabelText("截止时间");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认开始时间" }));

    expect(startInput).toHaveValue("2026-01-01 00:00:00");
    expect(endInput).toHaveValue("2026-01-01 23:00:00");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      start: bounds.start,
      end: bounds.end - 3_600_000,
    });
    // 只恢复这一端的时间，与“重置视图”无关。
    expect(onReset).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "恢复默认开始时间" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "恢复默认截止时间" }),
    ).toBeInTheDocument();
  });

  it("only restores the draft when the other end cannot be applied", () => {
    const onApply = vi.fn();
    render(
      <TimeRangeControls
        bounds={bounds}
        value={{ start: bounds.start + 3_600_000, end: bounds.end }}
        settingsOpen={false}
        onApply={onApply}
        onReset={vi.fn()}
        onToggleSettings={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("截止时间"), {
      target: { value: "写了一半" },
    });

    fireEvent.click(screen.getByRole("button", { name: "恢复默认开始时间" }));

    expect(screen.getByLabelText("开始时间")).toHaveValue(
      "2026-01-01 00:00:00",
    );
    expect(screen.getByLabelText("截止时间")).toHaveValue("写了一半");
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("resets the draft and notifies the parent to restore defaults", () => {
    const onApply = vi.fn();
    const onReset = vi.fn();
    render(
      <TimeRangeControls
        bounds={bounds}
        value={{ start: bounds.start + 60_000, end: bounds.end }}
        settingsOpen
        onApply={onApply}
        onReset={onReset}
        onToggleSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重置视图" }));

    expect(screen.getByLabelText("开始时间")).toHaveValue(
      "2026-01-01 00:00:00",
    );
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledWith();
    expect(onApply).not.toHaveBeenCalled();
  });
});
