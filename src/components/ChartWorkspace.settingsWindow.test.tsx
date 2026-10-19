import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareDataset } from "../chartSeries";
import { makeDataset } from "../test/fixtures";
import { ChartWorkspace } from "./ChartWorkspace";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  prewarm: vi.fn(),
  handlers: {
    current: null as null | {
      onApply: (settings: unknown) => void;
      onClose: () => void;
    },
  },
}));

vi.mock("./ChartView", () => ({
  ChartView: () => null,
}));

vi.mock("../chartSettingsWindow", () => ({
  isTauriRuntime: () => true,
  openChartSettingsWindow: mocks.open,
  closeChartSettingsWindow: mocks.close,
  prewarmChartSettingsWindow: mocks.prewarm,
  subscribeChartSettingsWindowEvents: (
    handlers: typeof mocks.handlers.current,
  ) => {
    mocks.handlers.current = handlers;
    return () => {};
  },
}));

const makePreparedDataset = () => prepareDataset(makeDataset());

beforeEach(() => {
  mocks.open.mockReset();
  mocks.close.mockReset();
  mocks.prewarm.mockReset();
  mocks.handlers.current = null;
});

describe("ChartWorkspace with a floating settings window", () => {
  it("prewarms the floating window on mount", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);
    expect(mocks.prewarm).toHaveBeenCalledTimes(1);
  });

  it("opens the floating window with the current payload", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);
    expect(mocks.close).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));

    expect(mocks.open).toHaveBeenCalledTimes(1);
    const payload = mocks.open.mock.calls[0][0];
    expect(payload.axes).toEqual(makePreparedDataset().axes);
    expect(payload.applied).toEqual({
      axes: {},
      yGridCount: 6,
      xGridCount: 6,
    });
    expect(payload.displayedExtents).toEqual(
      expect.objectContaining({
        primary: expect.anything(),
        secondary: expect.anything(),
      }),
    );
  });

  it("closes the floating window when settings are toggled off", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);

    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    expect(mocks.close).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it("applies settings sent from the floating window", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));

    act(() => {
      mocks.handlers.current?.onApply({
        axes: { primary: { min: 20, max: 30 } },
        yGridCount: 6,
        xGridCount: 6,
      });
    });

    const lastPayload = mocks.open.mock.calls.at(-1)?.[0];
    expect(lastPayload.applied).toEqual({
      axes: { primary: { min: 20, max: 30 } },
      yGridCount: 6,
      xGridCount: 6,
    });
  });

  it("resets time range and settings from the range reset button", () => {
    const view = render(<ChartWorkspace dataset={makePreparedDataset()} />);
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));

    act(() => {
      mocks.handlers.current?.onApply({
        axes: { primary: { min: 20, max: 30 } },
        yGridCount: 4,
        xGridCount: 7,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "重置视图" }));

    const lastPayload = mocks.open.mock.calls.at(-1)?.[0];
    expect(lastPayload.applied).toEqual({
      axes: {},
      yGridCount: 6,
      xGridCount: 6,
    });
    const workspace = view.container.querySelector("section.workspace-panel");
    expect(workspace).toHaveAttribute(
      "data-applied-range-start",
      String(new Date("2025-12-31T23:59:42").getTime()),
    );
    expect(workspace).toHaveAttribute(
      "data-applied-range-end",
      String(new Date("2026-01-01T00:10:18").getTime()),
    );
  });

  it("marks settings closed when the floating window closes", () => {
    render(<ChartWorkspace dataset={makePreparedDataset()} />);
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    const toggle = screen.getByRole("button", { name: "图表设置" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    act(() => {
      mocks.handlers.current?.onClose();
    });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
