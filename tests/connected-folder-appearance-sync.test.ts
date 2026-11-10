import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import type { ConnectedFolderAppearanceState } from "../src/shared/connected-folder-appearance.js";

const state = (revision: number, iconName: string): ConnectedFolderAppearanceState => ({ version: 1, revision, customizations: { lab: { schema: 2, iconName } } }) as ConnectedFolderAppearanceState;

test("a look applied outside this window replaces its copy, and a later edit builds on it", async (t) => {
  const dom = await createDomHarness();
  const previousFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = previousFetch; });
  const { useConnectedFolderCustomizations } = await import("../web-local/src/hooks/useConnectedFolderCustomizations.js");
  const puts: unknown[] = [];
  let hostRevision = 3;
  let releasePut: (() => void) | null = null;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { customization: { iconName?: string; bannerName?: string } };
    puts.push(body.customization);
    if (puts.length === 2) await new Promise<void>((resolve) => { releasePut = resolve; });
    hostRevision++;
    return Response.json({ appearance: { version: 1, revision: hostRevision, customizations: { lab: body.customization } } });
  }) as typeof fetch;
  let hook!: ReturnType<typeof useConnectedFolderCustomizations>;
  function Probe({ appearance }: { appearance: ConnectedFolderAppearanceState }) {
    hook = useConnectedFolderCustomizations({ fixtureCustomizations: null, appearance, connectedFolderIds: "lab" });
    return createElement("output", null, hook.customizations.lab?.iconName ?? "");
  }
  await dom.render(createElement(Probe, { appearance: state(1, "folder") }));
  assert.equal(dom.container.textContent, "folder");
  // The Worker applies a look; the window's next bootstrap read carries it.
  await dom.render(createElement(Probe, { appearance: state(2, "briefcase") }));
  assert.equal(dom.container.textContent, "briefcase", "a newer host copy replaces a known Connected Folder's look");
  await dom.act(() => hook.customize("lab", { bannerName: "Launch" }));
  await dom.waitFor(() => puts.length === 1);
  assert.equal((puts[0] as { iconName?: string }).iconName, "briefcase", "an edit is saved on top of the host's look, not a stale copy");
  await dom.settle();

  // While this window's own write is queued, an older host snapshot that
  // predates it cannot undo the edit.
  await dom.act(() => hook.customize("lab", { iconName: "notebook" }));
  await dom.waitFor(() => puts.length === 2);
  await dom.render(createElement(Probe, { appearance: state(4, "briefcase") }));
  assert.equal(dom.container.textContent, "notebook");
  await dom.act(async () => { releasePut!(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await dom.settle();
  assert.equal(dom.container.textContent, "notebook", "the window's saved write wins over a snapshot read before it");
});

test("a save's answer carries a look saved elsewhere meanwhile, and the next edit builds on it", async (t) => {
  const dom = await createDomHarness();
  const previousFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = previousFetch; });
  const { useConnectedFolderCustomizations } = await import("../web-local/src/hooks/useConnectedFolderCustomizations.js");
  // The host: the Worker gave Connected Folder B a new look (revision 6)
  // without this window hearing of it.
  let host: ConnectedFolderAppearanceState = { version: 1, revision: 6, customizations: { a: { schema: 2, iconName: "folder" }, b: { schema: 2, iconName: "briefcase" } } } as ConnectedFolderAppearanceState;
  const puts: Array<{ id: string; customization: { iconName?: string; bannerName?: string } }> = [];
  globalThis.fetch = (async (input, init) => {
    const id = /connected-folders\/([^/]+)\/appearance/.exec(String(input))![1]!;
    const { customization } = JSON.parse(String(init?.body));
    puts.push({ id, customization });
    host = { ...host, revision: host.revision + 1, customizations: { ...host.customizations, [id]: customization } };
    return Response.json({ appearance: host });
  }) as typeof fetch;
  let hook!: ReturnType<typeof useConnectedFolderCustomizations>;
  const stale = { version: 1, revision: 5, customizations: { a: { schema: 2, iconName: "folder" }, b: { schema: 2, iconName: "notebook" } } } as ConnectedFolderAppearanceState;
  function Probe({ appearance }: { appearance: ConnectedFolderAppearanceState }) {
    hook = useConnectedFolderCustomizations({ fixtureCustomizations: null, appearance, connectedFolderIds: "a|b" });
    return createElement("output", null, hook.customizations.b?.iconName ?? "");
  }
  await dom.render(createElement(Probe, { appearance: stale }));
  assert.equal(dom.container.textContent, "notebook");
  await dom.act(() => hook.customize("a", { bannerName: "Launch" }));
  await dom.waitFor(() => dom.container.textContent === "briefcase");
  // A bootstrap read at the same revision changes nothing; editing B starts from the Worker's look.
  await dom.render(createElement(Probe, { appearance: host }));
  await dom.act(() => hook.customize("b", { bannerName: "Orbit" }));
  await dom.waitFor(() => puts.length === 2);
  assert.equal(puts[1]!.id, "b");
  assert.equal(puts[1]!.customization.iconName, "briefcase", "B's next save keeps the look saved elsewhere");
});
