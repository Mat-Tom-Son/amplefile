import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment, useLayoutEffect } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { ConnectedFolderSummary, TreeEntry } from "../web-local/src/types.js";

// A window opened at a folder (File → New Window, Open in New Window) or
// handed one as it starts (a folder given to AmpleFile) shows that folder
// from its first frame (docs/product-model.md, "Windows"). It never draws
// another Connected Folder first, whose Worker a message sent in that moment
// would reach.
//
// Assertions here compare plain values, never a DOM element (see
// file-manager-tabs-window.test.ts).
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const garden = { id: "garden", name: "Garden", connectedFolderRoot: "/tmp/garden", location: { storage: "managed" } } as ConnectedFolderSummary;
const file = (path: string): TreeEntry => ({ kind: "file", path, name: path.slice(path.lastIndexOf("/") + 1), updatedAt: "2026-09-27T12:00:00Z", sizeBytes: 10 } as TreeEntry);
const folder = (path: string): TreeEntry => ({ kind: "folder", path, name: path.slice(path.lastIndexOf("/") + 1), updatedAt: "2026-09-27T12:00:00Z" } as TreeEntry);
const trees: Record<string, TreeEntry[]> = { "": [folder("Notes"), file("a.md")], "Notes": [file("Notes/n.md")] };
const gardenPlace = { kind: "connected-folder" as const, id: "garden" };

function answers(extra: ApiAnswer = () => undefined): ApiAnswer {
  return (path, options) => {
    const value = extra(path, options);
    if (value !== undefined) return value;
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true, provider: "test", model: "synthetic" } };
    if (path.startsWith("/api/agent/composer")) return { composer: null };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path.includes("/tree")) return { tree: trees[new URL(path, "http://local").searchParams.get("path") ?? ""] ?? [] };
    if (path.endsWith("/automations")) return { automations: [] };
    if (/\/connected-folders\/\w+\/conversations$/.test(path) && options.method === "POST") return { conversation: { id: "c1", title: "New Chat", updatedAt: "2026-09-27T12:00:00Z", createdAt: "2026-09-27T12:00:00Z" } };
    if (path.includes("/conversations/c1")) return new Promise(() => undefined);
    if (path.endsWith("/conversations")) return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    if (path.includes("/file-info")) return { modifiedAt: "2026-09-27T12:00:00Z" };
    if (path.endsWith("/context-attachments")) return { attachment: { sourcePath: "Notes/n.md", sourceFileName: "n.md", mode: "path_only_reference", includedInPrompt: false, reason: null, warnings: [] } };
    return undefined;
  };
}

/** What the window keeps on this computer, as a plain map, read through `window.localStorage` and the bare global alike. */
function keepStorage(t: test.TestContext, kept = new Map<string, string>()) {
  const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } };
  for (const target of [window, globalThis] as object[]) {
    const previous = Object.getOwnPropertyDescriptor(target, "localStorage");
    Object.defineProperty(target, "localStorage", { configurable: true, value: storage });
    t.after(() => { if (previous) Object.defineProperty(target, "localStorage", previous); else Reflect.deleteProperty(target, "localStorage"); });
  }
  return kept;
}

/** What the window names wherever it says which folder it shows: the toolbar, the panel's Info, and the message box. */
function shown(container: HTMLElement) {
  return {
    title: container.querySelector(".fm-title-text")?.textContent ?? null,
    info: container.querySelector(".fm-panel .fm-pv-name")?.textContent ?? null,
    placeholder: container.querySelector<HTMLInputElement>('input[aria-label="Message the Worker"]')?.placeholder ?? null,
  };
}

/** Every name the toolbar, the panel, and the message box ever showed, including values replaced within one commit. */
function watchShownNames(container: HTMLElement) {
  const seen = new Set<string>();
  const note = () => { for (const value of Object.values(shown(container))) if (value) seen.add(value); };
  const observer = new window.MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as Node;
      const element = target.nodeType === 3 ? target.parentElement : target as Element;
      if (record.oldValue && element?.closest(".fm-title-text, .fm-pv-name, .fm-comp")) seen.add(record.oldValue);
    }
    note();
  });
  observer.observe(container, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true, attributeFilter: ["placeholder"] });
  return { seen, stop: () => observer.disconnect() };
}

async function send(dom: Awaited<ReturnType<typeof createFileManagerHarness>>["dom"], text: string) {
  await dom.act(() => {
    const field = dom.container.querySelector<HTMLInputElement>('[aria-label="Message the Worker"]')!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>("button.fm-send")!.click());
}

type HandedLocation = { place: typeof gardenPlace; path: string; select: string | null };
const bootstrapAnswer: ApiAnswer = (path) => path === "/api/bootstrap"
  ? { connectedFolders: [lab, garden], agent: { ready: true, configured: true, provider: "test", model: "synthetic" } }
  : undefined;

/** The desktop bridge App reads as a window starts; `onOpenLocation` stands in for the host's answer to the window's take. */
function stubWindowBridge(t: test.TestContext, onOpenLocation: (callback: (location: HandedLocation) => void, onTaken?: () => void) => () => void) {
  const activeSent: Array<string | null> = [];
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = {
    api: { baseUrl: "http://127.0.0.1:1", getSessionHeaders: async () => ({}) },
    app: { platform: "darwin" },
    window: { setTheme() {}, getAccentColor: async () => "#3478f6", onAccentColorChanged: () => () => {} },
    windows: { slot: 2, fresh: true, setLocation() {} },
    menu: { setState() {}, onCommand: () => () => {} },
    runtime: {},
    agent: { onOpenSettings: () => () => {} },
    updates: { getStatus: async () => null, onStatusChanged: () => () => {} },
    connectedFolder: {
      setActiveConnectedFolder: async (id: string | null) => { activeSent.push(id); },
      onOpenLocation,
    },
  };
  t.after(() => { delete scope.ampleFileDesktop; });
  return activeSent;
}

const conversationPosts = (requests: Array<{ path: string; method: string }>) => requests.filter((request) => request.method === "POST" && request.path.endsWith("/conversations")).map((request) => request.path);

test("a new window handed a Connected Folder after its first read waits for it, draws only it, and sends to its Worker", async (t) => {
  const harness = await createFileManagerHarness(t, answers(bootstrapAnswer));
  // A fresh window: nothing kept for it, so it would otherwise fall back to the first Connected Folder, Lab.
  keepStorage(t);
  const take = Promise.withResolvers<void>();
  let handed: ((location: HandedLocation) => void) | null = null;
  // The host's answer to the window's take arrives only after the window has read its Connected Folders.
  const activeSent = stubWindowBridge(t, (callback, onTaken) => {
    handed = callback;
    void take.promise.then(() => {
      callback({ place: gardenPlace, path: "", select: null });
      onTaken?.();
    });
    return () => {};
  });
  const { App } = await import("../web-local/src/App.js");
  const watch = watchShownNames(harness.dom.container);
  await harness.dom.render(createElement(App));
  await harness.dom.waitFor(() => harness.requests.some((request) => request.path === "/api/bootstrap"));
  await harness.dom.settle();
  assert.ok(handed, "the window asks for its place as it starts, alongside its first read");
  assert.equal(harness.dom.container.querySelector(".fm-title-text")?.textContent ?? null, null, "the file manager waits for the place the window was handed");

  await harness.dom.act(async () => { take.resolve(); await take.promise; });
  await harness.dom.waitFor(() => shown(harness.dom.container).placeholder !== null);
  assert.deepEqual(shown(harness.dom.container), { title: "Garden", info: "Garden", placeholder: "Work in Garden" });
  await harness.dom.waitFor(() => activeSent.at(-1) === "garden");
  await send(harness.dom, "Plan the walkthrough");
  await harness.dom.waitFor(() => harness.requests.some((request) => request.method === "POST" && request.path.endsWith("/conversations")));
  watch.stop();
  assert.deepEqual([...watch.seen].filter((value) => value.includes("Lab")), [], "Lab was never drawn as the folder shown");
  assert.deepEqual(harness.requests.filter((request) => request.method === "POST" && request.path.endsWith("/conversations")).map((request) => request.path), ["/api/connected-folders/garden/conversations"]);
  assert.equal(activeSent.includes("lab"), false, "the window never named Lab as its Connected Folder");
});

test("a window brought back while a handed folder is slow to find never offers another Worker's message box, however long finding takes", async (t) => {
  const harness = await createFileManagerHarness(t, answers(bootstrapAnswer));
  keepStorage(t);
  // The host's real window registry and folder queue (desktop/src/open-path-drain.ts), with real time: the folder
  // takes far longer to find than the window's wait checks.
  const { FileManagerWindows } = await import("../desktop/src/file-manager-windows.js");
  const { OpenPathDrain } = await import("../desktop/src/open-path-drain.js");
  const windows = new FileManagerWindows<{ id: number; isDestroyed(): boolean }, HandedLocation>();
  const hostWindow = { id: 2, isDestroyed: () => false };
  const found = Promise.withResolvers<HandedLocation | null>();
  const drain: InstanceType<typeof OpenPathDrain<{ id: number; isDestroyed(): boolean }, HandedLocation>> = new OpenPathDrain({
    windows,
    lookUp: () => found.promise,
    // The windows that were open come back owed a place while the folder is queued, as ensureWindow brings them back.
    frontWindow: async () => {
      if (!windows.has(hostWindow)) { windows.add(hostWindow); drain.owe(hostWindow); }
      return hostWindow;
    },
    newWindow: async () => hostWindow,
    show() {},
    hand: (target, location) => { windows.handOpenLocation(target, { token: "garden", location }); },
    notFound() {},
    overdue() {},
    lookupLimitMs: 10_000,
    waitCheckMs: 15,
  });
  drain.queue("/Users/ana/Garden");
  // AmpleFile starts with the folder queued: its window comes back owed a place before its renderer loads.
  windows.add(hostWindow);
  drain.owe(hostWindow);
  const activeSent = stubWindowBridge(t, (callback, onTaken) => {
    void windows.takeOpenLocation(hostWindow).then((request) => {
      if (request) callback(request.location);
      onTaken?.();
    });
    return () => {};
  });
  const { App } = await import("../web-local/src/App.js");
  const watch = watchShownNames(harness.dom.container);
  await harness.dom.render(createElement(App));
  const running = drain.drain();
  await harness.dom.waitFor(() => harness.requests.some((request) => request.path === "/api/bootstrap"));
  // Many wait checks pass while the folder is still being found. A send attempted now has nowhere to go.
  await harness.dom.act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  const field = harness.dom.container.querySelector('[aria-label="Message the Worker"]');
  if (field) await send(harness.dom, "Sent while the folder was still being found");
  await harness.dom.settle();
  assert.deepEqual(conversationPosts(harness.requests), [], "nothing was sent to any Worker");
  assert.equal(field === null, true, "no message box while the window waits for its folder");

  await harness.dom.act(async () => { found.resolve({ place: gardenPlace, path: "", select: null }); await running; });
  await harness.dom.waitFor(() => shown(harness.dom.container).placeholder !== null);
  assert.deepEqual(shown(harness.dom.container), { title: "Garden", info: "Garden", placeholder: "Work in Garden" });
  await send(harness.dom, "Plan the walkthrough");
  await harness.dom.waitFor(() => conversationPosts(harness.requests).length > 0);
  watch.stop();
  assert.deepEqual([...watch.seen].filter((value) => value.includes("Lab")), [], "Lab was never drawn as the folder shown");
  assert.deepEqual(conversationPosts(harness.requests), ["/api/connected-folders/garden/conversations"]);
  assert.equal(activeSent.includes("lab"), false);
});

/** The window as App mounts it once it has taken its place: `connectedFolder` is the one it would otherwise fall back to. */
function windowWithPlace(harness: Awaited<ReturnType<typeof createFileManagerHarness>>, request: { id: number; location: { place: typeof gardenPlace; path: string }; select: string | null }, record: { firstFrame?: ReturnType<typeof shown>; switched: string[]; opened: number[] }) {
  // Runs in the commit that first puts the window on screen, before any effect could move it: what that frame shows.
  function FirstFrame() {
    useLayoutEffect(() => { record.firstFrame ??= shown(harness.dom.container); });
    return null;
  }
  return createElement(Fragment, null,
    createElement(harness.module.FileManagerView, {
      connectedFolder: lab, connectedFolders: [lab, garden], agent: { ready: true, configured: true } as never, fixture: null,
      openLocationRequest: request, onOpenedLocation: (id: number) => record.opened.push(id),
      onSwitchConnectedFolder(next: ConnectedFolderSummary) { record.switched.push(next.id); }, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
    }),
    createElement(FirstFrame));
}

function stubDesktop(t: test.TestContext) {
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = { menu: { setState() {} }, window: { control() {} }, connectedFolder: {} };
  t.after(() => { delete scope.ampleFileDesktop; });
}

test("a window that opens at a handed place draws it in its first frame, selects its item once read, and makes it the window's Connected Folder", async (t) => {
  const harness = await createFileManagerHarness(t, answers());
  keepStorage(t);
  stubDesktop(t);
  const record: { firstFrame?: ReturnType<typeof shown>; switched: string[]; opened: number[] } = { switched: [], opened: [] };
  await harness.dom.render(windowWithPlace(harness, { id: 4, location: { place: gardenPlace, path: "Notes" }, select: "Notes/n.md" }, record));
  assert.deepEqual(record.firstFrame, { title: "Notes", info: "Notes", placeholder: "Work in Notes" });
  assert.deepEqual(record.switched, ["garden"], "the window's Connected Folder is the one it shows");
  assert.deepEqual(record.opened, [4]);
  await harness.dom.waitFor(() => harness.dom.container.querySelector('[data-fm-path="Notes/n.md"][aria-selected="true"]') !== null);
  assert.equal(harness.requests.some((request) => request.path.startsWith("/api/connected-folders/lab/tree")), false, "Lab's files were never read");
  const crumbs = [...harness.dom.container.querySelectorAll(".fm-crumb")].map((crumb) => crumb.textContent);
  assert.deepEqual(crumbs.slice(-2), ["Notes", "n.md"]);
  // The message, with the selected file, goes to Garden's Worker.
  await send(harness.dom, "Summarize the notes");
  await harness.dom.waitFor(() => harness.requests.some((request) => request.method === "POST" && request.path.endsWith("/conversations")));
  assert.deepEqual(harness.requests.filter((request) => request.method !== "GET").map((request) => request.path), ["/api/connected-folders/garden/context-attachments", "/api/connected-folders/garden/conversations"]);
});

test("a window that comes back with kept tabs and is handed a place shows the place first, with Back to where its tab was", async (t) => {
  const harness = await createFileManagerHarness(t, answers());
  // The window's front tab was in the Trash over Lab's Notes when it was last open.
  keepStorage(t, new Map([["amplefile.file-manager.tabs.v1", JSON.stringify({
    tabs: [{ location: { place: { kind: "connected-folder", id: "lab" }, path: "" }, view: "folder" }, { location: { place: { kind: "connected-folder", id: "lab" }, path: "Notes" }, view: "trash" }],
    active: 1, showTabBar: false,
  })]]));
  stubDesktop(t);
  const record: { firstFrame?: ReturnType<typeof shown>; switched: string[]; opened: number[] } = { switched: [], opened: [] };
  await harness.dom.render(windowWithPlace(harness, { id: 9, location: { place: gardenPlace, path: "" }, select: null }, record));
  assert.deepEqual(record.firstFrame, { title: "Garden", info: "Garden", placeholder: "Work in Garden" });
  assert.deepEqual(record.switched, ["garden"]);
  await harness.dom.waitFor(() => harness.dom.container.querySelectorAll(".fm-folder-tabs [role=\"tab\"]").length === 2);
  // Back returns the front tab to the folder it was showing.
  await harness.dom.act(() => harness.dom.container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click());
  await harness.dom.waitFor(() => shown(harness.dom.container).title === "Notes");
});
