import assert from "node:assert/strict";
import test from "node:test";

import { finderOpenPaths, maximumWindowsPerRequest } from "../desktop/src/finder-open-paths.js";

/** Finder's open-file events of one request (desktop/src/finder-open-paths.ts). */

const folders = new Set(["/Users/ana/Projects", "/Users/ana/Photos", "/Volumes/Camera"]);
const isFolder = (path: string) => folders.has(path);

test("the first item opens in the window in front and each further folder in a window of its own", () => {
  assert.deepEqual(finderOpenPaths(["/Users/ana/Projects", "/Users/ana/Photos", "/Volumes/Camera"], isFolder), [
    { path: "/Users/ana/Projects", reveal: false, newWindow: false },
    { path: "/Users/ana/Photos", reveal: false, newWindow: true },
    { path: "/Volumes/Camera", reveal: false, newWindow: true },
  ]);
  assert.deepEqual(finderOpenPaths(["/Users/ana/Projects"], isFolder), [{ path: "/Users/ana/Projects", reveal: false, newWindow: false }]);
  assert.deepEqual(finderOpenPaths([], isFolder), []);
});

test("files in one folder share its window, the first of them selected, and a path named twice opens once", () => {
  assert.deepEqual(finderOpenPaths([
    "/Users/ana/Projects/plan.md",
    "/Users/ana/Projects/notes.txt",
    "/Users/ana/Projects",
    "/Users/ana/Photos",
    "/Users/ana/Photos",
  ], isFolder), [
    { path: "/Users/ana/Projects/plan.md", reveal: false, newWindow: false },
    { path: "/Users/ana/Photos", reveal: false, newWindow: true },
  ]);
});

test("one request opens at most a few windows", () => {
  const many = Array.from({ length: 20 }, (_, index) => `/Users/ana/Folder ${index}`);
  const chosen = finderOpenPaths(many, () => true);
  assert.equal(chosen.length, maximumWindowsPerRequest);
  assert.deepEqual(chosen.map((item) => item.path), many.slice(0, maximumWindowsPerRequest));
});
