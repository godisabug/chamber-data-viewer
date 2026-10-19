import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("desktop viewport CSS contract", () => {
  it("uses only system cursor keywords", () => {
    expect(styles).not.toMatch(/cursor:\s*url\(/);
  });

  it("uses the approved viewport, sidebar, and workspace frame values", () => {
    expect(styles).toContain("min-width: 980px;");
    expect(styles).toContain("min-height: 680px;");
    expect(styles).toMatch(/html,\s*body,\s*#root\s*\{[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(
      /\.app-shell\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.sidebar\s*\{[^}]*width:\s*264px;[^}]*padding-top:\s*32px;/s,
    );
    expect(styles).toMatch(/\.sidebar\.is-collapsed\s*\{[^}]*width:\s*48px;/s);
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*1179px\)[\s\S]*?\.sidebar:not\(\.is-collapsed\)\s*\{[^}]*width:\s*228px;/,
    );
    expect(styles).toMatch(
      /\.content-shell\s*\{[^}]*padding:\s*32px 0 0;[^}]*overflow:\s*hidden;/s,
    );
  });

  it("keeps scrolling inside the file list and settings panel only", () => {
    expect(styles).toMatch(
      /\.file-list\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.chart-settings\s*\{[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).not.toMatch(/\.content-shell\s*\{[^}]*overflow:\s*auto;/s);
  });

  it("does not restore fixed chart heights or legacy fixed first columns", () => {
    expect(styles).not.toMatch(
      /\.(?:chart|chart-frame)\s*\{[^}]*min-height:\s*480px;/s,
    );
    expect(styles).not.toMatch(
      /grid-template-columns:\s*(?:270px|304px)\s+minmax\(0,\s*1fr\)/,
    );
  });

  it("keeps the two essential actions visible in the collapsed sidebar", () => {
    expect(styles).not.toContain(
      ".sidebar.is-collapsed > :not(.sidebar-collapse-toggle)",
    );
    expect(styles).toMatch(
      /\.sidebar\.is-collapsed \.sidebar-header > :not\(\.sidebar-collapse-toggle\)\s*\{[^}]*display:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.sidebar\.is-collapsed \.file-list\s*\{[^}]*visibility:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.sidebar\.is-collapsed \.sidebar-footer\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.sidebar\.is-collapsed \.add-file-copy\s*\{[^}]*display:\s*none;/s,
    );
  });

  it("puts the collapsed file rail in the hidden file list's grid cell", () => {
    expect(styles).toMatch(/\.file-list\s*\{[^}]*grid-row:\s*2;[^}]*grid-column:\s*1;/s);
    expect(styles).toMatch(/\.file-rail\s*\{[^}]*grid-row:\s*2;[^}]*grid-column:\s*1;/s);
    expect(styles).toMatch(/\.sidebar-footer\s*\{[^}]*grid-row:\s*3;/s);
    expect(styles).toMatch(
      /\.file-rail-item\.is-active::before\s*\{[^}]*background:\s*var\(--accent\);/s,
    );
  });

  it("keeps the collapse toggle in the header safe area instead of over file rows", () => {
    expect(styles).toMatch(
      /\.sidebar-header\s*\{[^}]*position:\s*relative;/s,
    );
    const toggleRule = styles.match(/\n\.sidebar-collapse-toggle\s*\{([^}]*)\}/s)?.[1];
    expect(toggleRule).toBeTruthy();
    expect(toggleRule).toMatch(/top:\s*20px;/);
    expect(toggleRule).toMatch(/right:\s*8px;/);
    expect(toggleRule).toMatch(/width:\s*32px;/);
    expect(toggleRule).toMatch(/height:\s*32px;/);
    expect(toggleRule).not.toMatch(/top:\s*50%/);
    expect(toggleRule).not.toMatch(/translateY/);
  });

  it("keeps the bilingual brand and borderless mark inside the header", () => {
    expect(styles).toMatch(/\.sidebar-header\s*\{[^}]*grid-template-rows:\s*auto;/s);
    expect(styles).toMatch(/\.sidebar-header\s*\{[^}]*align-items:\s*center;/s);
    const markRule = styles.match(/\.brand-mark\s*\{([^}]*)\}/s)?.[1];
    expect(markRule).not.toMatch(/border:/);
    expect(styles).toMatch(
      /\.brand-mark \.app-mark-trace\s*\{[^}]*stroke:\s*var\(--accent\);[^}]*stroke-width:\s*1\.75;/s,
    );
    expect(styles).toMatch(
      /\.sidebar h1\s*\{[^}]*flex-direction:\s*column;[^}]*white-space:\s*normal;/s,
    );
  });

  it("styles the class names emitted by the real chart and file DOM", () => {
    expect(styles).not.toMatch(/\.chart-date-context\s*\{/);
    expect(styles).not.toMatch(/\.chart-cursor\s*\{/);
    expect(styles).toMatch(/\.chart-empty\s*\{/);
    expect(styles).toMatch(/\.file-location\s*\{/);
    expect(styles).toMatch(/\.file-sources\s*\{[^}]*webkit-line-clamp:\s*2;/s);
    expect(styles).toMatch(/\.range-field\s*>\s*\[role=["']alert["']\]\s*\{/);
    expect(styles).toMatch(/\.chart-settings\s+\[role=["']alert["']\]\s*\{/);
    expect(styles).not.toMatch(/\.diagnostics\s*\{/);
  });

  it("uses a transform-only loading motion with a reduced-motion fallback", () => {
    expect(styles).toMatch(
      /\.ui-icon\.is-spinning\s*\{[^}]*animation:\s*ui-icon-spin 800ms linear infinite;/s,
    );
    expect(styles).toMatch(
      /@keyframes ui-icon-spin\s*\{[\s\S]*?transform:\s*rotate\(360deg\);/,
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ui-icon\.is-spinning\s*\{[^}]*animation:\s*none;/,
    );
  });

  it("keeps the dark source ledger beside one continuous light observation surface", () => {
    expect(styles).toMatch(
      /\.sidebar\s*\{[^}]*background:\s*var\(--sidebar-bg\);/s,
    );
    for (const selector of [
      "content-shell",
      "workspace-panel",
      "chart-area",
      "empty-state",
    ]) {
      expect(styles).toMatch(
        new RegExp(
          `\\.${selector}\\s*\\{[^}]*background:\\s*var\\(--canvas\\);`,
          "s",
        ),
      );
    }
    expect(styles).toMatch(
      /\.range-controls\s*\{[^}]*background:\s*var\(--bg\);/s,
    );
    for (const selector of ["workspace-panel", "range-controls", "chart-area"]) {
      const rule = styles.match(
        new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`, "s"),
      )?.[1];
      expect(rule).toBeTruthy();
      expect(rule).not.toMatch(/box-shadow|border-radius/);
    }
  });

  it("reserves a dedicated integrated titlebar above the interactive workspace", () => {
    expect(styles).toMatch(
      /\.window-chrome\s*\{[^}]*position:\s*absolute;[^}]*height:\s*32px;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.window-drag-region\s*\{[^}]*right:\s*138px;[^}]*left:\s*0;[^}]*height:\s*32px;[^}]*pointer-events:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.window-controls\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*46px\);[^}]*height:\s*32px;/s,
    );
    expect(styles).toMatch(
      /\.window-control\.is-close:hover,[\s\S]*?background:\s*var\(--danger\);/,
    );
  });

  it("separates tooltip axis groups with breathing room", () => {
    expect(styles).toMatch(
      /\.tooltip-group\s*\+\s*\.tooltip-group\s*\{[^}]*margin-top:\s*12px;/s,
    );
  });

  it("marks tooltip rows with the legend's solid and dashed line samples", () => {
    expect(styles).toMatch(/\.tooltip-row \.series-swatch\s*\{[^}]*width:\s*16px;/s);
    expect(styles).toMatch(
      /\.tooltip-row \.series-swatch\.is-measured\s*\{[^}]*height:\s*3px;/s,
    );
    expect(styles).toMatch(
      /\.tooltip-row \.series-swatch\.is-setpoint\s*\{[^}]*repeating-linear-gradient\([^}]*currentColor 0 5px,[^}]*transparent 5px 8px/s,
    );
    expect(styles).not.toMatch(/\.tooltip-row \.series-swatch\s*\{[^}]*height:\s*8px;/s);
  });

  it("uses the system grabbing cursor over zrender canvas layers during pan", () => {
    const panRule = styles.match(
      /(\.chart\.is-panning,\s*\.chart\.is-panning \*)\s*\{([^}]*)\}/s,
    );
    expect(panRule).not.toBeNull();
    expect(panRule?.[2]).toMatch(/cursor:\s*grabbing\s*!important;/);
    expect(panRule?.[2]).not.toContain("url(");
  });

  it("lets the panning state win over zrender's inline curve cursor", () => {
    const style = document.createElement("style");
    style.textContent = styles;
    const chart = document.createElement("div");
    const zrenderLayer = document.createElement("canvas");
    chart.className = "chart is-panning";
    zrenderLayer.style.cursor = "pointer";
    chart.append(zrenderLayer);
    document.head.append(style);
    document.body.append(chart);

    try {
      expect(getComputedStyle(zrenderLayer).cursor).toBe("grabbing");
    } finally {
      chart.remove();
      style.remove();
    }
  });

  it("uses the system open-hand cursor over zrender canvas layers when y-pan is ready", () => {
    const readyRule = styles.match(
      /(\.chart\.is-y-pan-ready,\s*\.chart\.is-y-pan-ready \*)\s*\{([^}]*)\}/s,
    );
    expect(readyRule).not.toBeNull();
    expect(readyRule?.[2]).toMatch(/cursor:\s*grab\s*!important;/);
    expect(readyRule?.[2]).not.toContain("url(");
  });

  it("uses a selection cursor for the Shift-hover lock candidate", () => {
    const candidateRule = styles.match(
      /(\.chart\.is-curve-group-target,\s*\.chart\.is-curve-group-target \*)\s*\{([^}]*)\}/s,
    );
    expect(candidateRule).not.toBeNull();
    expect(candidateRule?.[2]).toMatch(/cursor:\s*pointer\s*!important;/);
    expect(candidateRule?.[2]).not.toContain("url(");
    expect(styles.indexOf(candidateRule?.[0] ?? "")).toBeLessThan(
      styles.indexOf(".chart.is-panning,"),
    );
  });

  it("shows focus rings only during real keyboard navigation", () => {
    expect(styles).toMatch(
      /\.using-keyboard\s+button:focus-visible[^{]*\{[^}]*outline:\s*2px\s+solid\s+var\(--accent-hover\);/s,
    );
    expect(styles).toMatch(
      /html:not\(\.using-keyboard\)\s+:focus-visible\s*\{[^}]*outline:\s*none;/s,
    );
  });

  it("keeps apply beside the compact time fields and secondary actions apart", () => {
    expect(styles).toMatch(
      /\.range-input-group\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*flex-end;[^}]*gap:\s*8px;/s,
    );
    expect(styles).toMatch(
      /\.range-field\s*\{[^}]*width:\s*184px;/s,
    );
    expect(styles).toMatch(
      /\.control-actions\s*\{[^}]*margin-left:\s*auto;/s,
    );
  });

  it("draws the time field as one bordered control with a calendar trigger", () => {
    expect(styles).toMatch(
      /\.time-field\s*\{[^}]*height:\s*var\(--control-height\);[^}]*border:\s*1px solid var\(--border\);/s,
    );
    expect(styles).toMatch(
      /\.time-field:focus-within\s*\{[^}]*border-color:\s*var\(--accent\);/s,
    );
    expect(styles).toMatch(/\.time-field input\s*\{[^}]*border:\s*0;/s);
    // 错误说明顶替字段名一行，不能再伸到命令带下方被图表区盖住。
    expect(styles).toMatch(
      /\.range-field\s*>\s*\[role=["']alert["']\]\s*\{[^}]*top:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.range-field\.is-invalid label\s*\{[^}]*opacity:\s*0;/s,
    );
  });

  it("shows restore-default inside the time field and names icon buttons with a quick tooltip", () => {
    expect(styles).toMatch(/\.time-field-restore\s*\{[^}]*width:\s*28px;/s);
    expect(styles).not.toMatch(/\.calendar-/);
    expect(styles).toMatch(
      /\[data-tip\]::after\s*\{[^}]*content:\s*attr\(data-tip\);[^}]*opacity:\s*0;/s,
    );
    expect(styles).toMatch(
      /\[data-tip\]:hover::after,\s*\.using-keyboard \[data-tip\]:focus-visible::after\s*\{[^}]*opacity:\s*1;/s,
    );
  });

  it("lays the quick reference out as four tiles per row and fills the used mouse part", () => {
    expect(styles).toMatch(
      /\.chart-help-tiles\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /\.mouse-glyph \.is-active\s*\{[^}]*fill:\s*var\(--fg\);/s,
    );
  });

  it("aligns the empty-state operation list in fixed key columns under a quiet watermark", () => {
    expect(styles).toMatch(
      /\.empty-state-hints dd\s*\{[^}]*grid-template-columns:\s*44px 14px 92px;/s,
    );
    expect(styles).toMatch(
      /\.empty-state-content\s*>\s*\.app-mark\s*\{[^}]*color:\s*var\(--neutral-100\);/s,
    );
    expect(styles).not.toMatch(/\.empty-state-open\s*\{/);
  });

  it("reveals the custom stepper only on hover or focus and hides the native one", () => {
    expect(styles).toMatch(/\.stepper-buttons\s*\{[^}]*opacity:\s*0;/s);
    expect(styles).toMatch(
      /\.stepper-field:hover \.stepper-buttons,\s*\.stepper-field:focus-within \.stepper-buttons\s*\{[^}]*opacity:\s*1;/s,
    );
    expect(styles).toMatch(
      /\.stepper-field input::-webkit-inner-spin-button,\s*\.stepper-field input::-webkit-outer-spin-button\s*\{[^}]*-webkit-appearance:\s*none;/s,
    );
  });

  it("gives every chart tool one button shape and one neutral engaged state", () => {
    expect(styles).toMatch(
      /\.range-field label\s*\{[^}]*font-weight:\s*500;/s,
    );
    // 游标、重置视图、图表设置、帮助共用同一种纯图标方形按钮。
    expect(styles).toMatch(
      /\.tertiary-button\.tool-button\s*\{[^}]*width:\s*var\(--control-height\);[^}]*padding:\s*0;/s,
    );
    expect(styles).not.toMatch(/\.tertiary-button\.chart-help-trigger\s*\{/);
    expect(styles).toMatch(
      /\.primary-button\s*\{[^}]*font-weight:\s*600;/s,
    );
    expect(styles).toMatch(
      /\.secondary-button\s*\{[^}]*color:\s*var\(--neutral-700\);[^}]*font-weight:\s*500;/s,
    );
    expect(styles).toMatch(
      /\.tertiary-button\s*\{[^}]*font-weight:\s*500;/s,
    );
    expect(styles).toMatch(
      /\.tertiary-button\s*\{[^}]*border:\s*1px\s+solid\s+transparent;[^}]*background:\s*transparent;/s,
    );
    expect(styles).toMatch(
      /\.tertiary-button\[aria-pressed=["']true["']\],\s*\.tertiary-button\[aria-expanded=["']true["']\]\s*\{[^}]*border-color:\s*var\(--border\);[^}]*color:\s*var\(--fg\);[^}]*background:\s*var\(--surface\);/s,
    );
    expect(styles).not.toContain(".cursor-switch");
    expect(styles).not.toMatch(/border-radius:\s*999px/);
    expect(styles).not.toMatch(/\.chart-settings-toggle\[aria-expanded/);
  });

  it("lays out every axis in one settings table that sizes its window", () => {
    expect(styles).toMatch(
      /\.settings-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+92px\s+92px;/s,
    );
    expect(styles).toMatch(/\.settings-heading\s*\{[^}]*min-height:\s*42px;/s);
    expect(styles).toMatch(
      /\.chart-settings--window\s*\{[^}]*position:\s*relative;[^}]*height:\s*auto;/s,
    );
    expect(styles).not.toMatch(/\.axis-switch|\.axis-fields|\.settings-section-heading/);
  });

  it("keeps the drop hint and the single error notice quiet", () => {
    expect(styles).toMatch(
      /\.drop-overlay\s*\{[^}]*border:\s*1\.5px dashed var\(--accent\);[^}]*background:\s*color-mix\(in srgb, var\(--accent\) 6%, transparent\);[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.error-banner\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s,
    );
    expect(styles).toMatch(/\.error-banner-close\s*\{[^}]*color:\s*var\(--muted\);/s);
    expect(styles).toMatch(
      /\.empty-state-content\s*\{[^}]*display:\s*grid;[^}]*justify-items:\s*center;/s,
    );
  });

  it("keeps file menus available at the scrolling boundary", () => {
    expect(styles).toMatch(
      /\.file-entry:not\(:first-child\):nth-last-child\(-n\s*\+\s*2\)\s+\.file-menu\s*\{[^}]*bottom:\s*\d/,
    );
    expect(styles).not.toMatch(
      /\.file-entry:nth-last-child\(-n\s*\+\s*2\)\s+\.file-menu/,
    );
    expect(styles).toMatch(/\.file-name\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.file-location\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it("keeps file metadata and tooltip numerals in the unified UI typeface", () => {
    expect(styles).not.toContain("--font-mono");
    expect(styles).toMatch(
      /\.sidebar-tooltip,\s*\.file-menu,\s*\.chart-context-menu,\s*\.chart-tooltip,\s*\.chart-help-popover,\s*\.chart-settings,\s*\.error-banner\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/s,
    );
    expect(styles).toMatch(/\.sidebar-tooltip::before\s*\{/);
    expect(styles).toMatch(
      /\.sidebar-tooltip-body\s*\{[^}]*max-height:\s*60vh;[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.sidebar-tooltip-body\s*\{[^}]*overflow-x:\s*clip;/s,
    );
    expect(styles).toMatch(
      /\.sidebar-tooltip\s*\{[^}]*max-width:\s*400px;/s,
    );
    expect(styles).not.toMatch(/vendor-badge|sidebar-tooltip-device/);
    expect(styles).not.toMatch(/\.sidebar-tooltip-paths\s*\{/);
  });

  it("keeps dataset actions progressive without data quality blockers", () => {
    expect(styles).toMatch(/\.menu-trigger\s*\{[^}]*opacity:\s*0;/s);
    expect(styles).toMatch(
      /\.file-entry:hover \.menu-trigger,[\s\S]*?\.file-entry:focus-within \.menu-trigger,[\s\S]*?\.menu-trigger\[aria-expanded="true"\]\s*\{[^}]*opacity:\s*1;/s,
    );
    expect(styles).not.toMatch(/\.data-quality-(?:trigger|popover|heading)/);
    expect(styles).not.toContain("--warning");
  });

  it("uses one restrained chrome system for existing overlays", () => {
    expect(styles).toContain(
      "--overlay-surface: color-mix(in srgb, var(--bg) 98%, transparent);",
    );
    expect(styles).toContain("--overlay-border: var(--border);");
    expect(styles).toContain(
      "--overlay-shadow: 0 8px 20px rgb(15 18 22 / 0.12);",
    );
    expect(styles).toMatch(
      /\.file-menu,\s*\.chart-context-menu,\s*\.chart-tooltip,\s*\.chart-help-popover,\s*\.chart-settings,\s*\.error-banner\s*\{[^}]*border:\s*1px solid var\(--overlay-border\);[^}]*background:\s*var\(--overlay-surface\);[^}]*box-shadow:\s*var\(--overlay-shadow\);/s,
    );
    expect(styles).toMatch(
      /\.sidebar-tooltip\s*\{[^}]*padding:\s*var\(--overlay-content-padding\);[^}]*border:\s*1px solid var\(--overlay-inverse-border\);[^}]*box-shadow:\s*var\(--overlay-shadow\);/s,
    );
    expect(styles).toMatch(
      /\.file-menu button\s*\{[^}]*min-height:\s*var\(--overlay-menu-item-height\);[^}]*padding:\s*8px 12px;[^}]*font-size:\s*12px;[^}]*line-height:\s*1\.4;/s,
    );
    expect(styles).toMatch(
      /\.chart-context-menu button\s*\{[^}]*min-height:\s*var\(--overlay-menu-item-height\);[^}]*padding:\s*8px 12px;[^}]*font-size:\s*12px;[^}]*line-height:\s*1\.4;/s,
    );
    expect(styles).toMatch(
      /\.chart-settings--window\s*\{[^}]*border:\s*0;[^}]*box-shadow:\s*none;/s,
    );
    expect(styles).not.toMatch(
      /\.error-banner\s*\{[^}]*border:\s*1px solid color-mix\([^}]*var\(--danger\)/s,
    );
    expect(styles).toMatch(
      /\.chart-help-popover\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*40;[^}]*width:\s*500px;[^}]*max-width:\s*calc\(100vw\s*-\s*32px\);[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.chart-help-body\s*\{[^}]*max-height:\s*calc\(100dvh\s*-\s*139px\);[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.keycap\s*\{[^}]*border:\s*1px solid var\(--border-strong\);[^}]*font-size:\s*11px;/s,
    );
  });

  it("styles the sidebar resize handle and the detail tooltip", () => {
    expect(styles).toMatch(
      /\.app-shell\s*\{[^}]*grid-template-columns:\s*auto\s+6px\s+minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(
      /\.sidebar-resize-handle\s*\{[^}]*cursor:\s*col-resize;/s,
    );
    expect(styles).toMatch(/\.sidebar-tooltip\s*\{[^}]*position:\s*fixed;/s);
    expect(styles).toMatch(/\.sidebar-tooltip\s*\{[^}]*pointer-events:\s*none;/s);
  });

  it("presents the complete open-data entry as one responsive action", () => {
    expect(styles).toMatch(
      /\.add-file-button\s*\{[^}]*grid-template-columns:\s*20px\s+minmax\(0,\s*1fr\);[^}]*width:\s*100%;[^}]*min-height:\s*52px;/s,
    );
    const addIconRule = styles.match(/\.add-file-icon\s*\{([^}]*)\}/s)?.[1];
    expect(addIconRule).toMatch(/width:\s*20px;/);
    expect(addIconRule).toMatch(/height:\s*20px;/);
    expect(addIconRule).toMatch(/color:\s*color-mix\(in srgb, var\(--bg\) 78%, transparent\);/);
    expect(addIconRule).not.toMatch(/background:/);
    expect(styles).toMatch(
      /\.add-file-copy strong\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(styles).not.toMatch(/\.add-file-copy > span\s*\{/);
    expect(styles).not.toContain(".vendor-chooser");
    expect(styles).not.toContain(".vendor-option");
  });

  it("keeps the legend toggle animation snappy", () => {
    expect(styles).toMatch(
      /\.legend-item\s*\{[^}]*transition:\s*opacity\s+var\(--motion-fast\)\s+var\(--ease-out\);/s,
    );
    expect(styles).toMatch(
      /\.legend-item\.is-hidden\s*\{[^}]*opacity:\s*0\.48;/s,
    );
    expect(styles).toMatch(
      /\.legend-item\.is-hidden \.series-swatch\s*\{[^}]*width:\s*10px;[^}]*opacity:\s*0\.42;/s,
    );
  });

  it("keeps legend text neutral while the swatch carries the series color", () => {
    expect(styles).toMatch(/\.legend-group-label\s*\{[^}]*font-size:\s*11px;/s);
    expect(styles).toMatch(/\.legend-item\s*\{[^}]*font-size:\s*11px;/s);
    expect(styles).not.toMatch(
      /\.legend-item\.is-primary\.is-measured\s*\{[^}]*color:/s,
    );
    expect(styles).toMatch(
      /\.legend-item\.is-primary\.is-measured \.series-swatch\s*\{[^}]*background:\s*#1c69d4;/s,
    );
    expect(styles).not.toMatch(
      /\.legend-group-label\.is-axis-locked\s*\{[^}]*color:/s,
    );
    expect(styles).toMatch(
      /\.axis-lock-indicator\s*\{[^}]*color:\s*var\(--fg\);/s,
    );
    expect(styles).toMatch(
      /\.legend-group-label\.is-hidden \.axis-lock-indicator\s*\{[^}]*color:\s*var\(--meta\);[^}]*opacity:\s*0\.48;/s,
    );
    expect(styles).toMatch(
      /\.legend-item\.is-tertiary\.is-setpoint \.series-swatch\s*\{[^}]*repeating-linear-gradient\([^}]*#5f8f94/s,
    );
    expect(styles).not.toMatch(/\.legend-item-label\s*\{/);
    expect(styles).not.toMatch(/\.legend\s*\{[^}]*border-bottom:/s);
  });

  it("uses only the approved compact desktop breakpoint", () => {
    expect(styles).toContain("@media (max-width: 1179px)");
    expect(styles).not.toMatch(/@media\s*\(max-width:\s*(?:767|768|799|800)px\)/);
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*1179px\)[\s\S]*?\.range-field\s*\{[^}]*width:\s*176px;/,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*1179px\)[\s\S]*?\.range-controls\s*\{[^}]*padding-inline:\s*12px;/,
    );
  });
});
