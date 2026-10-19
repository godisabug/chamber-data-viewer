import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { initKeyboardFocusNav } from "./keyboardFocus";

initKeyboardFocusNav();

// Suppress the WebView2 built-in browser context menu (返回/刷新/另存为 etc.).
// The chart area has its own onContextMenu handler and opens a custom menu;
// preventDefault only blocks the host's default menu and does not stop that
// React handler from running.
window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

const isSettingsWindow =
  new URLSearchParams(window.location.search).get("window") ===
  "chart-settings";
if (isSettingsWindow) {
  document.documentElement.classList.add("is-settings-window");
  document.body.classList.add("is-settings-window");
}

async function bootstrap() {
  const root = ReactDOM.createRoot(
    document.getElementById("root") as HTMLElement,
  );
  if (isSettingsWindow) {
    const { SettingsWindowApp } = await import("./SettingsWindowApp");
    root.render(
      <React.StrictMode>
        <SettingsWindowApp />
      </React.StrictMode>,
    );
  } else {
    const { default: App } = await import("./App");
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
}

void bootstrap();
