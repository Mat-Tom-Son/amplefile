import { isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Launch-argument rules for the Linux app, kept free of Electron so they can
// be tested directly. docs/linux-build.md describes the behavior.

const ozonePlatformSwitch = "--ozone-platform";
const cliRequestSwitch = "--amplefile-cli-request";
/** More paths than a file manager plausibly sends for one launch are ignored. */
const maximumOpenPaths = 16;

/** Arguments before Chromium's `--` terminator; everything after is positional. */
function switchesOf(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf("--");
  return end === -1 ? argv : argv.slice(0, end);
}

/** True when the person's own command line chose an Ozone platform. */
export function explicitOzonePlatform(argv: readonly string[]): boolean {
  return switchesOf(argv.slice(1)).some((argument) => argument === ozonePlatformSwitch || argument.startsWith(`${ozonePlatformSwitch}=`));
}

/**
 * Whether `DISPLAY` names an X server this session can reach. A local display
 * (`:0`, `unix:1.0`) must have its socket; another form (a remote host, an
 * XQuartz launchd path) cannot be checked cheaply and counts as available.
 */
export function x11DisplayAvailable(display: string | undefined, socketExists: (path: string) => boolean): boolean {
  const value = display?.trim();
  if (!value) return false;
  const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(value);
  return local ? socketExists(`/tmp/.X11-unix/X${local[1]}`) : true;
}

export interface LinuxDisplayLaunch {
  platform: NodeJS.Platform;
  /** `DISPLAY` from the launch environment. */
  display: string | undefined;
  /** The process's own argv: the executable first. */
  argv: readonly string[];
  /** The platform Chromium already selected: `app.commandLine.getSwitchValue("ozone-platform")`. */
  selectedOzonePlatform: string;
  socketExists: (path: string) => boolean;
}

/**
 * One rule for every Linux launch: X11 (XWayland on a Wayland desktop) when an
 * X display is available, otherwise the platform Chromium chose, which is
 * native Wayland on a Wayland-only session. Chromium selects its platform
 * before the main script runs, and switching it there breaks the GPU process,
 * so a launch that needs X11 starts again with the switch on its real command
 * line. Returns the arguments for that launch, or null to continue as is.
 * An explicit `--ozone-platform` from the person is always respected.
 */
export function linuxX11RelaunchArguments(launch: LinuxDisplayLaunch): string[] | null {
  if (launch.platform !== "linux") return null;
  if (explicitOzonePlatform(launch.argv)) return null;
  if (launch.selectedOzonePlatform === "x11") return null;
  if (!x11DisplayAvailable(launch.display, launch.socketExists)) return null;
  return [`${ozonePlatformSwitch}=x11`, ...launch.argv.slice(1)];
}

export interface OpenPathArgumentOptions {
  /** `process.defaultApp`: a development launch whose first positional argument is the app itself. */
  defaultApp: boolean;
  /** The launching process's directory, for relative paths; without it they are ignored. */
  workingDirectory?: string;
}

/**
 * The folder candidates a desktop launcher passed (`Exec=… %U` gives file://
 * URIs or paths). Switches, other URI schemes, a CLI request id and remote
 * file URIs are ignored; the caller still checks that each path is a folder.
 */
export function openPathArguments(argv: readonly string[], options: OpenPathArgumentOptions): string[] {
  const paths: string[] = [];
  let skipAppPath = options.defaultApp;
  let positionalOnly = false;
  for (let index = 1; index < argv.length && paths.length < maximumOpenPaths; index += 1) {
    const argument = argv[index] ?? "";
    if (!positionalOnly) {
      if (argument === "--") {
        positionalOnly = true;
        continue;
      }
      if (argument === cliRequestSwitch) {
        index += 1;
        continue;
      }
      if (argument.startsWith("-")) continue;
    }
    if (skipAppPath) {
      skipAppPath = false;
      continue;
    }
    const path = openPathFromArgument(argument, options.workingDirectory);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function openPathFromArgument(argument: string, workingDirectory: string | undefined): string | null {
  if (!argument || argument.includes("\0")) return null;
  if (/^file:/i.test(argument)) {
    try {
      // Rejects file URIs that name another host.
      return normalize(fileURLToPath(argument));
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(argument)) return null;
  if (isAbsolute(argument)) return normalize(argument);
  return workingDirectory && isAbsolute(workingDirectory) ? resolve(workingDirectory, argument) : null;
}
