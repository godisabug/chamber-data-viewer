import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChartExportDataUrl,
  createChartImageFileName,
  type ExportLegendItem,
} from "./chartExport";

afterEach(() => vi.restoreAllMocks());

describe("chart export", () => {
  it("adds a Windows-safe local timestamp to the exported file name", () => {
    expect(
      createChartImageFileName(
        "sample.csv",
        new Date(2026, 6, 19, 14, 3, 5),
      ),
    ).toBe("sample.csv-曲线-20260719-140305.png");
  });

  it("replaces every Windows-invalid character in a merged export name", () => {
    expect(
      createChartImageFileName(
        '已合并 4 个 TEMI2500 文件<>:"/\\|?* ',
        new Date(2026, 7, 4, 19, 5, 6),
      ),
    ).toBe("已合并 4 个 TEMI2500 文件---------曲线-20260804-190506.png");
  });

  it("bounds a long ASCII export name while preserving the complete suffix", () => {
    const suffix = "-曲线-20260804-190506.png";
    const result = createChartImageFileName(
      "A".repeat(255),
      new Date(2026, 7, 4, 19, 5, 6),
    );

    expect(result.length).toBeLessThanOrEqual(255);
    expect(result.endsWith(suffix)).toBe(true);
    expect(result.slice(0, -suffix.length)).toBe(
      "A".repeat(255 - suffix.length),
    );
  });

  it("does not split a surrogate pair when bounding a long Unicode export name", () => {
    const suffix = "-曲线-20260804-190506.png";
    const result = createChartImageFileName(
      `Z${"😀".repeat(255)}`,
      new Date(2026, 7, 4, 19, 5, 6),
    );
    const stem = result.slice(0, -suffix.length);
    const firstUnit = stem.charCodeAt(0);
    const lastUnit = stem.charCodeAt(stem.length - 1);

    expect(result.length).toBeLessThanOrEqual(255);
    expect(result.endsWith(suffix)).toBe(true);
    expect(stem).not.toBe("");
    expect(stem).not.toBe("数据曲线");
    expect(firstUnit >= 0xdc00 && firstUnit <= 0xdfff).toBe(false);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
    if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff) {
      const previousUnit = stem.charCodeAt(stem.length - 2);
      expect(previousUnit >= 0xd800 && previousUnit <= 0xdbff).toBe(true);
    }
  });

  it("composes the current compact axis legend above the 2x chart canvas", () => {
    const chartCanvas = document.createElement("canvas");
    chartCanvas.width = 1_600;
    chartCanvas.height = 900;
    const renderToCanvas = vi.fn(() => chartCanvas);
    const drawImage = vi.fn();
    const fillText = vi.fn();
    const strokes: Array<{ color: string; width: number; alpha: number }> = [];
    const context = {
      fillStyle: "",
      font: "",
      globalAlpha: 1,
      lineWidth: 1,
      strokeStyle: "",
      textBaseline: "alphabetic",
      beginPath: vi.fn(),
      drawImage,
      fillRect: vi.fn(),
      fillText,
      lineTo: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 20 })),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setLineDash: vi.fn(),
      stroke: vi.fn(() => {
        strokes.push({
          color: context.strokeStyle,
          width: context.lineWidth,
          alpha: context.globalAlpha,
        });
      }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,combined",
    );
    const items: ExportLegendItem[] = [
      {
        axisId: "primary",
        axisName: "温度",
        name: "实测温度",
        color: "#1c69d4",
        width: 2.8,
        measured: true,
        visible: true,
      },
      {
        axisId: "primary",
        axisName: "温度",
        name: "设定温度",
        color: "#4a86dc",
        width: 1.8,
        measured: false,
        visible: false,
      },
    ];

    const result = createChartExportDataUrl({ renderToCanvas }, items);

    expect(renderToCanvas).toHaveBeenCalledWith({
      pixelRatio: 2,
      backgroundColor: "#fafbfc",
    });
    expect(result).toBe("data:image/png;base64,combined");
    expect(drawImage).toHaveBeenCalledWith(chartCanvas, 0, 76);
    expect(fillText.mock.calls.map(([text]) => text)).toEqual(["温度"]);
    expect(context.font).toContain("Segoe UI");
    expect(context.font).not.toContain("BMWTypeNextLatin");
    expect(context.moveTo).toHaveBeenNthCalledWith(1, 212, 38);
    expect(context.setLineDash).toHaveBeenCalledWith([10, 6]);
    expect(strokes).toEqual([
      { color: "#1c69d4", width: 5.6, alpha: 1 },
      { color: "#4a86dc", width: 3.6, alpha: 0.2 },
    ]);
  });
});
