import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "./chartSettings";
import type { ChartSettingsWindowPayload } from "./chartSettingsWindow";
import { SettingsWindowApp } from "./SettingsWindowApp";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  emit: vi.fn(),
  setSize: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: vi.fn(
    (name: string, handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, handler);
      return Promise.resolve(() => {});
    },
  ),
}));

vi.mock("@tauri-apps/api/window", async () => {
  const actual = await vi.importActual<typeof import("@tauri-apps/api/window")>(
    "@tauri-apps/api/window",
  );
  return {
    ...actual,
    getCurrentWindow: () => ({
      setSize: mocks.setSize,
      close: mocks.close,
      onCloseRequested: () => Promise.resolve(() => {}),
    }),
  };
});

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

const payload: ChartSettingsWindowPayload = {
  axes: [
    { id: "primary", role: "primary", name: "温度", unit: "degC" },
    { id: "secondary", role: "secondary", name: "湿度", unit: "%RH" },
  ],
  applied: DEFAULT_CHART_SETTINGS,
  displayedExtents: { primary: [10, 80], secondary: [40, 100] },
};

let contentHeight = 0;

beforeEach(() => {
  mocks.listeners.clear();
  mocks.emit.mockReset().mockResolvedValue(undefined);
  mocks.setSize.mockReset().mockResolvedValue(undefined);
  mocks.close.mockReset().mockResolvedValue(undefined);
  resizeObservers.length = 0;
  contentHeight = 312;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const height = this.classList.contains("settings-window-content")
        ? contentHeight
        : 0;
      return {
        x: 0,
        y: 0,
        width: 360,
        height,
        top: 0,
        right: 360,
        bottom: height,
        left: 0,
        toJSON: () => ({}),
      };
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function receivePayload() {
  render(<SettingsWindowApp />);
  await waitFor(() =>
    expect(mocks.emit).toHaveBeenCalledWith("chart-settings:ready"),
  );
  act(() => {
    mocks.listeners.get("chart-settings:init")?.({ payload });
  });
}

describe("SettingsWindowApp", () => {
  it("fits the frameless window to the settings content", async () => {
    await receivePayload();

    expect(screen.getByRole("complementary", { name: "图表设置" })).toBeVisible();
    expect(mocks.setSize).toHaveBeenCalledTimes(1);
    expect(mocks.setSize.mock.calls[0][0]).toMatchObject({
      width: 360,
      height: 312,
    });
  });

  it("follows content growth, such as an inline error, without redundant resizes", async () => {
    await receivePayload();
    const observer = resizeObservers.at(-1)!;

    contentHeight = 336;
    act(() => observer.callback([], observer));
    act(() => observer.callback([], observer));

    expect(mocks.setSize).toHaveBeenCalledTimes(2);
    expect(mocks.setSize.mock.calls[1][0]).toMatchObject({
      width: 360,
      height: 336,
    });
  });
});
