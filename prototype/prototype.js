(() => {
  "use strict";

  const FULL_START = new Date("2026-05-02T07:57:49").getTime();
  const FULL_END = new Date("2026-07-03T10:43:20").getTime();
  const DEFAULT_TEMP_RANGE = [-60, 120];
  const DEFAULT_HUMIDITY_RANGE = [0, 120];
  const SIDEBAR_DEFAULT_WIDTH = 264;
  const SIDEBAR_MIN_WIDTH = 180;
  const SIDEBAR_MAX_WIDTH = 420;
  const SIDEBAR_COLLAPSED_WIDTH = 48;

  const elements = {
    app: document.querySelector("#prototypeApp"),
    windowMinimize: document.querySelector("#windowMinimize"),
    windowMaximize: document.querySelector("#windowMaximize"),
    windowClose: document.querySelector("#windowClose"),
    sidebar: document.querySelector("#sidebar"),
    sidebarToggle: document.querySelector("#sidebarToggle"),
    sidebarResizer: document.querySelector("#sidebarResizer"),
    openFileButton: document.querySelector("#openFileButton"),
    openFileTitle: document.querySelector("#openFileTitle"),
    fileEntry: document.querySelector("#fileEntry"),
    menuTrigger: document.querySelector("#menuTrigger"),
    fileMenu: document.querySelector("#fileMenu"),
    startTime: document.querySelector("#startTime"),
    endTime: document.querySelector("#endTime"),
    applyRange: document.querySelector("#applyRange"),
    resetView: document.querySelector("#resetView"),
    rangeError: document.querySelector("#rangeError"),
    cursorToggle: document.querySelector("#cursorToggle"),
    settingsToggle: document.querySelector("#settingsToggle"),
    settingsPanel: document.querySelector("#settingsPanel"),
    settingsHeading: document.querySelector("#settingsHeading"),
    settingsClose: document.querySelector("#settingsClose"),
    chartFrame: document.querySelector("#chartFrame"),
    canvas: document.querySelector("#chartCanvas"),
    tooltip: document.querySelector("#chartTooltip"),
    tooltipTime: document.querySelector("#tooltipTime"),
    tooltipTemp: document.querySelector("#tooltipTemp"),
    tooltipHumidity: document.querySelector("#tooltipHumidity"),
    axisMin: document.querySelector("#axisMin"),
    axisMax: document.querySelector("#axisMax"),
    axisMinLabel: document.querySelector("#axisMinLabel"),
    axisMaxLabel: document.querySelector("#axisMaxLabel"),
    yGridCount: document.querySelector("#yGridCount"),
    xGridCount: document.querySelector("#xGridCount"),
    applySettings: document.querySelector("#applySettings"),
    resetSettings: document.querySelector("#resetSettings"),
    liveRegion: document.querySelector("#liveRegion"),
  };

  const state = {
    viewStart: FULL_START,
    viewEnd: FULL_END,
    cursorVisible: true,
    pointer: null,
    pan: null,
    renderPending: false,
    series: new Set([
      "tempMeasured",
      "tempSetpoint",
      "humidityMeasured",
      "humiditySetpoint",
    ]),
    temperatureRange: [...DEFAULT_TEMP_RANGE],
    humidityRange: [...DEFAULT_HUMIDITY_RANGE],
    yGridCount: 6,
    xGridCount: 6,
    settingsAxis: "temperature",
    settingsDrag: null,
    readingTimer: null,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  };

  const points = createDataset(1800);
  let plotRect = { left: 74, top: 42, right: 0, bottom: 0, width: 0, height: 0 };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatInputTime(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function formatTooltipTime(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function formatAxisDate(timestamp) {
    const date = new Date(timestamp);
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function interpolateStops(progress, stops, fallback) {
    for (const [from, to, value] of stops) {
      if (progress >= from && progress <= to) return value;
    }
    return fallback;
  }

  function deterministicNoise(index, scale = 1) {
    return (
      Math.sin(index * 1.713) * 0.42 +
      Math.sin(index * 0.317 + 1.2) * 0.35 +
      Math.sin(index * 0.071 + 4.4) * 0.23
    ) * scale;
  }

  function createDataset(count) {
    const temperatureStops = [
      [0.063, 0.081, -40],
      [0.095, 0.113, 70],
      [0.116, 0.128, 50],
      [0.158, 0.174, -40],
      [0.188, 0.226, 65],
      [0.237, 0.252, -40],
      [0.263, 0.275, 38],
      [0.294, 0.311, -50],
      [0.327, 0.348, 60],
      [0.351, 0.367, 65],
      [0.403, 0.407, -50],
      [0.599, 0.603, 66],
      [0.739, 0.742, -20],
      [0.751, 0.789, 60],
      [0.797, 0.808, 45],
      [0.854, 0.861, 45],
      [0.869, 0.879, -20],
      [0.886, 0.904, -20],
      [0.911, 0.946, 60],
    ];
    const temperatureDrops = [
      [0.045, 0.049, -42],
      [0.132, 0.136, 14],
      [0.169, 0.172, -34],
      [0.219, 0.223, -32],
      [0.281, 0.285, -39],
      [0.944, 0.949, 18],
    ];
    const humidityDips = [
      [0.061, 0.064, 89],
      [0.142, 0.148, 92],
      [0.156, 0.159, 68],
      [0.171, 0.174, 86],
      [0.224, 0.229, 92],
      [0.309, 0.315, 89],
      [0.364, 0.370, 78],
      [0.666, 0.671, 86],
      [0.704, 0.709, 91],
      [0.728, 0.733, 88],
      [0.824, 0.829, 92],
      [0.851, 0.856, 88],
      [0.963, 0.970, 50],
      [0.972, 0.979, 86],
    ];

    const result = [];
    let measuredTemperature = 25;
    let measuredHumidity = 97;
    for (let index = 0; index < count; index += 1) {
      const progress = index / (count - 1);
      const timestamp = FULL_START + progress * (FULL_END - FULL_START);
      const ambient = 25 + Math.sin(progress * Math.PI * 3.2) * 2.5;
      const setTemperature = interpolateStops(progress, temperatureStops, ambient);
      const temperatureDrop = interpolateStops(progress, temperatureDrops, null);
      const tempTarget = temperatureDrop ?? setTemperature;
      measuredTemperature += (tempTarget - measuredTemperature) * 0.42;
      measuredTemperature += deterministicNoise(index, Math.abs(tempTarget) > 32 ? 0.55 : 0.24);

      const humidityGap = progress > 0.381 && progress < 0.596;
      const setHumidity = humidityGap ? null : 97.2;
      const humidityTarget = interpolateStops(progress, humidityDips, 97.1);
      measuredHumidity += (humidityTarget - measuredHumidity) * 0.38;
      measuredHumidity += deterministicNoise(index + 700, 0.34);

      result.push({
        timestamp,
        tempMeasured: Number(measuredTemperature.toFixed(2)),
        tempSetpoint: Number(setTemperature.toFixed(2)),
        humidityMeasured: humidityGap ? null : Number(measuredHumidity.toFixed(2)),
        humiditySetpoint: setHumidity,
      });
    }
    return result;
  }

  function setView(view) {
    elements.app.dataset.view = view;
    const loaded = view === "loaded";
    if (!loaded) {
      closeSettings();
      closeFileMenu();
      hideTooltip();
    } else {
      requestRender();
    }
  }

  function simulateRead(viewAfter = "loaded") {
    if (state.readingTimer !== null) return;
    elements.openFileButton.classList.add("is-loading");
    elements.openFileButton.setAttribute("aria-busy", "true");
    elements.openFileTitle.textContent = "正在读取数据";
    elements.liveRegion.textContent = "正在读取数据";
    state.readingTimer = window.setTimeout(() => {
      state.readingTimer = null;
      elements.openFileButton.classList.remove("is-loading");
      elements.openFileButton.removeAttribute("aria-busy");
      elements.openFileTitle.textContent = "打开数据文件";
      setView(viewAfter);
      elements.liveRegion.textContent = "数据文件已载入";
    }, 520);
  }

  function sidebarMaxWidth() {
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 560));
  }

  function updateSidebarSeparator() {
    const collapsed = elements.app.classList.contains("is-collapsed");
    const width = collapsed ? SIDEBAR_COLLAPSED_WIDTH : Math.round(state.sidebarWidth);
    elements.sidebarResizer.setAttribute("aria-valuemax", String(sidebarMaxWidth()));
    elements.sidebarResizer.setAttribute("aria-valuenow", String(width));
    elements.sidebarResizer.setAttribute(
      "aria-valuetext",
      collapsed ? "侧栏已折叠，48 像素" : `${width} 像素`,
    );
  }

  function setSidebarWidth(width) {
    state.sidebarWidth = clamp(width, SIDEBAR_MIN_WIDTH, sidebarMaxWidth());
    elements.app.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
    updateSidebarSeparator();
    requestRender();
  }

  function setSidebarCollapsed(collapsed) {
    elements.app.classList.toggle("is-collapsed", collapsed);
    elements.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    const action = collapsed ? "展开数据来源" : "折叠数据来源";
    elements.sidebarToggle.setAttribute("aria-label", action);
    elements.sidebarToggle.title = action;
    if (collapsed) {
      closeFileMenu();
    }
    updateSidebarSeparator();
    window.setTimeout(requestRender, 180);
  }

  function toggleSidebar() {
    const collapsed = !elements.app.classList.contains("is-collapsed");
    setSidebarCollapsed(collapsed);
    elements.liveRegion.textContent = collapsed ? "数据来源已折叠" : "数据来源已展开";
  }

  function syncSidebarToViewport() {
    if (elements.app.classList.contains("is-collapsed")) {
      updateSidebarSeparator();
      requestRender();
      return;
    }
    setSidebarWidth(state.sidebarWidth);
  }

  function announcePrototypeWindowAction(action) {
    elements.liveRegion.textContent = `浏览器原型不执行${action}；桌面版将使用原生窗口控制。`;
  }

  function syncFullscreenControl() {
    const fullscreen = Boolean(document.fullscreenElement);
    elements.windowMaximize.setAttribute("aria-label", fullscreen ? "退出全屏预览" : "进入全屏预览");
    elements.windowMaximize.title = fullscreen ? "退出全屏预览" : "进入全屏预览";
    elements.windowMaximize.classList.toggle("is-restoring", fullscreen);
  }

  async function toggleFullscreenPreview() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      elements.liveRegion.textContent = "当前浏览器不允许进入全屏预览。";
    }
  }

  function toggleFileMenu() {
    const open = elements.fileMenu.hidden;
    elements.fileMenu.hidden = !open;
    elements.menuTrigger.setAttribute("aria-expanded", String(open));
  }

  function closeFileMenu() {
    elements.fileMenu.hidden = true;
    elements.menuTrigger.setAttribute("aria-expanded", "false");
  }

  function applyRange() {
    const start = new Date(elements.startTime.value).getTime();
    const end = new Date(elements.endTime.value).getTime();
    let message = "";
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      message = "请输入完整的开始时间和截止时间";
    } else if (start >= end) {
      message = "开始时间必须早于截止时间";
    } else if (start < FULL_START || end > FULL_END) {
      message = "时间范围需位于当前数据集范围内";
    }
    if (message) {
      elements.rangeError.textContent = message;
      elements.rangeError.hidden = false;
      return;
    }
    elements.rangeError.hidden = true;
    state.viewStart = start;
    state.viewEnd = end;
    hideTooltip();
    requestRender();
  }

  function updateTimeInputs() {
    elements.startTime.value = formatInputTime(state.viewStart);
    elements.endTime.value = formatInputTime(state.viewEnd);
  }

  function resetView() {
    state.viewStart = FULL_START;
    state.viewEnd = FULL_END;
    elements.rangeError.hidden = true;
    updateTimeInputs();
    hideTooltip();
    requestRender();
    elements.liveRegion.textContent = "已重置为完整数据范围";
  }

  function toggleSeries(button) {
    const seriesName = button.dataset.series;
    if (!seriesName) return;
    if (state.series.has(seriesName)) state.series.delete(seriesName);
    else state.series.add(seriesName);
    button.setAttribute("aria-pressed", String(state.series.has(seriesName)));
    hideTooltip();
    requestRender();
  }

  function toggleAxis(axis) {
    const names = axis === "temperature"
      ? ["tempMeasured", "tempSetpoint"]
      : ["humidityMeasured", "humiditySetpoint"];
    const allVisible = names.every((name) => state.series.has(name));
    names.forEach((name) => {
      if (allVisible) state.series.delete(name);
      else state.series.add(name);
      document.querySelector(`[data-series="${name}"]`)?.setAttribute(
        "aria-pressed",
        String(!allVisible),
      );
    });
    requestRender();
  }

  function toggleCursor() {
    state.cursorVisible = elements.cursorToggle.checked;
    elements.chartFrame.classList.toggle("no-cursor", !state.cursorVisible);
    if (!state.cursorVisible) hideTooltip();
    requestRender();
  }

  function toggleSettings() {
    const open = elements.settingsPanel.hidden;
    elements.settingsPanel.hidden = !open;
    elements.settingsToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      elements.settingsPanel.style.top = "84px";
      elements.settingsPanel.style.right = "22px";
      elements.settingsPanel.style.left = "auto";
      syncSettingsFields();
    }
  }

  function closeSettings() {
    elements.settingsPanel.hidden = true;
    elements.settingsToggle.setAttribute("aria-expanded", "false");
  }

  function syncSettingsFields() {
    const temperature = state.settingsAxis === "temperature";
    const range = temperature ? state.temperatureRange : state.humidityRange;
    elements.axisMin.value = String(range[0]);
    elements.axisMax.value = String(range[1]);
    elements.axisMinLabel.textContent = temperature ? "温度下限" : "湿度下限";
    elements.axisMaxLabel.textContent = temperature ? "温度上限" : "湿度上限";
    elements.yGridCount.value = String(state.yGridCount);
    elements.xGridCount.value = String(state.xGridCount);
  }

  function selectSettingsAxis(button) {
    state.settingsAxis = button.dataset.axisTab;
    document.querySelectorAll("[data-axis-tab]").forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-pressed", String(active));
    });
    syncSettingsFields();
  }

  function applySettings() {
    const min = Number(elements.axisMin.value);
    const max = Number(elements.axisMax.value);
    const yCount = Number(elements.yGridCount.value);
    const xCount = Number(elements.xGridCount.value);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      elements.axisMin.focus();
      elements.axisMin.setAttribute("aria-invalid", "true");
      elements.liveRegion.textContent = "坐标轴下限必须小于上限";
      return;
    }
    if (![yCount, xCount].every((value) => Number.isInteger(value) && value >= 1 && value <= 9)) {
      elements.yGridCount.focus();
      elements.liveRegion.textContent = "刻度格数必须为一至九的整数";
      return;
    }
    elements.axisMin.removeAttribute("aria-invalid");
    if (state.settingsAxis === "temperature") state.temperatureRange = [min, max];
    else state.humidityRange = [min, max];
    state.yGridCount = yCount;
    state.xGridCount = xCount;
    closeSettings();
    hideTooltip();
    requestRender();
  }

  function resetSettings() {
    state.temperatureRange = [...DEFAULT_TEMP_RANGE];
    state.humidityRange = [...DEFAULT_HUMIDITY_RANGE];
    state.yGridCount = 6;
    state.xGridCount = 6;
    syncSettingsFields();
    requestRender();
    elements.liveRegion.textContent = "图表设置已重置";
  }

  function resizeSidebar(event) {
    if (elements.app.classList.contains("is-collapsed") || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const initialWidth = elements.sidebar.getBoundingClientRect().width;
    elements.sidebarResizer.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";

    const move = (moveEvent) => {
      setSidebarWidth(initialWidth + moveEvent.clientX - startX);
    };
    const stop = () => {
      elements.sidebarResizer.classList.remove("is-resizing");
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
  }

  function keyboardResizeSidebar(event) {
    const collapsed = elements.app.classList.contains("is-collapsed");
    const step = event.shiftKey ? 24 : 8;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (collapsed) setSidebarCollapsed(false);
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      setSidebarWidth(state.sidebarWidth + direction * step);
      event.preventDefault();
      return;
    }
    if (event.key === "Home") {
      setSidebarCollapsed(true);
      event.preventDefault();
      return;
    }
    if (event.key === "End") {
      setSidebarCollapsed(false);
      setSidebarWidth(sidebarMaxWidth());
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      toggleSidebar();
      event.preventDefault();
    }
  }

  function startSettingsDrag(event) {
    if (event.button !== 0 || event.target.closest("button, input")) return;
    const rect = elements.settingsPanel.getBoundingClientRect();
    state.settingsDrag = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    elements.settingsPanel.style.right = "auto";
    event.preventDefault();
  }

  function moveSettings(event) {
    if (!state.settingsDrag) return;
    const rect = elements.settingsPanel.getBoundingClientRect();
    const left = clamp(event.clientX - state.settingsDrag.offsetX, 8, window.innerWidth - rect.width - 8);
    const top = clamp(event.clientY - state.settingsDrag.offsetY, 8, window.innerHeight - rect.height - 8);
    elements.settingsPanel.style.left = `${left}px`;
    elements.settingsPanel.style.top = `${top}px`;
  }

  function stopSettingsDrag() {
    state.settingsDrag = null;
  }

  function requestRender() {
    if (state.renderPending || elements.app.dataset.view !== "loaded") return;
    state.renderPending = true;
    window.requestAnimationFrame(() => {
      state.renderPending = false;
      renderChart();
    });
  }

  function canvasPoint(event) {
    const rect = elements.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function isInsidePlot(point) {
    return point.x >= plotRect.left && point.x <= plotRect.right && point.y >= plotRect.top && point.y <= plotRect.bottom;
  }

  function timeAtX(x) {
    const ratio = clamp((x - plotRect.left) / plotRect.width, 0, 1);
    return state.viewStart + ratio * (state.viewEnd - state.viewStart);
  }

  function xAtTime(timestamp) {
    return plotRect.left + ((timestamp - state.viewStart) / (state.viewEnd - state.viewStart)) * plotRect.width;
  }

  function yAtValue(value, range) {
    return plotRect.bottom - ((value - range[0]) / (range[1] - range[0])) * plotRect.height;
  }

  function renderChart() {
    const frameRect = elements.chartFrame.getBoundingClientRect();
    if (frameRect.width < 1 || frameRect.height < 1) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(frameRect.width);
    const height = Math.round(frameRect.height);
    elements.canvas.width = Math.round(width * ratio);
    elements.canvas.height = Math.round(height * ratio);
    const context = elements.canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#fbfcfd";
    context.fillRect(0, 0, width, height);

    const left = 74;
    const rightInset = 74;
    const top = 43;
    const bottomInset = 52;
    plotRect = {
      left,
      top,
      right: width - rightInset,
      bottom: height - bottomInset,
      width: Math.max(1, width - left - rightInset),
      height: Math.max(1, height - top - bottomInset),
    };

    drawGrid(context, width, height);
    context.save();
    context.beginPath();
    context.rect(plotRect.left, plotRect.top, plotRect.width, plotRect.height);
    context.clip();
    drawVisibleSeries(context);
    if (state.pointer && state.cursorVisible && isInsidePlot(state.pointer)) {
      drawCursor(context, state.pointer);
    }
    context.restore();
    positionTooltip();
  }

  function drawGrid(context) {
    context.save();
    context.lineWidth = 1;
    context.strokeStyle = "#e4e8ec";
    context.fillStyle = "#68717b";
    context.font = '12px "Segoe UI Variable Text", "Segoe UI", sans-serif';
    context.textBaseline = "middle";

    for (let index = 0; index <= state.yGridCount; index += 1) {
      const y = plotRect.top + (index / state.yGridCount) * plotRect.height;
      context.beginPath();
      context.moveTo(plotRect.left, Math.round(y) + 0.5);
      context.lineTo(plotRect.right, Math.round(y) + 0.5);
      context.stroke();

      const temperature = state.temperatureRange[1] - (index / state.yGridCount) * (state.temperatureRange[1] - state.temperatureRange[0]);
      const humidity = state.humidityRange[1] - (index / state.yGridCount) * (state.humidityRange[1] - state.humidityRange[0]);
      context.textAlign = "right";
      context.fillText(formatTick(temperature), plotRect.left - 12, y);
      context.textAlign = "left";
      context.fillText(formatTick(humidity), plotRect.right + 12, y);
    }

    for (let index = 0; index <= state.xGridCount; index += 1) {
      const x = plotRect.left + (index / state.xGridCount) * plotRect.width;
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, plotRect.top);
      context.lineTo(Math.round(x) + 0.5, plotRect.bottom);
      context.stroke();
      const timestamp = state.viewStart + (index / state.xGridCount) * (state.viewEnd - state.viewStart);
      context.textAlign = "center";
      context.textBaseline = "top";
      context.fillText(formatAxisDate(timestamp), x, plotRect.bottom + 16);
      context.textBaseline = "middle";
    }

    context.strokeStyle = "#767d85";
    context.strokeRect(
      Math.round(plotRect.left) + 0.5,
      Math.round(plotRect.top) + 0.5,
      Math.round(plotRect.width),
      Math.round(plotRect.height),
    );

    context.fillStyle = "#68717b";
    context.font = '12px "Segoe UI Variable Text", "Segoe UI", sans-serif';
    context.textBaseline = "alphabetic";
    context.textAlign = "left";
    context.fillText("温度 °C", plotRect.left, 22);
    context.textAlign = "right";
    context.fillText("湿度 %RH", plotRect.right, 22);
    context.restore();
  }

  function formatTick(value) {
    if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
    return value.toFixed(1);
  }

  function drawVisibleSeries(context) {
    const definitions = [
      { key: "humiditySetpoint", axis: "humidity", color: "#7b8087", width: 1.35, dash: [7, 5], alpha: 0.86 },
      { key: "tempSetpoint", axis: "temperature", color: "#75808b", width: 1.35, dash: [7, 5], alpha: 0.9 },
      { key: "humidityMeasured", axis: "humidity", color: "#30343a", width: 2.05, dash: [], alpha: 1 },
      { key: "tempMeasured", axis: "temperature", color: "#1c69d4", width: 2.15, dash: [], alpha: 1 },
    ];
    definitions.forEach((definition) => {
      if (!state.series.has(definition.key)) return;
      drawSeries(context, definition);
    });
  }

  function drawSeries(context, definition) {
    const range = definition.axis === "temperature" ? state.temperatureRange : state.humidityRange;
    context.save();
    context.beginPath();
    context.strokeStyle = definition.color;
    context.globalAlpha = definition.alpha;
    context.lineWidth = definition.width;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.setLineDash(definition.dash);
    let active = false;
    for (const point of points) {
      if (point.timestamp < state.viewStart - (state.viewEnd - state.viewStart) * 0.002) continue;
      if (point.timestamp > state.viewEnd + (state.viewEnd - state.viewStart) * 0.002) break;
      const value = point[definition.key];
      if (value === null || value === undefined) {
        active = false;
        continue;
      }
      const x = xAtTime(point.timestamp);
      const y = yAtValue(value, range);
      if (!active) {
        context.moveTo(x, y);
        active = true;
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
    context.restore();
  }

  function nearestPoint(timestamp) {
    const ratio = (timestamp - FULL_START) / (FULL_END - FULL_START);
    return points[clamp(Math.round(ratio * (points.length - 1)), 0, points.length - 1)];
  }

  function drawCursor(context, pointer) {
    const timestamp = timeAtX(pointer.x);
    const point = nearestPoint(timestamp);
    const x = xAtTime(point.timestamp);
    context.save();
    context.strokeStyle = "rgba(72, 80, 89, 0.34)";
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(Math.round(x) + 0.5, plotRect.top);
    context.lineTo(Math.round(x) + 0.5, plotRect.bottom);
    context.stroke();
    context.setLineDash([]);

    if (state.series.has("tempMeasured") && point.tempMeasured !== null) {
      drawCursorPoint(context, x, yAtValue(point.tempMeasured, state.temperatureRange), "#1c69d4");
    }
    if (state.series.has("humidityMeasured") && point.humidityMeasured !== null) {
      drawCursorPoint(context, x, yAtValue(point.humidityMeasured, state.humidityRange), "#30343a");
    }
    context.restore();
  }

  function drawCursorPoint(context, x, y, color) {
    context.beginPath();
    context.arc(x, y, 3.2, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.lineWidth = 1.5;
    context.strokeStyle = color;
    context.stroke();
  }

  function positionTooltip() {
    if (!state.pointer || !state.cursorVisible || !isInsidePlot(state.pointer)) {
      hideTooltip();
      return;
    }
    const point = nearestPoint(timeAtX(state.pointer.x));
    elements.tooltipTime.textContent = formatTooltipTime(point.timestamp);
    elements.tooltipTemp.textContent = point.tempMeasured === null ? "—" : point.tempMeasured.toFixed(1);
    elements.tooltipHumidity.textContent = point.humidityMeasured === null ? "—" : point.humidityMeasured.toFixed(1);
    elements.tooltip.hidden = false;
    const tooltipRect = elements.tooltip.getBoundingClientRect();
    const frameRect = elements.chartFrame.getBoundingClientRect();
    let left = state.pointer.x + 16;
    if (left + tooltipRect.width > frameRect.width - 8) left = state.pointer.x - tooltipRect.width - 16;
    const top = clamp(state.pointer.y - tooltipRect.height / 2, 8, frameRect.height - tooltipRect.height - 8);
    elements.tooltip.style.left = `${left}px`;
    elements.tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    elements.tooltip.hidden = true;
  }

  function movePointer(event) {
    const point = canvasPoint(event);
    if (state.pan) {
      const delta = ((event.clientX - state.pan.clientX) / plotRect.width) * (state.pan.end - state.pan.start);
      const span = state.pan.end - state.pan.start;
      let start = state.pan.start - delta;
      start = clamp(start, FULL_START, FULL_END - span);
      state.viewStart = start;
      state.viewEnd = start + span;
      updateTimeInputs();
      state.pointer = null;
      hideTooltip();
      requestRender();
      return;
    }
    state.pointer = isInsidePlot(point) ? point : null;
    requestRender();
  }

  function leaveChart() {
    if (state.pan) return;
    state.pointer = null;
    hideTooltip();
    requestRender();
  }

  function startPan(event) {
    if (event.button !== 0) return;
    const point = canvasPoint(event);
    if (!isInsidePlot(point)) return;
    state.pan = {
      clientX: event.clientX,
      start: state.viewStart,
      end: state.viewEnd,
    };
    elements.chartFrame.classList.add("is-panning");
    elements.chartFrame.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function stopPan(event) {
    if (!state.pan) return;
    state.pan = null;
    elements.chartFrame.classList.remove("is-panning");
    elements.chartFrame.releasePointerCapture?.(event.pointerId);
    requestRender();
  }

  function zoomChart(event) {
    const point = canvasPoint(event);
    if (!isInsidePlot(point)) return;
    event.preventDefault();
    const fullSpan = FULL_END - FULL_START;
    const currentSpan = state.viewEnd - state.viewStart;
    const nextSpan = clamp(currentSpan * Math.exp(event.deltaY * 0.0011), fullSpan * 0.025, fullSpan);
    const anchor = timeAtX(point.x);
    const ratio = (anchor - state.viewStart) / currentSpan;
    let start = anchor - nextSpan * ratio;
    start = clamp(start, FULL_START, FULL_END - nextSpan);
    state.viewStart = start;
    state.viewEnd = start + nextSpan;
    updateTimeInputs();
    state.pointer = point;
    requestRender();
  }

  function keyboardChart(event) {
    const fullSpan = FULL_END - FULL_START;
    const span = state.viewEnd - state.viewStart;
    if (event.key === "Home") {
      resetView();
      event.preventDefault();
      return;
    }
    if (event.key === "+" || event.key === "=") {
      setCenteredSpan(Math.max(fullSpan * 0.025, span * 0.8));
      event.preventDefault();
      return;
    }
    if (event.key === "-") {
      setCenteredSpan(Math.min(fullSpan, span * 1.25));
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      let start = state.viewStart + span * 0.08 * direction;
      start = clamp(start, FULL_START, FULL_END - span);
      state.viewStart = start;
      state.viewEnd = start + span;
      updateTimeInputs();
      requestRender();
      event.preventDefault();
    }
  }

  function setCenteredSpan(nextSpan) {
    const center = (state.viewStart + state.viewEnd) / 2;
    let start = center - nextSpan / 2;
    start = clamp(start, FULL_START, FULL_END - nextSpan);
    state.viewStart = start;
    state.viewEnd = start + nextSpan;
    updateTimeInputs();
    requestRender();
  }

  elements.sidebarToggle.addEventListener("click", toggleSidebar);
  elements.windowMinimize.addEventListener("click", () => announcePrototypeWindowAction("最小化"));
  elements.windowMaximize.addEventListener("click", toggleFullscreenPreview);
  elements.windowClose.addEventListener("click", () => announcePrototypeWindowAction("关闭窗口"));
  elements.sidebarResizer.addEventListener("pointerdown", resizeSidebar);
  elements.sidebarResizer.addEventListener("dblclick", () => {
    setSidebarCollapsed(false);
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  });
  elements.sidebarResizer.addEventListener("keydown", keyboardResizeSidebar);
  elements.openFileButton.addEventListener("click", () => simulateRead("loaded"));
  elements.menuTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFileMenu();
  });
  elements.fileMenu.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    closeFileMenu();
    if (button.dataset.action === "close") {
      setView("empty");
      elements.liveRegion.textContent = "数据集已关闭，磁盘文件未受影响";
    } else {
      simulateRead("loaded");
    }
  });
  elements.fileEntry.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    elements.fileMenu.hidden = false;
    elements.menuTrigger.setAttribute("aria-expanded", "true");
    elements.menuTrigger.focus({ preventScroll: true });
  });
  elements.applyRange.addEventListener("click", applyRange);
  elements.startTime.addEventListener("input", () => { elements.rangeError.hidden = true; });
  elements.endTime.addEventListener("input", () => { elements.rangeError.hidden = true; });
  elements.resetView.addEventListener("click", resetView);
  elements.cursorToggle.addEventListener("change", toggleCursor);
  elements.settingsToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSettings();
  });
  elements.settingsClose.addEventListener("click", closeSettings);
  elements.settingsHeading.addEventListener("pointerdown", startSettingsDrag);
  document.addEventListener("pointermove", moveSettings);
  document.addEventListener("pointerup", stopSettingsDrag);
  elements.applySettings.addEventListener("click", applySettings);
  elements.resetSettings.addEventListener("click", resetSettings);

  document.querySelectorAll("[data-series]").forEach((button) => {
    button.addEventListener("click", () => toggleSeries(button));
  });
  document.querySelectorAll("[data-axis]").forEach((button) => {
    button.addEventListener("click", () => toggleAxis(button.dataset.axis));
  });
  document.querySelectorAll("[data-axis-tab]").forEach((button) => {
    button.addEventListener("click", () => selectSettingsAxis(button));
  });

  elements.chartFrame.addEventListener("pointermove", movePointer);
  elements.chartFrame.addEventListener("pointerleave", leaveChart);
  elements.chartFrame.addEventListener("pointerdown", startPan);
  elements.chartFrame.addEventListener("pointerup", stopPan);
  elements.chartFrame.addEventListener("pointercancel", stopPan);
  elements.chartFrame.addEventListener("wheel", zoomChart, { passive: false });
  elements.chartFrame.addEventListener("dblclick", resetView);
  elements.chartFrame.addEventListener("keydown", keyboardChart);

  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".file-entry-actions")) {
      closeFileMenu();
    }
    if (
      !elements.settingsPanel.hidden &&
      !event.target.closest("#settingsPanel") &&
      !event.target.closest("#settingsToggle")
    ) {
      closeSettings();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeFileMenu();
      closeSettings();
    }
  });

  const resizeObserver = new ResizeObserver(requestRender);
  resizeObserver.observe(elements.chartFrame);
  window.addEventListener("resize", syncSidebarToViewport);
  document.addEventListener("fullscreenchange", syncFullscreenControl);

  const query = new URLSearchParams(window.location.search);
  state.sidebarWidth = elements.sidebar.getBoundingClientRect().width;
  updateSidebarSeparator();
  syncFullscreenControl();
  if (query.get("state") === "empty") {
    setView("empty");
  } else {
    setView("loaded");
  }
  if (query.get("settings") === "open" && elements.app.dataset.view === "loaded") {
    toggleSettings();
  }
  if (query.get("menu") === "open" && elements.app.dataset.view === "loaded") {
    elements.fileMenu.hidden = false;
    elements.menuTrigger.setAttribute("aria-expanded", "true");
  }
  if (query.get("sidebar") === "collapsed") {
    setSidebarCollapsed(true);
  }
})();
