import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { Dataset } from "./types";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

function pngDataUrlBytes(dataUrl: string): Uint8Array {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error("图表导出数据不是有效的 PNG");
  }

  const decoded = atob(dataUrl.slice(PNG_DATA_URL_PREFIX.length));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function chooseDataFiles(): Promise<string[] | null> {
  const selected = await open({
    multiple: true,
    filters: [
      {
        name: "支持的数据文件",
        extensions: ["000", "csv", "SDR", "xls", "bin", "h12", "HSHBKA", "zip"],
      },
      { name: "所有文件", extensions: ["*"] },
    ],
  });

  if (Array.isArray(selected) && selected.length > 0) return selected;
  if (typeof selected === "string") return [selected];
  return null;
}

export async function loadDataset(paths: string[]): Promise<Dataset> {
  return invoke<Dataset>("load_dataset", { paths });
}

export async function saveChartImage(
  defaultFileName: string,
  dataUrl: string,
): Promise<string | null> {
  const selectedPath = await save({
    title: "将图像另存为",
    defaultPath: defaultFileName,
    filters: [{ name: "PNG 图像", extensions: ["png"] }],
  });
  if (typeof selectedPath !== "string") return null;

  await writeFile(selectedPath, pngDataUrlBytes(dataUrl));
  return selectedPath;
}
