import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { prepareDataset } from "../chartSeries";
import { makeDataset } from "../test/fixtures";
import { ChartLegend, type LegendSeries } from "./ChartLegend";

const dataset = prepareDataset(makeDataset());
const allSeries = new Set(dataset.series.map((series) => series.id));

describe("ChartLegend", () => {
  it("renders prepared order and handles toggling and visible previews", () => {
    const onToggle = vi.fn();
    const onPreview = vi.fn();
    render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={allSeries}
        onToggle={onToggle}
        onToggleGroup={vi.fn()}
        onPreview={onPreview}
      />,
    );

    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "温度，点击切换整组显示",
      "实测温度",
      "设定温度",
      "湿度，点击切换整组显示",
      "实测湿度",
      "设定湿度",
    ]);
    expect(
      screen.getByRole("group", { name: "曲线图例，点击切换曲线显示" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "温度曲线" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "湿度曲线" })).toBeInTheDocument();

    const actualTemperature = screen.getByRole("button", { name: "实测温度" });
    expect(actualTemperature).toHaveClass(
      "legend-item",
      "is-measured",
      "is-primary",
    );
    expect(actualTemperature).toHaveAttribute("aria-pressed", "true");
    expect(actualTemperature).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "设定温度" })).toHaveTextContent(
      "",
    );
    const swatch = actualTemperature.querySelector(".series-swatch");
    expect(swatch).toHaveAttribute("aria-hidden", "true");
    expect(swatch).toHaveAttribute("class", "series-swatch");

    fireEvent.click(actualTemperature);
    fireEvent.mouseEnter(actualTemperature);
    fireEvent.mouseLeave(actualTemperature);
    fireEvent.focus(actualTemperature);
    fireEvent.blur(actualTemperature);

    expect(onToggle).toHaveBeenCalledWith("actual-temp");
    expect(onPreview.mock.calls).toEqual([
      ["actual-temp"],
      [null],
      ["actual-temp"],
      [null],
    ]);
  });

  it("toggles a whole group through its group label", () => {
    const onToggleGroup = vi.fn();
    render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={allSeries}
        onToggle={vi.fn()}
        onToggleGroup={onToggleGroup}
        onPreview={vi.fn()}
      />,
    );

    const temperatureGroup = screen.getByRole("button", {
      name: "温度，点击切换整组显示",
    });
    expect(temperatureGroup).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(temperatureGroup);
    expect(onToggleGroup).toHaveBeenCalledWith(["actual-temp", "set-temp"]);
  });

  it("marks the group label unpressed when any series in the group is hidden", () => {
    const partialVisibility = new Set(allSeries);
    partialVisibility.delete("set-temp");
    render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={partialVisibility}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "温度，点击切换整组显示" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles an axis lock with Shift+click without changing visibility", () => {
    const onToggleGroup = vi.fn();
    const onToggleAxisLock = vi.fn();
    const view = render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={allSeries}
        lockedAxisIds={new Set()}
        onToggle={vi.fn()}
        onToggleGroup={onToggleGroup}
        onToggleAxisLock={onToggleAxisLock}
        onPreview={vi.fn()}
      />,
    );

    const temperatureGroup = screen.getByRole("button", {
      name: "温度，点击切换整组显示",
    });
    fireEvent.click(temperatureGroup, { shiftKey: true });

    expect(onToggleAxisLock).toHaveBeenCalledWith("primary");
    expect(onToggleGroup).not.toHaveBeenCalled();

    view.rerender(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={new Set()}
        lockedAxisIds={new Set(["primary"])}
        onToggle={vi.fn()}
        onToggleGroup={onToggleGroup}
        onToggleAxisLock={onToggleAxisLock}
        onPreview={vi.fn()}
      />,
    );

    const lockedTemperature = screen.getByRole("button", {
      name: "温度，点击切换整组显示，已锁定，Shift加点击解除锁定",
    });
    expect(lockedTemperature).toHaveClass("is-axis-locked", "is-hidden");
    expect(lockedTemperature).toHaveAttribute("data-axis-locked", "true");
    expect(
      lockedTemperature.querySelector(".axis-lock-indicator"),
    ).toBeInTheDocument();
    expect(lockedTemperature.firstElementChild).toHaveClass(
      "axis-lock-indicator",
    );
    expect(lockedTemperature).toHaveTextContent("温度");
  });

  it("marks the group label hidden only when the whole group is hidden", () => {
    const onlyHumidityVisible = new Set(
      dataset.series
        .filter((series) => series.axisId === "secondary")
        .map((series) => series.id),
    );
    render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={onlyHumidityVisible}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    const temperatureGroup = screen.getByRole("button", {
      name: "温度，点击切换整组显示",
    });
    expect(temperatureGroup).toHaveClass("legend-group-label", "is-hidden");
    expect(temperatureGroup).toHaveAttribute("aria-pressed", "false");
    expect(temperatureGroup).not.toHaveAttribute("title");

    const humidityGroup = screen.getByRole("button", {
      name: "湿度，点击切换整组显示",
    });
    expect(humidityGroup).toHaveClass("legend-group-label");
    expect(humidityGroup).not.toHaveClass("is-hidden");
    expect(humidityGroup).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the group label state plain when only one series is hidden", () => {
    const partialVisibility = new Set(allSeries);
    partialVisibility.delete("set-temp");
    render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={partialVisibility}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    const temperatureGroup = screen.getByRole("button", {
      name: "温度，点击切换整组显示",
    });
    expect(temperatureGroup).toHaveClass("legend-group-label");
    expect(temperatureGroup).not.toHaveClass("is-hidden");
    expect(temperatureGroup).toHaveAttribute("aria-pressed", "false");
  });

  it("marks hidden series and does not preview them on enter or focus", () => {
    const onPreview = vi.fn();
    render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={new Set()}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={onPreview}
      />,
    );

    const actualTemperature = screen.getByRole("button", { name: "实测温度" });
    expect(actualTemperature).toHaveClass("is-hidden");
    expect(actualTemperature).toHaveAttribute("aria-pressed", "false");

    fireEvent.mouseEnter(actualTemperature);
    fireEvent.focus(actualTemperature);

    expect(onPreview).not.toHaveBeenCalled();
  });

  it("keeps preview state stable while hover and focus overlap", () => {
    const onPreview = vi.fn();
    render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={allSeries}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={onPreview}
      />,
    );

    const actualTemperature = screen.getByRole("button", { name: "实测温度" });

    fireEvent.mouseEnter(actualTemperature);
    fireEvent.focus(actualTemperature);
    fireEvent.mouseLeave(actualTemperature);
    expect(onPreview.mock.calls).toEqual([["actual-temp"]]);
    fireEvent.blur(actualTemperature);
    expect(onPreview.mock.calls).toEqual([["actual-temp"], [null]]);

    onPreview.mockClear();
    fireEvent.focus(actualTemperature);
    fireEvent.mouseEnter(actualTemperature);
    fireEvent.blur(actualTemperature);
    expect(onPreview.mock.calls).toEqual([["actual-temp"]]);
    fireEvent.mouseLeave(actualTemperature);
    expect(onPreview.mock.calls).toEqual([["actual-temp"], [null]]);
  });

  it("clears an active preview when controlled visibility hides the series", () => {
    const onPreview = vi.fn();

    function ControlledLegend() {
      const [visibleSeries, setVisibleSeries] = useState(allSeries);
      return (
        <ChartLegend
          axes={dataset.axes}
          series={dataset.series}
          visibleSeries={visibleSeries}
          onToggle={(seriesId) => {
            setVisibleSeries((current) => {
              const next = new Set(current);
              next.delete(seriesId);
              return next;
            });
          }}
          onToggleGroup={vi.fn()}
          onPreview={onPreview}
        />
      );
    }

    render(<ControlledLegend />);
    const actualTemperature = screen.getByRole("button", { name: "实测温度" });

    fireEvent.mouseEnter(actualTemperature);
    fireEvent.click(actualTemperature);

    expect(actualTemperature).toHaveAttribute("aria-pressed", "false");
    expect(onPreview.mock.calls).toEqual([["actual-temp"], [null]]);
  });

  it("uses the latest callback and clears preview when active series is removed", () => {
    const firstOnPreview = vi.fn();
    const nextOnPreview = vi.fn();
    const view = render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={allSeries}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={firstOnPreview}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: "实测温度" }));
    view.rerender(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={allSeries}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={nextOnPreview}
      />,
    );

    expect(firstOnPreview.mock.calls).toEqual([["actual-temp"]]);
    expect(nextOnPreview).not.toHaveBeenCalled();

    view.rerender(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series.filter((item) => item.id !== "actual-temp")}
        visibleSeries={allSeries}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={nextOnPreview}
      />,
    );

    expect(nextOnPreview.mock.calls).toEqual([[null]]);
  });

  it("clears an active preview through the latest callback on unmount", () => {
    const firstOnPreview = vi.fn();
    const nextOnPreview = vi.fn();
    const view = render(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={allSeries}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={firstOnPreview}
      />,
    );

    fireEvent.focus(screen.getByRole("button", { name: "实测温度" }));
    view.rerender(
      <ChartLegend
        axes={dataset.axes}
        series={dataset.series}
        visibleSeries={allSeries}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={nextOnPreview}
      />,
    );
    view.unmount();

    expect(firstOnPreview.mock.calls).toEqual([["actual-temp"]]);
    expect(nextOnPreview.mock.calls).toEqual([[null]]);
  });

  it("disambiguates duplicate names while keeping unique names concise", () => {
    const series = [
      { id: "actual-a", name: "温度", role: "measured", axisId: "primary" },
      { id: "set-a", name: "温度", role: "setpoint", axisId: "primary" },
      { id: "actual-b", name: "温度", role: "measured", axisId: "primary" },
      { id: "humidity", name: "湿度", role: "measured", axisId: "secondary" },
    ] satisfies LegendSeries[];

    render(
      <ChartLegend
        axes={dataset.axes}
        series={series}
        visibleSeries={new Set(series.map((item) => item.id))}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "温度，主轴，实测，actual-a" }),
    ).toHaveTextContent("");
    expect(
      screen.getByRole("button", { name: "温度，主轴，设定" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "温度，主轴，实测，actual-b" }),
    ).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "湿度" })).toHaveAttribute(
      "aria-label",
      "湿度",
    );
  });

  it("falls back to the primary axis role when an axis is not matched", () => {
    render(
      <ChartLegend
        axes={[]}
        series={[dataset.series[0]]}
        visibleSeries={new Set(["actual-temp"])}
        onToggle={vi.fn()}
        onToggleGroup={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "实测温度" })).toHaveClass(
      "legend-item",
      "is-measured",
      "is-primary",
    );
  });
});
