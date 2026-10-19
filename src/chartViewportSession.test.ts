import { describe, expect, it, vi } from "vitest";
import type { ChartInputClock } from "./chartInputScheduler";
import {
  ChartViewportSession,
  type ChartViewport,
  type ChartViewportRenderWindow,
} from "./chartViewportSession";

function deterministicClock() {
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  let nextHandle = 1;
  const clock: ChartInputClock = {
    now: () => 0,
    requestFrame(callback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    setTimer(callback) {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle) {
      timers.delete(Number(handle));
    },
  };
  return {
    clock,
    flushFrame() {
      const pending = [...frames.entries()];
      pending.forEach(([handle, callback]) => {
        frames.delete(handle);
        callback(16);
      });
    },
    flushTimers() {
      const pending = [...timers.entries()];
      pending.forEach(([handle, callback]) => {
        timers.delete(handle);
        callback();
      });
    },
  };
}

function createSession(render = vi.fn()) {
  const time = deterministicClock();
  const commit = vi.fn();
  const session = new ChartViewportSession({
    initial: { range: { start: 0, end: 100 }, axes: {} },
    render,
    commit,
    clock: time.clock,
    idleMs: 100,
  });
  return { session, render, commit, ...time };
}

describe("chart viewport input session", () => {
  it("renders the leading input immediately and coalesces the trailing input", () => {
    const { session, render, flushFrame } = createSession();

    session.push({ range: { start: 10, end: 90 }, source: "command" });
    session.push({ range: { start: 20, end: 80 }, source: "command" });
    session.push({ range: { start: 30, end: 70 }, source: "command" });

    expect(render).toHaveBeenCalledTimes(1);
    expect(session.displayedViewport().range).toEqual({ start: 10, end: 90 });
    expect(session.targetViewport().range).toEqual({ start: 30, end: 70 });
    flushFrame();
    expect(render).toHaveBeenCalledTimes(2);
    expect(session.displayedViewport().range).toEqual({ start: 30, end: 70 });
  });

  it("commits only after the settled viewport renders successfully", () => {
    const { session, render, commit, flushTimers } = createSession();
    session.push({ range: { start: 10, end: 90 }, source: "command" });

    flushTimers();

    expect(render.mock.calls.map(([, quality]) => quality)).toEqual([
      "interactive",
      "settled",
    ]);
    expect(commit).toHaveBeenCalledWith({
      range: { start: 10, end: 90 },
      axes: {},
    });
  });

  it("does not advance displayed state when rendering fails", () => {
    const error = new Error("render failed");
    const render = vi.fn((_viewport: ChartViewport) => {
      throw error;
    });
    const { session, commit } = createSession(render);

    expect(() =>
      session.push({ range: { start: 10, end: 90 }, source: "command" }),
    ).toThrow(error);
    expect(session.displayedViewport().range).toEqual({ start: 0, end: 100 });
    expect(session.targetViewport().range).toEqual({ start: 0, end: 100 });
    expect(session.hasPendingInput()).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves displayed work across an interruption and resumes its commit", () => {
    const { session, commit, flushTimers } = createSession();
    session.push({ range: { start: 10, end: 90 }, source: "command" });
    session.push({ range: { start: 20, end: 80 }, source: "command" });

    const token = session.interrupt(true);
    expect(session.displayedViewport().range).toEqual({ start: 10, end: 90 });
    expect(session.targetViewport().range).toEqual({ start: 10, end: 90 });
    session.resumeCommit(token);
    flushTimers();

    expect(commit).toHaveBeenCalledWith({
      range: { start: 10, end: 90 },
      axes: {},
    });
  });

  it("does not commit while a physical gesture owns the session", () => {
    const { session, commit, flushTimers } = createSession();
    session.beginGesture();
    session.push({ range: { start: 10, end: 90 }, source: "command" });

    flushTimers();
    expect(commit).not.toHaveBeenCalled();

    session.endGesture();
    flushTimers();
    expect(commit).toHaveBeenCalledWith({
      range: { start: 10, end: 90 },
      axes: {},
    });
  });

  it("invalidates an interrupted session when stable state is replaced", () => {
    const { session, commit, flushTimers } = createSession();
    session.push({ range: { start: 10, end: 90 }, source: "command" });
    const token = session.interrupt(true);

    session.replaceStable({ range: { start: 40, end: 60 }, axes: {} });
    session.resumeCommit(token);
    flushTimers();

    expect(session.displayedViewport()).toEqual({
      range: { start: 40, end: 60 },
      axes: null,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps axis changes transient until commit", () => {
    const { session, commit, flushTimers } = createSession();
    session.push({
      range: { start: 0, end: 100 },
      axes: { temperature: { min: 10, max: 40 } },
      source: "command",
    });

    expect(session.displayedViewport().axes).toEqual({
      temperature: { min: 10, max: 40 },
    });
    flushTimers();
    expect(commit).toHaveBeenCalledWith({
      range: { start: 0, end: 100 },
      axes: { temperature: { min: 10, max: 40 } },
    });
    expect(session.displayedViewport().axes).toBeNull();
  });

  it("ignores all stale work after disposal", () => {
    const { session, render, commit, flushFrame, flushTimers } = createSession();
    session.push({ range: { start: 10, end: 90 }, source: "command" });
    session.push({ range: { start: 20, end: 80 }, source: "command" });
    session.dispose();

    flushFrame();
    flushTimers();
    session.push({ range: { start: 30, end: 70 }, source: "command" });

    expect(render).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it("owns interactive and settled render-window reuse", () => {
    const time = deterministicClock();
    const render = vi.fn();
    const prepareWindow = vi.fn(
      (range: { start: number; end: number }, quality: "interactive" | "settled"):
        ChartViewportRenderWindow => ({
        window: {
          range: { start: range.start - 100, end: range.end + 100 },
          seriesData: [[[range.start, quality === "interactive" ? 1 : 2]]],
        },
        quality,
        pixelWidth: 800,
        viewportRange: { ...range },
      }),
    );
    const session = new ChartViewportSession({
      initial: { range: { start: 0, end: 100 }, axes: {} },
      render,
      prepareWindow,
      commit: vi.fn(),
      clock: time.clock,
      idleMs: 100,
    });

    session.push({ range: { start: 10, end: 90 }, source: "command" });
    expect(session.currentRenderData()).toEqual([[[10, 1]]]);
    time.flushTimers();
    expect(session.currentRenderData()).toEqual([[[10, 2]]]);

    const interactiveCallsBeforeReuse = prepareWindow.mock.calls.filter(
      ([, quality]) => quality === "interactive",
    ).length;
    session.push({ range: { start: 20, end: 80 }, source: "command" });
    const interactiveCallsAfterReuse = prepareWindow.mock.calls.filter(
      ([, quality]) => quality === "interactive",
    ).length;

    expect(interactiveCallsAfterReuse).toBe(interactiveCallsBeforeReuse);
    expect(render).toHaveBeenLastCalledWith(
      expect.objectContaining({ range: { start: 20, end: 80 } }),
      "interactive",
      "command",
      expect.objectContaining({ quality: "interactive" }),
      true,
    );
  });
});
