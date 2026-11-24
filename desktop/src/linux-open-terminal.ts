import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { splitServiceExec } from "./linux-file-manager-integration.js";
import { findExecutable, linuxLaunchEnvironment, type LinuxLaunchPlan } from "./open-with-linux.js";

const terminals = ["ghostty", "foot", "kitty", "alacritty", "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "mate-terminal", "xterm"];

function workingDirectoryArgs(terminal: string, folder: string): string[] {
  switch (terminal) {
    case "konsole": return ["--workdir", folder];
    case "gnome-terminal":
    case "ghostty":
    case "foot":
    case "kgx":
    case "xfce4-terminal":
    case "mate-terminal": return [`--working-directory=${folder}`];
    case "kitty": return ["--directory", folder];
    case "alacritty": return ["--working-directory", folder];
    default: return [];
  }
}

function hasDefaultTerminal(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, ["--print-id"], { env, timeout: 3_000, maxBuffer: 16_384 }, (error, stdout) => {
      resolve(!error && Boolean(stdout.trim()));
    });
  });
}

function configuredTerminal(value: string | undefined): string[][] {
  const command = value?.trim();
  if (!command || /[\0\r\n]/.test(command)) return [];
  // Try the literal name first, including an executable path containing spaces.
  try { return [[command], splitServiceExec(command)]; } catch { return [[command]]; }
}

export async function linuxTerminalLaunchPlan(folder: string, inheritedEnv: NodeJS.ProcessEnv = process.env): Promise<LinuxLaunchPlan> {
  if (!isAbsolute(folder) || folder.includes("\0")) throw new Error("Choose a folder to open in a terminal.");
  const env = linuxLaunchEnvironment(inheritedEnv);
  const launcher = await findExecutable("xdg-terminal-exec", env);
  if (launcher && await hasDefaultTerminal(launcher, env)) {
    return { kind: "spawn", command: launcher, args: [`--dir=${folder}`], cwd: folder, env };
  }
  for (const [terminal, ...args] of [...configuredTerminal(env.TERMINAL), ...terminals.map((name) => [name])]) {
    if (!terminal) continue;
    const command = await findExecutable(terminal, env);
    if (command) return { kind: "spawn", command, args: [...workingDirectoryArgs(basename(command), folder), ...args], cwd: folder, env };
  }
  throw new Error("AmpleFile couldn’t find an installed terminal.");
}
