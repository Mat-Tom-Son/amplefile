import type { IpcMainInvokeEvent } from "electron";

import { outsideAgentSkill } from "../../src/shared/outside-agent-skill.js";
import {
  commandLineStatus,
  defaultCommandLineEnvironment,
  installCommandOnPath,
  installSkill,
  isCommandLineSkillTarget,
  removeCommandFromPath,
  removeSkill,
  type CommandLineEnvironment,
} from "./command-line-install.js";
import type { DesktopIpcMain } from "./desktop-ipc-main.js";

export interface CommandLineHostOptions {
  ipcMain: DesktopIpcMain;
  /** The sender check every handler starts with: the trusted main renderer. */
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  isPackaged: boolean;
  /** Where the command and the skill go; this computer's by default. Tests pass a folder of their own. */
  environment?: () => CommandLineEnvironment;
}

/**
 * Settings → Command Line: lets other AI agents use AmpleFile through the
 * command on Terminal's PATH and the skill in Claude Code's and Codex's skills
 * folders, each on a click (desktop/src/command-line-install.ts does the work).
 * Registers the group's IPC handlers; called once, when the interactive app
 * starts.
 */
export function registerCommandLineIpc(options: CommandLineHostOptions): void {
  const { ipcMain, assertTrusted } = options;
  const environment = options.environment ?? (() => defaultCommandLineEnvironment({ isPackaged: options.isPackaged }));
  ipcMain.handle("amplefile:command-line:status", (event) => {
    assertTrusted(event);
    return commandLineStatus(environment());
  });
  ipcMain.handle("amplefile:command-line:install-path", (event) => {
    assertTrusted(event);
    return installCommandOnPath(environment());
  });
  ipcMain.handle("amplefile:command-line:remove-path", (event) => {
    assertTrusted(event);
    return removeCommandFromPath(environment());
  });
  ipcMain.handle("amplefile:command-line:install-skill", (event, target) => {
    assertTrusted(event);
    if (!isCommandLineSkillTarget(target)) throw new Error("Choose Claude Code or Codex.");
    return installSkill(environment(), target);
  });
  ipcMain.handle("amplefile:command-line:remove-skill", (event, target) => {
    assertTrusted(event);
    if (!isCommandLineSkillTarget(target)) throw new Error("Choose Claude Code or Codex.");
    return removeSkill(environment(), target);
  });
  ipcMain.handle("amplefile:command-line:skill", (event) => {
    assertTrusted(event);
    return outsideAgentSkill();
  });
}
