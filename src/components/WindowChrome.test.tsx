import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  isMaximized: vi.fn<() => Promise<boolean>>(),
  minimize: vi.fn<() => Promise<void>>(),
  onResized: vi.fn<(handler: () => void) => Promise<() => void>>(),
  toggleMaximize: vi.fn<() => Promise<void>>(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mocks,
}));

import { WindowChrome } from "./WindowChrome";

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  mocks.close.mockResolvedValue(undefined);
  mocks.isMaximized.mockResolvedValue(false);
  mocks.minimize.mockResolvedValue(undefined);
  mocks.onResized.mockResolvedValue(mocks.unlisten);
  mocks.toggleMaximize.mockResolvedValue(undefined);
});

describe("WindowChrome", () => {
  it("keeps native window actions in the integrated app surface", async () => {
    render(<WindowChrome />);

    fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));

    expect(mocks.minimize).toHaveBeenCalledOnce();
    expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    const dragRegion = document.querySelector(".window-drag-region");
    expect(dragRegion).toHaveAttribute("data-tauri-drag-region", "deep");
    fireEvent.doubleClick(dragRegion!);
    // Tauri already handles double clicks on drag regions; don't toggle twice.
    expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
  });

  it("tracks maximize changes and releases the resize listener", async () => {
    let resizeHandler: (() => void) | undefined;
    mocks.onResized.mockImplementation(async (handler) => {
      resizeHandler = handler;
      return mocks.unlisten;
    });
    const view = render(<WindowChrome />);
    await waitFor(() => expect(mocks.onResized).toHaveBeenCalledOnce());

    mocks.isMaximized.mockResolvedValue(true);
    resizeHandler?.();

    await screen.findByRole("button", { name: "还原窗口" });
    view.unmount();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
});
