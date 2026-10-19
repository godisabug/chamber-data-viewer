import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  SETTINGS_WINDOW_WIDTH,
  type ChartSettingsWindowPayload,
} from "./chartSettingsWindow";
import { ChartSettingsPanel } from "./components/ChartSettingsPanel";

export function SettingsWindowApp() {
  const [payload, setPayload] = useState<ChartSettingsWindowPayload | null>(
    null,
  );
  const contentRef = useRef<HTMLDivElement | null>(null);

  // The window has no frame to resize by hand, so it follows its content:
  // one, two or three axes and any inline validation message.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!payload || !content) return;
    let fittedHeight = 0;
    const fit = () => {
      const height = Math.ceil(content.getBoundingClientRect().height);
      if (height <= 0 || height === fittedHeight) return;
      fittedHeight = height;
      void getCurrentWindow()
        .setSize(new LogicalSize(SETTINGS_WINDOW_WIDTH, height))
        .catch(() => undefined);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    return () => observer.disconnect();
  }, [payload]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    void (async () => {
      const unlistenInit = await listen<ChartSettingsWindowPayload>(
        "chart-settings:init",
        (event) => {
          if (!disposed) setPayload(event.payload);
        },
      );
      if (disposed) {
        unlistenInit();
        return;
      }
      unlisteners.push(unlistenInit);

      const unlistenCloseRequested = await getCurrentWindow().onCloseRequested(
        async (event) => {
          event.preventDefault();
          try {
            await emit("chart-settings:close");
            await getCurrentWindow().hide();
          } catch {
            await getCurrentWindow().destroy();
          }
        },
      );
      if (disposed) {
        unlistenCloseRequested();
        return;
      }
      unlisteners.push(unlistenCloseRequested);

      await emit("chart-settings:ready");
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  if (!payload) return null;

  return (
    <div className="settings-window-content" ref={contentRef}>
      <ChartSettingsPanel
        mode="window"
        axes={payload.axes}
        applied={payload.applied}
        displayedExtents={new Map(Object.entries(payload.displayedExtents))}
        onApply={(settings) => {
          void emit("chart-settings:apply", settings);
          void getCurrentWindow().close();
        }}
        onClose={() => {
          void getCurrentWindow().close();
        }}
      />
    </div>
  );
}
