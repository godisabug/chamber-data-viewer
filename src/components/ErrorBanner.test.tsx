import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_BANNER_AUTO_DISMISS_MS, ErrorBanner } from "./ErrorBanner";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ErrorBanner", () => {
  it("shows one load-error category with the backend reason", () => {
    render(<ErrorBanner message="文件已识别，但解析失败：表头无效" onDismiss={vi.fn()} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("无法载入数据");
    expect(alert).toHaveTextContent("文件已识别，但解析失败：表头无效");
  });

  it("dismisses itself after the reading delay", () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="无法读取文件：拒绝访问" onDismiss={onDismiss} />);

    act(() => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays while hovered and restarts the delay after the pointer leaves", () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="无法读取文件：拒绝访问" onDismiss={onDismiss} />);
    const alert = screen.getByRole("alert");

    act(() => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS - 100);
    });
    fireEvent.mouseEnter(alert);
    act(() => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS * 2);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(alert);
    act(() => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("closes from its own button", () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="无法读取文件：拒绝访问" onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
