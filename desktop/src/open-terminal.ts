import { isAbsolute } from "node:path";
import type { OpenWithLaunchPlan } from "./open-with.js";

/** Terminal, the Mac's own terminal app, by bundle id so a renamed or localized copy is still found. */
export const macTerminalBundleId = "com.apple.Terminal";

/**
 * Open Terminal Here on a Mac: Terminal opens a new window in the folder, as
 * it does for a folder dropped on its Dock icon or Finder's New Terminal at
 * Folder. `open` hands the folder over as an argument, never through a shell.
 * The main process resolves the folder under its place's path policy first.
 */
export function macTerminalLaunchPlan(folder: string): OpenWithLaunchPlan {
  if (!isAbsolute(folder) || folder.includes("\0")) throw new Error("Choose a folder to open in a terminal.");
  return { kind: "exec", command: "/usr/bin/open", args: ["-b", macTerminalBundleId, folder] };
}
