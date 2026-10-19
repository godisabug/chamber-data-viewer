import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateTimeField } from "./DateTimeField";

const DEFAULT_TIME = Date.parse("2026-04-30T11:14:27");

type HarnessProps = {
  initial?: string;
  onCommit?: () => void;
  onRestoreDefault?: () => void;
};

function Harness({
  initial = "2026-05-02 07:57:49",
  onCommit = () => {},
  onRestoreDefault = () => {},
}: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="start-time">开始时间</label>
      <DateTimeField
        id="start-time"
        label="开始时间"
        value={value}
        defaultTime={DEFAULT_TIME}
        invalid={false}
        onChange={setValue}
        onCommit={onCommit}
        onRestoreDefault={onRestoreDefault}
      />
      <button type="button">外部按钮</button>
    </>
  );
}

const field = () => screen.getByLabelText("开始时间") as HTMLInputElement;

const selected = () => {
  const input = field();
  return input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
};

/** 模拟一次单击：浏览器先把光标放到点击位置，再派发 click。 */
function clickAt(position: number) {
  const input = field();
  input.focus();
  input.setSelectionRange(position, position);
  fireEvent.click(input, { detail: 1 });
}

/** 返回 false 表示组件拦下了这个按键（preventDefault）。 */
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(field(), { key, ...init });

function type(keys: string) {
  for (const key of keys) press(key);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DateTimeField segments", () => {
  it("selects the segment under a click", () => {
    render(<Harness />);

    clickAt(1);
    expect(selected()).toBe("2026");
    clickAt(6);
    expect(selected()).toBe("05");
    // 点在分隔符两侧分别归属前一段的末尾、后一段的开头。
    clickAt(7);
    expect(selected()).toBe("05");
    clickAt(8);
    expect(selected()).toBe("02");
    clickAt(12);
    expect(selected()).toBe("07");
    clickAt(19);
    expect(selected()).toBe("49");
  });

  it("types into a segment and moves on once it is complete", () => {
    render(<Harness />);
    clickAt(6);

    type("6");
    expect(field()).toHaveValue("2026-06-02 07:57:49");
    expect(selected()).toBe("02");

    type("1");
    expect(field()).toHaveValue("2026-06-01 07:57:49");
    expect(selected()).toBe("01");
    type("5");
    expect(field()).toHaveValue("2026-06-15 07:57:49");
    expect(selected()).toBe("07");

    type("083000");
    expect(field()).toHaveValue("2026-06-15 08:30:00");
    // 最后一段写完后停在原处。
    expect(selected()).toBe("00");
  });

  it("accepts a whole timestamp typed character by character with its separators", () => {
    render(<Harness />);
    clickAt(0);

    type("2027-03-09 10:20:30");

    expect(field()).toHaveValue("2027-03-09 10:20:30");
    expect(selected()).toBe("30");
  });

  it("uses a separator to finish a half-typed segment, without skipping ahead", () => {
    render(<Harness />);
    clickAt(6);

    type("1");
    expect(selected()).toBe("01");
    expect(press("-")).toBe(false);
    expect(field()).toHaveValue("2026-01-02 07:57:49");
    expect(selected()).toBe("02");

    // 这一段还没开始键入时，分隔符不产生任何效果。
    expect(press("-")).toBe(false);
    expect(selected()).toBe("02");
    expect(field()).toHaveValue("2026-01-02 07:57:49");
  });

  it("steps the active segment with the up and down arrows", () => {
    render(<Harness />);
    clickAt(15);

    press("ArrowUp");
    expect(field()).toHaveValue("2026-05-02 07:58:49");
    expect(selected()).toBe("58");

    clickAt(12);
    press("ArrowDown");
    press("ArrowDown");
    expect(field()).toHaveValue("2026-05-02 05:58:49");
    expect(selected()).toBe("05");

    // 时间连续：23 时再加一小时进到次日。
    clickAt(12);
    type("23");
    clickAt(12);
    press("ArrowUp");
    expect(field()).toHaveValue("2026-05-03 00:58:49");
  });

  it("moves between segments with the left and right arrows", () => {
    render(<Harness />);
    clickAt(9);
    expect(selected()).toBe("02");

    expect(press("ArrowRight")).toBe(false);
    expect(selected()).toBe("07");
    press("ArrowRight");
    press("ArrowRight");
    press("ArrowRight");
    expect(selected()).toBe("49");

    for (let step = 0; step < 8; step += 1) press("ArrowLeft");
    expect(selected()).toBe("2026");
  });

  it("enters segment navigation from a full selection", () => {
    render(<Harness />);
    const input = field();
    input.focus();

    input.setSelectionRange(0, input.value.length);
    press("ArrowRight");
    expect(selected()).toBe("49");

    input.setSelectionRange(0, input.value.length);
    press("ArrowLeft");
    expect(selected()).toBe("2026");
  });

  it("leaves plain caret movement, extending selections and shortcuts to the browser", () => {
    render(<Harness />);
    const input = field();
    input.focus();

    input.setSelectionRange(6, 6);
    expect(press("ArrowLeft")).toBe(true);
    expect(press("ArrowRight")).toBe(true);

    input.setSelectionRange(5, 7);
    expect(press("ArrowRight", { shiftKey: true })).toBe(true);
    expect(press("a", { ctrlKey: true })).toBe(true);
    expect(press("c", { ctrlKey: true })).toBe(true);
    expect(press("Backspace")).toBe(true);
    expect(press("Tab")).toBe(true);

    // 全选后键入数字是整体替换，不属于分段编辑。
    input.setSelectionRange(0, input.value.length);
    expect(press("2")).toBe(true);
    expect(input).toHaveValue("2026-05-02 07:57:49");
  });

  it("ignores characters that would break the fixed format", () => {
    render(<Harness />);
    clickAt(6);

    expect(press("x")).toBe(false);
    expect(press("月")).toBe(false);
    expect(field()).toHaveValue("2026-05-02 07:57:49");
    expect(selected()).toBe("05");
  });

  it("stays out of the way while an input method is composing", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    clickAt(6);

    expect(press("1", { isComposing: true })).toBe(true);
    expect(press("Enter", { isComposing: true })).toBe(true);
    expect(field()).toHaveValue("2026-05-02 07:57:49");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits with Enter", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    clickAt(6);

    expect(press("Enter")).toBe(false);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("keeps a double click on the clicked segment and a triple click on everything", () => {
    render(<Harness />);
    clickAt(15);
    expect(selected()).toBe("57");

    // 浏览器双击时按“词”选中，可能把 07:57:49 整个选上。
    const input = field();
    input.setSelectionRange(11, 19);
    fireEvent.click(input, { detail: 2 });
    expect(selected()).toBe("57");

    input.setSelectionRange(0, 19);
    fireEvent.click(input, { detail: 3 });
    expect(selected()).toBe("2026-05-02 07:57:49");
  });

  it("selects a segment when clicking inside an existing selection, but keeps a drag selection", () => {
    vi.useFakeTimers();
    render(<Harness />);
    const input = field();
    input.focus();

    // 点在已有选区里：click 时选区还在，浏览器随后才把它折叠成光标。
    input.setSelectionRange(0, 19);
    fireEvent.mouseDown(input, { clientX: 60, clientY: 10 });
    fireEvent.click(input, { detail: 1, clientX: 60, clientY: 10 });
    input.setSelectionRange(6, 6);
    act(() => vi.runAllTimers());
    expect(selected()).toBe("05");

    // 拖选出的范围原样保留，方便复制任意一部分。
    fireEvent.mouseDown(input, { clientX: 20, clientY: 10 });
    input.setSelectionRange(2, 9);
    fireEvent.click(input, { detail: 1, clientX: 90, clientY: 10 });
    act(() => vi.runAllTimers());
    expect(selected()).toBe("26-05-0");
  });
});

describe("DateTimeField free text", () => {
  it("replaces the whole value when a complete time is pasted", () => {
    render(<Harness />);
    clickAt(6);

    const handled = fireEvent.paste(field(), {
      clipboardData: { getData: () => "2026/6/1 9:05" },
    });

    expect(handled).toBe(false);
    expect(field()).toHaveValue("2026-06-01 09:05:00");
  });

  it("lets anything else paste as ordinary text", () => {
    render(<Harness />);
    clickAt(6);

    expect(
      fireEvent.paste(field(), { clipboardData: { getData: () => "12" } }),
    ).toBe(true);
  });

  it("resumes segment editing after a segment is deleted and retyped", () => {
    render(<Harness />);
    const input = field();
    input.focus();

    fireEvent.change(input, { target: { value: "2026-05- 07:57:49" } });
    expect(input).toHaveValue("2026-05- 07:57:49");
    fireEvent.change(input, { target: { value: "2026-05-2 07:57:49" } });
    fireEvent.change(input, {
      target: {
        value: "2026-05-25 07:57:49",
        selectionStart: 10,
        selectionEnd: 10,
      },
    });

    expect(input).toHaveValue("2026-05-25 07:57:49");
    expect(selected()).toBe("07");
  });

  it("continues a segment whose first digit was just retyped", () => {
    render(<Harness initial="2026-05-0 07:57:49" />);
    const input = field();
    input.focus();

    // 把“0”前补成“20”：光标停在这一段中间，下一位应接着写成 25。
    fireEvent.change(input, {
      target: {
        value: "2026-05-20 07:57:49",
        selectionStart: 9,
        selectionEnd: 9,
      },
    });
    expect(selected()).toBe("20");

    type("5");
    expect(input).toHaveValue("2026-05-25 07:57:49");
    expect(selected()).toBe("07");
  });

  it("folds full-width characters typed through a Chinese input method", () => {
    render(<Harness initial="" />);

    fireEvent.change(field(), {
      target: { value: "２０２６－０５－０２　０７：５７：４９" },
    });

    expect(field()).toHaveValue("2026-05-02 07:57:49");
  });

  it("tidies a recognisable spelling into the fixed format on blur", () => {
    render(<Harness />);
    const input = field();

    fireEvent.change(input, { target: { value: "2026/5/2 7:57" } });
    expect(input).toHaveValue("2026/5/2 7:57");
    fireEvent.blur(input);
    expect(input).toHaveValue("2026-05-02 07:57:00");

    fireEvent.change(input, { target: { value: "下周一" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("下周一");
  });
});

describe("DateTimeField restore default", () => {
  const restore = () =>
    screen.queryByRole("button", { name: "恢复默认开始时间" });

  it("has no picker and stays bare while the draft equals the default time", () => {
    render(<Harness initial="2026-04-30 11:14:27" />);

    expect(restore()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      field().closest(".time-field")?.querySelectorAll("button"),
    ).toHaveLength(0);
    // 不再有日历：Alt+↓ 交还给浏览器。
    field().focus();
    expect(press("ArrowDown", { altKey: true })).toBe(true);
  });

  it("offers restore once the draft differs and says what it restores to", () => {
    const onRestoreDefault = vi.fn();
    render(<Harness onRestoreDefault={onRestoreDefault} />);

    const button = restore() as HTMLElement;
    expect(button).toHaveAttribute("data-tip", "恢复默认 2026-04-30 11:14:27");
    expect(button.querySelector("svg")).toHaveClass("lucide-rotate-ccw");
    fireEvent.click(button);

    expect(onRestoreDefault).toHaveBeenCalledOnce();
  });

  it("appears and disappears as the text is edited", () => {
    render(<Harness initial="2026-04-30 11:14:27" />);

    clickAt(9);
    press("ArrowUp");
    expect(field()).toHaveValue("2026-05-01 11:14:27");
    expect(restore()).not.toBeNull();

    press("ArrowDown");
    expect(restore()).toBeNull();
  });
});
