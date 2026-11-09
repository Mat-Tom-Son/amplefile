import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { ConnectedFolderSummary, TreeEntry } from "../web-local/src/types.js";

// The file manager window mounted for real (jsdom, a mocked local API), so
// these tests observe what a person would: requests made, focus, ARIA.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const file = (name: string): TreeEntry => ({ kind: "file", path: name, name, updatedAt: "2026-09-27T12:00:00Z", sizeBytes: 10 } as TreeEntry);

function answers(extra: ApiAnswer = () => undefined, tree: TreeEntry[] = [file("a.md"), file("b.md")]): ApiAnswer {
  return (path, options) => {
    const value = extra(path, options);
    if (value !== undefined) return value;
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true, provider: "test", model: "synthetic" } };
    if (path.startsWith("/api/agent/composer")) return { composer: { model: { provider: "test", id: "synthetic", name: "Synthetic" }, thinkingLevel: "off", thinkingLevels: ["off"] } };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path.includes("/tree")) return { tree };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations")) return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    return undefined;
  };
}

function view(module: Awaited<ReturnType<typeof createFileManagerHarness>>["module"], props: Record<string, unknown> = {}) {
  return createElement(module.FileManagerView, {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
    ...props,
  });
}

test("a model change made in Settings re-reads the Worker's model row", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers());
  const statusReads = () => requests.filter((item) => item.path.startsWith("/api/agent/status")).length;
  await dom.render(view(module, { modelConfigurationRevision: 0 }));
  await dom.waitFor(() => statusReads() === 1);
  await dom.render(view(module, { modelConfigurationRevision: 1 }));
  await dom.waitFor(() => statusReads() === 2);
});

test("folder suggestions are asked for only while Info shows them, once the folder has stayed shown", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path) => path.includes("/suggestions") ? { suggestions: ["Summarize the notes"] } : undefined));
  const suggestionReads = () => requests.filter((item) => item.path.includes("/suggestions")).length;
  await dom.render(view(module));
  const historyTab = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.includes("History"))!;
  await dom.act(() => historyTab.click());
  await dom.act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
  assert.equal(suggestionReads(), 0, "History hides the suggestions, so no model call is made");
  const infoTab = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Info")!;
  await dom.act(() => infoTab.click());
  assert.equal(suggestionReads(), 0, "the call waits for the folder to stay shown");
  await dom.waitFor(() => suggestionReads() === 1);
  await dom.waitFor(() => dom.container.textContent?.includes("Summarize the notes") === true);
});

test("moving to another folder abandons the previous folder's suggestion request", async (t) => {
  const asked: Array<{ path: string; signal: AbortSignal }> = [];
  const { dom } = await createFileManagerHarness(t, (path, options) => {
    asked.push({ path: new URL(path, "http://local").searchParams.get("path") ?? "", signal: options.signal! });
    return new Promise(() => {});
  });
  const { useFolderSuggestions } = await import("../web-local/src/components/file-manager/useFolderSuggestions.js");
  function Probe({ path }: { path: string }) { useFolderSuggestions("abandon", path, true); return null; }
  await dom.render(createElement(Probe, { path: "One" }));
  await dom.render(createElement(Probe, { path: "Two" }));
  await dom.render(createElement(Probe, { path: "Three" }));
  await dom.waitFor(() => asked.length >= 1, 2_000);
  await dom.act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.path, "Three", "folders passed through quickly are never asked for");
  await dom.render(createElement(Probe, { path: "Four" }));
  assert.equal(asked[0]!.signal.aborted, true);
});

test("Enter on a sort header sorts instead of renaming the selected item", async (t) => {
  const { dom, module } = await createFileManagerHarness(t, answers());
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(dom.container.querySelector('[data-fm-path="a.md"]')));
  await dom.act(() => dom.container.querySelector<HTMLElement>('[data-fm-path="a.md"]')!.click());
  const header = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="columnheader"]')].find((item) => item.textContent?.includes("Size"))!;
  await dom.act(() => header.focus());
  await dom.press("Enter");
  assert.equal(document.querySelector('[role="dialog"]'), null, "the selected file is not put into Rename");
  const grid = dom.container.querySelector<HTMLElement>('[role="grid"]')!;
  await dom.act(() => grid.focus());
  await dom.press("Enter");
  await dom.waitFor(() => Boolean(document.querySelector('[role="dialog"]')));
});

test("every list names its active row, and icon view keeps grid, row and cell roles in order", async (t) => {
  const { dom, module } = await createFileManagerHarness(t, answers((path) => path === "/api/recents"
    ? { recents: [{ place: { kind: "connected-folder", id: "lab" }, path: "Notes/a.md", name: "a.md", kind: "file", updatedAt: "2026-09-27T12:00:00Z", where: "Lab" }] }
    : undefined));
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(dom.container.querySelector('[data-fm-path="a.md"]')));
  const grid = () => dom.container.querySelector<HTMLElement>('[role="grid"]')!;
  await dom.act(() => dom.container.querySelector<HTMLElement>('[data-fm-path="b.md"]')!.click());
  assert.ok(document.getElementById(grid().getAttribute("aria-activedescendant")!)?.textContent?.includes("b.md"));

  await dom.act(() => dom.container.querySelector<HTMLButtonElement>('button[aria-label="Icons"]')!.click());
  const cells = [...grid().querySelectorAll('[role="gridcell"]')];
  assert.ok(cells.length >= 2);
  assert.ok(cells.every((cell) => cell.parentElement?.getAttribute("role") === "row"), "a gridcell sits in a row");

  const recents = [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((item) => item.textContent?.includes("Recents"))!;
  await dom.act(() => recents.click());
  await dom.waitFor(() => Boolean(grid().querySelector('.fm-rows [role="row"]')));
  await dom.act(() => grid().querySelector<HTMLElement>('.fm-rows [role="row"]')!.click());
  const active = grid().getAttribute("aria-activedescendant");
  assert.ok(active, "Recents names its active row");
  assert.equal(document.getElementById(active)?.getAttribute("aria-selected"), "true");
});

test("when a Worker reply ends, the window re-reads its bootstrap so a look the Worker applied shows", async (t) => {
  const stamp = "2026-09-27T12:00:00Z";
  const { dom, module, streams } = await createFileManagerHarness(t, answers((path) => {
    if (path.endsWith("/conversations")) return { conversations: [{ id: "chat", title: "Make it look nice", createdAt: stamp, updatedAt: stamp }] };
    if (path.endsWith("/conversations/chat")) return { messages: [] };
    if (path.endsWith("/runtime")) return { runtime: null };
    if (path.endsWith("/work")) return { work: null };
    if (path.includes("/agent/catalog")) return { commands: [] };
    if (path.includes("/paths-exist")) return { existing: [] };
    return undefined;
  }));
  let refreshes = 0;
  await dom.render(view(module, { onRefreshBootstrap: async () => { refreshes++; } }));
  const historyTab = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.includes("History"))!;
  await dom.act(() => historyTab.click());
  await dom.waitFor(() => Boolean([...dom.container.querySelectorAll<HTMLButtonElement>(".fm-crow-btn")].find((row) => row.textContent?.includes("Make it look nice"))));
  await dom.act(() => [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-crow-btn")].find((row) => row.textContent?.includes("Make it look nice"))!.click());
  const path = "/api/connected-folders/lab/conversations/chat/events";
  await dom.waitFor(() => Boolean(streams.get(path)?.onmessage));
  const before = refreshes;
  await dom.act(async () => { streams.get(path)!.onmessage!({ data: JSON.stringify({ conversationId: "chat", type: "done", turnId: "turn-1" }) }); await Promise.resolve(); });
  await dom.waitFor(() => refreshes === before + 1);
});

test("clicking a sort header leaves focus on the list, and the header stays reachable by keyboard", async (t) => {
  const { dom, module } = await createFileManagerHarness(t, answers());
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(dom.container.querySelector('[data-fm-path="a.md"]')));
  const header = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="columnheader"]')].find((item) => item.textContent?.includes("Size"))!;
  const search = dom.container.querySelector<HTMLInputElement>('input[type="search"], .fm-search input')!;
  assert.ok(search, "the toolbar search field");
  await dom.act(() => search.focus());
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  await dom.act(() => { header.dispatchEvent(press); });
  assert.equal(press.defaultPrevented, true, "a mouse press does not move focus to the header");
  assert.equal(document.activeElement, dom.container.querySelector('[role="grid"]'), "focus moves to the list, as in Finder");
  assert.notEqual(header.tabIndex, -1);
  assert.equal(header.disabled, false);
});
