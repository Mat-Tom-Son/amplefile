import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { productIdentity } from "../../src/shared/product-identity.js";
import { LinuxFileManagerIntegration, linuxFileManagerLaunchCommand } from "./linux-file-manager-integration.js";
import type { FileManagerRequest } from "./linux-file-manager-service.js";

/**
 * A path the system asked AmpleFile to show; `reveal` shows a folder selected in its parent rather than opened,
 * and `newWindow` opens it in a window of its own instead of the most recently focused one.
 */
export interface FileManagerOpenPath {
  path: string;
  reveal: boolean;
  newWindow: boolean;
}

/** At most this many windows open for one request. */
export const maximumWindowsPerRequest = 8;

/**
 * What a FileManager1 call opens, as a system file manager does: one folder
 * or one folder's items in the most recently focused window, and each further
 * folder in a window of its own. ShowFolders opens each folder; ShowItems and
 * ShowItemProperties show each item selected in its folder (a folder too),
 * one window per folder, with the first item there selected.
 */
export function fileManagerOpenPaths(request: FileManagerRequest): FileManagerOpenPath[] {
  const reveal = request.method !== "ShowFolders";
  const chosen: string[] = [];
  const folders = new Set<string>();
  for (const path of request.paths) {
    // Items in one folder share its window; the first of them is the one selected.
    const key = reveal ? dirname(path) : path;
    if (folders.has(key)) continue;
    folders.add(key);
    chosen.push(path);
    if (chosen.length >= maximumWindowsPerRequest) break;
  }
  return chosen.map((path, index) => ({ path, reveal, newWindow: index > 0 }));
}

/** A launcher's or a second launch's folders: the first in the most recently focused window, each further one in a new window. */
export function launcherOpenPaths(paths: readonly string[]): FileManagerOpenPath[] {
  return paths.slice(0, maximumWindowsPerRequest).map((path, index) => ({ path, reveal: false, newWindow: index > 0 }));
}

export interface LinuxFileManagerHostOptions {
  ipcMain: IpcMain;
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  userDataPath: string;
  isPackaged: boolean;
  execPath: string;
  appPath: string;
  appImage?: string;
  /** Hands a path to the open-location path (the most recent window or a new one) and brings that window forward. */
  open: (target: FileManagerOpenPath) => void;
  log: (message: string) => void;
}

/**
 * Settings → File Manager on Linux: registers its IPC and, when the person
 * chose this copy of AmpleFile, answers as the file manager. Called once,
 * when the interactive app starts.
 */
export function startLinuxFileManager(options: LinuxFileManagerHostOptions): LinuxFileManagerIntegration {
  const integration = new LinuxFileManagerIntegration({
    environment: {
      env: process.env,
      home: homedir(),
      launchCommand: linuxFileManagerLaunchCommand(options),
      desktopId: `${productIdentity.packageName}.desktop`,
      statePath: join(options.userDataPath, "file-manager-integration.json"),
    },
    onRequest: (request) => { for (const target of fileManagerOpenPaths(request)) options.open(target); },
    log: options.log,
  });
  const { ipcMain, assertTrusted } = options;
  ipcMain.handle("amplefile:file-manager-integration:status", (event) => {
    assertTrusted(event);
    return integration.status();
  });
  ipcMain.handle("amplefile:file-manager-integration:set-show-files-from-other-apps", (event, enabled: unknown) => {
    assertTrusted(event);
    if (typeof enabled !== "boolean") throw new Error("Choose on or off.");
    return integration.setShowFilesFromOtherApps(enabled);
  });
  ipcMain.handle("amplefile:file-manager-integration:set-open-folders-by-default", (event, enabled: unknown) => {
    assertTrusted(event);
    if (typeof enabled !== "boolean") throw new Error("Choose on or off.");
    return integration.setOpenFoldersByDefault(enabled);
  });
  void integration.startIfChosen().catch((error) => options.log(`could not start answering as the file manager: ${error instanceof Error ? error.message : String(error)}`));
  return integration;
}
