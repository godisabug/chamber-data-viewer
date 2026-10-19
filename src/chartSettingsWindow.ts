import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AppliedChartSettings, AxisExtent } from "./chartSettings";
import type { Axis } from "./types";

export const CHART_SETTINGS_WINDOW_LABEL = "chart-settings";

/** Logical width; the settings webview fits its height to the content. */
export const SETTINGS_WINDOW_WIDTH = 360;
/** Initial logical height for the common two-axis layout. */
const SETTINGS_WINDOW_HEIGHT = 315;
/** Aligns the right edge with the command band's 16px inset. */
const SETTINGS_WINDOW_MARGIN = 16;
/** Opens just below the 32px title strip and 72px command band, like the help popover. */
const SETTINGS_WINDOW_TOP_OFFSET = 104;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Computes the physical screen position for the settings window:
 * anchored below the main window's command band at its right edge, then
 * clamped into the current monitor's work area so the window can never be
 * placed off-screen.
 *
 * All values stay in physical pixels; the window is positioned with
 * `setPosition(PhysicalPosition)` after creation, avoiding the logical-pixel
 * semantics of the `x`/`y` creation options entirely.
 */
async function computeSettingsWindowPosition(): Promise<PhysicalPosition> {
  const mainWindow = getCurrentWindow();
  const [position, size, scaleFactor, monitor] = await Promise.all([
    mainWindow.outerPosition(),
    mainWindow.outerSize(),
    mainWindow.scaleFactor(),
    currentMonitor(),
  ]);

  const settingsWidth = Math.round(SETTINGS_WINDOW_WIDTH * scaleFactor);
  const settingsHeight = Math.round(SETTINGS_WINDOW_HEIGHT * scaleFactor);
  const margin = Math.round(SETTINGS_WINDOW_MARGIN * scaleFactor);
  const topOffset = Math.round(SETTINGS_WINDOW_TOP_OFFSET * scaleFactor);

  const x = position.x + Math.max(0, size.width - settingsWidth - margin);
  const y = position.y + topOffset;

  const workArea = monitor?.workArea;
  if (!workArea) return new PhysicalPosition(x, y);
  return new PhysicalPosition(
    clamp(
      x,
      workArea.position.x,
      workArea.position.x + Math.max(0, workArea.size.width - settingsWidth),
    ),
    clamp(
      y,
      workArea.position.y,
      workArea.position.y + Math.max(0, workArea.size.height - settingsHeight),
    ),
  );
}

export type ChartSettingsWindowPayload = {
  axes: Axis[];
  applied: AppliedChartSettings;
  displayedExtents: Record<string, AxisExtent | null>;
};

export type ChartSettingsWindowHandlers = {
  onApply: (settings: AppliedChartSettings) => void;
  onClose: () => void;
};

let settingsWindow: WebviewWindow | null = null;
let settingsWindowOpening: Promise<WebviewWindow | null> | null = null;
let latestPayload: ChartSettingsWindowPayload | null = null;

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  );
}

async function ensureSettingsWindow(): Promise<WebviewWindow | null> {
  if (settingsWindowOpening) return settingsWindowOpening;

  settingsWindowOpening = (async () => {
    const existing =
      await WebviewWindow.getByLabel(CHART_SETTINGS_WINDOW_LABEL);
    if (existing) {
      settingsWindow = existing;
      return existing;
    }
    settingsWindow = null;

    const mainWindow = getCurrentWindow();
    const window = new WebviewWindow(CHART_SETTINGS_WINDOW_LABEL, {
      url: "index.html?window=chart-settings",
      title: "图表设置",
      width: SETTINGS_WINDOW_WIDTH,
      height: SETTINGS_WINDOW_HEIGHT,
      decorations: false,
      resizable: false,
      visible: false,
      shadow: true,
      skipTaskbar: true,
      parent: mainWindow,
    });
    await new Promise<void>((resolve, reject) => {
      window.once("tauri://created", () => resolve());
      window.once("tauri://error", (event) =>
        reject(new Error(String(event.payload))),
      );
    });
    settingsWindow = window;
    return window;
  })();

  try {
    return await settingsWindowOpening;
  } finally {
    settingsWindowOpening = null;
  }
}

export async function openChartSettingsWindow(
  payload: ChartSettingsWindowPayload,
): Promise<void> {
  latestPayload = payload;
  const window = await ensureSettingsWindow();
  if (!window) return;
  if (latestPayload !== payload) {
    settingsWindow = null;
    await window.destroy();
    return;
  }
  try {
    // Re-derive the position on every open so a prewarmed window never
    // keeps stale geometry (e.g. the main window moved since startup).
    await window.setPosition(await computeSettingsWindowPosition());
  } catch {
    // Positioning is best-effort; the window still opens at its current spot.
  }
  await window.show();
  await window.setFocus();
  await emit("chart-settings:init", payload);
}

export async function closeChartSettingsWindow(): Promise<void> {
  latestPayload = null;
  const window =
    settingsWindow ??
    (await WebviewWindow.getByLabel(CHART_SETTINGS_WINDOW_LABEL));
  if (!window) return;
  try {
    await window.hide();
  } catch {
    // The window may already have been closed by the settings webview.
  }
}

export async function prewarmChartSettingsWindow(): Promise<void> {
  await ensureSettingsWindow();
}

export function subscribeChartSettingsWindowEvents(
  handlers: ChartSettingsWindowHandlers,
): () => void {
  let disposed = false;
  const unlisteners: UnlistenFn[] = [];

  void Promise.all([
    listen<AppliedChartSettings>("chart-settings:apply", (event) => {
      if (!disposed) handlers.onApply(event.payload);
    }),
    listen<void>("chart-settings:close", () => {
      if (!disposed) handlers.onClose();
    }),
    listen<void>("chart-settings:ready", () => {
      if (disposed || !latestPayload) return;
      void emit("chart-settings:init", latestPayload);
    }),
  ]).then((listeners) => {
    if (disposed) {
      for (const unlisten of listeners) unlisten();
    } else {
      unlisteners.push(...listeners);
    }
  });

  return () => {
    disposed = true;
    for (const unlisten of unlisteners) unlisten();
  };
}
