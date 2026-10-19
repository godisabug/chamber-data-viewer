import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

describe("portable desktop delivery", () => {
  it("builds a green single-file executable instead of installers", () => {
    const packageJson = readJson("package.json");
    const tauriConfig = readJson("src-tauri/tauri.conf.json");

    expect(packageJson.scripts["build:portable"]).toBe("tauri build --no-bundle");
    expect(tauriConfig.mainBinaryName).toBe("实验箱数据查看器");
    expect(tauriConfig.bundle.active).toBe(false);
    expect(tauriConfig.bundle.targets).toBeUndefined();
    expect(tauriConfig.bundle.windows).toBeUndefined();
  });

  it("documents the portable executable as the delivery artifact", () => {
    const readme = readText("README.md");
    const deliveryPath = "src-tauri\\target\\release\\实验箱数据查看器.exe";

    expect(readme).toContain("npm run build:portable");
    expect(readme).toContain(deliveryPath);
    expect(readme).not.toContain("src-tauri\\target\\release\\bundle");
  });

  it("runs referenced TypeScript builds and exposes a local lint command", () => {
    const packageJson = readJson("package.json");
    expect(packageJson.scripts.build).toBe("tsc -b && vite build");
    expect(packageJson.scripts.lint).toBe("oxlint src vite.config.ts packaging.test.mjs");
  });

  it("opens resizable but not maximized at the approved desktop size", () => {
    const window = readJson("src-tauri/tauri.conf.json").app.windows[0];

    expect(window).toMatchObject({
      width: 1280,
      height: 800,
      minWidth: 980,
      minHeight: 680,
      decorations: false,
      shadow: true,
      resizable: true,
      maximized: false,
      fullscreen: false,
    });
  });

  it("uses the same simplified trace mark across browser and desktop app icons", () => {
    const tauriConfig = readJson("src-tauri/tauri.conf.json");
    const sourceIcon = readText("src-tauri/icons/app-icon.svg");
    const favicon = readText("public/favicon.svg");

    expect(sourceIcon).toContain("derived from src/components/AppMark.tsx");
    for (const color of ["#17191c", "#d9dbde", "#1c69d4"]) {
      expect(sourceIcon).toContain(color);
      expect(favicon).toContain(color);
    }
    expect(sourceIcon).not.toContain("#6d7177");
    expect(favicon).toContain('d="M7 16l4-4 3 2 3-5"');
    expect(favicon).not.toContain("#863bff");
    for (const icon of tauriConfig.bundle.icon) {
      expect(existsSync(`src-tauri/${icon}`)).toBe(true);
    }
    expect(readText("src-tauri/build.rs")).toContain(
      'cargo:rerun-if-changed=icons/icon.ico',
    );
  });

  it("grants the floating settings window the permissions it needs", () => {
    const capabilities = readJson("src-tauri/capabilities/default.json");
    expect(capabilities.windows).toEqual(
      expect.arrayContaining(["main", "chart-settings"]),
    );
    for (const permission of [
      "core:window:allow-start-dragging",
      "core:window:allow-minimize",
      "core:window:allow-toggle-maximize",
      "core:window:allow-close",
      "core:window:allow-destroy",
      "core:window:allow-hide",
      "core:window:allow-set-position",
      "core:window:allow-set-size",
      "core:window:allow-show",
      "core:window:allow-set-focus",
      "core:webview:allow-create-webview-window",
    ]) {
      expect(capabilities.permissions).toContain(permission);
    }
  });
});
