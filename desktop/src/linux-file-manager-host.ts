import { homedir } from "node:os";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { productIdentity } from "../../src/shared/product-identity.js";
import { LinuxFileManagerIntegration, linuxFileManagerLaunchCommand } from "./linux-file-manager-integration.js";
import type { FileManagerRequest } from "./linux-file-manager-service.js";

/** A path the system asked AmpleFile to show; `reveal` shows a folder selected in its parent rather than opened. */
export interface FileManagerOpenPath {
  path: string;
  reveal: boolean;
}

/**
 * What a FileManager1 call opens. One window shows one folder, so the first
 * usable item is shown: ShowFolders opens it; ShowItems and
 * ShowItemProperties show it selected in its folder (a folder too).
 */
export function fileManagerOpenPath(request: FileManagerRequest): FileManagerOpenPath {
  return { path: request.paths[0]!, reveal: request.method !== "ShowFolders" };
}

export interface LinuxFileManagerHostOptions {
  ipcMain: IpcMain;
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  userDataPath: string;
  isPackaged: boolean;
  execPath: string;
  appPath: string;
  appImage?: string;
  /** Hands a path to the window's open-location path and brings the window forward. */
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
    onRequest: (request) => options.open(fileManagerOpenPath(request)),
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
