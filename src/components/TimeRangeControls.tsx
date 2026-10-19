import { useId, useLayoutEffect, useState } from "react";
import {
  formatTimeRangeInput,
  validateTimeRange,
  type NumericRange,
  type RangeErrors,
} from "../chartRange";
import { ChartHelpPopover } from "./ChartHelpPopover";
import { DateTimeField } from "./DateTimeField";
import { UiIcon } from "./UiIcon";

type TimeRangeControlsProps = {
  /** 打开文件时的默认时间范围，也是“重置”要回到的范围。 */
  bounds: NumericRange;
  value: NumericRange;
  resetKey?: unknown;
  settingsOpen: boolean;
  cursorVisible?: boolean;
  onApply: (range: NumericRange) => void;
  onReset: () => void;
  onToggleCursor?: () => void;
  onToggleSettings: () => void;
  onHelpOpenChange?: (open: boolean) => void;
};

export function TimeRangeControls({
  bounds,
  value,
  resetKey,
  settingsOpen,
  cursorVisible = true,
  onApply,
  onReset,
  onToggleCursor = () => {},
  onToggleSettings,
  onHelpOpenChange,
}: TimeRangeControlsProps) {
  const [start, setStart] = useState(() => formatTimeRangeInput(value.start));
  const [end, setEnd] = useState(() => formatTimeRangeInput(value.end));
  const [errors, setErrors] = useState<RangeErrors>({});
  const fieldId = useId();

  useLayoutEffect(() => {
    setStart(formatTimeRangeInput(value.start));
    setEnd(formatTimeRangeInput(value.end));
    setErrors({});
  }, [bounds.end, bounds.start, resetKey, value.end, value.start]);

  const startId = `${fieldId}-start`;
  const endId = `${fieldId}-end`;
  const startErrorId = `${fieldId}-start-error`;
  const endErrorId = `${fieldId}-end-error`;

  const apply = () => {
    const result = validateTimeRange(start, end, bounds);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setStart(formatTimeRangeInput(result.range.start));
    setEnd(formatTimeRangeInput(result.range.end));
    setErrors({});
    onApply(result.range);
  };

  /** 把一端恢复为默认时间并立即生效；另一端的草稿若无法通过校验，则只改草稿。 */
  const restoreDefault = (field: "start" | "end") => {
    const nextStart =
      field === "start" ? formatTimeRangeInput(bounds.start) : start;
    const nextEnd = field === "end" ? formatTimeRangeInput(bounds.end) : end;
    setStart(nextStart);
    setEnd(nextEnd);
    setErrors({});
    const result = validateTimeRange(nextStart, nextEnd, bounds);
    if (result.ok) onApply(result.range);
  };

  const reset = () => {
    setStart(formatTimeRangeInput(bounds.start));
    setEnd(formatTimeRangeInput(bounds.end));
    setErrors({});
    onReset();
  };

  return (
    <section className="range-controls" aria-label="时间范围">
      <div className="range-input-group">
        <div className={errors.start ? "range-field is-invalid" : "range-field"}>
          <label htmlFor={startId}>开始时间</label>
          <DateTimeField
            id={startId}
            label="开始时间"
            value={start}
            defaultTime={bounds.start}
            invalid={Boolean(errors.start)}
            describedBy={errors.start ? startErrorId : undefined}
            onChange={(text) => {
              setStart(text);
              setErrors({});
            }}
            onCommit={apply}
            onRestoreDefault={() => restoreDefault("start")}
          />
          {errors.start ? (
            <span id={startErrorId} role="alert">
              {errors.start}
            </span>
          ) : null}
        </div>
        <div className={errors.end ? "range-field is-invalid" : "range-field"}>
          <label htmlFor={endId}>截止时间</label>
          <DateTimeField
            id={endId}
            label="截止时间"
            value={end}
            defaultTime={bounds.end}
            invalid={Boolean(errors.end)}
            describedBy={errors.end ? endErrorId : undefined}
            onChange={(text) => {
              setEnd(text);
              setErrors({});
            }}
            onCommit={apply}
            onRestoreDefault={() => restoreDefault("end")}
          />
          {errors.end ? (
            <span id={endErrorId} role="alert">
              {errors.end}
            </span>
          ) : null}
        </div>
        <button className="primary-button range-apply" type="button" onClick={apply}>
          应用范围
        </button>
      </div>
      <div className="control-actions">
        <button
          className="tertiary-button tool-button"
          type="button"
          aria-label="游标"
          aria-pressed={cursorVisible}
          data-tip={cursorVisible ? "隐藏游标和读数" : "显示游标和读数"}
          onClick={onToggleCursor}
        >
          <UiIcon name="cursor" size="md" />
        </button>
        <button
          className="tertiary-button tool-button"
          type="button"
          aria-label="重置视图"
          data-tip="重置视图：时间范围与纵轴回到默认"
          onClick={reset}
        >
          <UiIcon name="fit-view" size="md" />
        </button>
        <button
          className="tertiary-button tool-button chart-settings-toggle"
          type="button"
          aria-label="图表设置"
          aria-expanded={settingsOpen}
          data-chart-settings-toggle=""
          data-tip={settingsOpen ? undefined : "图表设置"}
          onClick={onToggleSettings}
        >
          <UiIcon name="settings" size="md" />
        </button>
        <ChartHelpPopover onOpenChange={onHelpOpenChange} />
      </div>
    </section>
  );
}
