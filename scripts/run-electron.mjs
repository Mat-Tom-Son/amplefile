import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import electron from "electron";

// Chromium selects its Ozone platform before the app's main module runs.
// Give development launches the packaged app's rule on the real command line:
// X11 when an X display is reachable, otherwise Chromium's own choice (native
// Wayland on a Wayland-only session). desktop/src/linux-launch.ts owns the
// rule; this copy avoids compiling TypeScript before every launch.
const userArguments = process.argv.slice(2);
const explicitPlatform = userArguments.some(argument => argument === "--ozone-platform" || argument.startsWith("--ozone-platform="));
const display = process.env.DISPLAY?.trim();
const localDisplay = display && /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display);
const x11Available = Boolean(display) && (!localDisplay || existsSync(`/tmp/.X11-unix/X${localDisplay[1]}`));
const result = spawnSync(electron, [
  ...(process.platform === "linux" && x11Available && !explicitPlatform ? ["--ozone-platform=x11"] : []),
  ...userArguments,
], { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
