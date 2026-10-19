import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  resolveYAxisExtents,
  type ChartConfig,
} from "../chartOptions";
import {
  fitRangeWithBreathingSpace,
  type NumericRange,
} from "../chartRange";
import { toggleLockedAxis } from "../chartInteraction";
import {
  hasVisibleData,
  type PreparedDataset,
} from "../chartSeries";
import {
  DEFAULT_CHART_SETTINGS,
  type AppliedChartSettings,
} from "../chartSettings";
import {
  closeChartSettingsWindow,
  isTauriRuntime,
  openChartSettingsWindow,
  prewarmChartSettingsWindow,
  subscribeChartSettingsWindowEvents,
  type ChartSettingsWindowPayload,
} from "../chartSettingsWindow";
import { ChartLegend } from "./ChartLegend";
import { ChartSettingsPanel } from "./ChartSettingsPanel";
import { ChartView } from "./ChartView";
import { TimeRangeControls } from "./TimeRangeControls";

type Props = {
  dataset: PreparedDataset;
};

const CURSOR_VISIBILITY_KEY = "chamber-data-viewer:chart-cursor-visible";

function initialCursorVisible(): boolean {
  try {
    return localStorage.getItem(CURSOR_VISIBILITY_KEY) !== "false";
  } catch {
    return true;
  }
}

type PersistedViewState = {
  range: NumericRange;
  settings: AppliedChartSettings;
  visibleSeries: Set<string>;
};

type ViewState = PersistedViewState & {
  datasetRef: PreparedDataset;
  activationRef: object;
  previewSeriesId: string | null;
  lockedAxisIds: Set<string>;
  settingsOpen: boolean;
};

type ViewAction =
  | { type: "reset"; state: ViewState }
  | {
      type: "setRange";
      activationRef: object;
      range: NumericRange;
    }
  | { type: "setSettings"; settings: AppliedChartSettings }
  | { type: "toggleSeries"; seriesId: string }
  | { type: "toggleSeriesGroup"; seriesIds: string[] }
  | { type: "toggleAxisLock"; axisId: string }
  | { type: "clearAxisLocks" }
  | { type: "setPreview"; seriesId: string | null }
  | { type: "toggleSettings" }
  | { type: "closeSettings" };

const numericTime = (value: string) =>
  new Date(value.replace(" ", "T")).getTime();

function cloneRange(range: NumericRange): NumericRange {
  return { ...range };
}

function cloneSettings(
  settings: AppliedChartSettings,
): AppliedChartSettings {
  return {
    ...settings,
    axes: Object.fromEntries(
      Object.entries(settings.axes).map(([axisId, bounds]) => [
        axisId,
        { ...bounds },
      ]),
    ),
  };
}

function clonePersistedViewState(
  state: PersistedViewState,
): PersistedViewState {
  return {
    range: cloneRange(state.range),
    settings: cloneSettings(state.settings),
    visibleSeries: new Set(state.visibleSeries),
  };
}

function viewStateForDataset(
  dataset: PreparedDataset,
  preparedDataset: PreparedDataset,
  completeRange: NumericRange,
  cached?: PersistedViewState,
): ViewState {
  const persisted = cached
    ? clonePersistedViewState(cached)
    : {
        range: cloneRange(completeRange),
        settings: cloneSettings(DEFAULT_CHART_SETTINGS),
        visibleSeries: new Set(
          preparedDataset.series.map((series) => series.id),
        ),
      };
  return {
    ...persisted,
    datasetRef: dataset,
    activationRef: {},
    previewSeriesId: null,
    lockedAxisIds: new Set(),
    settingsOpen: false,
  };
}

function viewReducer(state: ViewState, action: ViewAction): ViewState {
  if (action.type === "reset") return action.state;
  if (action.type === "setRange") {
    if (action.activationRef !== state.activationRef) return state;
    return { ...state, range: action.range };
  }
  if (action.type === "setSettings") {
    return { ...state, settings: action.settings };
  }
  if (action.type === "setPreview") {
    if (state.previewSeriesId === action.seriesId) return state;
    return { ...state, previewSeriesId: action.seriesId };
  }
  if (action.type === "toggleAxisLock") {
    return {
      ...state,
      lockedAxisIds: toggleLockedAxis(state.lockedAxisIds, action.axisId),
    };
  }
  if (action.type === "clearAxisLocks") {
    if (state.lockedAxisIds.size === 0) return state;
    return { ...state, lockedAxisIds: new Set() };
  }
  if (action.type === "toggleSettings") {
    return { ...state, settingsOpen: !state.settingsOpen };
  }
  if (action.type === "closeSettings") {
    if (!state.settingsOpen) return state;
    return { ...state, settingsOpen: false };
  }

  if (action.type === "toggleSeries") {
    const visibleSeries = new Set(state.visibleSeries);
    const hiding = visibleSeries.delete(action.seriesId);
    if (!hiding) visibleSeries.add(action.seriesId);
    return {
      ...state,
      visibleSeries,
      previewSeriesId:
        hiding && state.previewSeriesId === action.seriesId
          ? null
          : state.previewSeriesId,
    };
  }
  const visibleSeries = new Set(state.visibleSeries);
  const hidingAll = action.seriesIds.every((seriesId) =>
    visibleSeries.has(seriesId),
  );
  for (const seriesId of action.seriesIds) {
    if (hidingAll) visibleSeries.delete(seriesId);
    else visibleSeries.add(seriesId);
  }
  return {
    ...state,
    visibleSeries,
    previewSeriesId:
      hidingAll &&
      state.previewSeriesId !== null &&
      action.seriesIds.includes(state.previewSeriesId)
        ? null
        : state.previewSeriesId,
  };
}

export function ChartWorkspace({ dataset }: Props) {
  const preparedDataset = dataset;
  const [cursorVisible, setCursorVisible] = useState(initialCursorVisible);
  const [helpOpen, setHelpOpen] = useState(false);
  const completeRange = useMemo<NumericRange>(
    () => ({
      start: numericTime(dataset.timeRange.start),
      end: numericTime(dataset.timeRange.end),
    }),
    [dataset.timeRange.end, dataset.timeRange.start],
  );
  const fitCompleteRange = useMemo(
    () => fitRangeWithBreathingSpace(completeRange),
    [completeRange],
  );
  const persistedViewsRef = useRef<
    WeakMap<PreparedDataset, PersistedViewState> | null
  >(null);
  if (persistedViewsRef.current === null) {
    persistedViewsRef.current = new WeakMap();
  }
  const persistedViews = persistedViewsRef.current;
  const targetForCurrent = useMemo(
    () =>
      viewStateForDataset(
        dataset,
        preparedDataset,
        fitCompleteRange,
        persistedViews.get(dataset),
      ),
    [dataset, fitCompleteRange, persistedViews, preparedDataset],
  );
  const [state, dispatch] = useReducer(viewReducer, targetForCurrent);
  const effective =
    state.datasetRef === preparedDataset ? state : targetForCurrent;
  const tauriRuntime = useMemo(() => isTauriRuntime(), []);
  const durableSnapshot = useMemo(
    () =>
      clonePersistedViewState({
        range: state.range,
        settings: state.settings,
        visibleSeries: state.visibleSeries,
      }),
    [state.range, state.settings, state.visibleSeries],
  );

  useLayoutEffect(() => {
    persistedViews.set(state.datasetRef, durableSnapshot);
    if (state.datasetRef !== preparedDataset) {
      dispatch({ type: "reset", state: targetForCurrent });
    }
  }, [
    dataset,
    durableSnapshot,
    persistedViews,
    preparedDataset,
    state.datasetRef,
    targetForCurrent,
  ]);

  const config = useMemo<ChartConfig>(
    () => ({
      ...effective.settings,
      xMin: effective.range.start,
      xMax: effective.range.end,
    }),
    [effective.range.end, effective.range.start, effective.settings],
  );
  const emptyWithinAxisRange = useMemo(
    () =>
      effective.visibleSeries.size > 0 &&
      !hasVisibleData(
        preparedDataset,
        effective.visibleSeries,
        effective.range,
        effective.settings.axes,
      ),
    [
      effective.range,
      effective.settings.axes,
      effective.visibleSeries,
      preparedDataset,
    ],
  );
  const displayedYAxisExtents = useMemo(
    () =>
      resolveYAxisExtents(preparedDataset, config, {
        visibleSeries: effective.visibleSeries,
        previewSeriesId: effective.previewSeriesId,
      }),
    [
      config,
      effective.previewSeriesId,
      effective.visibleSeries,
      preparedDataset,
    ],
  );

  const settingsWindowPayload = useMemo<ChartSettingsWindowPayload | null>(
    () =>
      effective.settingsOpen
        ? {
            axes: preparedDataset.axes,
            applied: effective.settings,
            displayedExtents: Object.fromEntries(displayedYAxisExtents),
          }
        : null,
    [
      displayedYAxisExtents,
      effective.settings,
      effective.settingsOpen,
      preparedDataset.axes,
    ],
  );

  useEffect(() => {
    if (!tauriRuntime) return;
    void prewarmChartSettingsWindow();
  }, [tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) return;
    if (settingsWindowPayload) {
      void openChartSettingsWindow(settingsWindowPayload);
    } else {
      void closeChartSettingsWindow();
    }
  }, [settingsWindowPayload, tauriRuntime]);

  useEffect(() => {
    if (!tauriRuntime) return;
    return subscribeChartSettingsWindowEvents({
      onApply: (settings) => dispatch({ type: "setSettings", settings }),
      onClose: () => dispatch({ type: "closeSettings" }),
    });
  }, [tauriRuntime]);

  return (
    <section
      className="workspace-panel"
      aria-label="数据曲线"
      data-od-id="chart-workspace"
      data-applied-range-start={effective.range.start}
      data-applied-range-end={effective.range.end}
    >
      <TimeRangeControls
        bounds={fitCompleteRange}
        value={effective.range}
        resetKey={dataset}
        settingsOpen={effective.settingsOpen}
        cursorVisible={cursorVisible}
        onApply={(range) =>
          dispatch({
            type: "setRange",
            activationRef: effective.activationRef,
            range,
          })
        }
        onReset={() => {
          dispatch({
            type: "setRange",
            activationRef: effective.activationRef,
            range: cloneRange(fitCompleteRange),
          });
          dispatch({
            type: "setSettings",
            settings: cloneSettings(DEFAULT_CHART_SETTINGS),
          });
          dispatch({ type: "clearAxisLocks" });
        }}
        onToggleCursor={() => {
          setCursorVisible((current) => {
            const next = !current;
            try {
              localStorage.setItem(CURSOR_VISIBILITY_KEY, String(next));
            } catch {
              // The preference still applies for this session.
            }
            return next;
          });
        }}
        onToggleSettings={() => dispatch({ type: "toggleSettings" })}
        onHelpOpenChange={setHelpOpen}
      />

      <div className="chart-area">
        {effective.settingsOpen && !tauriRuntime ? (
          <ChartSettingsPanel
            axes={preparedDataset.axes}
            applied={effective.settings}
            displayedExtents={displayedYAxisExtents}
            onApply={(settings) =>
              dispatch({ type: "setSettings", settings })
            }
            onClose={() => dispatch({ type: "closeSettings" })}
          />
        ) : null}

        <ChartLegend
          axes={preparedDataset.axes}
          series={preparedDataset.series}
          visibleSeries={effective.visibleSeries}
          lockedAxisIds={effective.lockedAxisIds}
          onToggle={(seriesId) =>
            dispatch({ type: "toggleSeries", seriesId })
          }
          onToggleGroup={(seriesIds) =>
            dispatch({ type: "toggleSeriesGroup", seriesIds })
          }
          onToggleAxisLock={(axisId) =>
            dispatch({ type: "toggleAxisLock", axisId })
          }
          onPreview={(seriesId) =>
            dispatch({ type: "setPreview", seriesId })
          }
        />

        <ChartView
          dataset={preparedDataset}
          config={config}
          visibleSeries={effective.visibleSeries}
          previewSeriesId={effective.previewSeriesId}
          lockedAxisIds={effective.lockedAxisIds}
          cursorVisible={cursorVisible}
          helpOpen={helpOpen}
          onToggleAxisLock={(axisId) =>
            dispatch({ type: "toggleAxisLock", axisId })
          }
          onClearAxisLocks={() => dispatch({ type: "clearAxisLocks" })}
          onVisibleRangeChange={(range) =>
            dispatch({
              type: "setRange",
              activationRef: effective.activationRef,
              range,
            })
          }
          onSettingsChange={(settings) =>
            dispatch({ type: "setSettings", settings })
          }
          emptyWithinAxisRange={emptyWithinAxisRange}
        />
      </div>
    </section>
  );
}
