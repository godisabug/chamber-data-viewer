import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHART_INPUT_FRAME_FALLBACK_MS,
  createChartInputScheduler,
  type ChartInputScheduler,
  type ChartInputClock,
} from "./chartInputScheduler";

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function flushFrames(timestamp = 16): void {
  const pending = [...frames.entries()];
  for (const [id, callback] of pending) {
    frames.delete(id);
    callback(timestamp);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  frames.clear();
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chart input scheduler", () => {
  it("runs entirely through an injected deterministic clock", () => {
    const scheduledFrames = new Map<number, FrameRequestCallback>();
    const scheduledTimers = new Map<number, () => void>();
    let nextHandle = 1;
    const clock: ChartInputClock = {
      now: () => 0,
      requestFrame: vi.fn((callback) => {
        const handle = nextHandle++;
        scheduledFrames.set(handle, callback);
        return handle;
      }),
      cancelFrame: vi.fn((handle) => scheduledFrames.delete(handle)),
      setTimer: vi.fn((callback) => {
        const handle = nextHandle++;
        scheduledTimers.set(handle, callback);
        return handle as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: vi.fn((handle) => scheduledTimers.delete(Number(handle))),
    };
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush, clock });

    scheduler.push(1);
    scheduler.push(2);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1]);
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    const trailingFrame = [...scheduledFrames.values()][0];
    trailingFrame?.(16);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(scheduledFrames.size).toBe(0);
    expect(scheduledTimers.size).toBe(0);
  });

  it("flushes the first value synchronously and only the latest trailing value", () => {
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush });

    scheduler.push(1);
    expect(flush).toHaveBeenLastCalledWith(1);
    scheduler.push(2);
    scheduler.push(3);
    expect(flush).toHaveBeenCalledTimes(1);

    flushFrames();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith(3);
  });

  it("defers a push reentered from a leading flush into one trailing batch", () => {
    let scheduler: ChartInputScheduler<number>;
    const flush = vi.fn((value: number) => {
      if (value === 1) scheduler.push(2);
    });
    scheduler = createChartInputScheduler<number>({ flush });

    scheduler.push(1);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1]);
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    flushFrames();
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers a push reentered from a trailing flush to the next frame", () => {
    let scheduler: ChartInputScheduler<number>;
    const flush = vi.fn((value: number) => {
      if (value === 2) scheduler.push(3);
    });
    scheduler = createChartInputScheduler<number>({ flush });

    scheduler.push(1);
    scheduler.push(2);
    flushFrames();
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    flushFrames();
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2, 3]);
  });

  it("lets only the 32ms fallback win when rAF is starved", () => {
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush });
    scheduler.push(1);
    scheduler.push(2);
    const staleFrame = [...frames.values()][0];

    vi.advanceTimersByTime(CHART_INPUT_FRAME_FALLBACK_MS);
    expect(flush).toHaveBeenLastCalledWith(2);
    staleFrame?.(CHART_INPUT_FRAME_FALLBACK_MS + 1);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale callback consume or clear a newer pending batch", () => {
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush });
    scheduler.push(1);
    scheduler.push(2);
    const staleFrame = [...frames.values()][0];
    vi.advanceTimersByTime(CHART_INPUT_FRAME_FALLBACK_MS);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);

    scheduler.push(3);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2, 3]);
    scheduler.push(4);
    staleFrame?.(48);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2, 3]);
    flushFrames();
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2, 3, 4]);
  });

  it("settles the final pending value once and skips equal values", () => {
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush });
    scheduler.push(1);
    scheduler.push(2);
    scheduler.settle(3);
    scheduler.settle(3);
    flushFrames();
    vi.advanceTimersByTime(CHART_INPUT_FRAME_FALLBACK_MS);

    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 3]);
  });

  it("cancels pending work and ignores all work after dispose", () => {
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush });
    scheduler.push(1);
    scheduler.push(2);
    scheduler.cancel();
    flushFrames();
    vi.advanceTimersByTime(CHART_INPUT_FRAME_FALLBACK_MS);
    scheduler.dispose();
    scheduler.push(3);

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("invalidates armed callbacks when disposed repeatedly", () => {
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush });
    scheduler.push(1);
    scheduler.push(2);
    const staleFrame = [...frames.values()][0];

    scheduler.dispose();
    scheduler.dispose();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    staleFrame?.(16);
    vi.advanceTimersByTime(CHART_INPUT_FRAME_FALLBACK_MS);
    scheduler.push(3);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1]);
  });

  it("does not arm after a leading flush cancels its batch", () => {
    let scheduler: ChartInputScheduler<number>;
    const flush = vi.fn((value: number) => {
      if (value === 1) scheduler.cancel();
    });
    scheduler = createChartInputScheduler<number>({ flush });

    scheduler.push(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    scheduler.push(2);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
  });

  it("does not arm after a leading flush disposes the scheduler", () => {
    let scheduler: ChartInputScheduler<number>;
    const flush = vi.fn((_value: number) => {
      scheduler.dispose();
      scheduler.dispose();
    });
    scheduler = createChartInputScheduler<number>({ flush });

    scheduler.push(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.push(2);
    flushFrames();
    vi.advanceTimersByTime(CHART_INPUT_FRAME_FALLBACK_MS);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1]);
  });

  it("keeps a newer batch when an older flush cancels, pushes, and throws", () => {
    const error = new Error("outer flush failed");
    let scheduler: ChartInputScheduler<number>;
    const flush = vi.fn((value: number) => {
      if (value !== 1) return;
      scheduler.cancel();
      scheduler.push(2);
      throw error;
    });
    scheduler = createChartInputScheduler<number>({ flush });

    expect(() => scheduler.push(1)).toThrow(error);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.push(3);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    flushFrames();
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2, 3]);
  });

  it("does not let an older successful flush overwrite a newer reentrant flush", () => {
    let scheduler: ChartInputScheduler<number>;
    const flush = vi.fn((value: number) => {
      if (value !== 1) return;
      scheduler.cancel();
      scheduler.push(2);
    });
    scheduler = createChartInputScheduler<number>({ flush });

    scheduler.push(1);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.cancel();
    scheduler.push(2);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers when requestAnimationFrame registration throws", () => {
    const error = new Error("rAF failed");
    vi.mocked(requestAnimationFrame).mockImplementationOnce(() => {
      throw error;
    });
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush });

    expect(() => scheduler.push(1)).toThrow(error);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    scheduler.push(2);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("cancels the frame and recovers when timer registration throws", () => {
    const error = new Error("timer failed");
    const scheduleTimeout = globalThis.setTimeout;
    vi.stubGlobal(
      "setTimeout",
      vi.fn(scheduleTimeout).mockImplementationOnce(() => {
        throw error;
      }),
    );
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush });

    expect(() => scheduler.push(1)).toThrow(error);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    scheduler.push(2);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("recovers when equals throws", () => {
    const error = new Error("equals failed");
    const equals = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementation(Object.is);
    const flush = vi.fn();
    const scheduler = createChartInputScheduler<number>({ flush, equals });

    scheduler.push(1);
    flushFrames();
    expect(() => scheduler.push(2)).toThrow(error);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    scheduler.push(3);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 3]);
  });

  it("aborts a leading flush when equals disposes its owner", () => {
    let scheduler: ChartInputScheduler<number>;
    const equals = vi.fn((left: number, right: number) => {
      if (right === 2) scheduler.dispose();
      return Object.is(left, right);
    });
    const flush = vi.fn();
    scheduler = createChartInputScheduler<number>({ flush, equals });

    scheduler.push(1);
    flushFrames();
    scheduler.push(2);
    scheduler.push(3);

    expect(flush.mock.calls.map(([value]) => value)).toEqual([1]);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a superseded flush after equals starts a newer batch", () => {
    let scheduler: ChartInputScheduler<number>;
    const equals = vi.fn((left: number, right: number) => {
      if (right === 2) {
        scheduler.cancel();
        scheduler.push(3);
      }
      return Object.is(left, right);
    });
    const flush = vi.fn();
    scheduler = createChartInputScheduler<number>({ flush, equals });

    scheduler.push(1);
    flushFrames();
    scheduler.push(2);

    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 3]);
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("defers a push reentered from equals into the current batch", () => {
    let scheduler: ChartInputScheduler<number>;
    const equals = vi.fn((left: number, right: number) => {
      if (right === 2) scheduler.push(3);
      return Object.is(left, right);
    });
    const flush = vi.fn();
    scheduler = createChartInputScheduler<number>({ flush, equals });

    scheduler.push(1);
    flushFrames();
    scheduler.push(2);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    flushFrames();
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2, 3]);
  });

  it("releases trailing work before propagating a flush error", () => {
    const error = new Error("flush failed");
    const flush = vi.fn()
      .mockImplementationOnce(() => {
        return undefined;
      })
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementation(() => undefined);
    const scheduler = createChartInputScheduler<number>({ flush });

    scheduler.push(1);
    scheduler.push(2);
    expect(() => flushFrames()).toThrow(error);

    scheduler.push(3);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2, 3]);
    flushFrames();
    vi.advanceTimersByTime(CHART_INPUT_FRAME_FALLBACK_MS);
    expect(flush.mock.calls.map(([value]) => value)).toEqual([1, 2, 3]);
  });
});
