import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseDataFiles, loadDataset, saveChartImage } from "./tauri";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
  save: mocks.save,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: mocks.writeFile }));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.open.mockReset();
  mocks.save.mockReset();
  mocks.writeFile.mockReset();
});

describe("automatic data file loading", () => {
  it("normalizes native multi-selection results while retaining an all-files option", async () => {
    mocks.open
      .mockResolvedValueOnce(["D:\\data\\part-1.000", "D:\\data\\part-2.SDR"])
      .mockResolvedValueOnce("D:\\data\\sample.csv")
      .mockResolvedValueOnce(null);

    await expect(chooseDataFiles()).resolves.toEqual([
      "D:\\data\\part-1.000",
      "D:\\data\\part-2.SDR",
    ]);
    await expect(chooseDataFiles()).resolves.toEqual(["D:\\data\\sample.csv"]);
    await expect(chooseDataFiles()).resolves.toBeNull();
    expect(mocks.open).toHaveBeenNthCalledWith(1, {
      multiple: true,
      filters: [
        {
          name: "支持的数据文件",
          extensions: ["000", "csv", "SDR", "xls", "bin", "h12", "HSHBKA", "zip"],
        },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
  });

  it("invokes the backend without a manually selected vendor rule", async () => {
    const dataset = { sourceId: "d:/data/sample.000" };
    mocks.invoke.mockResolvedValue(dataset);

    const paths = ["D:\\data\\part-1.000", "D:\\data\\part-2.SDR"];

    await expect(loadDataset(paths)).resolves.toBe(dataset);
    expect(mocks.invoke).toHaveBeenCalledWith("load_dataset", {
      paths,
    });
  });
});

describe("saveChartImage", () => {
  it("writes decoded PNG bytes to the path selected by the native dialog", async () => {
    mocks.save.mockResolvedValue("D:\\exports\\chart.png");
    mocks.writeFile.mockResolvedValue(undefined);

    const savedPath = await saveChartImage(
      "example.csv-曲线.png",
      "data:image/png;base64,iVBORw0KGgo=",
    );

    expect(mocks.save).toHaveBeenCalledWith({
      title: "将图像另存为",
      defaultPath: "example.csv-曲线.png",
      filters: [{ name: "PNG 图像", extensions: ["png"] }],
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "D:\\exports\\chart.png",
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(savedPath).toBe("D:\\exports\\chart.png");
  });

  it("does not write a file when the save dialog is cancelled", async () => {
    mocks.save.mockResolvedValue(null);

    await expect(
      saveChartImage("chart.png", "data:image/png;base64,iVBORw0KGgo="),
    ).resolves.toBeNull();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
