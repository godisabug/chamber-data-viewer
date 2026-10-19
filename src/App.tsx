import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ChartWorkspace } from "./components/ChartWorkspace";
import { EmptyState } from "./components/EmptyState";
import { ErrorBanner } from "./components/ErrorBanner";
import { Sidebar } from "./components/Sidebar";
import {
  loadSidebarCollapsed,
  storeSidebarCollapsed,
} from "./sidebarCollapsed";
import { WindowChrome } from "./components/WindowChrome";
import { prepareDataset, type PreparedDataset } from "./chartSeries";
import { mergeDataset, moveDataset, removeDataset } from "./datasetCollection";
import {
  effectiveSidebarMaxWidth,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./sidebarWidth";
import { chooseDataFiles, loadDataset } from "./tauri";

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "无法读取文件";
}

type FileState = {
  datasets: PreparedDataset[];
  activeSourceId: string | null;
};

type FileAction =
  | { type: "merge"; loaded: PreparedDataset; replaceSourceId?: string; activate: boolean }
  | { type: "delete"; sourceId: string }
  | { type: "reorder"; sourceId: string; targetSourceId: string }
  | { type: "activate"; sourceId: string };

const INITIAL_FILE_STATE: FileState = {
  datasets: [],
  activeSourceId: null,
};

const SIDEBAR_WIDTH_KEY = "chamber-data-viewer:sidebar-width";

function loadSidebarWidth(): number | null {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return null;
    return Math.max(
      SIDEBAR_MIN_WIDTH,
      Math.min(stored, effectiveSidebarMaxWidth(window.innerWidth)),
    );
  } catch {
    return null;
  }
}

function sameSource(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function sourceRequestKey(paths: readonly string[]): string {
  const normalizedPaths = paths.map((path) =>
    path.replaceAll("\\", "/").toLocaleLowerCase("en-US"),
  );
  return JSON.stringify(Array.from(new Set(normalizedPaths)).sort());
}

function fileReducer(state: FileState, action: FileAction): FileState {
  if (action.type === "merge") {
    const datasets = mergeDataset(state.datasets, action.loaded, action.replaceSourceId);
    const activeStillExists = state.activeSourceId !== null && datasets.some(
      (item) => sameSource(item.sourceId, state.activeSourceId!),
    );
    return {
      datasets,
      activeSourceId: action.activate || !activeStillExists
        ? action.loaded.sourceId
        : state.activeSourceId,
    };
  }
  if (action.type === "delete") {
    return removeDataset(state.datasets, action.sourceId, state.activeSourceId);
  }
  if (action.type === "reorder") {
    const datasets = moveDataset(state.datasets, action.sourceId, action.targetSourceId);
    return { datasets, activeSourceId: state.activeSourceId };
  }

  const existing = state.datasets.find((item) => sameSource(item.sourceId, action.sourceId));
  if (!existing || existing.sourceId === state.activeSourceId) return state;
  return { ...state, activeSourceId: existing.sourceId };
}

export default function App() {
  const [fileState, dispatchFile] = useReducer(fileReducer, INITIAL_FILE_STATE);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(loadSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    loadSidebarCollapsed,
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [dropFileCount, setDropFileCount] = useState(0);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const pendingRef = useRef(0);
  const pendingReadRef = useRef(0);
  const latestStartedPathRequestRef = useRef(new Map<string, number>());
  const committedSourceRequestRef = useRef(new Map<string, number>());
  const latestReplaceRequestRef = useRef(new Map<string, number>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const beginRequest = useCallback(() => {
    const generation = ++generationRef.current;
    pendingRef.current += 1;
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }
    return generation;
  }, []);

  const finishRequest = useCallback(() => {
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    if (mountedRef.current) setLoading(pendingRef.current > 0);
  }, []);

  useEffect(() => {
    let frame = 0;
    const updateViewportWidth = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setViewportWidth(window.innerWidth);
      });
    };
    window.addEventListener("resize", updateViewportWidth);
    return () => {
      window.removeEventListener("resize", updateViewportWidth);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const beginReading = useCallback(() => {
    pendingReadRef.current += 1;
    if (mountedRef.current) setReading(true);
  }, []);

  const finishReading = useCallback(() => {
    pendingReadRef.current = Math.max(0, pendingReadRef.current - 1);
    if (mountedRef.current) setReading(pendingReadRef.current > 0);
  }, []);

  const isCurrentRequest = useCallback(
    (generation: number) => mountedRef.current && generation === generationRef.current,
    [],
  );

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (sidebarCollapsed || event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startWidth =
        sidebarRef.current?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT_WIDTH;
      let latestWidth = startWidth;
      setSidebarResizing(true);
      const onMove = (moveEvent: PointerEvent) => {
        latestWidth = Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(
            startWidth + moveEvent.clientX - startX,
            effectiveSidebarMaxWidth(window.innerWidth),
          ),
        );
        if (sidebarRef.current) {
          sidebarRef.current.style.width = `${latestWidth}px`;
        }
      };
      const finish = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        setSidebarResizing(false);
        if (sidebarRef.current) {
          sidebarRef.current.style.width = `${latestWidth}px`;
        }
        setSidebarWidth(latestWidth);
        try {
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(latestWidth));
        } catch {
          // The sidebar still resizes for this session when storage is unavailable.
        }
      };
      try {
        handle.setPointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture is a progressive enhancement; drag still works via listeners.
      }
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    },
    [sidebarCollapsed],
  );

  const updateSidebarCollapsed = useCallback((next: boolean) => {
    setSidebarCollapsed(next);
    storeSidebarCollapsed(next);
  }, []);

  const setAndStoreSidebarWidth = useCallback(
    (nextWidth: number) => {
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(nextWidth, effectiveSidebarMaxWidth(window.innerWidth)),
      );
      setSidebarWidth(next);
      if (sidebarRef.current) sidebarRef.current.style.width = `${next}px`;
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
      } catch {
        // Ignore storage failures; the session width still changes.
      }
    },
    [],
  );

  const resetSidebarWidth = useCallback(() => {
    updateSidebarCollapsed(false);
    setAndStoreSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, [setAndStoreSidebarWidth, updateSidebarCollapsed]);

  const handleSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 24 : 8;
      const currentWidth = sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        updateSidebarCollapsed(false);
        setAndStoreSidebarWidth(
          currentWidth + (event.key === "ArrowLeft" ? -step : step),
        );
        event.preventDefault();
        return;
      }
      if (event.key === "Home") {
        updateSidebarCollapsed(true);
        event.preventDefault();
        return;
      }
      if (event.key === "End") {
        updateSidebarCollapsed(false);
        setAndStoreSidebarWidth(
          effectiveSidebarMaxWidth(window.innerWidth),
        );
        event.preventDefault();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        updateSidebarCollapsed(!sidebarCollapsed);
        event.preventDefault();
      }
    },
    [
      setAndStoreSidebarWidth,
      sidebarCollapsed,
      sidebarWidth,
      updateSidebarCollapsed,
    ],
  );

  const openPaths = useCallback(async (
    paths: string[],
    replaceSourceId?: string,
  ) => {
    if (!mountedRef.current || paths.length === 0) return;
    const generation = beginRequest();
    beginReading();
    const pathKey = sourceRequestKey(paths);
    latestStartedPathRequestRef.current.set(pathKey, generation);
    if (replaceSourceId) {
      latestReplaceRequestRef.current.set(
        replaceSourceId.toLocaleLowerCase("en-US"),
        generation,
      );
    }
    try {
      const rawLoaded = await loadDataset(paths);
      if (!mountedRef.current) return;
      if (latestStartedPathRequestRef.current.get(pathKey) !== generation) return;
      if (
        replaceSourceId &&
        latestReplaceRequestRef.current.get(
          replaceSourceId.toLocaleLowerCase("en-US"),
        ) !== generation
      ) {
        return;
      }
      const sourceKey = rawLoaded.sourceId.toLocaleLowerCase("en-US");
      const committedRequest = committedSourceRequestRef.current.get(sourceKey);
      if (committedRequest !== undefined && committedRequest > generation) return;
      const loaded = prepareDataset(rawLoaded);
      committedSourceRequestRef.current.set(sourceKey, generation);

      const activate = isCurrentRequest(generation);
      dispatchFile({ type: "merge", loaded, replaceSourceId, activate });
    } catch (loadError) {
      if (!isCurrentRequest(generation)) return;
      setError(errorMessage(loadError));
    } finally {
      finishReading();
      finishRequest();
    }
  }, [beginReading, beginRequest, finishReading, finishRequest, isCurrentRequest]);

  const openFile = useCallback(async (replaceSourceId?: string) => {
    if (!mountedRef.current) return;

    const generation = beginRequest();
    try {
      const paths = await chooseDataFiles();
      if (!paths || !isCurrentRequest(generation)) return;
      await openPaths(paths, replaceSourceId);
    } catch (chooseError) {
      if (isCurrentRequest(generation)) setError(errorMessage(chooseError));
    } finally {
      finishRequest();
    }
  }, [beginRequest, finishRequest, isCurrentRequest, openPaths]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const reportRegistrationError = (registrationError: unknown) => {
      if (!disposed && mountedRef.current) setError(errorMessage(registrationError));
    };

    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (disposed) return;
          // "over" fires continuously while dragging; only enter/leave/drop
          // change the drop hint, so dragging never re-renders the chart.
          const payload = event.payload;
          if (payload.type === "enter") {
            setDropFileCount(payload.paths.length);
          } else if (payload.type === "leave") {
            setDropFileCount(0);
          } else if (payload.type === "drop") {
            setDropFileCount(0);
            void openPaths(payload.paths);
          }
        })
        .then((handler) => {
          if (disposed) {
            handler();
          } else {
            unlisten = handler;
          }
        })
        .catch(reportRegistrationError);
    } catch (registrationError) {
      reportRegistrationError(registrationError);
    }

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = undefined;
    };
  }, [openPaths]);

  useEffect(() => {
    const openWithShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "o") return;
      event.preventDefault();
      if (!loading) void openFile();
    };
    window.addEventListener("keydown", openWithShortcut);
    return () => window.removeEventListener("keydown", openWithShortcut);
  }, [loading, openFile]);

  const { datasets, activeSourceId } = fileState;
  const activeDataset = datasets.find((item) => item.sourceId === activeSourceId) ?? null;

  return (
    <div
      className={`app-shell${sidebarResizing ? " is-resizing" : ""}`}
      data-od-id="application-shell"
    >
      <WindowChrome />
      <Sidebar
        ref={sidebarRef}
        width={sidebarWidth}
        collapsed={sidebarCollapsed}
        datasets={datasets}
        activeSourceId={activeSourceId}
        loading={loading}
        reading={reading}
        onCollapsedChange={updateSidebarCollapsed}
        onActivate={(sourceId) => dispatchFile({ type: "activate", sourceId })}
        onOpen={openFile}
        onDelete={(sourceId) => dispatchFile({ type: "delete", sourceId })}
        onReorder={(sourceId, targetSourceId) =>
          dispatchFile({ type: "reorder", sourceId, targetSourceId })
        }
      />
      <div
        className={`sidebar-resize-handle${sidebarResizing ? " is-resizing" : ""}`}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        aria-controls="data-source-sidebar chart-workspace"
        aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}
        aria-valuemax={effectiveSidebarMaxWidth(viewportWidth)}
        aria-valuenow={
          sidebarCollapsed
            ? SIDEBAR_COLLAPSED_WIDTH
            : Math.round(sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH)
        }
        aria-valuetext={
          sidebarCollapsed
            ? `侧栏已折叠，${SIDEBAR_COLLAPSED_WIDTH} 像素`
            : `${Math.round(sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH)} 像素`
        }
        title="拖动调整宽度；方向键微调；Enter 折叠或展开"
        onPointerDown={startSidebarResize}
        onDoubleClick={resetSidebarWidth}
        onKeyDown={handleSidebarResizeKeyDown}
      />
      <main
        id="chart-workspace"
        className="content-shell"
        data-od-id="main-content"
      >
        {error ? (
          <ErrorBanner
            key={error}
            message={error}
            onDismiss={() => setError(null)}
          />
        ) : null}
        {datasets.length === 0 ? (
          <EmptyState reading={reading} />
        ) : null}
        {activeDataset ? <ChartWorkspace dataset={activeDataset} /> : null}
      </main>
      {dropFileCount > 0 ? (
        <div className="drop-overlay" aria-hidden="true">
          <span>松开以载入 {dropFileCount} 个文件</span>
        </div>
      ) : null}
    </div>
  );
}
