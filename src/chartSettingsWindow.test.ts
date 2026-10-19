import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "./chartSettings";
import type { ChartSettingsWindowPayload } from "./chartSettingsWindow";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  listen: vi.fn(),
  getCurrentWindow: vi.fn(),
  currentMonitor: vi.fn(),
  WebviewWindow: vi.fn(),
  getByLabel: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/api/window", async () => {
  const actual = await vi.importActual<typeof import("@tauri-apps/api/window")>(
    "@tauri-apps/api/window",
  );
  return {
    ...actual,
    getCurrentWindow: mocks.getCurrentWindow,
    currentMonitor: mocks.currentMonitor,
  };
});

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: Object.assign(mocks.WebviewWindow, {
    getByLabel: mocks.getByLabel,
  }),
}));

const payload: ChartSettingsWindowPayload = {
  axes: [
    { id: "primary", role: "primary", name: "温度", unit: "°C" },
    { id: "secondary", role: "secondary", name: "湿度", unit: "%RH" },
  ],
  applied: DEFAULT_CHART_SETTINGS,
  displayedExtents: {
    primary: [10, 80] as const,
    secondary: [40, 100] as const,
  },
};

function makeWindowMock() {
  return {
    once: vi.fn((event: string, callback: () => void) => {
      if (event === "tauri://created") callback();
    }),
    show: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined),
    setPosition: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
  };
}

async function loadChartSettingsWindow() {
  vi.resetModules();
  return await import("./chartSettingsWindow");
}

beforeEach(() => {
  mocks.emit.mockReset().mockResolvedValue(undefined);
  mocks.listen.mockReset();
  mocks.getCurrentWindow.mockReset();
  mocks.currentMonitor.mockReset().mockResolvedValue({
    name: "Test Monitor",
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    workArea: {
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1080 },
    },
    scaleFactor: 1,
  });
  mocks.WebviewWindow.mockReset();
  mocks.getByLabel.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("chartSettingsWindow", () => {
  it("detects the Tauri runtime", async () => {
    const module = await loadChartSettingsWindow();
    expect(module.isTauriRuntime()).toBe(false);
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(module.isTauriRuntime()).toBe(true);
  });

  it("creates a compact floating window below the command band in physical pixels", async () => {
    const module = await loadChartSettingsWindow();
    const windowMock = makeWindowMock();
    const mainWindow = {
      outerPosition: vi.fn().mockResolvedValue({ x: 100, y: 50 }),
      outerSize: vi.fn().mockResolvedValue({ width: 1280, height: 800 }),
      scaleFactor: vi.fn().mockResolvedValue(1),
    };
    mocks.getCurrentWindow.mockReturnValue(mainWindow);
    mocks.WebviewWindow.mockImplementation(function () {
      return windowMock;
    });

    await module.openChartSettingsWindow(payload);

    expect(mocks.WebviewWindow).toHaveBeenCalledWith(
      "chart-settings",
      expect.objectContaining({
        url: "index.html?window=chart-settings",
        title: "图表设置",
        width: 360,
        height: 315,
        decorations: false,
        resizable: false,
        skipTaskbar: true,
        parent: mainWindow,
      }),
    );
    const position = windowMock.setPosition.mock.calls[0][0];
    expect(position.x).toBe(100 + 1280 - 360 - 16);
    expect(position.y).toBe(50 + 104);
    expect(windowMock.setPosition.mock.invocationCallOrder[0]).toBeLessThan(
      windowMock.show.mock.invocationCallOrder[0],
    );
    expect(windowMock.show).toHaveBeenCalledTimes(1);
    expect(windowMock.setFocus).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith("chart-settings:init", payload);
  });

  it("reuses an existing floating window", async () => {
    const module = await loadChartSettingsWindow();
    const existing = makeWindowMock();
    mocks.getCurrentWindow.mockReturnValue({
      outerPosition: vi.fn().mockResolvedValue({ x: 100, y: 50 }),
      outerSize: vi.fn().mockResolvedValue({ width: 1280, height: 800 }),
      scaleFactor: vi.fn().mockResolvedValue(1),
    });
    mocks.getByLabel.mockResolvedValue(existing);

    await module.openChartSettingsWindow(payload);

    expect(mocks.WebviewWindow).not.toHaveBeenCalled();
    expect(existing.setPosition).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith("chart-settings:init", payload);
  });

  it("hides the floating window on close for instant reuse", async () => {
    const module = await loadChartSettingsWindow();
    const windowMock = makeWindowMock();
    mocks.getByLabel.mockResolvedValue(windowMock);

    await module.closeChartSettingsWindow();

    expect(windowMock.hide).toHaveBeenCalledTimes(1);
    expect(windowMock.destroy).not.toHaveBeenCalled();
  });

  it("prewarms the floating window without showing, positioning or emitting", async () => {
    const module = await loadChartSettingsWindow();
    const windowMock = makeWindowMock();
    mocks.getCurrentWindow.mockReturnValue({
      outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
      outerSize: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
      scaleFactor: vi.fn().mockResolvedValue(1),
    });
    mocks.WebviewWindow.mockImplementation(function () {
      return windowMock;
    });

    await module.prewarmChartSettingsWindow();

    expect(mocks.WebviewWindow).toHaveBeenCalledWith(
      "chart-settings",
      expect.objectContaining({ visible: false }),
    );
    expect(windowMock.setPosition).not.toHaveBeenCalled();
    expect(windowMock.show).not.toHaveBeenCalled();
    expect(windowMock.setFocus).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("clamps the floating window into the current monitor work area", async () => {
    const module = await loadChartSettingsWindow();
    const windowMock = makeWindowMock();
    const mainWindow = {
      outerPosition: vi.fn().mockResolvedValue({ x: 1700, y: 50 }),
      outerSize: vi.fn().mockResolvedValue({ width: 1280, height: 800 }),
      scaleFactor: vi.fn().mockResolvedValue(1),
    };
    mocks.getCurrentWindow.mockReturnValue(mainWindow);
    mocks.WebviewWindow.mockImplementation(function () {
      return windowMock;
    });

    await module.openChartSettingsWindow(payload);

    const position = windowMock.setPosition.mock.calls[0][0];
    expect(position.x).toBe(1920 - 360);
    expect(position.y).toBe(50 + 104);
  });

  it("scales the floating window placement with the display scale factor", async () => {
    const module = await loadChartSettingsWindow();
    const windowMock = makeWindowMock();
    mocks.currentMonitor.mockResolvedValue({
      name: "Scaled Monitor",
      position: { x: 0, y: 0 },
      size: { width: 2560, height: 1440 },
      workArea: {
        position: { x: 0, y: 0 },
        size: { width: 2560, height: 1440 },
      },
      scaleFactor: 2,
    });
    mocks.getCurrentWindow.mockReturnValue({
      outerPosition: vi.fn().mockResolvedValue({ x: 100, y: 50 }),
      outerSize: vi.fn().mockResolvedValue({ width: 1280, height: 800 }),
      scaleFactor: vi.fn().mockResolvedValue(2),
    });
    mocks.WebviewWindow.mockImplementation(function () {
      return windowMock;
    });

    await module.openChartSettingsWindow(payload);

    const position = windowMock.setPosition.mock.calls[0][0];
    // 360 logical px == 720 physical px at 2x; the inset and offset double too.
    expect(position.x).toBe(100 + 1280 - 720 - 16 * 2);
    expect(position.y).toBe(50 + 104 * 2);
  });

  it("forwards apply and close events to the main app handlers", async () => {
    const module = await loadChartSettingsWindow();
    const listeners: Record<string, (event: { payload: unknown }) => void> = {};
    mocks.listen.mockImplementation(
      (name: string, handler: (event: { payload: unknown }) => void) => {
        listeners[name] = handler;
        return Promise.resolve(() => {});
      },
    );
    const onApply = vi.fn();
    const onClose = vi.fn();

    const unlisten = module.subscribeChartSettingsWindowEvents({
      onApply,
      onClose,
    });
    await Promise.resolve();

    const settings = {
      axes: { primary: { min: 20, max: 30 } },
      yGridCount: 6,
      xGridCount: 6,
    };
    listeners["chart-settings:apply"]({ payload: settings });
    listeners["chart-settings:close"]({ payload: undefined });

    expect(onApply).toHaveBeenCalledWith(settings);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(listeners).not.toHaveProperty("chart-settings:reset");
    expect(mocks.emit).not.toHaveBeenCalled();
    unlisten();
  });

  it("replies to the window ready event with the latest payload", async () => {
    const module = await loadChartSettingsWindow();
    mocks.getCurrentWindow.mockReturnValue({
      outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
      outerSize: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
      scaleFactor: vi.fn().mockResolvedValue(1),
    });
    mocks.WebviewWindow.mockImplementation(function () {
      return makeWindowMock();
    });
    await module.openChartSettingsWindow(payload);

    const listeners: Record<string, (event: { payload: unknown }) => void> = {};
    mocks.listen.mockImplementation(
      (name: string, handler: (event: { payload: unknown }) => void) => {
        listeners[name] = handler;
        return Promise.resolve(() => {});
      },
    );
    module.subscribeChartSettingsWindowEvents({
      onApply: vi.fn(),
      onClose: vi.fn(),
    });
    await Promise.resolve();

    listeners["chart-settings:ready"]({ payload: undefined });

    expect(mocks.emit).toHaveBeenLastCalledWith(
      "chart-settings:init",
      payload,
    );
  });
});
