import assert from "node:assert/strict";
import test from "node:test";
import { fitWindowToWorkArea } from "../desktop/src/window-bounds.js";

const minimum = { width: 1100, height: 760 };
test("an oversized saved window fits a scaled laptop display", () => {
  assert.deepEqual(fitWindowToWorkArea({ x: 0, y: 0, width: 1760, height: 1216, isMaximized: false }, { x: 0, y: 28, width: 1536, height: 900 }, minimum), { x: 0, y: 28, width: 1536, height: 900, isMaximized: false });
});
test("the minimum size yields to a smaller display", () => {
  assert.deepEqual(fitWindowToWorkArea({ x: 90, y: 90, width: 1440, height: 960 }, { x: 0, y: 24, width: 1024, height: 700 }, minimum), { x: 0, y: 24, width: 1024, height: 700 });
});
test("a partially offscreen window stays on its own monitor", () => {
  assert.deepEqual(fitWindowToWorkArea({ x: -2000, y: -30, width: 1200, height: 800 }, { x: -1536, y: 0, width: 1536, height: 960 }, minimum), { x: -1536, y: 0, width: 1200, height: 800 });
});
test("an already visible placement is preserved", () => {
  const state = { x: 40, y: 70, width: 1200, height: 800 };
  assert.deepEqual(fitWindowToWorkArea(state, { x: 0, y: 28, width: 1536, height: 900 }, minimum), state);
});
