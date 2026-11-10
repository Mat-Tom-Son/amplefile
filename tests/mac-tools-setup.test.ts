import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { createElement } from "react";

import { includedComputerStatus } from "../resources/included-tools/readiness.js";
import type { IncludedToolStatus } from "../src/shared/included-tools.js";
import { includedToolReadiness } from "../web-local/src/lib/included-tool-readiness.js";
import { createDomHarness } from "./support/dom.js";

const assets = registerHooks({
  load(url, context, next) {
    if (/\.(png|svg|css)$/.test(url)) return { format: "module", source: /\.css$/.test(url) ? "export {};" : `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { IncludedComputerSetup } = await import("../web-local/src/components/panes/IncludedComputerSetup.js");
const { FileManagerWelcome } = await import("../web-local/src/components/file-manager/FileManagerWelcome.js");
assets.deregister();

test("Computer Control can always be set up, and its status tells macOS's answer apart from capture", () => {
  assert.equal(includedToolReadiness({ id: "computer", state: "unknown", detail: "", checkedAt: "" }).setup, true);
  assert.equal(includedToolReadiness({ id: "documents", state: "unknown", detail: "", checkedAt: "" }).setup, false);
  const allowedNotCapturing = includedComputerStatus({ status: "setup_required", accessibility: true, screenRecording: false, screenRecordingPreflight: true });
  assert.equal(allowedNotCapturing.facts?.screenRecordingAllowed, true);
  assert.equal(allowedNotCapturing.facts?.screenRecording, false, "allowed is not yet capturable until the helper restarts");
  assert.equal(includedComputerStatus({ status: "unavailable", supportedOS: false, reason: "This included helper requires macOS 14 or later." }).facts?.supportedOS, false);
});

/** Fetch stub for the setup routes; `computer` answers each setup action. */
function stubSetup(t: TestContext, computer: (action: string) => IncludedToolStatus, tools: () => IncludedToolStatus[]) {
  const posts: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return Response.json({ status: computer(String(body.action)) });
    }
    assert.doesNotMatch(String(input), /connectedFolderId/, "first run reads the tools without a Connected Folder");
    if (String(input).startsWith("/api/standard-folders")) return Response.json({ folders: [] });
    return Response.json({ tools: tools() });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return posts;
}

test("Allow asks macOS, watches for the person's OK, and restarts the helper once Screen Recording is allowed", { timeout: 20_000 }, async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  let phase: "asked" | "allowed" | "ready" = "asked";
  const status = (): IncludedToolStatus => ({
    id: "computer", detail: "", checkedAt: "",
    state: phase === "ready" ? "ready" : "setup_required",
    facts: { accessibility: phase !== "asked", screenRecording: phase === "ready", screenRecordingAllowed: phase !== "asked" },
  });
  const posts = stubSetup(t, (action) => {
    if (action === "recheck") phase = "ready";
    return status();
  }, () => [{ id: "computer", state: "unknown", detail: "", checkedAt: "" }]);
  await dom.render(createElement(IncludedComputerSetup, { enabled: true }));
  const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  await dom.waitFor(() => Boolean(button("Allow Computer Control")));
  assert.match(document.body.textContent!, /turn on AmpleFile Computer/);

  await dom.act(() => button("Allow Computer Control")!.click());
  await dom.waitFor(() => /Watching for your OK/.test(document.body.textContent!));
  assert.deepEqual(posts[0], { id: "computer", action: "request-permissions" });
  assert.deepEqual([...document.querySelectorAll(".setup-checklist li")].map((item) => item.textContent), [
    "Accessibility lets it click and typeOpen Settings", "Screen Recording lets it see the screenOpen Settings",
  ]);

  phase = "allowed";
  await dom.waitFor(() => document.querySelector('[role="status"]')?.textContent === "Ready", 8_000);
  assert.deepEqual(posts.map((item) => item.action), ["request-permissions", "check", "recheck"], "allowed but not capturing restarts the helper once");
  assert.match(document.body.textContent!, /Your Worker can see the screen/);
});

test("a failed status read clears once the next read succeeds", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  let failing = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => failing
    ? Response.json({ error: "The local service restarted." }, { status: 503 })
    : Response.json({ tools: [{ id: "computer", state: "setup_required", detail: "", checkedAt: "" }] })) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  await dom.render(createElement(IncludedComputerSetup, { enabled: true }));
  await dom.waitFor(() => Boolean(document.querySelector(".included-tool-error")));
  failing = false;
  await dom.act(() => { window.dispatchEvent(new Event("focus")); });
  await dom.waitFor(() => !document.querySelector(".included-tool-error"));
});

test("first run offers Computer Control", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  stubSetup(t, () => ({ id: "computer", state: "setup_required", detail: "", checkedAt: "" }), () => [
    { id: "computer", state: "unknown", detail: "", checkedAt: "" },
  ]);
  await dom.render(createElement(FileManagerWelcome, { agentConfigured: true, fixtureMode: false, onAiConnected: () => {}, onPutToWork: async () => {}, onCreateConnectedFolder: () => {}, onOpenFolder: () => {} }));
  const button = (text: RegExp) => [...document.querySelectorAll("button")].find((item) => text.test(item.textContent ?? ""));
  const heading = () => document.querySelector(".fm-welcome-step h2")?.textContent;
  await dom.act(() => button(/^Get Started$/)!.click());
  await dom.waitFor(() => heading() === "Let Your Worker Use Your Mac");
  assert.equal(document.querySelector(".fm-welcome-dots")?.getAttribute("aria-label"), "Step 2 of 3");
  await dom.act(() => button(/^Computer Control/)!.click());
  await dom.waitFor(() => Boolean(button(/^Allow Computer Control$/)));
  await dom.act(() => button(/^Continue$/)!.click());
  assert.equal(heading(), "Pick a Folder to Start With");
});
