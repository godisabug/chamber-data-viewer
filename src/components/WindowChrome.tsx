import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function WindowChrome() {
  const tauriRuntime = isTauriRuntime();
  const [maximized, setMaximized] = useState(false);

  const syncMaximized = useCallback(async () => {
    if (!tauriRuntime) return;
    try {
      setMaximized(await getCurrentWindow().isMaximized());
    } catch {
      // Keep the controls usable if querying the current state briefly fails.
    }
  }, [tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();

    void appWindow
      .isMaximized()
      .then((next) => {
        if (!disposed) setMaximized(next);
      })
      .catch(() => undefined);
    void appWindow
      .onResized(() => {
        void syncMaximized();
      })
      .then((handler) => {
        if (disposed) handler();
        else unlisten = handler;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [syncMaximized, tauriRuntime]);

  if (!tauriRuntime) return null;

  const minimize = () => {
    void getCurrentWindow().minimize();
  };
  const toggleMaximized = () => {
    void getCurrentWindow()
      .toggleMaximize()
      .then(syncMaximized)
      .catch(() => undefined);
  };
  const close = () => {
    void getCurrentWindow().close();
  };

  return (
    <div className="window-chrome" aria-label="窗口控制">
      <div
        className="window-drag-region"
        data-tauri-drag-region="deep"
        aria-hidden="true"
      />
      <div className="window-controls">
        <button
          className="window-control"
          type="button"
          aria-label="最小化窗口"
          title="最小化"
          onClick={minimize}
        >
          <span className="window-control-icon is-minimize" aria-hidden="true" />
        </button>
        <button
          className="window-control"
          type="button"
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
          title={maximized ? "还原" : "最大化"}
          onClick={toggleMaximized}
        >
          <span
            className={`window-control-icon ${maximized ? "is-restore" : "is-maximize"}`}
            aria-hidden="true"
          />
        </button>
        <button
          className="window-control is-close"
          type="button"
          aria-label="关闭窗口"
          title="关闭"
          onClick={close}
        >
          <span className="window-control-icon is-close" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
