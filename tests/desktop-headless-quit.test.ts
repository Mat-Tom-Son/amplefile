import assert from "node:assert/strict";
import test from "node:test";

import { HeadlessQuitSequence, type HeadlessQuitHost } from "../desktop/src/headless-quit.js";

function harness() {
  const state = { interactive: false, generation: 0, quits: 0, events: [] as string[] };
  const hooks: { onRemoveToken?: () => void; onCloseChrome?: () => void; onIdle?: (count: number) => void } = {};
  let idleCount = 0;
  const host: HeadlessQuitHost = {
    interactiveRequested: () => state.interactive,
    cliRequestGeneration: () => state.generation,
    waitForIdle: async () => {
      idleCount += 1;
      state.events.push("idle");
      await Promise.resolve();
      hooks.onIdle?.(idleCount);
    },
    removeActToken: async () => {
      state.events.push("remove-token");
      await Promise.resolve();
      hooks.onRemoveToken?.();
    },
    closeChromeConnection: async () => {
      state.events.push("close-chrome");
      await Promise.resolve();
      hooks.onCloseChrome?.();
    },
    quit: () => {
      state.quits += 1;
      state.events.push("quit");
    },
  };
  return { state, hooks, sequence: new HeadlessQuitSequence(host) };
}

test("an idle headless CLI host tears down and quits", async () => {
  const { state, sequence } = harness();
  assert.equal(await sequence.run(), "quit");
  assert.deepEqual(state.events, ["idle", "remove-token", "close-chrome", "quit"]);
});

test("an interactive launch arriving while the act token is removed is not killed", async () => {
  const { state, hooks, sequence } = harness();
  hooks.onRemoveToken = () => { state.interactive = true; };
  assert.equal(await sequence.run(), "interactive");
  assert.equal(state.quits, 0);
  // The Chrome connection is left for the interactive app to start.
  assert.ok(!state.events.includes("close-chrome"));
});

test("an interactive launch arriving while Chrome closes is not killed", async () => {
  const { state, hooks, sequence } = harness();
  hooks.onCloseChrome = () => { state.interactive = true; };
  assert.equal(await sequence.run(), "interactive");
  assert.equal(state.quits, 0);
});

test("a CLI request arriving during teardown is served before the host quits", async () => {
  const { state, hooks, sequence } = harness();
  let arrived = false;
  hooks.onRemoveToken = () => {
    if (arrived) return;
    arrived = true;
    state.generation += 1;
  };
  assert.equal(await sequence.run(), "quit");
  assert.deepEqual(state.events, ["idle", "remove-token", "idle", "remove-token", "close-chrome", "quit"]);
  assert.equal(state.quits, 1);
});

test("interactive startup waits for a teardown in flight, then the host stays up", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const state = { interactive: false, quits: 0 };
  let tokenRemovalStarted!: () => void;
  const removing = new Promise<void>((resolve) => { tokenRemovalStarted = resolve; });
  const sequence = new HeadlessQuitSequence({
    interactiveRequested: () => state.interactive,
    cliRequestGeneration: () => 0,
    waitForIdle: async () => undefined,
    removeActToken: async () => { tokenRemovalStarted(); await gate; },
    closeChromeConnection: async () => undefined,
    quit: () => { state.quits += 1; },
  });
  const run = sequence.run();
  await removing;
  // A person opens AmpleFile mid-teardown; startup waits for teardown to finish.
  state.interactive = true;
  let startupMayProceed = false;
  const startup = sequence.whenTeardownSettled().then(() => { startupMayProceed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startupMayProceed, false);

  release();
  await startup;
  assert.equal(await run, "interactive");
  assert.equal(state.quits, 0);
});

test("a headless host never closes a Chrome connection it did not start", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  // Closing is permanent for the process, so an interactive launch during teardown would find it dead.
  assert.match(main, /closeChromeConnection: async \(\) => \{\n\s*if \(!chromeConnectionStartRequested\) return;\n\s*await \(await ensureDesktopHost\(\)\)\.chromeConnection\.close\(\);/);
  assert.match(main, /chromeConnectionStartRequested = true;\n\s*await host\.chromeConnection\.startIfEnabled\(\)/);
  assert.equal((main.match(/chromeConnectionStartRequested = true;/g) ?? []).length, 1);
});
