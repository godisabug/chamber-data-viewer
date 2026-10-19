import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDataset } from "../test/fixtures";
import { Sidebar } from "./Sidebar";

const STORAGE_KEY = "chamber-data-viewer:sidebar-collapsed";
const dataset = makeDataset({
  sourceId: "c:/a/sample.csv",
  sourceFile: "sample.csv",
});

function renderSidebar({
  loading = false,
  reading = false,
  datasets = [dataset],
}: {
  loading?: boolean;
  reading?: boolean;
  datasets?: ReturnType<typeof makeDataset>[];
} = {}) {
  const callbacks = {
    onActivate: vi.fn(),
    onOpen: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
  };

  const view = render(
    <Sidebar
      datasets={datasets}
      activeSourceId={datasets[0]?.sourceId ?? null}
      loading={loading}
      reading={reading}
      {...callbacks}
    />,
  );

  return { ...callbacks, ...view };
}

describe("Sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists the collapsed sidebar and offers the complementary expand action", async () => {
    const user = userEvent.setup();
    const { onOpen } = renderSidebar();

    const collapseButton = screen.getByRole("button", { name: "折叠侧边栏" });
    expect(collapseButton).toHaveClass("sidebar-collapse-toggle");
    expect(collapseButton.parentElement).toHaveClass("sidebar-header");
    await user.click(collapseButton);

    expect(screen.getByRole("complementary")).toHaveClass("is-collapsed");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
    expect(screen.getByRole("button", { name: "展开侧边栏" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "添加数据文件" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps switching files from numbered rail items while collapsed", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const second = makeDataset({
      sourceId: "c:/b/second.csv",
      sourceFile: "second.csv",
      sources: [{ sourceId: "c:/b/second.csv", sourceFile: "second.csv" }],
    });
    const { onActivate } = renderSidebar({ datasets: [dataset, second] });

    const rail = screen.getByRole("navigation", { name: "已打开的数据文件" });
    const items = within(rail).getAllByRole("button");
    expect(items.map((item) => item.textContent)).toEqual(["1", "2"]);
    expect(items[0]).toHaveClass("file-rail-item", "is-active");
    expect(items[0]).toHaveAttribute("aria-current", "page");
    expect(items[1]).not.toHaveAttribute("aria-current");
    expect(items[1]).toHaveAccessibleName("切换到文件 second.csv");

    fireEvent.click(items[1]);
    expect(onActivate).toHaveBeenCalledWith("c:/b/second.csv");
  });

  it("shows no rail while the sidebar is expanded", () => {
    renderSidebar();
    expect(
      screen.queryByRole("navigation", { name: "已打开的数据文件" }),
    ).not.toBeInTheDocument();
  });

  it("names a rail number with its path after the hover delay", () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(STORAGE_KEY, "true");
      const single = makeDataset({
        sourceId: "c:/data/sample.000",
        sourceFile: "sample.000",
        sources: [{ sourceId: "c:/data/sample.000", sourceFile: "sample.000" }],
      });
      renderSidebar({ datasets: [single] });

      const item = within(
        screen.getByRole("navigation", { name: "已打开的数据文件" }),
      ).getByRole("button");
      fireEvent.mouseEnter(item);
      act(() => {
        vi.advanceTimersByTime(799);
      });
      expect(document.querySelector(".sidebar-tooltip")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });

      const tooltip = document.querySelector(".sidebar-tooltip");
      expect(tooltip).toHaveTextContent("c:/data/sample.000");

      fireEvent.mouseLeave(item);
      expect(document.querySelector(".sidebar-tooltip")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the native file flow directly without a vendor chooser", async () => {
    const user = userEvent.setup();
    const { onOpen } = renderSidebar();
    await user.click(screen.getByRole("button", { name: "添加数据文件" }));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith();
    const addButton = screen.getByRole("button", { name: "添加数据文件" });
    expect(screen.getByText("打开数据文件").closest("button")).toBe(addButton);
    expect(screen.queryByText("自动识别文件格式")).not.toBeInTheDocument();
    expect(addButton.querySelector(".lucide-plus")).toBeInTheDocument();
    expect(document.querySelector(".sidebar-open-status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("region", { name: /厂家/ })).not.toBeInTheDocument();
  });

  it("renders the product mark on the shared stroke system", () => {
    const { container } = renderSidebar();
    const glyph = container.querySelector(".brand-mark svg");

    expect(
      screen.getByRole("heading", { name: "试验箱数据查看器 chamber data viewer" }),
    ).toBeInTheDocument();
    expect(glyph).toHaveClass("app-mark");
    expect(glyph).toHaveAttribute("viewBox", "0 0 24 24");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toHaveAttribute("focusable", "false");
    expect(glyph).toHaveAttribute("fill", "none");
    expect(glyph).toHaveAttribute("stroke", "currentColor");
    expect(glyph).toHaveAttribute("stroke-width", "1.5");
    expect(glyph).toHaveAttribute("stroke-linecap", "round");
    expect(glyph).toHaveAttribute("stroke-linejoin", "round");
    const paths = glyph?.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths?.[0]).toHaveClass("app-mark-frame");
    expect(paths?.[1]).toHaveClass("app-mark-trace");
    paths?.forEach((path) => {
      expect(path).toHaveAttribute("vector-effect", "non-scaling-stroke");
    });
  });

  it("uses the complete sourceFile for file text and accessible names", () => {
    const nested = makeDataset({
      sourceId: "c:/a/folder/sample.csv",
      sourceFile: "folder/sample.csv",
    });
    renderSidebar({ datasets: [nested] });

    const select = screen.getByRole("button", {
      name: "切换到文件 folder/sample.csv",
    });
    expect(select).not.toHaveAttribute("title");
    expect(within(select).getByText("folder/sample.csv")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "folder/sample.csv 文件操作" }),
    ).not.toHaveAttribute("title");
  });

  it("uses source identity for activation and closes a file menu with Escape", async () => {
    const user = userEvent.setup();
    const { onActivate } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "切换到文件 sample.csv" }));
    expect(onActivate).toHaveBeenCalledWith("c:/a/sample.csv");

    await user.click(screen.getByRole("button", { name: "sample.csv 文件操作" }));
    expect(screen.getByRole("menu")).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not surface structured invalid measurements as a sidebar blocker", () => {
    const withDiagnostics = makeDataset({
      diagnostics: [
        {
          level: "warning",
          message: "检测到 2 个停录间断，曲线已断开",
        },
        {
          code: "invalid_measurement",
          level: "warning",
          message: "实测湿度有 6 个无效值，已按缺失数据处理",
        },
      ],
    });
    renderSidebar({ datasets: [withDiagnostics] });

    expect(
      screen.queryByRole("button", { name: /部分测量值无效/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "数据说明" }),
    ).not.toBeInTheDocument();
  });

  it("opens the same dataset menu from a right click", () => {
    renderSidebar();
    const entry = screen.getByRole("group", {
      name: "已打开的数据文件：sample.csv",
    });

    fireEvent.contextMenu(entry);

    expect(screen.getByRole("menuitem", { name: "更换文件" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "关闭数据集" })).toBeInTheDocument();
  });

  it("presents a merged TEMI2500 group as one accessible dataset entry", async () => {
    const user = userEvent.setup();
    const group = makeDataset({
      sourceId:
        'temi2500-group:["c:/data/sr260615/a.sdr","c:/data/sr260615/b.sdr"]',
      sourceFile: "已合并 2 个 TEMI2500 文件",
      sources: [
        { sourceId: "c:/data/sr260615/a.sdr", sourceFile: "a.SDR" },
        { sourceId: "c:/data/sr260615/b.sdr", sourceFile: "b.SDR" },
      ],
    });
    const { container, onOpen, onDelete } = renderSidebar({ datasets: [group] });

    const select = screen.getByRole("button", {
      name: /切换到文件 已合并 2 个文件.*a\.SDR.*b\.SDR/,
    });
    expect(within(select).getByText("a.SDR、b.SDR")).toHaveClass("file-sources");
    expect(within(select).getByText("已合并 2 个文件")).toHaveClass("file-name");
    expect(within(select).queryByText("c:/data/sr260615")).not.toBeInTheDocument();
    expect(select).not.toHaveAttribute("title");
    expect(screen.queryByText("已打开 1 个数据集")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".file-entry")).toHaveLength(1);
    expect(document.body).not.toHaveTextContent("temi2500-group:");

    const menuTrigger = screen.getByRole("button", {
      name: /已合并 2 个文件.*a\.SDR.*b\.SDR.*文件操作/,
    });
    await user.click(menuTrigger);
    await user.click(screen.getByRole("menuitem", { name: "更换文件" }));
    expect(onOpen).toHaveBeenCalledWith(group.sourceId);

    await user.click(menuTrigger);
    await user.click(screen.getByRole("menuitem", { name: "关闭数据集" }));
    expect(onDelete).toHaveBeenCalledWith(group.sourceId);
  });

  it("centers a newly opened middle file menu without scrolling again on close", async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    try {
      const datasets = Array.from({ length: 5 }, (_, index) =>
        makeDataset({
          sourceId: `c:/data/file-${index}.csv`,
          sourceFile: `file-${index}.csv`,
        }),
      );
      const user = userEvent.setup();
      renderSidebar({ datasets });
      const trigger = screen.getByRole("button", {
        name: "file-2.csv 文件操作",
      });
      const entry = trigger.closest(".file-entry");

      await user.click(trigger);

      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "center",
        inline: "nearest",
      });
      expect(scrollIntoView.mock.instances[0]).toBe(entry);
      expect(screen.getByRole("menu")).toBeInTheDocument();

      await user.click(trigger);

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(scrollIntoView).toHaveBeenCalledOnce();
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          Element.prototype,
          "scrollIntoView",
          originalScrollIntoView,
        );
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("opens regular additions and replacements directly", async () => {
    const user = userEvent.setup();
    const { onOpen } = renderSidebar();

    await user.click(screen.getByRole("button", { name: "添加数据文件" }));
    expect(onOpen).toHaveBeenLastCalledWith();

    await user.click(screen.getByRole("button", { name: "sample.csv 文件操作" }));
    await user.click(screen.getByRole("menuitem", { name: "更换文件" }));
    expect(onOpen).toHaveBeenLastCalledWith(dataset.sourceId);
  });

  it("closes transient controls on an outside pointer press", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "sample.csv 文件操作" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("gates file operations while choosing without showing reading feedback", async () => {
    const user = userEvent.setup();
    const { onActivate, onOpen } = renderSidebar({ loading: true });
    const addButton = screen.getByRole("button", { name: "添加数据文件" });
    const menuButton = screen.getByRole("button", { name: "sample.csv 文件操作" });

    expect(addButton).toBeDisabled();
    expect(addButton).toHaveAttribute("aria-busy", "false");
    expect(addButton.querySelector(".ui-icon.is-spinning")).not.toBeInTheDocument();
    expect(screen.getByText("打开数据文件")).toBeInTheDocument();
    expect(menuButton).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "切换到文件 sample.csv" }));

    expect(onActivate).toHaveBeenCalledWith(dataset.sourceId);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows reading feedback while dataset loading is active", () => {
    renderSidebar({ loading: true, reading: true });

    const addButton = screen.getByRole("button", { name: "添加数据文件" });
    expect(addButton).toBeDisabled();
    expect(addButton).toHaveAttribute("aria-busy", "true");
    expect(addButton.querySelector(".ui-icon.is-spinning")).toBeInTheDocument();
    expect(document.querySelector(".sidebar-open-status")).toHaveTextContent(
      "正在读取数据，自动识别文件格式",
    );
    expect(document.querySelector(".sidebar-open-status")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("disables an already-open delete action when loading starts", async () => {
    const user = userEvent.setup();
    const callbacks = {
      onActivate: vi.fn(),
      onOpen: vi.fn(),
      onDelete: vi.fn(),
      onReorder: vi.fn(),
    };
    const view = render(
      <Sidebar
        datasets={[dataset]}
        activeSourceId={dataset.sourceId}
        loading={false}
        reading={false}
        {...callbacks}
      />,
    );
    await user.click(screen.getByRole("button", { name: "sample.csv 文件操作" }));

    view.rerender(
      <Sidebar
        datasets={[dataset]}
        activeSourceId={dataset.sourceId}
        loading
        reading={false}
        {...callbacks}
      />,
    );
    const deleteAction = screen.getByRole("menuitem", { name: "关闭数据集" });
    expect(deleteAction).toBeDisabled();
    await user.click(deleteAction);
    expect(callbacks.onDelete).not.toHaveBeenCalled();
  });

  it("shows only file identity without device or controller labels", () => {
    renderSidebar({
      datasets: [
        makeDataset({
          sourceId: "c:/data/sample.SDR",
          sourceFile: "sample.SDR",
          parser: "samwontech-temi2500-sdr",
          controllerRule: "samwontech-temi2500-sdr-v1",
        }),
      ],
    });

    const fileButton = screen.getByRole("button", {
      name: "切换到文件 sample.SDR",
    });
    expect(fileButton).toHaveTextContent(/^sample\.SDR$/);
    expect(fileButton).not.toHaveAccessibleDescription();
    expect(screen.queryByText("控制器未知")).not.toBeInTheDocument();
  });

  it("disambiguates duplicate source files while keeping unique names concise", () => {
    const left = makeDataset({
      sourceId: "c:/left/same/sample.csv",
      sourceFile: "sample.csv",
    });
    const right = makeDataset({
      sourceId: "d:/right/same/sample.csv",
      sourceFile: "sample.csv",
    });
    const unique = makeDataset({
      sourceId: "c:/other/unique.csv",
      sourceFile: "unique.csv",
    });
    renderSidebar({ datasets: [left, right, unique] });

    expect(screen.getByText("c:/left/same")).toHaveClass("file-location");
    expect(screen.getByText("d:/right/same")).toHaveClass("file-location");
    for (const item of [left, right]) {
      expect(
        screen.getByRole("button", {
          name: `切换到文件 sample.csv（${item.sourceId}）`,
        }),
      ).not.toHaveAttribute("title");
      expect(
        screen.getByRole("button", {
          name: `sample.csv（${item.sourceId}） 文件操作`,
        }),
      ).not.toHaveAttribute("title");
    }
    const uniqueSelect = screen.getByRole("button", { name: "切换到文件 unique.csv" });
    expect(uniqueSelect).not.toHaveAttribute("title");
    expect(uniqueSelect.querySelector(".file-location")).toBeNull();
    expect(
      screen.getByRole("button", { name: "unique.csv 文件操作" }),
    ).not.toHaveAttribute("title");
  });

  it("makes every file card a drag surface without a dedicated handle", () => {
    const datasets = [
      makeDataset({ sourceId: "c:/data/a.csv", sourceFile: "a.csv" }),
      makeDataset({ sourceId: "c:/data/b.csv", sourceFile: "b.csv" }),
    ];
    const { container } = renderSidebar({ datasets });

    expect(
      screen.getByRole("group", { name: "已打开的数据文件：a.csv" }),
    ).toHaveClass("file-entry");
    expect(
      screen.getByRole("group", { name: "已打开的数据文件：b.csv" }),
    ).toHaveClass("file-entry");
    expect(container.querySelector(".file-drag-handle")).toBeNull();
    expect(container.querySelector(".file-drag-grip")).toBeNull();
  });

  it("reports a keyboard drag as a reorder request", async () => {
    const user = userEvent.setup();
    const datasets = [
      makeDataset({ sourceId: "c:/data/a.csv", sourceFile: "a.csv" }),
      makeDataset({ sourceId: "c:/data/b.csv", sourceFile: "b.csv" }),
      makeDataset({ sourceId: "c:/data/c.csv", sourceFile: "c.csv" }),
    ];
    const { container, onReorder } = renderSidebar({ datasets });
    const entries = Array.from(container.querySelectorAll(".file-entry"));
    const rectMocks = entries.map((entry, index) =>
      vi.spyOn(entry, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: index * 64,
        top: index * 64,
        right: 220,
        bottom: index * 64 + 64,
        left: 0,
        width: 220,
        height: 64,
        toJSON: () => ({}),
      } as DOMRect),
    );
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    const card = screen.getByRole("group", {
      name: "已打开的数据文件：a.csv",
    });

    try {
      card.focus();
      await user.keyboard(" ");
      expect(document.body.style.cursor).toBe("grabbing");
      await user.keyboard("{ArrowDown}");
      await user.keyboard(" ");
      expect(document.body.style.cursor).toBe("");
    } finally {
      for (const mock of rectMocks) mock.mockRestore();
      if (originalScrollIntoView) {
        Object.defineProperty(
          Element.prototype,
          "scrollIntoView",
          originalScrollIntoView,
        );
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }

    expect(onReorder).toHaveBeenCalledWith("c:/data/a.csv", "c:/data/b.csv");
  });

  it("reports a pointer drag as a reorder request", async () => {
    const user = userEvent.setup();
    const datasets = [
      makeDataset({ sourceId: "c:/data/a.csv", sourceFile: "a.csv" }),
      makeDataset({ sourceId: "c:/data/b.csv", sourceFile: "b.csv" }),
    ];
    const { container, onReorder } = renderSidebar({ datasets });
    const entries = Array.from(container.querySelectorAll(".file-entry"));
    const rectMocks = entries.map((entry, index) =>
      vi.spyOn(entry, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: index * 64,
        top: index * 64,
        right: 220,
        bottom: index * 64 + 64,
        left: 0,
        width: 220,
        height: 64,
        toJSON: () => ({}),
      } as DOMRect),
    );

    try {
      const card = screen.getByRole("group", {
        name: "已打开的数据文件：a.csv",
      });
      await user.pointer([
        { keys: "[MouseLeft>]", target: card, coords: { x: 0, y: 0 } },
      ]);
      await user.pointer([{ coords: { x: 0, y: 120 } }]);
      await user.pointer([{ coords: { x: 0, y: 200 } }]);
      await user.pointer([{ keys: "[/MouseLeft]", coords: { x: 0, y: 200 } }]);

      expect(onReorder).toHaveBeenCalledWith("c:/data/a.csv", "c:/data/b.csv");
    } finally {
      for (const mock of rectMocks) mock.mockRestore();
    }
  });

  it("shows a delayed tooltip with only path details on deliberate hover", () => {
    vi.useFakeTimers();
    try {
      const single = makeDataset({
        sourceId: "c:/data/sample.000",
        sourceFile: "sample.000",
        sources: [{ sourceId: "c:/data/sample.000", sourceFile: "sample.000" }],
      });
      renderSidebar({ datasets: [single] });

      const card = screen.getByRole("group", {
        name: "已打开的数据文件：sample.000",
      });
      fireEvent.mouseOver(card);
      act(() => {
        vi.advanceTimersByTime(799);
      });
      expect(document.querySelector(".sidebar-tooltip")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });

      const tooltip = document.querySelector(".sidebar-tooltip");
      expect(tooltip).toBeInTheDocument();
      expect(tooltip).toHaveTextContent("c:/data/sample.000");

      act(() => {
        fireEvent.mouseOut(card);
      });
      expect(document.querySelector(".sidebar-tooltip")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the pending tooltip when the pointer leaves before the delay", () => {
    vi.useFakeTimers();
    try {
      renderSidebar();
      const card = screen.getByRole("group", {
        name: "已打开的数据文件：sample.csv",
      });
      fireEvent.mouseOver(card);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      fireEvent.mouseOut(card);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(document.querySelector(".sidebar-tooltip")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows every source path for a merged group", () => {
    vi.useFakeTimers();
    try {
      const group = makeDataset({
        sourceId: "group-id",
        sourceFile: "已合并 3 个文件",
        sources: [
          { sourceId: "c:/data/one/a.csv", sourceFile: "a.csv" },
          { sourceId: "c:/data/one/b.csv", sourceFile: "b.csv" },
          { sourceId: "c:/data/one/c.csv", sourceFile: "c.csv" },
        ],
      });
      renderSidebar({ datasets: [group] });

      const card = screen.getByRole("group", {
        name: /已打开的数据文件：已合并 3 个文件/,
      });
      fireEvent.mouseOver(card);
      act(() => {
        vi.advanceTimersByTime(800);
      });

      const tooltip = document.querySelector(".sidebar-tooltip");
      expect(tooltip).toBeInTheDocument();
      expect(tooltip).toHaveTextContent("c:/data/one/a.csv");
      expect(tooltip).toHaveTextContent("c:/data/one/b.csv");
      expect(tooltip).toHaveTextContent("c:/data/one/c.csv");
    } finally {
      vi.useRealTimers();
    }
  });
});
