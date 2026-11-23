import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { ConnectedFolderSummary, TreeEntry } from "../web-local/src/types.js";

// Folder tabs and per-folder views in the real window (jsdom, a mocked local
// API): what each tab keeps, Close Tab's choice between a folder tab and a
// browser tab, a Chat that keeps going when its tab is left or closed, tabs
// coming back after the window reopens, and each folder's own view.
//
// Assertions here compare plain values, never a DOM element: a failing assert
// that carries an element of the mounted window makes node's test runner walk
// the whole jsdom and React graph to report it, which exhausts memory.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const garden = { id: "garden", name: "Garden", connectedFolderRoot: "/tmp/garden", location: { storage: "managed" } } as ConnectedFolderSummary;
const file = (path: string): TreeEntry => ({ kind: "file", path, name: path.slice(path.lastIndexOf("/") + 1), updatedAt: "2026-09-27T12:00:00Z", sizeBytes: 10 } as TreeEntry);
const folder = (path: string): TreeEntry => ({ kind: "folder", path, name: path.slice(path.lastIndexOf("/") + 1), updatedAt: "2026-09-27T12:00:00Z" } as TreeEntry);
const trees: Record<string, TreeEntry[]> = {
  "": [folder("Notes"), file("a.md"), file("b.md")],
  "Notes": [file("Notes/n.md")],
};

function answers(extra: ApiAnswer = () => undefined): ApiAnswer {
  return (path, options) => {
    const value = extra(path, options);
    if (value !== undefined) return value;
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true, provider: "test", model: "synthetic" } };
    if (path.startsWith("/api/agent/composer")) return { composer: null };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path.includes("/tree")) return { tree: trees[new URL(path, "http://local").searchParams.get("path") ?? ""] ?? [] };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations") && options.method !== "POST") return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    if (path.includes("/file-info")) return { modifiedAt: "2026-09-27T12:00:00Z" };
    return undefined;
  };
}

/** What the window keeps on this computer, as a plain map, so a test can look at it and hand it to the next window. */
function keepStorage(t: test.TestContext, kept = new Map<string, string>()) {
  // The harness takes its window down after the test, so the cleanup holds on to this one.
  const target = window;
  const previous = Object.getOwnPropertyDescriptor(target, "localStorage");
  Object.defineProperty(target, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } } });
  t.after(() => { if (previous) Object.defineProperty(target, "localStorage", previous); });
  return kept;
}

async function mountWindow(t: test.TestContext, options: { answer?: ApiAnswer; desktop?: Record<string, unknown>; storage?: Map<string, string> } = {}) {
  const harness = await createFileManagerHarness(t, answers(options.answer));
  if (options.storage) keepStorage(t, options.storage);
  const closes: string[] = [];
  const states: Array<Record<string, unknown>> = [];
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = {
    menu: { setState: (state: Record<string, unknown>) => states.push(state) },
    window: { control: (action: string) => closes.push(action) },
    connectedFolder: {},
    ...options.desktop,
  };
  t.after(() => { delete scope.ampleFileDesktop; });
  const switched: string[] = [];
  let action: { id: number; command: string } | null = null;
  let mounted = true;
  const render = () => harness.dom.render(!mounted ? null : createElement(harness.module.FileManagerView, {
    connectedFolder: lab, connectedFolders: [lab, garden], agent: { ready: true, configured: true } as never, fixture: null, desktopAction: action,
    onSwitchConnectedFolder(next: ConnectedFolderSummary) { switched.push(next.id); }, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  }));
  await render();
  const { container, dom } = { container: harness.dom.container, dom: harness.dom };
  await dom.waitFor(() => Boolean(container.querySelector("nav.fm-sidebar")));
  let commands = 0;
  return {
    ...harness, container, closes, states, switched,
    /** A menu bar command, as App hands it to the window. */
    command: async (command: string) => { action = { id: ++commands, command }; await render(); },
    /** The window closed and opened again on this computer: a fresh window, reading what was kept. */
    reopen: async () => {
      mounted = false;
      await render();
      switched.length = 0;
      action = null;
      mounted = true;
      await render();
      await dom.waitFor(() => Boolean(container.querySelector("nav.fm-sidebar")));
    },
    stripShown: () => Boolean(container.querySelector(".fm-folder-tabs")),
    tabs: () => [...container.querySelectorAll<HTMLElement>('.fm-folder-tabs [role="tab"]')].map((tab) => tab.textContent),
    activeTab: () => container.querySelector<HTMLElement>('.fm-folder-tabs [role="tab"][aria-selected="true"]')?.textContent ?? null,
    tab: (index: number) => container.querySelectorAll<HTMLButtonElement>('.fm-folder-tabs [role="tab"]')[index]!,
    row: (path: string) => container.querySelector<HTMLElement>(`[data-fm-path="${path}"]`),
    contents: () => container.querySelector<HTMLElement>(".fm-content")!,
    title: () => container.querySelector(".fm-title-text")?.textContent ?? null,
    back: () => container.querySelector<HTMLButtonElement>('.fm-toolbar [aria-label="Back"]')!,
    button: (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`),
  };
}

test("New Tab opens at the folder shown, and each tab keeps its own folder, Back and Forward, and selection", async (t) => {
  const view = await mountWindow(t);
  await view.dom.waitFor(() => Boolean(view.row("a.md")));
  assert.equal(view.stripShown(), false, "one tab: the strip stays hidden, so the window looks as it did");
  await view.dom.act(() => view.row("a.md")!.click());
  assert.equal(view.row("a.md")!.getAttribute("aria-selected"), "true");

  await view.command("new-tab");
  await view.dom.waitFor(() => view.tabs().length === 2);
  assert.deepEqual(view.tabs(), ["Lab", "Lab"]);
  assert.equal(view.tab(1).getAttribute("aria-selected"), "true", "the new tab comes to the front, after the one it was opened from");
  await view.dom.waitFor(() => Boolean(view.row("a.md")));
  assert.equal(view.row("a.md")!.getAttribute("aria-selected"), "false", "a new tab starts with nothing selected");

  // The new tab goes into Notes; the first stays where it was.
  await view.dom.act(() => { view.row("Notes")!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  await view.dom.waitFor(() => Boolean(view.row("Notes/n.md")));
  assert.deepEqual(view.tabs(), ["Lab", "Notes"]);
  assert.equal(view.back().disabled, false);

  await view.dom.act(() => view.tab(0).click());
  await view.dom.waitFor(() => Boolean(view.row("a.md")));
  assert.equal(view.title(), "Lab");
  assert.equal(view.row("a.md")!.getAttribute("aria-selected"), "true", "coming back keeps the tab's selection");
  assert.equal(view.back().disabled, true, "Back is the tab's own");

  // The tab keys: Ctrl+Tab goes to the next tab, Ctrl+PageUp to the one before (off the Mac).
  await view.dom.act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", code: "Tab", ctrlKey: true, bubbles: true, cancelable: true })); });
  await view.dom.waitFor(() => view.activeTab() === "Notes");
  await view.dom.waitFor(() => Boolean(view.row("Notes/n.md")));
  assert.equal(view.back().disabled, false);
  await view.dom.act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "PageUp", code: "PageUp", ctrlKey: true, bubbles: true, cancelable: true })); });
  await view.dom.waitFor(() => view.activeTab() === "Lab");

  // Ctrl+T in the window opens a tab too.
  await view.dom.act(() => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "t", code: "KeyT", ctrlKey: true, bubbles: true, cancelable: true })); });
  await view.dom.waitFor(() => view.tabs().length === 3);
  assert.deepEqual(view.tabs(), ["Lab", "Lab", "Notes"], "right after the tab it was opened from");
});

test("Close Tab closes the folder tab in front, the last one closes the window, and the Browser pane keeps it for its own tab", async (t) => {
  const view = await mountWindow(t);
  await view.dom.waitFor(() => Boolean(view.row("a.md")));
  await view.command("new-tab");
  await view.dom.waitFor(() => view.tabs().length === 2);
  assert.deepEqual(view.states.at(-1), { showHiddenFiles: false }, "the menu bar heard Show Hidden Files last");
  assert.ok(view.states.some((state) => state.folderTabsOpen === true), "and that New Tab and Close Tab have a window to act on");

  // While the Browser pane has the keyboard, Close Tab is the browser's: no folder tab closes.
  const pane = document.createElement("div");
  pane.className = "fm-browser";
  const strip = document.createElement("button");
  pane.append(strip);
  document.body.append(pane);
  strip.focus();
  await view.command("close-tab");
  assert.equal(view.tabs().length, 2);
  pane.remove();

  // Behind a dialog, nothing closes.
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  await view.command("close-tab");
  assert.equal(view.tabs().length, 2);
  dialog.remove();

  // From the folder's list it closes the folder tab in front.
  await view.dom.act(() => view.contents().focus());
  await view.command("close-tab");
  await view.dom.waitFor(() => !view.stripShown());
  assert.deepEqual(view.closes, [], "a tab remains, so the window stays");
  // The last tab closes the window, through the desktop, which keeps AmpleFile running.
  await view.command("close-tab");
  assert.deepEqual(view.closes, ["close"]);
});

test("a Chat keeps going when its tab is left or closed: it is never stopped, and its tab shows it again", async (t) => {
  const asked: string[] = [];
  // The Chat's first message is sent and its reply never ends while the test runs: a turn in progress.
  const view = await mountWindow(t, {
    answer: (path, options) => {
      if (options.method && options.method !== "GET") asked.push(`${options.method} ${path}`);
      if (path === "/api/connected-folders/lab/conversations" && options.method === "POST") return { conversation: { id: "c1", title: "amplefile chat", updatedAt: "2026-09-27T12:00:00Z", createdAt: "2026-09-27T12:00:00Z" } };
      if (path.includes("/conversations/c1")) return new Promise(() => undefined);
      return undefined;
    },
  });
  await view.dom.waitFor(() => Boolean(view.row("a.md")));
  // Organize, from the Action menu, starts a Chat in the panel.
  await view.dom.act(() => view.button("Action")!.click());
  await view.dom.act(() => [...view.container.querySelectorAll<HTMLButtonElement>('.fm-menu [role="menuitem"]')].find((item) => item.textContent === "Organize")!.click());
  await view.dom.waitFor(() => Boolean(view.container.querySelector(".fm-panel.is-chat .chat-panel")));
  const chat = view.container.querySelector(".fm-panel .chat-panel")!;
  await view.dom.waitFor(() => asked.some((request) => request.startsWith("POST /api/connected-folders/lab/conversations")));

  // A new tab in front: the Chat is put out of sight, not taken down.
  await view.command("new-tab");
  await view.dom.waitFor(() => view.tabs().length === 2);
  assert.equal(Boolean(view.container.querySelector(".fm-panel.is-chat")), false, "the new tab's panel shows Info");
  assert.ok(chat.isConnected, "the first tab's Chat is still there");
  assert.equal(chat.closest<HTMLElement>(".fm-tab-chat")!.hidden, true);

  // Back to the first tab: the same Chat, as it was.
  await view.dom.act(() => view.tab(0).click());
  await view.dom.waitFor(() => Boolean(view.container.querySelector(".fm-panel.is-chat")));
  assert.ok(view.container.querySelector(".fm-panel .chat-panel") === chat, "the very same Chat, never remounted");
  assert.equal(view.container.querySelector(".fm-ph-t")?.textContent, "Organize this folder.");

  // Closing the Chat's tab takes the Chat away from the window; its reply is never stopped.
  await view.dom.act(() => view.button("Close Lab")!.click());
  await view.dom.waitFor(() => !view.stripShown());
  assert.equal(chat.isConnected, false);
  assert.deepEqual(asked.filter((request) => /\/abort|DELETE/.test(request)), [], "no Stop, no delete: the turn goes on on the host");
});

test("tabs come back where they were when the window reopens, with the same one in front and its Connected Folder the window's", async (t) => {
  const storage = new Map<string, string>();
  const first = await mountWindow(t, { storage });
  await first.dom.waitFor(() => Boolean(first.row("a.md")));
  await first.command("new-tab");
  await first.dom.waitFor(() => first.tabs().length === 2);
  // The second tab goes to Garden; the first stays in Lab, inside Notes.
  await first.dom.act(() => [...first.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((item) => item.textContent?.includes("Garden"))!.click());
  await first.dom.waitFor(() => first.activeTab() === "Garden");
  await first.dom.act(() => first.tab(0).click());
  await first.dom.waitFor(() => Boolean(first.row("Notes")));
  await first.dom.act(() => { first.row("Notes")!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  await first.dom.waitFor(() => first.activeTab() === "Notes");
  await first.dom.act(() => first.tab(1).click());
  await first.dom.waitFor(() => first.activeTab() === "Garden");
  const kept = JSON.parse(storage.get("amplefile.file-manager.tabs.v1")!);
  assert.deepEqual(kept.tabs.map((tab: { location: unknown }) => tab.location), [{ place: { kind: "connected-folder", id: "lab" }, path: "Notes" }, { place: { kind: "connected-folder", id: "garden" }, path: "" }]);
  assert.equal(kept.active, 1);

  // The window closes and opens again: the same tabs, Garden in front, and the window's Connected Folder follows it.
  await first.reopen();
  const second = first;
  await second.dom.waitFor(() => second.tabs().length === 2);
  assert.deepEqual(second.tabs(), ["Notes", "Garden"]);
  assert.equal(second.activeTab(), "Garden");
  assert.deepEqual(second.switched, ["garden"]);
  await second.dom.act(() => second.tab(0).click());
  await second.dom.waitFor(() => Boolean(second.row("Notes/n.md")));
  assert.equal(second.back().disabled, false, "Back comes back too");
});

test("each folder keeps its own Icons or List and sort, and a folder never set shows the last choice; nothing is written into a folder", async (t) => {
  const storage = new Map<string, string>();
  const view = await mountWindow(t, { storage });
  await view.dom.waitFor(() => Boolean(view.row("a.md")));
  const shownAs = () => view.container.querySelector<HTMLElement>(".fm-shell")!.dataset.view;
  assert.equal(shownAs(), "list");
  await view.dom.act(() => view.button("Icons")!.click());
  assert.equal(shownAs(), "icons");

  // Notes has nothing remembered: the last choice, Icons. Set it to List, sorted by size.
  await view.dom.act(() => { view.row("Notes")!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  await view.dom.waitFor(() => Boolean(view.row("Notes/n.md")));
  assert.equal(shownAs(), "icons");
  await view.dom.act(() => view.button("List")!.click());
  await view.dom.act(() => [...view.container.querySelectorAll<HTMLButtonElement>('.fm-list-head [role="columnheader"]')].find((item) => item.textContent === "Size")!.click());
  assert.equal(shownAs(), "list");

  // Lab keeps Icons.
  await view.dom.act(() => view.back().click());
  await view.dom.waitFor(() => Boolean(view.row("a.md")));
  assert.equal(shownAs(), "icons");
  const remembered = JSON.parse(storage.get("amplefile.file-manager.folder-views.v1")!);
  assert.deepEqual(Object.keys(remembered).sort(), ["connected-folder:lab\0", "connected-folder:lab\0Notes"], "by the Connected Folder's portable id and the path inside it");
  assert.equal(remembered["connected-folder:lab\0Notes"].sort.key, "size");
  assert.equal(storage.get("amplefile.file-manager.view.v1"), JSON.stringify("list"), "the last choice is List, for folders never set");
  // A Connected Folder never visited: the last choice.
  await view.dom.act(() => [...view.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((item) => item.textContent?.includes("Garden"))!.click());
  await view.dom.waitFor(() => view.title() === "Garden");
  assert.equal(shownAs(), "list");
});

test("with several windows, each keeps its own tabs, reports the tab in front's folder, and offers Open in New Window", async (t) => {
  const storage = new Map<string, string>();
  const reported: unknown[] = [];
  const opened: unknown[] = [];
  const view = await mountWindow(t, {
    storage,
    desktop: { windows: { slot: 2, fresh: false, newWindow: async () => true, setLocation: (location: unknown) => reported.push(location), openInNewWindow: async (location: unknown) => { opened.push(location); return true; } } },
  });
  await view.dom.waitFor(() => Boolean(view.row("Notes")));
  assert.deepEqual(reported.at(-1), { place: { kind: "connected-folder", id: "lab" }, path: "" });

  // A second tab inside Notes: the window reports it while it is in front, and the first tab's folder when that is.
  await view.command("new-tab");
  await view.dom.waitFor(() => view.tabs().length === 2);
  await view.dom.act(() => { view.row("Notes")!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  await view.dom.waitFor(() => view.activeTab() === "Notes");
  assert.deepEqual(reported.at(-1), { place: { kind: "connected-folder", id: "lab" }, path: "Notes" });
  await view.dom.act(() => view.tab(0).click());
  await view.dom.waitFor(() => view.activeTab() === "Lab");
  assert.deepEqual(reported.at(-1), { place: { kind: "connected-folder", id: "lab" }, path: "" });

  // The tabs are this window's: kept under its own key, never the first window's.
  assert.ok(storage.has("amplefile.file-manager.tabs.v1.window-2"));
  assert.equal(storage.has("amplefile.file-manager.tabs.v1"), false, "window 1's tabs are left alone");

  // Open in New Window, beside Open in New Tab, in a folder's menu and a Connected Folder's sidebar menu.
  await view.dom.act(() => { view.row("Notes")!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 })); });
  const items = () => [...view.container.querySelectorAll<HTMLButtonElement>('.fm-menu [role="menuitem"]')];
  assert.deepEqual(items().slice(0, 3).map((item) => item.textContent), ["Open Folder", "Open in New Tab", "Open in New Window"]);
  await view.dom.act(() => items().find((item) => item.textContent === "Open in New Window")!.click());
  await view.dom.waitFor(() => opened.length === 1);
  assert.deepEqual(opened[0], { place: { kind: "connected-folder", id: "lab" }, path: "Notes" });
  await view.dom.act(() => { [...view.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((item) => item.textContent?.includes("Garden"))!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 200 })); });
  assert.deepEqual(items().slice(0, 2).map((item) => item.textContent), ["Open in New Tab", "Open in New Window"]);
  await view.dom.act(() => items().find((item) => item.textContent === "Open in New Window")!.click());
  await view.dom.waitFor(() => opened.length === 2);
  assert.deepEqual(opened[1], { place: { kind: "connected-folder", id: "garden" }, path: "" });
  assert.equal(view.tabs().length, 2, "a new window, not a new tab");
});
