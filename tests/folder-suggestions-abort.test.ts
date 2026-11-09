import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { startLocalApi } from "../src/local/server.js";

/**
 * The window drops its folder-suggestions request when the person moves on;
 * the model call behind the route stops with it, and the stopped call leaves
 * nothing cached.
 */
test("closing a suggestions request stops its model call and caches nothing", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-suggestions-abort-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  const original = PiConversationClient.prototype.infer;
  t.after(async () => { PiConversationClient.prototype.infer = original; await api.close(); await rm(sandbox, { recursive: true, force: true }); });
  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Suggestions" });
  await writeFile(join(connectedFolder.connectedFolderRoot, "plan.md"), "plan");

  const signals: AbortSignal[] = [];
  let calls = 0;
  PiConversationClient.prototype.infer = async function (request) {
    calls += 1;
    if (calls > 1) return { kind: "json", json: { suggestions: ["Summarize plan.md"] } } as never;
    const signal = request.signal!;
    signals.push(signal);
    // Stands in for a slow model: settles only when stopped.
    return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };

  const url = `${api.origin}/api/connected-folders/${connectedFolder.id}/suggestions?path=`;
  const client = new AbortController();
  const dropped = fetch(url, { signal: client.signal }).catch((error: unknown) => error);
  const deadline = Date.now() + 10_000;
  while (!signals.length) {
    if (Date.now() > deadline) throw new Error("The model call never started.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  client.abort();
  await dropped;
  while (!signals[0]!.aborted) {
    if (Date.now() > deadline) throw new Error("The model call was not stopped.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // The stopped call cached nothing, so the next request asks the model again.
  const next = await (await fetch(url)).json() as { suggestions: string[] };
  assert.deepEqual(next.suggestions, ["Summarize plan.md"]);
  assert.equal(calls, 2);
});
