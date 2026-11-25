// Loaded into every test-file process by scripts/run-tests.mjs. When the
// process ends it removes each temporary folder the test file made with
// mkdtemp and left in the system's temporary folder. A test's own cleanup is
// not enough by itself: cleanup hooks run in the order they were added, so a
// folder removed before its service closes is written back by the close, and
// a test with no hook leaves its folder whole. On a computer whose temporary
// folder is held in memory, what stays there costs memory until restart.
//
// It acts only in a test file's own process and main thread, so a helper
// process or worker a test starts keeps what it made for the test to read.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { isMainThread } from "node:worker_threads";

const isTestFile = process.argv.slice(1).some((argument) => /\.test\.[cm]?[jt]s$/.test(argument));

if (isMainThread && isTestFile) {
  const temporaryRoots = [...new Set([resolve(tmpdir()), realPathOf(resolve(tmpdir()))])];
  const { lstatSync, rmSync } = fs;
  const made = new Set();
  const remember = (created) => {
    const path = pathOf(created);
    if (path && temporaryRoots.some((root) => path.startsWith(`${root}${sep}`))) made.add(path);
    return created;
  };

  const { mkdtempSync } = fs;
  fs.mkdtempSync = function mkdtempSyncRemembered(...args) {
    return remember(Reflect.apply(mkdtempSync, this, args));
  };
  const { mkdtemp } = fs;
  fs.mkdtemp = function mkdtempRemembered(...args) {
    const callback = args.at(-1);
    if (typeof callback !== "function") return Reflect.apply(mkdtemp, this, args);
    return Reflect.apply(mkdtemp, this, [...args.slice(0, -1), (error, created) => {
      if (!error) remember(created);
      callback(error, created);
    }]);
  };
  const promised = fs.promises.mkdtemp;
  fs.promises.mkdtemp = function mkdtempPromiseRemembered(...args) {
    return Reflect.apply(promised, this, args).then(remember);
  };
  syncBuiltinESMExports();

  process.on("exit", () => {
    for (const path of made) {
      try {
        // Only a folder still there, and never through a link put in its place.
        if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
      } catch {
        // Already gone, or not removable: a leftover never fails a test.
      }
    }
  });
}

function realPathOf(path) {
  try {
    return fs.realpathSync.native(path);
  } catch {
    return path;
  }
}

function pathOf(created) {
  if (typeof created === "string") return resolve(created);
  if (Buffer.isBuffer(created)) return resolve(created.toString());
  return null;
}
