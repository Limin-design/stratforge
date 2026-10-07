import React from "react";
import { createRoot } from "react-dom/client";
import "dockview/dist/styles/dockview.css";
import "./theme.css";
import { App } from "./App.js";
import { applyTheme } from "./theme.js";
import { initErrorTracking } from "./telemetry/errorTracker.js";

// Capture uncaught errors / promise rejections (scrubbed, on-device) from the start.
initErrorTracking();

// Apply any saved color-palette overrides before first paint.
applyTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
