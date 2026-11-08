import { spawnSync } from "node:child_process";
import electron from "electron";

// Ozone can initialize while Electron modules load, before the app's main
// module gets to append switches. Select the tested backend at process launch.
const result = spawnSync(electron, [
  ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
  ...process.argv.slice(2),
], { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
