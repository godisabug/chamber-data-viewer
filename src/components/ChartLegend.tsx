import { useCallback, useEffect, useRef } from "react";
import type { Axis, Series } from "../types";
import { UiIcon } from "./UiIcon";

export type LegendSeries = Pick<Series, "id" | "name" | "role" | "axisId">;

type ChartLegendProps = {
  axes: readonly Axis[];
  series: readonly LegendSeries[];
  visibleSeries: ReadonlySet<string>;
  lockedAxisIds?: ReadonlySet<string>;
  onToggle: (seriesId: string) => void;
  onToggleGroup: (seriesIds: string[]) => void;
  onToggleAxisLock?: (axisId: string) => void;
  onPreview: (seriesId: string | null) => void;
};

const axisRoleName = (role: Axis["role"]) =>
  role === "primary" ? "主轴" : "次轴";

const seriesRoleName = (role: Series["role"]) => {
  if (role === "measured") return "实测";
  if (role === "setpoint") return "设定";
  if (role === "output") return "输出";
  return "其他";
};

export function ChartLegend({
  axes,
  series,
  visibleSeries,
  lockedAxisIds = new Set(),
  onToggle,
  onToggleGroup,
  onToggleAxisLock = () => {},
  onPreview,
}: ChartLegendProps) {
  const hoveredSeriesId = useRef<string | null>(null);
  const focusedSeriesId = useRef<string | null>(null);
  const previewedSeriesId = useRef<string | null>(null);
  const onPreviewRef = useRef(onPreview);

  const emitPreview = useCallback((seriesId: string | null) => {
    if (previewedSeriesId.current === seriesId) return;
    previewedSeriesId.current = seriesId;
    onPreviewRef.current(seriesId);
  }, []);

  const syncPreview = useCallback(() => {
    emitPreview(hoveredSeriesId.current ?? focusedSeriesId.current);
  }, [emitPreview]);

  useEffect(() => {
    onPreviewRef.current = onPreview;
  }, [onPreview]);

  useEffect(() => {
    const interactiveSeriesIds = new Set(
      series
        .filter((item) => visibleSeries.has(item.id))
        .map((item) => item.id),
    );
    if (
      hoveredSeriesId.current !== null &&
      !interactiveSeriesIds.has(hoveredSeriesId.current)
    ) {
      hoveredSeriesId.current = null;
    }
    if (
      focusedSeriesId.current !== null &&
      !interactiveSeriesIds.has(focusedSeriesId.current)
    ) {
      focusedSeriesId.current = null;
    }
    syncPreview();
  }, [series, visibleSeries, syncPreview]);

  useEffect(
    () => () => {
      hoveredSeriesId.current = null;
      focusedSeriesId.current = null;
      emitPreview(null);
    },
    [emitPreview],
  );

  const nameCounts = new Map<string, number>();
  series.forEach((item) => {
    nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
  });
  const legendItems = series.map((item) => {
    const axisRole =
      axes.find((axis) => axis.id === item.axisId)?.role ?? "primary";
    const axisIndex = axes.findIndex((axis) => axis.id === item.axisId);
    const axisClassRole =
      axisIndex <= 0 ? "primary" : axisIndex === 1 ? "secondary" : "tertiary";
    return {
      item,
      axisRole,
      axisClassRole,
      contextName: `${item.name}，${axisRoleName(axisRole)}，${seriesRoleName(item.role)}`,
    };
  });
  const groupedLegendItems = axes
    .map((axis) => ({
      axis,
      items: legendItems.filter(({ item }) => item.axisId === axis.id),
    }))
    .filter(({ items }) => items.length > 0);
  const matchedAxisIds = new Set(axes.map((axis) => axis.id));
  const unmatchedItems = legendItems.filter(
    ({ item }) => !matchedAxisIds.has(item.axisId),
  );
  if (unmatchedItems.length > 0) {
    groupedLegendItems.push({
      axis: { id: "__unmatched", role: "primary", name: "其他", unit: "" },
      items: unmatchedItems,
    });
  }
  const contextCounts = new Map<string, number>();
  legendItems.forEach(({ item, contextName }) => {
    if ((nameCounts.get(item.name) ?? 0) < 2) return;
    contextCounts.set(contextName, (contextCounts.get(contextName) ?? 0) + 1);
  });

  return (
    <div
      className="legend"
      role="group"
      aria-label="曲线图例，点击切换曲线显示"
    >
      {groupedLegendItems.map(({ axis, items }) => {
        const groupFullyHidden = items.every(
          ({ item }) => !visibleSeries.has(item.id),
        );
        const locked = lockedAxisIds.has(axis.id);
        return (
          <div
            className="legend-group"
            role="group"
            aria-label={`${axis.name}曲线`}
            key={axis.id}
          >
            <button
              className={[
                "legend-group-label",
                groupFullyHidden ? "is-hidden" : "",
                locked ? "is-axis-locked" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              type="button"
              aria-pressed={items.every(
                ({ item }) => visibleSeries.has(item.id),
              )}
              aria-label={`${axis.name}，点击切换整组显示${
                locked ? "，已锁定，Shift加点击解除锁定" : ""
              }`}
              data-axis-locked={locked || undefined}
              key={`${axis.id}-group`}
              onClick={(event) => {
                if (event.shiftKey) {
                  onToggleAxisLock(axis.id);
                  return;
                }
                onToggleGroup(items.map(({ item }) => item.id));
              }}
            >
              {locked ? (
                <span className="axis-lock-indicator" aria-hidden="true">
                  <UiIcon name="lock" size="xs" />
                </span>
              ) : null}
              {axis.name}
            </button>
            {items.map(({ item, axisClassRole, contextName }) => {
              const isVisible = visibleSeries.has(item.id);
              const duplicateName = (nameCounts.get(item.name) ?? 0) > 1;
              const accessibleName = duplicateName
                ? (contextCounts.get(contextName) ?? 0) > 1
                  ? `${contextName}，${item.id}`
                  : contextName
                : item.name;
              const className = [
                "legend-item",
                `is-${item.role}`,
                `is-${axisClassRole}`,
                isVisible ? "" : "is-hidden",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <button
                  className={className}
                  type="button"
                  aria-pressed={isVisible}
                  aria-label={accessibleName}
                  title={accessibleName}
                  key={item.id}
                  onClick={() => onToggle(item.id)}
                  onMouseEnter={() => {
                    if (!isVisible) return;
                    hoveredSeriesId.current = item.id;
                    syncPreview();
                  }}
                  onMouseLeave={() => {
                    if (hoveredSeriesId.current === item.id) {
                      hoveredSeriesId.current = null;
                    }
                    syncPreview();
                  }}
                  onFocus={() => {
                    if (!isVisible) return;
                    focusedSeriesId.current = item.id;
                    syncPreview();
                  }}
                  onBlur={() => {
                    if (focusedSeriesId.current === item.id) {
                      focusedSeriesId.current = null;
                    }
                    syncPreview();
                  }}
                >
                  <span className="series-swatch" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
