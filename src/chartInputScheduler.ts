export const CHART_INPUT_FRAME_FALLBACK_MS = 32;

export type ChartInputClock = {
  now: () => number;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
};

export const browserChartInputClock: ChartInputClock = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle),
};

export type ChartInputScheduler<T> = {
  push: (value: T) => void;
  settle: (value?: T) => void;
  cancel: () => void;
  dispose: () => void;
};

type SchedulerOptions<T> = {
  flush: (value: T) => void;
  equals?: (left: T, right: T) => boolean;
  fallbackMs?: number;
  clock?: ChartInputClock;
};

export function createChartInputScheduler<T>({
  flush,
  equals = Object.is,
  fallbackMs = CHART_INPUT_FRAME_FALLBACK_MS,
  clock = browserChartInputClock,
}: SchedulerOptions<T>): ChartInputScheduler<T> {
  let disposed = false;
  let nextToken = 0;
  let activeToken: number | null = null;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | undefined;
  let hasPending = false;
  let lastFlushed: T | undefined;
  let hasLastFlushed = false;
  let nextFlushAttempt = 0;
  let lastCommittedFlushAttempt = 0;

  const flushIfChanged = (value: T, ownerToken: number): boolean => {
    const attempt = ++nextFlushAttempt;
    if (hasLastFlushed) {
      const unchanged = equals(lastFlushed as T, value);
      if (disposed || activeToken !== ownerToken) return false;
      if (unchanged) return false;
    }
    if (disposed || activeToken !== ownerToken) return false;
    flush(value);
    if (attempt > lastCommittedFlushAttempt) {
      lastFlushed = value;
      hasLastFlushed = true;
      lastCommittedFlushAttempt = attempt;
    }
    return true;
  };

  const cancelHandles = () => {
    const frameToCancel = frame;
    const timerToCancel = timer;
    frame = null;
    timer = null;
    if (frameToCancel !== null) clock.cancelFrame(frameToCancel);
    if (timerToCancel !== null) clock.clearTimer(timerToCancel);
  };

  const releaseOwnedBatch = (token: number): boolean => {
    if (activeToken !== token) return false;
    activeToken = null;
    pending = undefined;
    hasPending = false;
    cancelHandles();
    return true;
  };

  const discardHandles = (
    frameToCancel: number | null,
    timerToCancel: ReturnType<typeof setTimeout> | null,
  ) => {
    if (frameToCancel !== null) clock.cancelFrame(frameToCancel);
    if (timerToCancel !== null) clock.clearTimer(timerToCancel);
  };

  let claim: (token: number) => void;

  const arm = (token: number) => {
    if (disposed || activeToken !== token) return;

    let scheduledFrame: number | null = null;
    let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      scheduledFrame = clock.requestFrame(() => claim(token));
      if (disposed || activeToken !== token) {
        discardHandles(scheduledFrame, null);
        return;
      }

      scheduledTimer = clock.setTimer(() => claim(token), fallbackMs);
      if (disposed || activeToken !== token) {
        discardHandles(scheduledFrame, scheduledTimer);
        return;
      }

      frame = scheduledFrame;
      timer = scheduledTimer;
    } catch (error) {
      discardHandles(scheduledFrame, scheduledTimer);
      releaseOwnedBatch(token);
      throw error;
    }
  };

  const armPendingSuccessor = (token: number) => {
    if (disposed || activeToken !== token || !hasPending) return;
    const successor = ++nextToken;
    activeToken = successor;
    try {
      arm(successor);
    } catch (error) {
      releaseOwnedBatch(successor);
      throw error;
    }
  };

  claim = (token: number) => {
    if (disposed || activeToken !== token) return;

    // The winning callback owns the batch while user code runs. Keeping the
    // token active makes reentrant pushes latest-pending instead of recursive.
    cancelHandles();
    if (!hasPending) {
      activeToken = null;
      return;
    }

    const value = pending as T;
    pending = undefined;
    hasPending = false;
    try {
      flushIfChanged(value, token);
    } catch (error) {
      releaseOwnedBatch(token);
      throw error;
    }

    if (disposed || activeToken !== token) return;
    if (hasPending) {
      armPendingSuccessor(token);
    } else {
      activeToken = null;
    }
  };

  const flushLeading = (value: T, armWhenChanged: boolean) => {
    const token = ++nextToken;
    activeToken = token;

    let changed: boolean;
    try {
      changed = flushIfChanged(value, token);
    } catch (error) {
      releaseOwnedBatch(token);
      throw error;
    }

    if (disposed || activeToken !== token) return;
    if (!changed && !hasPending) {
      releaseOwnedBatch(token);
      return;
    }
    if (!armWhenChanged && !hasPending) {
      releaseOwnedBatch(token);
      return;
    }

    try {
      arm(token);
    } catch (error) {
      releaseOwnedBatch(token);
      throw error;
    }
  };

  const cancel = () => {
    nextToken += 1;
    activeToken = null;
    pending = undefined;
    hasPending = false;
    cancelHandles();
  };

  return {
    push(value) {
      if (disposed) return;
      if (activeToken === null) {
        flushLeading(value, true);
        return;
      }
      pending = value;
      hasPending = true;
    },
    settle(value) {
      if (disposed) return;
      if (value !== undefined) {
        pending = value;
        hasPending = true;
      }
      const valueToFlush = pending;
      const shouldFlush = hasPending;
      cancel();
      if (shouldFlush) flushLeading(valueToFlush as T, false);
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
    },
  };
}
