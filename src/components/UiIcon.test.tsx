import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UiIcon, type UiIconName } from "./UiIcon";

const ICON_NAMES: UiIconName[] = [
  "add",
  "close",
  "collapse",
  "cursor",
  "expand",
  "file-chart",
  "fit-view",
  "help",
  "lock",
  "loader",
  "more",
  "restore",
  "settings",
  "step-down",
  "step-up",
];

describe("UiIcon", () => {
  it.each(ICON_NAMES)("renders the %s icon as decorative SVG", (name) => {
    const { container } = render(<UiIcon name={name} />);
    const icon = container.querySelector("svg");

    expect(icon).toHaveClass("ui-icon");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("focusable", "false");
  });

  it("maps semantic size roles to stable dimensions", () => {
    const view = render(<UiIcon name="lock" size="xs" />);
    const icon = view.container.querySelector("svg");
    expect(icon).toHaveAttribute("width", "12");
    expect(icon).toHaveAttribute("height", "12");

    view.rerender(<UiIcon name="file-chart" size="lg" />);
    const largeIcon = view.container.querySelector("svg");
    expect(largeIcon).toHaveAttribute("width", "40");
    expect(largeIcon).toHaveAttribute("height", "40");
  });

  it("uses a single plus stroke for adding data files", () => {
    const { container } = render(<UiIcon name="add" size="md" />);
    expect(container.querySelector("svg")).toHaveClass("lucide-plus");
  });

  it("uses direction-only chevrons for the sidebar toggle", () => {
    const view = render(<UiIcon name="collapse" />);
    expect(view.container.querySelector("svg")).toHaveClass(
      "lucide-chevron-left",
    );
    view.rerender(<UiIcon name="expand" />);
    expect(view.container.querySelector("svg")).toHaveClass(
      "lucide-chevron-right",
    );
  });

  it("uses the shared circled help glyph for chart guidance", () => {
    const { container } = render(<UiIcon name="help" />);
    expect(container.querySelector("svg")).toHaveClass("lucide-circle-help");
  });

  it("gives each chart tool its own silhouette", () => {
    // 四角框只代表“重置视图”，回转箭头只代表“恢复默认”，一个图标不兼两义。
    const view = render(<UiIcon name="fit-view" />);
    expect(view.container.querySelector("svg")).toHaveClass("lucide-maximize");
    view.rerender(<UiIcon name="restore" />);
    expect(view.container.querySelector("svg")).toHaveClass(
      "lucide-rotate-ccw",
    );
    view.rerender(<UiIcon name="settings" />);
    expect(view.container.querySelector("svg")).toHaveClass(
      "lucide-sliders-horizontal",
    );
  });

  it("draws the cursor tool as the cursor itself: a line with its readout card", () => {
    const { container } = render(<UiIcon name="cursor" />);
    const icon = container.querySelector("svg");

    expect(icon).toHaveClass("lucide-cursor-readout");
    // 与其余 Lucide 图标同一套描边，自绘图形才不会显得突兀。
    expect(icon).toHaveAttribute("stroke-width", "2.25");
    expect(icon).toHaveAttribute("fill", "none");
    expect(icon?.querySelector("path")).toHaveAttribute("d", "M5 3v18");
    expect(icon?.querySelector("rect")).toHaveAttribute("rx", "1");
  });
});
