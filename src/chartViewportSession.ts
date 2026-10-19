import type { NumericRange } from "./chartRange";
import type { AxisBounds } from "./chartSettings";
import {
  containsRange,
  type ChartLodWindow,
  type LodQuality,
} from "./chartLod";
import {
  browserChartInputClock,
  createChartInputScheduler,
  type ChartInputClock,
  type ChartInputScheduler,
} from "./chartInputScheduler";

export type ChartViewport = {
  range: NumericRange;
  axes: Record<string, AxisBounds> | null;
};

export type ChartViewportInput = {
  range: NumericRange;
  axes?: Record<string, AxisBounds>;
  source: "command" | "native";
};

export type ChartViewportRenderQuality = "interactive" | "settled";

export type ChartViewportRenderWindow = {
  window: ChartLodWindow;
  quality: Exclude<LodQuality, "export">;
  pixelWidth: number;
  viewportRange: NumericRange;
};

type StableViewport = {
  range: NumericRange;
  axes: Record<string, AxisBounds>;
};

type QueuedViewportInput = ChartViewport & {
  source: ChartViewportInput["source"];
};

type ChartViewportSessionOptions = {
  initial: StableViewport;
  render: (
    viewport: ChartViewport,
    quality: ChartViewportRenderQuality,
    source: ChartViewportInput["source"],
    renderWindow: ChartViewportRenderWindow | null,
    renderDataChanged: boolean,
  ) => boolean | void;
  prepareWindow?: (
    range: NumericRange,
    quality: ChartViewportRenderQuality,
  ) => ChartViewportRenderWindow | null;
  commit: (viewport: StableViewport) => void;
  clock?: ChartInputClock;
  idleMs: number;
};

function cloneRange(range: NumericRange): NumericRange {
  return { start: range.start, end: range.end };
}

function cloneAxes(
  axes: Record<string, AxisBounds> | null | undefined,
): Record<string, AxisBounds> | null {
  if (axes == null) return null;
  return Object.fromEntries(
    Object.entries(axes).map(([axisId, bounds]) => [
      axisId,
      { ...bounds },
    ]),
  );
}

function cloneViewport(viewport: ChartViewport): ChartViewport {
  return { range: cloneRange(viewport.range), axes: cloneAxes(viewport.axes) };
}

function rangesEqual(left: NumericRange, right: NumericRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function axesEqual(
  left: Record<string, AxisBounds> | null,
  right: Record<string, AxisBounds> | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([axisId, bounds]) => {
    const other = right[axisId];
    return other?.min === bounds.min && other?.max === bounds.max;
  });
}

function viewportsEqual(left: ChartViewport, right: ChartViewport): boolean {
  return rangesEqual(left.range, right.range) && axesEqual(left.axes, right.axes);
}

export class ChartViewportSession {
  private readonly options: ChartViewportSessionOptions;
  private stable: StableViewport;
  private displayed: ChartViewport;
  private requested: QueuedViewportInput | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scheduler: ChartInputScheduler<QueuedViewportInput>;
  private readonly clock: ChartInputClock;
  private disposed = false;
  private generation = 0;
  private gestureActive = false;
  private installedWindow: ChartViewportRenderWindow | null = null;
  private interactiveWindow: ChartViewportRenderWindow | null = null;
  private settledWindow: ChartViewportRenderWindow | null = null;

  constructor(options: ChartViewportSessionOptions) {
    this.options = options;
    this.clock = options.clock ?? browserChartInputClock;
    this.stable = {
      range: cloneRange(options.initial.range),
      axes: cloneAxes(options.initial.axes) ?? {},
    };
    this.displayed = { range: cloneRange(this.stable.range), axes: null };
    this.scheduler = createChartInputScheduler<QueuedViewportInput>({
      flush: (input) => this.flush(input),
      equals: (_left, right) => viewportsEqual(this.displayed, right),
      clock: this.clock,
    });
  }

  displayedViewport(): ChartViewport {
    return cloneViewport(this.displayed);
  }

  stableViewport(): StableViewport {
    return {
      range: cloneRange(this.stable.range),
      axes: cloneAxes(this.stable.axes) ?? {},
    };
  }

  targetViewport(): ChartViewport {
    if (this.requested === null) return this.displayedViewport();
    return {
      range: cloneRange(this.requested.range),
      axes: cloneAxes(this.requested.axes ?? this.displayed.axes),
    };
  }

  hasPendingInput(): boolean {
    return this.requested !== null;
  }

  currentRenderData(): ChartLodWindow["seriesData"] | null {
    return this.installedWindow?.window.seriesData ?? null;
  }

  primeSettledWindow(renderWindow: ChartViewportRenderWindow): void {
    this.installedWindow = renderWindow;
    this.settledWindow = renderWindow;
    this.interactiveWindow = this.prepareWindow(
      this.displayed.range,
      "interactive",
    );
  }

  invalidateWindows(): void {
    this.installedWindow = null;
    this.interactiveWindow = null;
    this.settledWindow = null;
  }

  refreshSettled(): void {
    if (this.disposed) return;
    this.render(this.displayed, "settled", "command");
  }

  restoreDisplayed(): void {
    if (this.disposed) return;
    const quality = this.installedWindow?.quality ?? "settled";
    const renderWindow = this.prepareWindow(this.displayed.range, quality);
    const rendered = this.options.render(
      this.displayed,
      quality,
      "command",
      renderWindow,
      true,
    );
    if (rendered !== false && renderWindow !== null) {
      this.installedWindow = renderWindow;
    }
  }

  beginGesture(): void {
    if (this.disposed) return;
    this.gestureActive = true;
    this.cancelIdleCommit();
  }

  endGesture(): void {
    if (this.disposed || !this.gestureActive) return;
    this.gestureActive = false;
    if (this.requested === null && this.differsFromStable()) {
      this.restartIdleCommit();
    }
  }

  push(input: ChartViewportInput): void {
    if (this.disposed) return;
    const normalized = this.normalize(input);
    if (viewportsEqual(normalized, this.targetViewport())) return;
    this.requested = normalized;
    this.scheduler.push(this.requested);
  }

  settle(input?: ChartViewportInput): void {
    if (this.disposed) return;
    if (input !== undefined) {
      const normalized = this.normalize(input);
      if (viewportsEqual(normalized, this.displayed)) {
        this.scheduler.cancel();
        this.requested = null;
      } else {
        this.requested = normalized;
      }
    }
    this.scheduler.settle(this.requested ?? undefined);
    if (this.requested === null && this.differsFromStable()) {
      this.restartIdleCommit();
    }
  }

  interrupt(preserveDisplayed: boolean): number | null {
    if (this.disposed) return null;
    this.scheduler.cancel();
    this.requested = null;
    this.gestureActive = false;
    this.cancelIdleCommit();
    if (!preserveDisplayed || !this.differsFromStable()) return null;
    return this.generation;
  }

  resumeCommit(generation: number | null): void {
    if (
      generation === null ||
      this.disposed ||
      generation !== this.generation ||
      !this.differsFromStable()
    ) {
      return;
    }
    this.restartIdleCommit();
  }

  replaceStable(viewport: StableViewport): void {
    if (this.disposed) return;
    this.generation += 1;
    this.scheduler.cancel();
    this.cancelIdleCommit();
    this.requested = null;
    this.gestureActive = false;
    this.stable = {
      range: cloneRange(viewport.range),
      axes: cloneAxes(viewport.axes) ?? {},
    };
    this.displayed = { range: cloneRange(viewport.range), axes: null };
    this.invalidateWindows();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.scheduler.dispose();
    this.cancelIdleCommit();
    this.requested = null;
    this.invalidateWindows();
  }

  private normalize(input: ChartViewportInput): QueuedViewportInput {
    return {
      range: cloneRange(input.range),
      axes: cloneAxes(input.axes ?? this.targetViewport().axes),
      source: input.source,
    };
  }

  private flush(input: QueuedViewportInput): void {
    if (this.disposed) return;
    const viewport: ChartViewport = {
      range: cloneRange(input.range),
      axes: cloneAxes(input.axes ?? this.displayed.axes),
    };
    try {
      if (!this.render(viewport, "interactive", input.source)) {
        this.cancelFailedInput();
        return;
      }
    } catch (error) {
      this.cancelFailedInput();
      throw error;
    }
    this.displayed = cloneViewport(viewport);
    if (
      this.requested !== null &&
      viewportsEqual(this.targetViewport(), viewport)
    ) {
      this.requested = null;
    }
    this.restartIdleCommit();
  }

  private differsFromStable(): boolean {
    if (!rangesEqual(this.displayed.range, this.stable.range)) return true;
    if (this.displayed.axes === null) return false;
    const mergedAxes = { ...this.stable.axes, ...this.displayed.axes };
    return !axesEqual(mergedAxes, this.stable.axes);
  }

  private restartIdleCommit(): void {
    this.cancelIdleCommit();
    const generation = this.generation;
    this.idleTimer = this.clock.setTimer(() => {
      if (this.disposed || generation !== this.generation) return;
      this.idleTimer = null;
      if (this.gestureActive) return;
      const settled = this.displayedViewport();
      if (!this.render(settled, "settled", "command")) return;
      const nextStable: StableViewport = {
        range: cloneRange(settled.range),
        axes: {
          ...this.stable.axes,
          ...(cloneAxes(settled.axes) ?? {}),
        },
      };
      this.options.commit(nextStable);
      this.stable = nextStable;
      this.displayed = { range: cloneRange(nextStable.range), axes: null };
    }, this.options.idleMs);
  }

  private cancelIdleCommit(): void {
    if (this.idleTimer === null) return;
    this.clock.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  private cancelFailedInput(): void {
    this.requested = null;
    this.scheduler.cancel();
    this.cancelIdleCommit();
  }

  private prepareWindow(
    range: NumericRange,
    quality: ChartViewportRenderQuality,
  ): ChartViewportRenderWindow | null {
    const cached =
      quality === "interactive"
        ? this.interactiveWindow
        : this.settledWindow;
    if (
      cached !== null &&
      cached.quality === quality &&
      containsRange(cached.window.range, range)
    ) {
      const cachedSpan =
        cached.viewportRange.end - cached.viewportRange.start;
      const requestedSpan = range.end - range.start;
      if (quality === "interactive" || cachedSpan <= requestedSpan) {
        return cached;
      }
    }
    return this.options.prepareWindow?.(range, quality) ?? null;
  }

  private render(
    viewport: ChartViewport,
    quality: ChartViewportRenderQuality,
    source: ChartViewportInput["source"],
  ): boolean {
    const renderWindow = this.prepareWindow(viewport.range, quality);
    const rendered = this.options.render(
      viewport,
      quality,
      source,
      renderWindow,
      this.installedWindow !== renderWindow,
    );
    if (rendered === false) return false;
    if (renderWindow === null) return true;
    this.installedWindow = renderWindow;
    if (quality === "interactive") {
      this.interactiveWindow = renderWindow;
      return true;
    }
    this.settledWindow = renderWindow;
    this.interactiveWindow = this.options.prepareWindow?.(
      viewport.range,
      "interactive",
    ) ?? null;
    return true;
  }
}
