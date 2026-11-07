import type { ModelContextDiagnosticsBridge } from "../../src/shared/model-context-diagnostics.js";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const diagnostics: ModelContextDiagnosticsBridge = {
  request: (input) => ipcRenderer.invoke("amplefile:diagnostics:request", input),
  close: () => ipcRenderer.invoke("amplefile:diagnostics:close"),
  clipboard: {
    write: (content) => ipcRenderer.invoke("amplefile:clipboard:write", content),
  },
};

contextBridge.exposeInMainWorld("ampleFileDiagnostics", diagnostics);
