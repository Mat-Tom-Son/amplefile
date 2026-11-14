import { posix, win32 } from "node:path";

/**
 * Pure pieces of "Open with": the app-picker dialog options and the launch
 * plan for the app the person chose. The main process owns validation of the
 * Connected Folder file, shows the chooser, and executes the plan without a
 * shell. On macOS and Windows the chooser is a file dialog for an app; on
 * Linux it is a menu of the desktop's own handlers for the file's type (see
 * open-with-linux.ts) with an Other… dialog.
 */

export interface OpenWithDialogOptions {
  title: string;
  properties: ["openFile"];
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/**
 * `exec` waits for the command to finish (`open -a`, `gio launch`); `spawn`
 * starts the app detached. Optional `env` and `cwd` are set on Linux.
 */
export type OpenWithLaunchPlan =
  | { kind: "exec"; command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }
  | { kind: "spawn"; command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string };

/** An app chosen from a list rather than by its path: its name and how to start it. */
export interface OpenWithPickedApp {
  appName: string;
  launchPlan: (filePath: string) => OpenWithLaunchPlan;
}

export async function openFileWithPickedApp(platform: NodeJS.Platform, dependencies: {
  resolveFile: () => Promise<string>;
  /** The chosen app's path, an app chosen from a list, or null when canceled. */
  pickApp: (filePath: string) => Promise<string | OpenWithPickedApp | null>;
  launch: (plan: OpenWithLaunchPlan) => Promise<void>;
}): Promise<{ opened: boolean; canceled: boolean; appName: string | null }> {
  // Fail before showing a picker for an unavailable file. Recheck after the
  // chooser: the Connected Folder or its files may have changed while it was open.
  const pickedFor = await dependencies.resolveFile();
  const choice = await dependencies.pickApp(pickedFor);
  if (!choice) return { opened: false, canceled: true, appName: null };
  const filePath = await dependencies.resolveFile();
  const appName = typeof choice === "string" ? openWithAppName(choice, platform) : choice.appName;
  let plan: OpenWithLaunchPlan;
  try {
    plan = typeof choice === "string" ? openWithLaunchPlan(platform, choice, filePath) : choice.launchPlan(filePath);
  } catch (error) {
    // Planning errors are written for people (a terminal app without a launcher, for example).
    throw new Error(`Couldn't open with ${appName}. ${error instanceof Error ? error.message : ""}`.trim());
  }
  try {
    await dependencies.launch(plan);
  } catch {
    throw new Error(`Couldn't open with ${appName}.`);
  }
  return { opened: true, canceled: false, appName };
}

export function openWithDialogOptions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): OpenWithDialogOptions {
  const base = { title: "Choose an App", properties: ["openFile"] as ["openFile"] };
  if (platform === "darwin") {
    return { ...base, defaultPath: "/Applications", filters: [{ name: "Applications", extensions: ["app"] }] };
  }
  if (platform === "win32") {
    return { ...base, defaultPath: env.ProgramFiles ?? "C:\\Program Files", filters: [{ name: "Applications", extensions: ["exe"] }] };
  }
  // Linux's Other…: installed desktop entries, or any program under All Files.
  return { ...base, defaultPath: "/usr/share/applications", filters: [{ name: "Applications", extensions: ["desktop"] }, { name: "All Files", extensions: ["*"] }] };
}

/** The chosen app's display name: its basename without the extension. */
export function openWithAppName(appPath: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? win32 : posix;
  const trimmed = appPath.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
  const name = path.basename(trimmed, path.extname(trimmed));
  return name || path.basename(trimmed) || appPath;
}

/**
 * macOS hands the file to the chosen bundle through `open -a`; elsewhere the
 * chosen executable receives the file path as its only argument. Both are
 * argument vectors, never a shell string.
 */
export function openWithLaunchPlan(platform: NodeJS.Platform, appPath: string, filePath: string): OpenWithLaunchPlan {
  if (!appPath || !filePath || appPath.includes("\0") || filePath.includes("\0")) {
    throw new Error("An app and a file are required.");
  }
  if (platform === "darwin") return { kind: "exec", command: "/usr/bin/open", args: ["-a", appPath, filePath] };
  return { kind: "spawn", command: appPath, args: [filePath] };
}
