import type { AmpleFileDesktopBridge } from "../../src/shared/desktop-ipc";

export {};

declare global {
  interface Window {
    /**
     * The desktop bridge the preloads expose, typed by the desktop IPC
     * contract (src/shared/desktop-ipc.ts). Absent in the browser preview and
     * the local web UI.
     */
    ampleFileDesktop?: AmpleFileDesktopBridge;
  }
}
