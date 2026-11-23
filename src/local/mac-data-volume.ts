import { statSync } from "node:fs";

/**
 * macOS: the data volume's own mount. Every folder on it has a second name
 * there (`/System/Volumes/Data/Users/ana` is `/Users/ana`) that is not a
 * symbolic link, so `realpath` leaves it as it is and a check that compares
 * paths would not see that a Connected Folder holds it: through it a Connected
 * Folder would open as a plain folder and its changes would skip History.
 * AmpleFile never goes in. A path by that name is used under its usual one
 * when that is the same folder or file, and anything else in it is refused:
 * the window's routes, Go to Folder, a folder added to the sidebar, a
 * registered Connected Folder's root, and the walks of folder search and
 * folder size, which skip it.
 */
export const macDataVolumeRoot = "/System/Volumes/Data";
export const macDataVolumeRefusal = "That folder is another name for this Mac’s own folders. Open it at its usual path, such as /Users.";

/** Whether an absolute path is the data volume's mount or inside it. The Mac's disk ignores case. */
export function isInsideMacDataVolume(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  const lower = path.toLowerCase().replace(/\/+$/, "");
  const root = macDataVolumeRoot.toLowerCase();
  return lower === root || lower.startsWith(`${root}/`);
}

/** Whether a path's segments from the disk's top go into the data volume ("System/Volumes/Data/…"). */
export function entersMacDataVolume(parts: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && parts.length >= 3 && ["system", "volumes", "data"].every((name, index) => parts[index]!.toLowerCase() === name);
}

/** A path by the data volume's name under its usual one when that is the same folder or file; anything else as it is. */
export function withoutMacDataVolumeName(path: string, platform: NodeJS.Platform = process.platform): string {
  if (!isInsideMacDataVolume(path, platform)) return path;
  const trimmed = path.replace(/\/+$/, "");
  const usual = trimmed.slice(macDataVolumeRoot.length) || "/";
  const aliased = statSync(trimmed, { throwIfNoEntry: false });
  const plain = statSync(usual, { throwIfNoEntry: false });
  return aliased && plain && aliased.dev === plain.dev && aliased.ino === plain.ino ? usual : path;
}

/** The usual name of a path, refusing one that has none (the data volume's own top, and what only it holds). */
export function usualMacPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const usual = withoutMacDataVolumeName(path, platform);
  if (isInsideMacDataVolume(usual, platform)) throw Object.assign(new Error(macDataVolumeRefusal), { status: 400, statusCode: 400 });
  return usual;
}
