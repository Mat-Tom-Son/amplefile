import { lstat, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ampleFileDesktopStateOverride } from "./user-data-path.js";

/** The Native Messaging host name and Store extension origin AmpleFile 0.1.6 and earlier registered. */
export const leftoverChromeHostName = "com.amplefile.chrome";
export const leftoverChromeExtensionOrigin = "chrome-extension://ophmjbphcjmjcpcdpmfehbldiomkepgk/";

export interface LeftoverChromeRegistrationOptions {
  /** AmpleFile's own included-tools state root, `<userData>/assistant-tools`. */
  stateRoot: string;
  /** Google Chrome's user data root; tests inject one. Only AmpleFile's own host manifest in it is read. */
  chromeUserDataRoot?: string;
}

export interface LeftoverChromeCleanupLaunch {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** The ad hoc `AmpleFile Local Smoke` build, which never registered. */
  localSmokeBuild: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Only where an earlier AmpleFile could have registered: the installed Mac or Linux app
 * with its normal profile. Development, Local Smoke and an
 * `AMPLEFILE_DESKTOP_STATE_DIR` profile never touch Chrome's directory; the
 * override counts exactly when it chooses the profile's folder.
 */
export function leftoverChromeCleanupApplies(launch: LeftoverChromeCleanupLaunch): boolean {
  return ["darwin", "linux"].includes(launch.platform) && launch.isPackaged && !launch.localSmokeBuild && !ampleFileDesktopStateOverride(launch.environment)?.trim();
}

export interface LeftoverChromeRegistrationResult {
  /**
   * Removed only when its contents prove it is this installation's. `unreadable`
   * means Chrome's side could not be read; it is left as it is, and AmpleFile's
   * own leftovers are still removed, so a launch never retries a state that will
   * not change by itself.
   */
  registration: "removed" | "kept" | "absent" | "unreadable" | "not-checked";
  helper: "removed" | "absent";
}

/**
 * An earlier AmpleFile could leave a Native Messaging registration in Google
 * Chrome and a copied helper in AmpleFile's own data. This removes them once:
 * AmpleFile's own leftover folders are the trigger, so after they are gone
 * Chrome's directory is never looked at again. The registration is removed
 * only when it names AmpleFile's host and Store origin and points at a helper
 * inside this installation's own data; another product's file, another
 * installation's registration, and every Chrome profile are left alone.
 */
export async function removeLeftoverChromeRegistration(options: LeftoverChromeRegistrationOptions): Promise<LeftoverChromeRegistrationResult> {
  const stateRoot = resolve(options.stateRoot);
  const leftovers = [join(stateRoot, "chrome"), join(stateRoot, "chrome-companion")];
  const present = await Promise.all(leftovers.map((path) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })));
  if (!present.some(Boolean)) return { registration: "not-checked", helper: "absent" };

  const chromeRoot = options.chromeUserDataRoot ?? (process.platform === "linux"
    ? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "google-chrome")
    : join(homedir(), "Library/Application Support/Google/Chrome"));
  const manifestPath = join(chromeRoot, "NativeMessagingHosts", `${leftoverChromeHostName}.json`);
  const registration = await inspectRegistration(manifestPath, join(stateRoot, "chrome", "native-host"));
  if (registration === "removed") await rm(manifestPath, { force: true });
  for (const path of leftovers) await rm(path, { recursive: true, force: true });
  return { registration, helper: "removed" };
}

async function inspectRegistration(manifestPath: string, helperDirectory: string): Promise<LeftoverChromeRegistrationResult["registration"]> {
  let manifest: unknown;
  try {
    const info = await lstat(manifestPath);
    // A link, a folder or an oversized file is not the plain JSON AmpleFile wrote.
    if (!info.isFile() || info.size > 4096) return "kept";
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing file, or a path through something that is not a folder, holds no registration.
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    return "unreadable";
  }
  return isOwnRegistration(manifest, helperDirectory) ? "removed" : "kept";
}

function isOwnRegistration(manifest: unknown, helperDirectory: string): boolean {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const { name, type, path, allowed_origins: origins } = manifest as Record<string, unknown>;
  return name === leftoverChromeHostName
    && type === "stdio"
    && Array.isArray(origins) && origins.length === 1 && origins[0] === leftoverChromeExtensionOrigin
    && typeof path === "string" && resolve(path) === path
    && dirname(path) === helperDirectory
    && /^amplefile-chrome-host-[a-f0-9]{24}$/.test(basename(path));
}
