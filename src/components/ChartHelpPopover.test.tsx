import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartHelpPopover } from "./ChartHelpPopover";

afterEach(() => {
  document.documentElement.classList.remove("using-keyboard");
});

describe("ChartHelpPopover", () => {
  it("opens a labelled non-modal quick reference from the icon button", () => {
    const onOpenChange = vi.fn();
    render(<ChartHelpPopover onOpenChange={onOpenChange} />);

    const trigger = screen.getByRole("button", {
      name: "图表操作速查（F1）",
    });
    expect(trigger).toHaveAttribute("data-tip", "图表操作速查（F1）");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls");
    const dialog = screen.getByRole("dialog", { name: "图表操作速查" });
    expect(dialog).not.toHaveAttribute("aria-modal", "true");
    expect(
      within(dialog).getByRole("heading", { name: "查看与横轴" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("heading", { name: "纵轴与锁定" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("heading", { name: "曲线与图像" }),
    ).toBeVisible();
    // 每格自上而下：标题、按键图示、操作方法。
    const tiles = [...dialog.querySelectorAll(".chart-help-tile")];
    expect(tiles).toHaveLength(11);
    const lockTile = within(dialog)
      .getByText("锁定 / 解锁纵轴")
      .closest(".chart-help-tile") as HTMLElement;
    expect([...lockTile.children].map((child) => child.className)).toEqual([
      "chart-help-result",
      "chart-help-gesture",
      "chart-help-where",
    ]);
    expect(within(lockTile).getByText("Shift")).toHaveClass("keycap");
    expect(lockTile.querySelector(".mouse-glyph")).toBeInTheDocument();
    expect(lockTile).toHaveTextContent("单击曲线或图例名");
    expect(lockTile).toHaveAttribute("title", "锁定或解除对应纵轴");
    const escTile = within(dialog)
      .getByText("解除锁定")
      .closest(".chart-help-tile") as HTMLElement;
    expect(escTile.querySelector(".mouse-glyph")).toBeNull();
    expect(within(escTile).getByText("Esc")).toHaveClass("keycap");
    // 展开后不再显示按钮自己的名称提示。
    expect(trigger).not.toHaveAttribute("data-tip");
    expect(
      within(dialog).getByRole("button", { name: "关闭图表操作速查" }),
    ).toHaveFocus();
    expect(document.documentElement).not.toHaveClass("using-keyboard");
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("toggles with F1 and lets Escape close only the help layer", () => {
    const downstreamKeydown = vi.fn();
    window.addEventListener("keydown", downstreamKeydown);
    render(<ChartHelpPopover />);

    const trigger = screen.getByRole("button", {
      name: "图表操作速查（F1）",
    });
    expect(fireEvent.keyDown(window, { key: "F1" })).toBe(false);
    expect(screen.getByRole("dialog", { name: "图表操作速查" })).toBeVisible();
    expect(document.documentElement).toHaveClass("using-keyboard");

    downstreamKeydown.mockClear();
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(false);
    expect(
      screen.queryByRole("dialog", { name: "图表操作速查" }),
    ).not.toBeInTheDocument();
    expect(downstreamKeydown).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    fireEvent.keyDown(window, { key: "F1" });
    expect(screen.getByRole("dialog", { name: "图表操作速查" })).toBeVisible();
    fireEvent.keyDown(window, { key: "F1" });
    expect(
      screen.queryByRole("dialog", { name: "图表操作速查" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    window.removeEventListener("keydown", downstreamKeydown);
  });

  it("reveals the restored trigger focus when Escape follows pointer opening", () => {
    render(<ChartHelpPopover />);
    const trigger = screen.getByRole("button", {
      name: "图表操作速查（F1）",
    });
    fireEvent.click(trigger);
    expect(document.documentElement).not.toHaveClass("using-keyboard");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(trigger).toHaveFocus();
    expect(document.documentElement).toHaveClass("using-keyboard");
  });

  it("closes from its explicit control and restores focus", () => {
    render(<ChartHelpPopover />);
    const trigger = screen.getByRole("button", {
      name: "图表操作速查（F1）",
    });
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole("button", { name: "关闭图表操作速查" }));

    expect(
      screen.queryByRole("dialog", { name: "图表操作速查" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on outside pointer input without swallowing that action", () => {
    const onOutsideClick = vi.fn();
    render(
      <>
        <ChartHelpPopover />
        <button type="button" onClick={onOutsideClick}>
          外部操作
        </button>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "图表操作速查（F1）" }));

    const outside = screen.getByRole("button", { name: "外部操作" });
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);

    expect(
      screen.queryByRole("dialog", { name: "图表操作速查" }),
    ).not.toBeInTheDocument();
    expect(onOutsideClick).toHaveBeenCalledOnce();
  });
});
