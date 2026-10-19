import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { StepperInput } from "./StepperInput";
import { UiIcon } from "./UiIcon";
import {
  clampPanelPosition,
  createSettingsDraft,
  DEFAULT_CHART_SETTINGS,
  formatAxisBound,
  stepAxisBoundText,
  stepGridCountText,
  updateAxisDraft,
  validateSettingsDraft,
  type AppliedChartSettings,
  type AxisExtent,
  type SettingsErrors,
} from "../chartSettings";
import type { Axis } from "../types";

type ChartSettingsPanelProps = {
  mode?: "inline" | "window";
  axes: Axis[];
  applied: AppliedChartSettings;
  displayedExtents: ReadonlyMap<string, AxisExtent | null>;
  onApply: (settings: AppliedChartSettings) => void;
  onClose: () => void;
};

type PanelPosition = { x: number; y: number };

type DragState = {
  clientX: number;
  clientY: number;
  origin: PanelPosition;
};

const formatUnit = (unit: string) => (unit === "degC" ? "°C" : unit);

/** 留空即自动：占位符直接显示当前自动范围，让“自动”可读。 */
function automaticBoundText(
  extent: AxisExtent | null | undefined,
  field: "min" | "max",
): string {
  if (!extent) return "自动";
  return field === "min"
    ? formatAxisBound(extent[0], extent[1])
    : formatAxisBound(extent[1], extent[0]);
}

export function ChartSettingsPanel({
  mode = "inline",
  axes,
  applied,
  displayedExtents,
  onApply,
  onClose,
}: ChartSettingsPanelProps) {
  const [draft, setDraft] = useState(() =>
    createSettingsDraft(axes, applied),
  );
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [position, setPosition] = useState<PanelPosition>({ x: 0, y: 0 });
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const errorIdPrefix = useId();

  const close = () => {
    setDraft(createSettingsDraft(axes, applied));
    setErrors({});
    onClose();
  };

  useLayoutEffect(() => {
    if (mode !== "inline") return;
    const panel = panelRef.current;
    if (!panel) return;

    const panelRect = panel.getBoundingClientRect();
    setPosition({
      x: Math.max(0, window.innerWidth - panelRect.width - 20),
      y: 0,
    });
  }, [mode]);

  useEffect(() => {
    if (mode !== "inline") return;
    const stop = () => {
      dragRef.current = null;
    };
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (typeof event.buttons === "number" && (event.buttons & 1) === 0) {
        stop();
        return;
      }

      const panel = panelRef.current;
      if (!panel) return;

      const panelRect = panel.getBoundingClientRect();
      setPosition(
        clampPanelPosition(
          {
            x: drag.origin.x + event.clientX - drag.clientX,
            y: drag.origin.y + event.clientY - drag.clientY,
          },
          { width: window.innerWidth, height: window.innerHeight },
          { width: panelRect.width, height: panelRect.height },
        ),
      );
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    document.addEventListener("visibilitychange", stop);
    window.addEventListener("blur", stop);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      document.removeEventListener("visibilitychange", stop);
      window.removeEventListener("blur", stop);
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== "inline") return;
    const clampToViewport = () => {
      const panel = panelRef.current;
      if (!panel) return;

      const panelRect = panel.getBoundingClientRect();
      setPosition((current) =>
        clampPanelPosition(
          current,
          { width: window.innerWidth, height: window.innerHeight },
          { width: panelRect.width, height: panelRect.height },
        ),
      );
    };

    const panel = panelRef.current;
    if (!panel) return;

    const resizeObserver = new ResizeObserver(clampToViewport);
    resizeObserver.observe(panel);
    window.addEventListener("resize", clampToViewport);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", clampToViewport);
    };
  }, [mode]);

  useEffect(() => {
    const closeFromDocument = () => {
      setDraft(createSettingsDraft(axes, applied));
      setErrors({});
      onClose();
    };
    const pointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest("[data-chart-settings-toggle]")
      ) {
        return;
      }
      closeFromDocument();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFromDocument();
    };

    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
    };
  }, [applied, axes, onClose]);

  useLayoutEffect(() => {
    setDraft(createSettingsDraft(axes, applied));
    setErrors({});
  }, [applied, axes]);

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateSettingsDraft(axes, draft, displayedExtents);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    onApply(result.value);
    onClose();
  };

  const clearError = (key: string) => {
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const clearAxisErrors = (axisId: string) => {
    const minKey = `${axisId}.min`;
    const maxKey = `${axisId}.max`;
    setErrors((current) => {
      if (!(minKey in current) && !(maxKey in current)) return current;
      const next = { ...current };
      delete next[minKey];
      delete next[maxKey];
      return next;
    });
  };

  /** resolve 基于最新草稿算出新值，返回 null 表示保持不变；连续步进因此不会读到过期值。 */
  const changeAxisField = (
    axisId: string,
    field: "min" | "max",
    resolve: (current: string) => string | null,
  ) => {
    const extent = displayedExtents.get(axisId) ?? null;
    setDraft((current) => {
      const axisDraft = current.axes[axisId] ?? { min: "", max: "" };
      const value = resolve(axisDraft[field]);
      if (value === null) return current;
      return {
        ...current,
        axes: {
          ...current.axes,
          [axisId]: updateAxisDraft(axisDraft, field, value, extent),
        },
      };
    });
    clearAxisErrors(axisId);
  };

  const changeGridField = (
    field: "yGridCount" | "xGridCount",
    resolve: (current: string) => string,
  ) => {
    setDraft((current) => ({ ...current, [field]: resolve(current[field]) }));
    clearError(field);
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (event.button !== 0) return;
    if (
      target instanceof Element &&
      target.closest("button, input")
    ) {
      return;
    }
    event.preventDefault();
    dragRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      origin: position,
    };
  };

  const errorId = (key: string) =>
    `${errorIdPrefix}-chart-settings-${key.replace(".", "-")}-error`;

  const fieldError = (key: string) =>
    errors[key] ? (
      <span id={errorId(key)} role="alert">
        {errors[key]}
      </span>
    ) : null;

  const axisInput = (axis: Axis, field: "min" | "max") => {
    const key = `${axis.id}.${field}`;
    const axisDraft = draft.axes[axis.id] ?? { min: "", max: "" };
    const extent = displayedExtents.get(axis.id);
    return (
      <StepperInput
        label={`${axis.name}${field === "min" ? "下限" : "上限"}`}
        step="1"
        value={axisDraft[field]}
        placeholder={automaticBoundText(extent, field)}
        aria-invalid={Boolean(errors[key])}
        aria-describedby={errors[key] ? errorId(key) : undefined}
        onChange={(event) => {
          const { value } = event.target;
          changeAxisField(axis.id, field, () => value);
        }}
        onStep={(direction) =>
          changeAxisField(axis.id, field, (current) =>
            stepAxisBoundText(
              current,
              extent ? automaticBoundText(extent, field) : null,
              direction,
            ),
          )
        }
      />
    );
  };

  const gridInput = (field: "yGridCount" | "xGridCount", label: string) => (
    <StepperInput
      label={label}
      min="1"
      max="9"
      value={draft[field]}
      aria-invalid={Boolean(errors[field])}
      aria-describedby={errors[field] ? errorId(field) : undefined}
      onChange={(event) => {
        const { value } = event.target;
        changeGridField(field, () => value);
      }}
      onStep={(direction) =>
        changeGridField(field, (current) =>
          stepGridCountText(current, direction),
        )
      }
    />
  );

  // “恢复默认”只改草稿：纵轴回到自动、格数回到默认，仍由“应用”生效。
  const defaultDraft = createSettingsDraft(axes, DEFAULT_CHART_SETTINGS);
  const isDefaultDraft =
    draft.yGridCount === defaultDraft.yGridCount &&
    draft.xGridCount === defaultDraft.xGridCount &&
    axes.every((axis) => {
      const axisDraft = draft.axes[axis.id];
      return !axisDraft || (axisDraft.min === "" && axisDraft.max === "");
    });

  const panel = (
    <aside
      className={
        mode === "window"
          ? "chart-settings chart-settings--window"
          : "chart-settings"
      }
      role="complementary"
      aria-label="图表设置"
      ref={panelRef}
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
    >
      <div
        className="settings-heading"
        onPointerDown={mode === "inline" ? startDrag : undefined}
        data-tauri-drag-region={mode === "window" ? "deep" : undefined}
      >
        <h3>图表设置</h3>
        <button type="button" aria-label="关闭图表设置" onClick={close}>
          <UiIcon name="close" />
        </button>
      </div>

      <form className="settings-form" noValidate onSubmit={apply}>
        <div className="settings-body">
          <div className="settings-grid" role="group" aria-label="纵坐标范围">
            <span className="settings-grid-heading">纵坐标范围</span>
            <span className="settings-grid-heading">下限</span>
            <span className="settings-grid-heading">上限</span>
            {axes.map((axis) => (
              <Fragment key={axis.id}>
                <span className="settings-row-label">
                  {axis.name}
                  {formatUnit(axis.unit) ? (
                    <span className="settings-unit">{formatUnit(axis.unit)}</span>
                  ) : null}
                </span>
                {axisInput(axis, "min")}
                {axisInput(axis, "max")}
                {errors[`${axis.id}.min`] || errors[`${axis.id}.max`] ? (
                  <div className="settings-row-errors">
                    {fieldError(`${axis.id}.min`)}
                    {fieldError(`${axis.id}.max`)}
                  </div>
                ) : null}
              </Fragment>
            ))}
          </div>

          <div className="settings-grid" role="group" aria-label="刻度格数">
            <span className="settings-grid-heading">刻度格数</span>
            <span className="settings-grid-heading">纵轴</span>
            <span className="settings-grid-heading">横轴</span>
            <span className="settings-row-label is-hint">1 至 9 格</span>
            {gridInput("yGridCount", "纵轴刻度格数")}
            {gridInput("xGridCount", "横轴刻度格数")}
            {errors.yGridCount || errors.xGridCount ? (
              <div className="settings-row-errors">
                {fieldError("yGridCount")}
                {fieldError("xGridCount")}
              </div>
            ) : null}
          </div>

          <p className="settings-note">留空即自动，灰色数字为当前显示范围。</p>
        </div>

        <div className="settings-actions">
          <button
            className="tertiary-button settings-reset"
            type="button"
            disabled={isDefaultDraft}
            onClick={() => {
              setDraft(defaultDraft);
              setErrors({});
            }}
          >
            <UiIcon name="restore" />
            恢复默认
          </button>
          <button className="secondary-button" type="button" onClick={close}>
            取消
          </button>
          <button className="primary-button" type="submit">
            应用
          </button>
        </div>
      </form>
    </aside>
  );

  return mode === "window" ? panel : createPortal(panel, document.body);
}
