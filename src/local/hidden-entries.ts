import { resolve } from "node:path";

/**
 * Entries the system file manager hides until the person asks to see hidden
 * files (Finder's ⇧⌘., GNOME Files' Ctrl+H): any name starting with a period,
 * Finder's `Icon\r` custom-icon file, and on macOS the home folder's Library.
 *
 * This is the set a Standard Folder listing leaves out by default. A listing
 * that asks for hidden entries keeps them and marks each one `hidden`, so the
 * window can dim it. `.amplefile/`, `.pi/`, and the other built-in entries in
 * `connected-folder-ignore.ts` are not "hidden" in this sense: no listing ever
 * shows them.
 *
 * GNOME Files also hides backup names ending in `~` and names listed in a
 * folder's `.hidden` file. A Standard Folder listing has always shown those,
 * so they are not hidden here either; treating them as hidden would change
 * what the default listing shows.
 */
export interface HiddenEntryContext {
  platform: NodeJS.Platform;
  /** True when the folder being listed is the person's home folder. */
  atHomeFolder: boolean;
}

export function isSystemHiddenEntry(name: string, context: HiddenEntryContext): boolean {
  if (name.startsWith(".") || name === "Icon\r") return true;
  return context.platform === "darwin" && context.atHomeFolder && name === "Library";
}

/**
 * macOS: what Finder hides at the disk's top by each item's hidden flag
 * (`ls -lO /`) rather than by its name. A listing cannot read that flag, so
 * the disk's top uses the set macOS gives every Mac.
 */
const macDiskTopHidden = new Set(["Volumes", "bin", "cores", "dev", "etc", "home", "opt", "private", "sbin", "tmp", "usr", "var"]);

export function isHiddenAtMacDiskTop(name: string, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && macDiskTopHidden.has(name);
}

/** Whether `directory` is the home folder, ignoring case where the disk does. */
export function isHomeFolder(directory: string, home: string, platform: NodeJS.Platform): boolean {
  const comparable = (value: string) => {
    const resolved = resolve(value).replace(/[\\/]+$/, "");
    return platform === "linux" ? resolved : resolved.toLocaleLowerCase();
  };
  return comparable(directory) === comparable(home);
}
