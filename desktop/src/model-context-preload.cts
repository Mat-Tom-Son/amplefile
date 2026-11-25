import type { DesktopIpcRenderer } from "../../src/shared/desktop-ipc.js";
import type { ModelContextDiagnosticsBridge } from "../../src/shared/model-context-diagnostics.js";

const electron = require("electron") as typeof import("electron");
const { contextBridge } = electron;
// Electron's ipcRenderer, typed by the desktop IPC contract (src/shared/desktop-ipc.ts).
const ipcRenderer: DesktopIpcRenderer = electron.ipcRenderer;

const diagnostics: ModelContextDiagnosticsBridge = {
  request: (input) => ipcRenderer.invoke("amplefile:diagnostics:request", input),
  close: () => ipcRenderer.invoke("amplefile:diagnostics:close"),
  clipboard: {
    write: (content) => ipcRenderer.invoke("amplefile:clipboard:write", content),
  },
};

contextBridge.exposeInMainWorld("ampleFileDiagnostics", diagnostics);
