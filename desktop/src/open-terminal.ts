import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { OpenWithLaunchPlan } from "./open-with.js";

/** Terminal, the Mac's own terminal app, by bundle id so a renamed or localized copy is still found. */
export const macTerminalBundleId = "com.apple.Terminal";

/**
 * Open Terminal Here on a Mac: Terminal opens a new window in the folder, as
 * it does for a folder dropped on its Dock icon or Finder's New Terminal at
 * Folder. `open` hands the folder over as an argument, never through a shell.
 *
 * Terminal opens a folder, a package included, as a place to start a shell,
 * but runs an executable file or a `.command` script it is handed. The path
 * therefore ends in `/`, which only a folder satisfies: had the folder been
 * swapped for such a file after it was checked, `open` finds nothing to hand
 * over and Terminal runs nothing.
 */
export function macTerminalLaunchPlan(folder: string): OpenWithLaunchPlan {
  if (!isAbsolute(folder) || folder.includes("\0")) throw new Error("Choose a folder to open in a terminal.");
  return { kind: "exec", command: "/usr/bin/open", args: ["-b", macTerminalBundleId, folder.endsWith("/") ? folder : `${folder}/`] };
}

/**
 * The host side of Open Terminal Here. `resolveFolder` resolves the folder
 * under its place's path policy (a Connected Folder or the computer, no `..`,
 * no reserved metadata, no link along the way) and is asked twice: the folder
 * must be a folder itself, not a link to one, and must still be that same
 * folder, by device and inode, after choosing the terminal and before launch.
 */
export async function openFolderInTerminal(options: {
  resolveFolder: () => Promise<string | null>;
  launch: (plan: OpenWithLaunchPlan) => Promise<void>;
  launchPlan?: (folder: string) => OpenWithLaunchPlan | Promise<OpenWithLaunchPlan>;
  launchFailureMessage?: string;
}): Promise<void> {
  const folder = await options.resolveFolder();
  const original = folder ? await lstat(folder).catch(() => null) : null;
  if (!folder || !original?.isDirectory()) throw new Error("Choose a folder to open in a terminal.");
  const plan = await (options.launchPlan ?? macTerminalLaunchPlan)(folder);
  const current = await options.resolveFolder() === folder ? await lstat(folder).catch(() => null) : null;
  if (!current?.isDirectory() || current.dev !== original.dev || current.ino !== original.ino) {
    throw new Error("That folder changed. Try opening it in a terminal again.");
  }
  try {
    await options.launch(plan);
  } catch (error) {
    // The window gets the plain sentence; the host's log keeps the launch error.
    console.warn(`Open Terminal Here failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(options.launchFailureMessage ?? "AmpleFile couldn’t open Terminal.");
  }
}
