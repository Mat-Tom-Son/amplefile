// The package repository proof's stand-in for a running AmpleFile (README.md
// beside this file): the app's own Linux update code, run with Node's type
// stripping against the installed files.
//
//   node watch.mjs system-package-updates.ts once
//       prints what Settings → About would say for this install
//   node watch.mjs system-package-updates.ts watch STATUS_FILE SECONDS
//       starts the update source and appends each status it emits
import { appendFileSync } from "node:fs";

const [modulePath, mode, statusFile, seconds] = process.argv.slice(2);
const updates = await import(modulePath);
const installation = updates.systemPackageInstallation({
  platform: process.platform,
  isPackaged: true,
  execPath: "/opt/AmpleFile/amplefile-desktop",
  resourcesPath: "/opt/AmpleFile/resources",
  appImage: undefined,
  productName: "AmpleFile",
  repositoryId: "amplefile",
  readText: updates.readTextFile,
});
const installedVersion = updates.installedAsarVersion("/opt/AmpleFile/resources/app.asar");
if (!installation) {
  console.log(JSON.stringify({ installation: null, installedVersion }));
  process.exit(0);
}
const source = new updates.SystemPackageUpdates({
  installation,
  pollIntervalMs: mode === "watch" ? 500 : 60_000,
  automaticChecks: mode === "watch",
  prepareToRestart: async () => {},
  relaunch: () => {},
  host: {
    currentVersion: () => installedVersion ?? "unknown",
    identify: updates.identifyInstalledFile,
    installedVersion: updates.installedAsarVersion,
    emitStatus: (status) => { if (mode === "watch") appendFileSync(statusFile, `${JSON.stringify(status)}\n`); },
  },
});
source.start();
if (mode === "once") {
  console.log(JSON.stringify({ installation, installedVersion, about: source.getStatus().message, supported: source.supported }));
  source.dispose();
} else {
  setTimeout(() => { source.dispose(); process.exit(0); }, Number(seconds) * 1000);
}
