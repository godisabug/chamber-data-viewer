import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedDataset } from "./chartSeries";
import { makeDataset } from "./test/fixtures";
import type { Dataset } from "./types";

type DragEvent = {
  payload: {
    type: string;
    paths: string[];
  };
};

type DragHandler = (event: DragEvent) => void;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  chooseDataFiles: vi.fn<() => Promise<string[] | null>>(),
  loadDataset: vi.fn<(paths: string[]) => Promise<Dataset>>(),
  prepareDataset: vi.fn<(dataset: Dataset) => PreparedDataset>(),
  dragHandler: { current: null as DragHandler | null },
  dragRegistration: vi.fn<() => Promise<() => void>>(),
  unlisten: vi.fn(),
  sidebarProps: {
    current: null as null | {
      onOpen: (replaceSourceId?: string) => void;
    },
  },
  chartDiagnostics: { current: [] as string[] },
  pointTimeType: { current: null as string | null },
}));

vi.mock("./chartSeries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chartSeries")>();
  mocks.prepareDataset.mockImplementation(actual.prepareDataset);
  return { ...actual, prepareDataset: mocks.prepareDataset };
});

vi.mock("./tauri", () => ({
  chooseDataFiles: mocks.chooseDataFiles,
  loadDataset: mocks.loadDataset,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: DragHandler) => {
      mocks.dragHandler.current = handler;
      return mocks.dragRegistration();
    },
  }),
}));

vi.mock("./components/Sidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/Sidebar")>();
  return {
    ...actual,
    Sidebar: (props: Parameters<typeof actual.Sidebar>[0]) => {
      mocks.sidebarProps.current = props;
      return <actual.Sidebar {...props} />;
    },
  };
});

vi.mock("./components/ChartView", () => ({
  ChartView: ({ dataset }: { dataset: PreparedDataset }) => {
    mocks.chartDiagnostics.current = dataset.diagnostics.map(
      (item) => item.message,
    );
    mocks.pointTimeType.current = typeof dataset.series[0]?.points[0]?.[0];
    return null;
  },
}));

import App from "./App";

async function openGenericFile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "添加数据文件" }));
}

function sidebarOpenLabel() {
  return within(screen.getByRole("button", { name: "添加数据文件" })).getByText(
    "打开数据文件",
  );
}

beforeEach(() => {
  localStorage.clear();
  mocks.chooseDataFiles.mockReset();
  mocks.loadDataset.mockReset();
  mocks.prepareDataset.mockClear();
  mocks.dragRegistration.mockReset();
  mocks.dragRegistration.mockResolvedValue(mocks.unlisten);
  mocks.unlisten.mockReset();
  mocks.dragHandler.current = null;
  mocks.sidebarProps.current = null;
  mocks.chartDiagnostics.current = [];
  mocks.pointTimeType.current = null;
});

describe("App", () => {
  it("prepares loaded points once and reuses them across file activation", async () => {
    const user = userEvent.setup();
    const paths = ["c:/fixtures/a.csv", "c:/fixtures/b.csv"];
    mocks.chooseDataFiles
      .mockResolvedValueOnce([paths[0]])
      .mockResolvedValueOnce([paths[1]]);
    mocks.loadDataset.mockImplementation(async (selectedPaths) => {
      const path = selectedPaths[0];
      return makeDataset({
        sourceId: path,
        sourceFile: path.endsWith("a.csv") ? "a.csv" : "b.csv",
      });
    });
    render(<App />);

    await openGenericFile(user);
    await screen.findByRole("button", { name: "切换到文件 a.csv" });
    expect(mocks.pointTimeType.current).toBe("number");
    await openGenericFile(user);
    await screen.findByRole("button", { name: "切换到文件 b.csv" });
    await user.click(screen.getByRole("button", { name: "切换到文件 a.csv" }));

    expect(mocks.prepareDataset).toHaveBeenCalledTimes(2);
    expect(
      mocks.prepareDataset.mock.calls.map(([raw]) => raw.sourceId),
    ).toEqual(paths);
    expect(mocks.pointTimeType.current).toBe("number");
  });

  it("shows a watermark and an operation list in the empty workspace, with the sidebar as the only open button", async () => {
    const user = userEvent.setup();
    mocks.chooseDataFiles.mockResolvedValue(null);
    render(<App />);

    const emptyState = screen.getByRole("region", {
      name: "未加载数据文件",
    });
    expect(emptyState.querySelector(".app-mark")).toBeInTheDocument();
    expect(within(emptyState).queryByRole("button")).toBeNull();
    const hints = [...emptyState.querySelectorAll(".empty-state-hints dt")].map(
      (hint) => hint.textContent,
    );
    expect(hints).toEqual([
      "打开数据文件",
      "载入多个文件",
      "缩放时间轴",
      "平移时间轴",
      "缩放纵轴",
      "平移纵轴",
      "载入后查看全部操作",
    ]);
    expect(
      [...emptyState.querySelectorAll(".keycap")].map((cap) => cap.textContent),
    ).toEqual(["Ctrl", "O", "Shift", "Shift", "F1"]);
    expect(emptyState.querySelectorAll(".mouse-glyph")).toHaveLength(4);
    expect(
      screen.queryByRole("button", { name: "图表操作速查（F1）" }),
    ).not.toBeInTheDocument();

    // 打开文件只有侧栏一个按钮，另有 Ctrl+O。
    await user.click(screen.getByRole("button", { name: "添加数据文件" }));
    expect(mocks.chooseDataFiles).toHaveBeenCalledTimes(1);
    await user.keyboard("{Control>}o{/Control}");
    expect(mocks.chooseDataFiles).toHaveBeenCalledTimes(2);
  });

  it("shows the drop hint only between drag enter and leave or drop", async () => {
    mocks.loadDataset.mockResolvedValueOnce(
      makeDataset({ sourceId: "c:/drop/a.csv", sourceFile: "a.csv" }),
    );
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    act(() => {
      mocks.dragHandler.current?.({
        payload: { type: "enter", paths: ["c:/drop/a.csv", "c:/drop/b.csv"] },
      });
    });
    expect(screen.getByText("松开以载入 2 个文件")).toBeInTheDocument();
    act(() => {
      mocks.dragHandler.current?.({ payload: { type: "over", paths: [] } });
    });
    expect(screen.getByText("松开以载入 2 个文件")).toBeInTheDocument();
    act(() => {
      mocks.dragHandler.current?.({ payload: { type: "leave", paths: [] } });
    });
    expect(screen.queryByText(/松开以载入/)).not.toBeInTheDocument();

    act(() => {
      mocks.dragHandler.current?.({
        payload: { type: "enter", paths: ["c:/drop/a.csv"] },
      });
    });
    await act(async () => {
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: ["c:/drop/a.csv"] },
      });
    });
    expect(screen.queryByText(/松开以载入/)).not.toBeInTheDocument();
    expect(mocks.loadDataset).toHaveBeenCalledWith(["c:/drop/a.csv"]);
  });

  it("lets the user dismiss the single load-error notice", async () => {
    mocks.loadDataset.mockRejectedValueOnce(
      "暂不支持该文件格式：无法可靠识别文件内容",
    );
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    await act(async () => {
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: ["c:/unknown/a.dat"] },
      });
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法载入数据");
    expect(alert).toHaveTextContent("暂不支持该文件格式：无法可靠识别文件内容");
    fireEvent.click(within(alert).getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("exposes the sidebar splitter contract and supports keyboard resizing", () => {
    render(<App />);
    const separator = screen.getByRole("separator", {
      name: "调整侧栏宽度",
    });
    const sidebar = screen.getByRole("complementary", { name: "数据来源" });

    expect(separator).toHaveAttribute(
      "aria-controls",
      "data-source-sidebar chart-workspace",
    );
    expect(separator).toHaveAttribute("aria-valuemin", "48");
    expect(separator).toHaveAttribute("aria-valuenow", "264");
    expect(separator).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(sidebar).toHaveStyle({ width: "272px" });
    expect(separator).toHaveAttribute("aria-valuenow", "272");

    fireEvent.keyDown(separator, { key: "Home" });
    expect(sidebar).toHaveClass("is-collapsed");
    expect(separator).toHaveAttribute("aria-valuenow", "48");
    expect(separator).toHaveAttribute("aria-valuetext", "侧栏已折叠，48 像素");

    fireEvent.keyDown(separator, { key: "Enter" });
    expect(sidebar).not.toHaveClass("is-collapsed");
    expect(separator).toHaveAttribute("aria-valuenow", "272");
  });

  it("starts loading feedback only after file selection begins reading", async () => {
    const user = userEvent.setup();
    const pendingChoice = deferred<string[] | null>();
    const pending = deferred<Dataset>();
    mocks.chooseDataFiles.mockReturnValueOnce(pendingChoice.promise);
    mocks.loadDataset.mockReturnValueOnce(pending.promise);
    render(<App />);

    await openGenericFile(user);

    const addButton = screen.getByRole("button", { name: "添加数据文件" });
    expect(addButton).toBeDisabled();
    expect(addButton).toHaveAttribute("aria-busy", "false");
    expect(
      addButton.querySelector(".ui-icon.is-spinning"),
    ).not.toBeInTheDocument();
    expect(sidebarOpenLabel()).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "未加载数据文件" }),
    ).toHaveAttribute("aria-busy", "false");

    await act(async () => {
      pendingChoice.resolve(["c:/fixtures/pending.csv"]);
      await pendingChoice.promise;
    });

    const workspaceStatus = screen.getByRole("region", {
      name: "正在读取数据",
    });
    expect(workspaceStatus).toHaveAttribute("aria-busy", "true");
    expect(workspaceStatus).toHaveTextContent("正在读取数据…");
    expect(
      workspaceStatus.querySelector(".ui-icon.is-spinning"),
    ).toBeInTheDocument();

    expect(addButton).toBeDisabled();
    expect(addButton).toHaveAttribute("aria-busy", "true");
    expect(addButton.querySelector(".ui-icon.is-spinning")).toBeInTheDocument();

    await act(async () => {
      pending.resolve(
        makeDataset({
          sourceId: "c:/fixtures/pending.csv",
          sourceFile: "pending.csv",
        }),
      );
      await pending.promise;
    });

    await screen.findByRole("button", { name: "切换到文件 pending.csv" });
    await waitFor(() => expect(addButton).not.toBeDisabled());
    expect(addButton).toHaveAttribute("aria-busy", "false");
    expect(
      addButton.querySelector(".ui-icon.is-spinning"),
    ).not.toBeInTheDocument();
  });

  it("returns to the idle empty state when file selection is cancelled", async () => {
    const user = userEvent.setup();
    mocks.chooseDataFiles.mockResolvedValueOnce(null);
    render(<App />);

    await openGenericFile(user);

    const addButton = screen.getByRole("button", { name: "添加数据文件" });
    await waitFor(() => expect(addButton).not.toBeDisabled());
    expect(addButton).toHaveAttribute("aria-busy", "false");
    expect(
      addButton.querySelector(".ui-icon.is-spinning"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "未加载数据文件" }),
    ).toHaveAttribute("aria-busy", "false");
    expect(mocks.loadDataset).not.toHaveBeenCalled();
  });

  it("loads a native TEMI2500 multi-selection as one grouped request", async () => {
    const user = userEvent.setup();
    const paths = ["c:/temi/part-1.SDR", "c:/temi/part-2.SDR"];
    const grouped = makeDataset({
      sourceId: 'temi2500-group:["c:/temi/part-1.sdr","c:/temi/part-2.sdr"]',
      sourceFile: "已合并 2 个 TEMI2500 文件",
      sources: [
        { sourceId: "c:/temi/part-1.sdr", sourceFile: "part-1.SDR" },
        { sourceId: "c:/temi/part-2.sdr", sourceFile: "part-2.SDR" },
      ],
      parser: "samwontech-temi2500-sdr",
      controllerRule: "samwontech-temi2500-sdr-v1",
    });
    mocks.chooseDataFiles.mockResolvedValueOnce(paths);
    mocks.loadDataset.mockResolvedValueOnce(grouped);
    render(<App />);

    await openGenericFile(user);

    expect(
      await screen.findByRole("button", {
        name: /切换到文件 已合并 2 个文件.*c:\/temi.*part-1\.SDR.*part-2\.SDR/,
      }),
    ).toHaveAttribute("aria-current", "page");
    expect(mocks.chooseDataFiles).toHaveBeenCalledOnce();
    expect(mocks.loadDataset).toHaveBeenCalledOnce();
    expect(mocks.loadDataset).toHaveBeenCalledWith(paths);
    expect(mocks.prepareDataset).toHaveBeenCalledOnce();
    expect(mocks.prepareDataset).toHaveBeenCalledWith(grouped);
  });

  it("loads all native drop paths through one backend request", async () => {
    const paths = ["c:/temi/drop-1.SDR", "c:/temi/drop-2.SDR"];
    const grouped = makeDataset({
      sourceId: 'temi2500-group:["c:/temi/drop-1.sdr","c:/temi/drop-2.sdr"]',
      sourceFile: "已合并 2 个 TEMI2500 文件",
    });
    mocks.loadDataset.mockResolvedValueOnce(grouped);
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    await act(async () => {
      mocks.dragHandler.current?.({ payload: { type: "drop", paths } });
    });

    await screen.findByRole("button", {
      name: "切换到文件 已合并 2 个 TEMI2500 文件",
    });
    expect(mocks.loadDataset).toHaveBeenCalledOnce();
    expect(mocks.loadDataset).toHaveBeenCalledWith(paths);
    expect(mocks.prepareDataset).toHaveBeenCalledOnce();
    expect(mocks.prepareDataset).toHaveBeenCalledWith(grouped);
  });

  it("keeps the current dataset when a grouped replacement is rejected", async () => {
    const user = userEvent.setup();
    const original = makeDataset({
      sourceId: "c:/slot/original.csv",
      sourceFile: "original.csv",
    });
    const replacementPaths = [
      "c:/replacement/part-1.SDR",
      "c:/replacement/part-2.SDR",
    ];
    mocks.chooseDataFiles
      .mockResolvedValueOnce([original.sourceId])
      .mockResolvedValueOnce(replacementPaths);
    mocks.loadDataset
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new Error("多文件合并失败"));
    render(<App />);

    await openGenericFile(user);
    expect(
      await screen.findByRole("button", { name: "切换到文件 original.csv" }),
    ).toHaveAttribute("aria-current", "page");

    act(() => {
      mocks.sidebarProps.current?.onOpen(original.sourceId);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "多文件合并失败",
    );
    expect(
      screen.getByRole("button", { name: "切换到文件 original.csv" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("region", { name: "数据曲线" }),
    ).toBeInTheDocument();
    expect(mocks.loadDataset).toHaveBeenLastCalledWith(replacementPaths);
    expect(mocks.loadDataset).toHaveBeenCalledTimes(2);
    expect(mocks.prepareDataset).toHaveBeenCalledOnce();
    expect(mocks.prepareDataset).toHaveBeenCalledWith(original);
  });

  it("keeps same-named files from different source paths", async () => {
    const user = userEvent.setup();
    const paths = ["c:/left/sample.csv", "c:/right/sample.csv"];
    mocks.chooseDataFiles
      .mockResolvedValueOnce([paths[0]])
      .mockResolvedValueOnce([paths[1]]);
    mocks.loadDataset.mockImplementation(async (selectedPaths) =>
      makeDataset({ sourceId: selectedPaths[0], sourceFile: "sample.csv" }),
    );
    render(<App />);

    await openGenericFile(user);
    await screen.findByRole("button", { name: "切换到文件 sample.csv" });
    await openGenericFile(user);

    await waitFor(() => {
      for (const path of paths) {
        expect(
          screen.getByRole("button", {
            name: `切换到文件 sample.csv（${path}）`,
          }),
        ).toBeInTheDocument();
      }
    });
    expect(mocks.chooseDataFiles).toHaveBeenNthCalledWith(1);
    expect(mocks.chooseDataFiles).toHaveBeenNthCalledWith(2);
    expect(mocks.loadDataset).toHaveBeenNthCalledWith(1, [paths[0]]);
    expect(mocks.loadDataset).toHaveBeenNthCalledWith(2, [paths[1]]);
  });

  it("shows an error directly when automatic drag loading fails", async () => {
    mocks.loadDataset.mockRejectedValueOnce("无法自动识别格式");
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    await act(async () => {
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: ["c:/unknown/reading.dat"] },
      });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法自动识别格式",
    );
    expect(
      screen.queryByRole("region", { name: /厂家/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the current chart visible when a later automatic parse fails", async () => {
    const user = userEvent.setup();
    mocks.chooseDataFiles
      .mockResolvedValueOnce(["c:/ok.csv"])
      .mockResolvedValueOnce(["c:/broken.csv"]);
    mocks.loadDataset
      .mockResolvedValueOnce(
        makeDataset({ sourceId: "c:/ok.csv", sourceFile: "ok.csv" }),
      )
      .mockRejectedValueOnce(new Error("文件解析失败"));
    render(<App />);

    await openGenericFile(user);
    expect(
      await screen.findByRole("region", { name: "数据曲线" }),
    ).toBeInTheDocument();
    await openGenericFile(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("文件解析失败");
    expect(
      screen.getByRole("region", { name: "数据曲线" }),
    ).toBeInTheDocument();
  });

  it("replaces a dataset in place and returns to the empty state after deletion", async () => {
    const user = userEvent.setup();
    mocks.chooseDataFiles
      .mockResolvedValueOnce(["c:/first.csv"])
      .mockResolvedValueOnce(["c:/second.csv"]);
    mocks.loadDataset
      .mockResolvedValueOnce(
        makeDataset({ sourceId: "c:/first.csv", sourceFile: "first.csv" }),
      )
      .mockResolvedValueOnce(
        makeDataset({ sourceId: "c:/second.csv", sourceFile: "second.csv" }),
      );
    render(<App />);

    await openGenericFile(user);
    await user.click(
      await screen.findByRole("button", { name: "first.csv 文件操作" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "更换文件" }));

    expect(
      await screen.findByRole("button", { name: "切换到文件 second.csv" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "切换到文件 first.csv" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "second.csv 文件操作" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "关闭数据集" }));

    expect(
      screen.getByRole("region", { name: "未加载数据文件" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "数据曲线" }),
    ).not.toBeInTheDocument();
  });

  it("keeps both drops when A resolves before B and leaves B active", async () => {
    const loadA = deferred<Dataset>();
    const loadB = deferred<Dataset>();
    mocks.loadDataset.mockImplementation((paths) =>
      paths[0] === "c:/drops/a.csv" ? loadA.promise : loadB.promise,
    );
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    act(() => {
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: ["c:/drops/a.csv"] },
      });
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: ["c:/drops/b.csv"] },
      });
    });
    expect(screen.getByText("正在读取数据")).toBeInTheDocument();

    await act(async () => {
      loadA.resolve(
        makeDataset({ sourceId: "c:/drops/a.csv", sourceFile: "a.csv" }),
      );
      await loadA.promise;
    });
    expect(screen.getByText("正在读取数据")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "切换到文件 a.csv" }),
    ).toHaveAttribute("aria-current", "page");

    await act(async () => {
      loadB.resolve(
        makeDataset({ sourceId: "c:/drops/b.csv", sourceFile: "b.csv" }),
      );
      await loadB.promise;
    });
    expect(
      screen.getByRole("button", { name: "切换到文件 b.csv" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "切换到文件 a.csv" }),
    ).not.toHaveAttribute("aria-current");
    expect(screen.getByText("打开数据文件")).toBeInTheDocument();
  });

  it("keeps both drops when B resolves before A and leaves B active", async () => {
    const loadA = deferred<Dataset>();
    const loadB = deferred<Dataset>();
    mocks.loadDataset.mockImplementation((paths) =>
      paths[0] === "c:/drops/a.csv" ? loadA.promise : loadB.promise,
    );
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    act(() => {
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: ["c:/drops/a.csv"] },
      });
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: ["c:/drops/b.csv"] },
      });
    });
    await act(async () => {
      loadB.resolve(
        makeDataset({ sourceId: "c:/drops/b.csv", sourceFile: "b.csv" }),
      );
      await loadB.promise;
    });
    expect(screen.getByText("正在读取数据")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "切换到文件 b.csv" }),
    ).toHaveAttribute("aria-current", "page");

    await act(async () => {
      loadA.resolve(
        makeDataset({ sourceId: "c:/drops/a.csv", sourceFile: "a.csv" }),
      );
      await loadA.promise;
    });
    expect(
      screen.getByRole("button", { name: "切换到文件 a.csv" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("button", { name: "切换到文件 b.csv" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("打开数据文件")).toBeInTheDocument();
  });

  it("ignores an older rejection after the latest drop succeeds", async () => {
    const loadA = deferred<Dataset>();
    const loadB = deferred<Dataset>();
    mocks.loadDataset.mockImplementation((paths) =>
      paths[0] === "c:/drops/a.csv" ? loadA.promise : loadB.promise,
    );
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    act(() => {
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: ["c:/drops/a.csv"] },
      });
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: ["c:/drops/b.csv"] },
      });
    });
    await act(async () => {
      loadB.resolve(
        makeDataset({ sourceId: "c:/drops/b.csv", sourceFile: "b.csv" }),
      );
      await loadB.promise;
    });
    expect(screen.getByText("正在读取数据")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "切换到文件 b.csv" }),
    ).toHaveAttribute("aria-current", "page");

    await act(async () => {
      loadA.reject(new Error("旧请求失败"));
      await loadA.promise.catch(() => undefined);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: /厂家/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "切换到文件 b.csv" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("打开数据文件")).toBeInTheDocument();
  });

  it("does not let an older refresh overwrite a newer result for the same normalized path set", async () => {
    const older = deferred<Dataset>();
    const newer = deferred<Dataset>();
    mocks.loadDataset
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    act(() => {
      mocks.dragHandler.current?.({
        payload: {
          type: "drop",
          paths: [
            "C:\\SHARED\\sample.SDR",
            "C:\\SHARED\\sample.000",
            "c:/shared/SAMPLE.000",
          ],
        },
      });
      mocks.dragHandler.current?.({
        payload: {
          type: "drop",
          paths: ["c:/shared/SAMPLE.000", "c:/shared/sample.sdr"],
        },
      });
    });
    await act(async () => {
      newer.resolve(
        makeDataset({
          sourceId: "c:/shared/sample.csv",
          sourceFile: "sample.csv",
          diagnostics: [{ level: "info", message: "newer-result" }],
        }),
      );
      await newer.promise;
    });
    expect(mocks.chartDiagnostics.current).toEqual(["newer-result"]);
    expect(screen.queryByText("诊断信息")).not.toBeInTheDocument();
    expect(screen.queryByText("newer-result")).not.toBeInTheDocument();

    await act(async () => {
      older.resolve(
        makeDataset({
          sourceId: "c:/shared/sample.csv",
          sourceFile: "sample.csv",
          diagnostics: [{ level: "info", message: "older-result" }],
        }),
      );
      await older.promise;
    });
    expect(mocks.chartDiagnostics.current).toEqual(["newer-result"]);
    expect(screen.queryByText("older-result")).not.toBeInTheDocument();
    expect(screen.getByText("打开数据文件")).toBeInTheDocument();
  });

  it("does not merge an older same-path-set result before the newer request succeeds", async () => {
    const older = deferred<Dataset>();
    const newer = deferred<Dataset>();
    mocks.loadDataset
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    act(() => {
      mocks.dragHandler.current?.({
        payload: {
          type: "drop",
          paths: ["C:\\DATA\\part-2.SDR", "C:\\DATA\\part-1.SDR"],
        },
      });
      mocks.dragHandler.current?.({
        payload: {
          type: "drop",
          paths: ["c:/data/PART-1.sdr", "c:/data/part-2.sdr"],
        },
      });
    });
    await act(async () => {
      older.resolve(
        makeDataset({
          sourceId: "c:/data/sample.csv",
          sourceFile: "sample.csv",
          diagnostics: [{ level: "info", message: "superseded-result" }],
        }),
      );
      await older.promise;
    });
    expect(
      screen.queryByRole("button", { name: "切换到文件 sample.csv" }),
    ).not.toBeInTheDocument();
    expect(mocks.chartDiagnostics.current).toEqual([]);
    expect(screen.queryByText("superseded-result")).not.toBeInTheDocument();
    expect(screen.getByText("正在读取数据")).toBeInTheDocument();

    await act(async () => {
      newer.resolve(
        makeDataset({
          sourceId: "c:/data/sample.csv",
          sourceFile: "sample.csv",
          diagnostics: [{ level: "info", message: "latest-result" }],
        }),
      );
      await newer.promise;
    });
    expect(
      screen.getByRole("button", { name: "切换到文件 sample.csv" }),
    ).toHaveAttribute("aria-current", "page");
    expect(mocks.chartDiagnostics.current).toEqual(["latest-result"]);
    expect(screen.queryByText("latest-result")).not.toBeInTheDocument();
    expect(screen.queryByText("superseded-result")).not.toBeInTheDocument();
    expect(screen.getByText("打开数据文件")).toBeInTheDocument();
  });

  it("does not merge an older same-path-set success after the latest request fails", async () => {
    const older = deferred<Dataset>();
    const newer = deferred<Dataset>();
    mocks.loadDataset
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    render(<App />);
    await waitFor(() => expect(mocks.dragHandler.current).not.toBeNull());

    const latestPaths = ["c:/data/PART-1.sdr", "c:/data/part-2.sdr"];
    act(() => {
      mocks.dragHandler.current?.({
        payload: {
          type: "drop",
          paths: ["C:\\DATA\\part-2.SDR", "C:\\DATA\\part-1.SDR"],
        },
      });
      mocks.dragHandler.current?.({
        payload: { type: "drop", paths: latestPaths },
      });
    });
    await act(async () => {
      newer.reject(new Error("最新请求无法自动识别格式"));
      await newer.promise.catch(() => undefined);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "最新请求无法自动识别格式",
    );
    expect(
      screen.queryByRole("region", { name: /厂家/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("正在读取数据")).toBeInTheDocument();

    await act(async () => {
      older.resolve(
        makeDataset({
          sourceId: "c:/data/sample.csv",
          sourceFile: "sample.csv",
          diagnostics: [{ level: "info", message: "superseded-result" }],
        }),
      );
      await older.promise;
    });
    expect(
      screen.getByRole("region", { name: "未加载数据文件" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "切换到文件 sample.csv" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "最新请求无法自动识别格式",
    );
    expect(sidebarOpenLabel()).toBeInTheDocument();
  });

  it("does not let an older concurrent replacement choice overwrite the same slot", async () => {
    const user = userEvent.setup();
    const original = makeDataset({
      sourceId: "c:/slot/original.csv",
      sourceFile: "original.csv",
    });
    mocks.chooseDataFiles.mockResolvedValueOnce([original.sourceId]);
    mocks.loadDataset.mockResolvedValueOnce(original);
    render(<App />);
    await openGenericFile(user);
    await screen.findByRole("button", { name: "切换到文件 original.csv" });

    const olderChoice = deferred<string[] | null>();
    const newerChoice = deferred<string[] | null>();
    mocks.chooseDataFiles
      .mockReturnValueOnce(olderChoice.promise)
      .mockReturnValueOnce(newerChoice.promise);
    mocks.loadDataset.mockResolvedValueOnce(
      makeDataset({
        sourceId: "c:/replacement/newer.csv",
        sourceFile: "newer.csv",
      }),
    );
    act(() => {
      mocks.sidebarProps.current?.onOpen(original.sourceId);
      mocks.sidebarProps.current?.onOpen(original.sourceId);
    });

    await act(async () => {
      newerChoice.resolve(["c:/replacement/newer.csv"]);
      await newerChoice.promise;
    });
    expect(
      await screen.findByRole("button", { name: "切换到文件 newer.csv" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("打开数据文件")).toBeInTheDocument();

    await act(async () => {
      olderChoice.resolve(["c:/replacement/older.csv"]);
      await olderChoice.promise;
    });
    expect(
      screen.getByRole("button", { name: "切换到文件 newer.csv" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.queryByRole("button", { name: "切换到文件 older.csv" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "切换到文件 original.csv" }),
    ).not.toBeInTheDocument();
    expect(mocks.loadDataset).toHaveBeenLastCalledWith([
      "c:/replacement/newer.csv",
    ]);
    expect(screen.getByText("打开数据文件")).toBeInTheDocument();
  });

  it("immediately releases a drag listener whose registration resolves after unmount", async () => {
    const registration = deferred<() => void>();
    mocks.dragRegistration.mockReturnValueOnce(registration.promise);
    const view = render(<App />);

    view.unmount();
    await act(async () => {
      registration.resolve(mocks.unlisten);
      await registration.promise;
    });

    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("reports drag registration rejection without an unhandled promise", async () => {
    const registration = deferred<() => void>();
    mocks.dragRegistration.mockReturnValueOnce(registration.promise);
    render(<App />);

    await act(async () => {
      registration.reject(new Error("拖放监听注册失败"));
      await registration.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "拖放监听注册失败",
    );
  });

  it("reports file chooser rejection and does not start a load", async () => {
    const user = userEvent.setup();
    mocks.chooseDataFiles.mockRejectedValueOnce(new Error("文件选择器不可用"));
    render(<App />);

    await openGenericFile(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "文件选择器不可用",
    );
    expect(mocks.loadDataset).not.toHaveBeenCalled();
    expect(sidebarOpenLabel()).toBeInTheDocument();
  });

  it("resizes and persists the sidebar width by dragging the boundary", () => {
    render(<App />);
    const aside = screen.getByRole("complementary");
    const handle = document.querySelector(".sidebar-resize-handle");
    expect(handle).not.toBeNull();
    vi.spyOn(aside, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 264,
      bottom: 0,
      width: 264,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(handle!, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle!, { clientX: 200, pointerId: 1 });
    fireEvent.pointerUp(handle!, { clientX: 200, pointerId: 1 });

    expect(aside.style.width).toBe("364px");
    expect(localStorage.getItem("chamber-data-viewer:sidebar-width")).toBe(
      "364",
    );
  });

  it("resets the sidebar width on handle double-click", () => {
    localStorage.setItem("chamber-data-viewer:sidebar-width", "380");
    render(<App />);
    const aside = screen.getByRole("complementary");
    const handle = document.querySelector(".sidebar-resize-handle");

    fireEvent.doubleClick(handle!);

    expect(aside.style.width).toBe("264px");
    expect(localStorage.getItem("chamber-data-viewer:sidebar-width")).toBe(
      "264",
    );
  });
});
