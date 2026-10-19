import { CHART_CANVAS_BACKGROUND, CHART_FONT_FAMILY } from "./chartTheme";

export type ExportLegendItem = {
  axisId: string;
  axisName: string;
  name: string;
  color: string;
  width: number;
  measured: boolean;
  visible: boolean;
};

type ChartCanvasSource = {
  renderToCanvas(options: {
    pixelRatio: number;
    backgroundColor: string;
  }): HTMLCanvasElement;
};

export const CHART_EXPORT_PIXEL_RATIO = 2;
const MAX_WINDOWS_COMPONENT_UNITS = 255;
const LEGEND_FONT_SIZE = 11;
const LEGEND_ROW_HEIGHT = 38;
const LEGEND_LEFT_PADDING = 78;
const LEGEND_RIGHT_PADDING = 78;
const LEGEND_GROUP_GAP = 18;
const LEGEND_LABEL_GAP = 8;
const LEGEND_ITEM_GAP = 8;
const LEGEND_SWATCH_WIDTH = 20;
const LEGEND_HIDDEN_SWATCH_WIDTH = 10;
const LEGEND_HIDDEN_OPACITY = 0.2;

type ExportLegendGroup = {
  axisId: string;
  axisName: string;
  items: ExportLegendItem[];
};

type LaidOutLegendGroup = ExportLegendGroup & {
  x: number;
  labelWidth: number;
  width: number;
};

function groupLegendItems(
  legendItems: readonly ExportLegendItem[],
): ExportLegendGroup[] {
  const groups: ExportLegendGroup[] = [];
  const groupsByAxis = new Map<string, ExportLegendGroup>();
  for (const item of legendItems) {
    let group = groupsByAxis.get(item.axisId);
    if (!group) {
      group = {
        axisId: item.axisId,
        axisName: item.axisName,
        items: [],
      };
      groupsByAxis.set(item.axisId, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function safeWindowsFileStem(value: string): string {
  // oxlint-disable-next-line no-control-regex -- Windows forbids ASCII control characters in file names.
  const safeStem = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/, "")
    .trim();
  return safeStem || "数据曲线";
}

function boundWindowsFileStem(value: string, budget: number): string {
  const boundedBudget = Math.max(0, budget);
  let boundedStem = safeWindowsFileStem(value).slice(0, boundedBudget);
  const lastUnit = boundedStem.charCodeAt(boundedStem.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    boundedStem = boundedStem.slice(0, -1);
  }
  if (boundedStem) return boundedStem;

  return "数据曲线".slice(0, boundedBudget);
}

export function createChartImageFileName(
  sourceFile: string,
  date = new Date(),
): string {
  const timestamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
  const suffix = `-曲线-${timestamp}.png`;
  const stemBudget = MAX_WINDOWS_COMPONENT_UNITS - suffix.length;
  const boundedStem = boundWindowsFileStem(sourceFile, stemBudget);
  const boundedSuffix = boundedStem.endsWith("-") ? suffix.slice(1) : suffix;
  return `${boundedStem}${boundedSuffix}`;
}

export function createChartExportDataUrl(
  chart: ChartCanvasSource,
  legendItems: readonly ExportLegendItem[],
): string {
  const chartCanvas = chart.renderToCanvas({
    pixelRatio: CHART_EXPORT_PIXEL_RATIO,
    backgroundColor: CHART_CANVAS_BACKGROUND,
  });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建图表导出画布");

  const scale = CHART_EXPORT_PIXEL_RATIO;
  const leftPadding = LEGEND_LEFT_PADDING * scale;
  const rightPadding = LEGEND_RIGHT_PADDING * scale;
  const groupGap = LEGEND_GROUP_GAP * scale;
  const labelGap = LEGEND_LABEL_GAP * scale;
  const itemGap = LEGEND_ITEM_GAP * scale;
  const swatchWidth = LEGEND_SWATCH_WIDTH * scale;
  const rowHeight = LEGEND_ROW_HEIGHT * scale;
  const availableWidth = Math.max(
    1,
    chartCanvas.width - leftPadding - rightPadding,
  );

  context.font = `${LEGEND_FONT_SIZE * scale}px ${CHART_FONT_FAMILY}`;
  const groups = groupLegendItems(legendItems).map((group) => {
    const labelWidth = context.measureText(group.axisName).width;
    return {
      ...group,
      labelWidth,
      width:
        labelWidth +
        labelGap +
        group.items.length * swatchWidth +
        Math.max(0, group.items.length - 1) * itemGap,
    };
  });
  const rows: LaidOutLegendGroup[][] = [[]];
  let rowWidth = 0;
  for (const group of groups) {
    const nextWidth =
      rowWidth === 0 ? group.width : rowWidth + groupGap + group.width;
    if (rowWidth > 0 && nextWidth > availableWidth) {
      rows.push([]);
      rowWidth = 0;
    }
    const x = rowWidth === 0 ? 0 : rowWidth + groupGap;
    rows.at(-1)!.push({ ...group, x });
    rowWidth = x + group.width;
  }
  if (groups.length === 0) rows.length = 0;

  const legendHeight = rows.length * rowHeight;
  canvas.width = chartCanvas.width;
  canvas.height = chartCanvas.height + legendHeight;

  context.fillStyle = CHART_CANVAS_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(chartCanvas, 0, legendHeight);

  rows.forEach((row, rowIndex) => {
    const centerY = rowIndex * rowHeight + rowHeight / 2;

    row.forEach((group) => {
      const groupX = leftPadding + group.x;
      const groupHidden = group.items.every((item) => !item.visible);
      context.save();
      context.globalAlpha = groupHidden ? 0.48 : 1;
      context.fillStyle = groupHidden ? "#a8adb4" : "#6d7177";
      context.font = `${LEGEND_FONT_SIZE * scale}px ${CHART_FONT_FAMILY}`;
      context.textBaseline = "middle";
      context.fillText(group.axisName, groupX, centerY);
      context.restore();

      let itemX = groupX + group.labelWidth + labelGap;
      group.items.forEach((item) => {
        const lineWidth = item.visible
          ? swatchWidth
          : LEGEND_HIDDEN_SWATCH_WIDTH * scale;
        context.save();
        context.globalAlpha = item.visible ? 1 : LEGEND_HIDDEN_OPACITY;
        context.strokeStyle = item.color;
        context.lineWidth = item.width * scale;
        if (!item.measured) {
          context.setLineDash([5 * scale, 3 * scale]);
        }
        context.beginPath();
        context.moveTo(itemX, centerY);
        context.lineTo(itemX + lineWidth, centerY);
        context.stroke();
        context.restore();
        itemX += swatchWidth + itemGap;
      });
    });
  });

  return canvas.toDataURL("image/png");
}
