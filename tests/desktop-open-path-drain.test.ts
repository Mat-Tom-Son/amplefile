import assert from "node:assert/strict";
import test from "node:test";

import { FileManagerWindows } from "../desktop/src/file-manager-windows.js";
import { OpenPathDrain, type OpenPathDrainHost } from "../desktop/src/open-path-drain.js";

// Folders given to AmpleFile (desktop/src/open-path-drain.ts), with the real
// window registry and real time: a window owed a place waits for it as long
// as a folder is still being found, and a folder that takes too long is given
// up rather than handed late.

class FakeWindow {
  destroyed = false;
  constructor(readonly id: number) {}
  isDestroyed(): boolean { return this.destroyed; }
}

type Place = { path: string };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a promise has settled yet, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

/** A host whose one window comes back owed a place, as ensureWindow brings windows back while folders are found. */
function host(options: { lookUp: (path: string) => Promise<Place | null>; lookupLimitMs?: number; waitCheckMs?: number }) {
  const windows = new FileManagerWindows<FakeWindow, Place>();
  const window = new FakeWindow(1);
  const events: string[] = [];
  let drain: OpenPathDrain<FakeWindow, Place>;
  const definition: OpenPathDrainHost<FakeWindow, Place> = {
    windows,
    lookUp: (target) => options.lookUp(target.path),
    frontWindow: async () => {
      if (!windows.has(window)) { windows.add(window); drain.owe(window); }
      return window;
    },
    newWindow: async () => { throw new Error("one window here"); },
    show: () => {},
    hand: (target, location) => { events.push(`hand ${location.path}`); windows.handOpenLocation(target, { token: `t-${location.path}`, location }); },
    notFound: (path) => events.push(`not found ${path}`),
    overdue: (path) => events.push(`overdue ${path}`),
    lookupLimitMs: options.lookupLimitMs ?? 5_000,
    waitCheckMs: options.waitCheckMs ?? 10,
  };
  drain = new OpenPathDrain(definition);
  return { windows, window, events, drain, bringBack: () => definition.frontWindow() };
}

test("a window owed a place keeps waiting while its folder is still being found, past every wait check", async () => {
  const found = Promise.withResolvers<Place | null>();
  const { windows, window, events, drain, bringBack } = host({ lookUp: () => found.promise, waitCheckMs: 10 });
  drain.queue("/Users/ana/Garden");
  // The window comes back while the folder is queued, and its renderer asks for its place at once.
  await bringBack();
  const take = windows.takeOpenLocation(window);
  const running = drain.drain();
  await delay(80);
  assert.equal(await settled(take), false, "eight wait checks later the folder is still being found: the renderer still waits");
  found.resolve({ path: "Garden" });
  assert.deepEqual(await take, { token: "t-Garden", location: { path: "Garden" } });
  await running;
  assert.deepEqual(events, ["hand Garden"]);
});

test("a folder that takes longer than the limit is given up: nothing arrives late, the window shows its own place, and the person is told", async () => {
  const found = Promise.withResolvers<Place | null>();
  const { windows, window, events, drain, bringBack } = host({ lookUp: () => found.promise, lookupLimitMs: 40 });
  drain.queue("/Volumes/Stalled/Garden");
  await bringBack();
  const take = windows.takeOpenLocation(window);
  await drain.drain();
  assert.equal(await take, null, "given up: there is nothing to take");
  assert.deepEqual(events, ["overdue /Volumes/Stalled/Garden"]);
  // The lookup answers after all: the folder never arrives in a window that has moved on.
  found.resolve({ path: "Garden" });
  await delay(20);
  assert.deepEqual(events, ["overdue /Volumes/Stalled/Garden"]);
  assert.equal(windows.entry(window)?.pendingOpenLocation, null);
});

test("a window owed a place with nothing left to find stops waiting, and folders queued with nothing finding them start being found", async () => {
  const { windows, window, events, drain } = host({ lookUp: async (path) => ({ path: path.slice(path.lastIndexOf("/") + 1) }), waitCheckMs: 10 });
  windows.add(window);
  drain.owe(window);
  const idle = windows.takeOpenLocation(window);
  await delay(40);
  assert.equal(await idle, null, "nothing queued or being found: the window shows its own place");

  // A folder is queued but nobody has started finding it: the window's own check starts it.
  drain.queue("/Users/ana/Notes");
  drain.owe(window);
  const take = windows.takeOpenLocation(window);
  assert.deepEqual(await take, { token: "t-Notes", location: { path: "Notes" } });
  assert.deepEqual(events, ["hand Notes"]);
  await delay(20);
  assert.equal(drain.busy, false);
});

test("a path that leads nowhere opens nothing and frees the windows waiting on it", async () => {
  const { windows, window, events, drain, bringBack } = host({ lookUp: async () => null });
  drain.queue({ path: "/gone", reveal: false, newWindow: false });
  await bringBack();
  const take = windows.takeOpenLocation(window);
  await drain.drain();
  assert.equal(await take, null);
  assert.deepEqual(events, ["not found /gone"]);
});
