import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { createFileManagerHarness } from "./support/file-manager.js";
import type { BrowserOpenTabCommand, BrowserPageState, BrowserShortcut, BrowserTabsSync, BrowserViewRequest } from "../src/shared/browser.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";

// The Browser pane in the real file manager window (jsdom, a mocked local API)
// against a stand-in for the desktop bridge: these tests observe what the
// window asks the host to do, and what a person would see and press.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const garden = { id: "garden", name: "Garden", connectedFolderRoot: "/tmp/garden", location: { storage: "linked" } } as ConnectedFolderSummary;
/** Longer than the half second a site's question ignores presses for after it appears. */
const pastQuestionGuard = () => new Promise((resolve) => setTimeout(resolve, 620));
const answer = (path: string) => {
  if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true } };
  if (path.startsWith("/api/agent/composer")) return { composer: null };
  if (path === "/api/standard-folders") return { folders: [] };
  if (path.includes("/tree")) return { tree: path.includes("/lab/") ? [{ kind: "folder", path: "Notes", name: "Notes", hasChildren: false, children: [] }] : [] };
  if (path.endsWith("/automations")) return { automations: [] };
  if (path.endsWith("/lab/conversations")) return { conversations: [
    { id: "chat-2", title: "Something else", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
    { id: "chat-1", title: "Order the parts", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" },
  ] };
  if (path.endsWith("/conversations")) return { conversations: [] };
  if (path.includes("/conversations/")) return { conversation: { id: path.includes("chat-2") ? "chat-2" : "chat-1", title: path.includes("chat-2") ? "Something else" : "Order the parts", messages: [] }, messages: [] };
  if (path === "/api/connected-folders/activity") return { running: [] };
  if (path.endsWith("/suggestions")) return { suggestions: [] };
  if (path.includes("/history/checkpoints")) return { checkpoints: [] };
  return undefined;
};

function page(pageId: string, extra: Partial<BrowserPageState> = {}): BrowserPageState {
  return {
    pageId, url: `https://${pageId}.example.com/`, title: `Page ${pageId}`, favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false,
    audible: false, sitePermissions: [], permissionRequest: null, notice: null, muted: false, zoomPercent: 100, blockedPopup: null, worker: null, ...extra,
  };
}

/** A stand-in for the desktop's `browser` bridge that records every call and lets a test speak as the host. */
function createBridge(initial: BrowserPageState[] = []) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const listeners = { state: new Set<(value: BrowserPageState) => void>(), open: new Set<(value: BrowserOpenTabCommand) => void>(), close: new Set<(value: { pageId: string }) => void>(), shortcut: new Set<(value: BrowserShortcut) => void>() };
  /** What the next calls of one kind answer with, for a test that makes the desktop refuse. */
  const failures = new Map<string, Error>();
  const menuAnswers: Array<string | null> = [];
  const record = <T,>(name: string, result: T) => (...args: unknown[]) => { calls.push({ name, args }); return result; };
  const subscribe = <T,>(set: Set<(value: T) => void>) => (listener: (value: T) => void) => { set.add(listener); return () => { set.delete(listener); }; };
  const bridge = {
    mount: (request: BrowserViewRequest) => { calls.push({ name: "mount", args: [request] }); return Promise.resolve(null); },
    layout: record("layout", undefined),
    unmount: record("unmount", Promise.resolve()),
    navigate: (pageId: string, address: string) => { calls.push({ name: "navigate", args: [pageId, address] }); return Promise.resolve(page(pageId, { url: `https://${address}/`, title: address })); },
    command: (...args: unknown[]) => { calls.push({ name: "command", args }); const failure = failures.get("command"); return failure ? Promise.reject(failure) : Promise.resolve(); },
    close: record("close", Promise.resolve()),
    respondPermission: record("respondPermission", Promise.resolve()),
    sync: record("sync", undefined),
    states: () => Promise.resolve(initial),
    showDownload: record("showDownload", Promise.resolve()),
    popupTabMenu: (...args: unknown[]) => { calls.push({ name: "popupTabMenu", args }); return Promise.resolve(menuAnswers.shift() ?? null); },
    suggest: () => Promise.resolve([]),
    recent: () => Promise.resolve([{ url: "https://recent.example.com/", title: "Recent Page", visits: 1, lastVisitedAt: "2026-11-01T00:00:00Z" }]),
    clearHistory: record("clearHistory", Promise.resolve()),
    onState: subscribe(listeners.state),
    onOpenTab: subscribe(listeners.open),
    onCloseTab: subscribe(listeners.close),
    onShortcut: subscribe(listeners.shortcut),
    onFindResult: () => () => undefined,
    onDownload: () => () => undefined,
  };
  return {
    bridge,
    calls,
    failures,
    menuAnswers,
    /** A key pressed in a page that the desktop hands to the window. */
    shortcut: (pageId: string, key: string, extra: Partial<BrowserShortcut> = {}) => { for (const listener of listeners.shortcut) listener({ pageId, key, code: "", metaKey: !extra.ctrlKey, ctrlKey: false, shiftKey: false, altKey: false, ...extra }); },
    named: (name: string) => calls.filter((call) => call.name === name),
    lastSync: () => calls.filter((call) => call.name === "sync").at(-1)?.args[0] as BrowserTabsSync | undefined,
    state: (value: BrowserPageState) => { for (const listener of listeners.state) listener(value); },
    open: (value: BrowserOpenTabCommand) => { for (const listener of listeners.open) listener(value); },
    close: (pageId: string) => { for (const listener of listeners.close) listener({ pageId }); },
  };
}

/** Where the page's placeholder measures in these tests; jsdom lays nothing out, so every box is zero without this. */
const placeholderBox = { left: 228, top: 510, width: 892, height: 378 };

async function mountWindow(t: Parameters<typeof createFileManagerHarness>[0], host: ReturnType<typeof createBridge> | null, extraProps: Record<string, unknown> = {}) {
  const harness = await createFileManagerHarness(t, answer);
  const elementPrototype = window.HTMLElement.prototype;
  const measure = elementPrototype.getBoundingClientRect;
  const boxes = new Map<string, { left: number; top: number; width: number; height: number }>([["fm-browser-viewport", { ...placeholderBox }]]);
  elementPrototype.getBoundingClientRect = function (this: HTMLElement) {
    const box = [...boxes].find(([name]) => this.classList.contains(name))?.[1];
    if (!box) return measure.call(this);
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON() {} } as DOMRect;
  };
  t.after(() => { elementPrototype.getBoundingClientRect = measure; });
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  if (host) {
    scope.ampleFileDesktop = { desktop: true, app: { name: "AmpleFile", version: "0", platform: "darwin", iconUrl: "" }, connectedFolder: {}, shell: { openExternal: async () => undefined }, browser: host.bridge };
    t.after(() => { delete scope.ampleFileDesktop; });
  }
  const feedback = await import("../web-local/src/ui/feedback.js");
  const errors: Array<string | null> = [];
  const switched: string[] = [];
  const props = {
    connectedFolder: lab, connectedFolders: [lab, garden], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder(next: ConnectedFolderSummary) { switched.push(next.id); }, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError(message: string | null) { errors.push(message); },
    ...extraProps,
  };
  const render = (extra: Record<string, unknown> = {}) => harness.dom.render(createElement(Fragment, null, createElement(harness.module.FileManagerView, { ...props, ...extra }), createElement(feedback.ToastHost), createElement(feedback.ConfirmDialogHost)));
  await render();
  const { container } = harness.dom;
  await harness.dom.waitFor(() => Boolean(container.querySelector("nav.fm-sidebar")));
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label) ?? null;
  const press = async (label: string) => {
    const target = button(label);
    assert.ok(target, `a button named ${label}`);
    await harness.dom.act(async () => { target.click(); });
  };
  return {
    ...harness, container, errors, render, button, press, switched, boxes,
    /** One frame, in which the pane measures its placeholder again. */
    frame: () => harness.dom.settle(),
    allow: () => [...container.querySelectorAll<HTMLButtonElement>(".fm-browser-strip.is-question button")].find((item) => item.textContent === "Allow") ?? null,
    pane: () => container.querySelector<HTMLElement>(".fm-browser"),
    layout: () => container.querySelector<HTMLElement>(".fm-main")!.dataset.browser,
    tabs: () => [...container.querySelectorAll<HTMLButtonElement>('.fm-browser-tab [role="tab"]')],
    toasts: () => [...container.ownerDocument.querySelectorAll<HTMLElement>(".toast")],
  };
}

test("outside the desktop app the window offers no Browser", async (t) => {
  const view = await mountWindow(t, null);
  assert.equal(view.button("Browser"), null);
  assert.equal(view.pane(), null);
  assert.equal(view.layout(), "hidden");
});

test("the Browser button opens the pane under the folder with a new tab, and the first address creates its page", async (t) => {
  const host = createBridge();
  const view = await mountWindow(t, host);
  assert.equal(view.pane(), null, "no pane until a tab is open");
  assert.equal(view.button("Browser")!.getAttribute("aria-pressed"), "false");

  await view.press("Browser");
  assert.equal(view.layout(), "split");
  const files = view.container.querySelector<HTMLElement>(".fm-files")!;
  const pane = view.pane()!;
  assert.ok(files.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING, "the browser sits under the folder's contents");
  assert.ok(view.container.querySelector('.fm-browser-divide.fm-browser-resize[role="separator"][aria-orientation="horizontal"]'), "with the band between them as the slider");
  assert.equal(view.button("Browser")!.getAttribute("aria-pressed"), "true");
  assert.deepEqual(view.tabs().map((tab) => tab.getAttribute("aria-label")), ["New Tab"]);
  assert.equal(host.named("mount").length, 0, "a new tab has no page yet");
  await view.dom.waitFor(() => pane.textContent?.includes("Recent Page") === true);
  assert.match(pane.textContent ?? "", /Sign-ins here are shared by every Worker and the AmpleFile Agent\./);
  assert.deepEqual(host.lastSync(), { tabs: [], viewingPageId: null }, "Workers are not told about a tab with no page");

  const address = pane.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
  await view.dom.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(address, "example.com");
    address.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await view.dom.act(async () => { address.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await view.dom.waitFor(() => host.named("navigate").length === 1);
  const [pageId, typed] = host.named("navigate")[0]!.args as [string, string];
  assert.match(pageId, /^[a-z0-9]{12}$/);
  assert.equal(typed, "https://example.com");
  await view.dom.waitFor(() => host.named("mount").length === 1);
  const mounted = host.named("mount")[0]!.args[0] as BrowserViewRequest;
  assert.equal(mounted.pageId, pageId, "the page is placed over the pane's placeholder");
  await view.dom.waitFor(() => host.lastSync()?.viewingPageId === pageId);
  assert.deepEqual(host.lastSync()!.tabs.map((tab) => tab.pageId), [pageId], "Workers see the tab and that the person has it in front");
});

test("a tab a Worker opens arrives as the tab strip alone, and the person decides how much of the area the page takes", async (t) => {
  const host = createBridge();
  const view = await mountWindow(t, host);
  await view.dom.act(() => {
    host.open({ pageId: "worker1", url: "https://worker1.example.com/", title: "Supplier", show: false });
    host.state(page("worker1", { title: "Supplier", worker: { owner: "lab/chat-1" } }));
  });
  assert.equal(view.layout(), "collapsed");
  const pane = view.pane()!;
  assert.equal(pane.querySelector(".fm-browser-page"), null, "only the tab strip shows");
  const band = view.container.querySelector<HTMLElement>(".fm-browser-divide")!;
  assert.ok(band.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING, "a band separates the folder from the strip");
  assert.equal(band.getAttribute("role"), null, "with nothing to slide while the browser is folded away");
  assert.equal(host.named("mount").length, 0, "the page stays in the background");
  assert.equal(view.tabs()[0]!.getAttribute("aria-label"), "Supplier, a Worker is using it");
  assert.equal(view.tabs()[0]!.getAttribute("aria-selected"), "false");
  assert.ok(pane.querySelector(".fm-browser-tab .fm-dot.is-run"), "with the running dot");
  assert.equal(host.lastSync()!.viewingPageId, null, "the Worker is not told the person is looking");

  // Choosing the tab opens the pane beside the folder and shows the page.
  await view.dom.act(() => view.tabs()[0]!.click());
  assert.equal(view.layout(), "split");
  await view.dom.waitFor(() => host.named("mount").length === 1);
  assert.equal(view.tabs()[0]!.getAttribute("aria-selected"), "true");
  const marker = pane.querySelector<HTMLElement>(".fm-browser-worker")!;
  assert.equal(marker.querySelector(".fm-browser-worker-text")!.textContent, "Worker in Lab");
  assert.equal(marker.getAttribute("title"), "The Lab Worker is using this page");

  // The marker leads to the Worker's own Chat, in the panel. Already in its Connected Folder, the person keeps their place.
  await view.dom.act(async () => { view.container.querySelector<HTMLElement>('[data-fm-path="Notes"]')!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  await view.dom.waitFor(() => view.container.querySelector(".fm-title-text")?.textContent === "Notes");
  await view.press("Open the Chat");
  await view.dom.waitFor(() => Boolean(view.container.querySelector(".fm-panel.is-chat")));
  await view.dom.waitFor(() => view.container.querySelector(".fm-panel.is-chat .fm-ph-t")?.textContent === "Order the parts");
  assert.equal(view.requests.some((item) => /\/conversations\/chat-2/.test(item.path)), false, "the Chat that is using the page, and no other");
  assert.equal(view.container.querySelector(".fm-title-text")?.textContent, "Notes", "the folder shown does not change");
  assert.deepEqual(view.switched, []);
  assert.equal(view.layout(), "split", "the page stays in view beside the Chat");

  // Hide Folder gives the page the whole area; the folder stays mounted but out of reach.
  await view.press("Hide Folder");
  assert.equal(view.layout(), "full");
  const files = view.container.querySelector<HTMLElement>(".fm-files")!;
  assert.equal(files.hasAttribute("inert"), true);
  assert.equal(view.container.querySelector(".fm-browser-divide"), null, "no band when the folder is folded away");
  await view.press("Show Folder");
  assert.equal(view.layout(), "split");
  assert.equal(files.hasAttribute("inert"), false);

  // Hide Browser folds it back to the strip: the placeholder goes, the page keeps running.
  await view.press("Hide Browser");
  assert.equal(view.layout(), "collapsed");
  assert.deepEqual(host.named("unmount").map((call) => call.args[0]), ["worker1"]);
  assert.equal(host.named("close").length, 0, "folding the pane never closes a page");
  assert.equal(view.tabs().length, 1);
  await view.press("Show Browser");
  assert.equal(view.layout(), "split");

  // The Worker closes its own tab: the pane goes with its last tab.
  await view.dom.act(() => host.close("worker1"));
  assert.equal(view.pane(), null);
  assert.equal(view.layout(), "hidden");
  assert.equal(host.named("close").length, 0, "the host already closed it");
});

test("a site's question shows above the page, is announced when the page is out of view, and only the person's press answers it", async (t) => {
  const host = createBridge();
  const view = await mountWindow(t, host);
  const request = { requestId: "ask-1", origin: "https://maps.example.com", kinds: ["camera", "microphone"] as Array<"camera" | "microphone"> };
  await view.dom.act(() => {
    host.open({ pageId: "maps01", url: "https://maps.example.com/", title: "Maps", show: false });
    host.state(page("maps01", { url: "https://maps.example.com/", title: "Maps", permissionRequest: request }));
  });
  assert.equal(view.layout(), "collapsed");
  assert.equal(view.tabs()[0]!.getAttribute("aria-label"), "Maps, the site is waiting for your answer");
  assert.ok(view.pane()!.querySelector(".fm-browser-tab .fm-dot.is-ask"));
  await view.dom.waitFor(() => view.toasts().length === 1);
  const notice = view.toasts()[0]!;
  assert.match(notice.textContent ?? "", /maps\.example\.com is waiting for your answer/);
  assert.equal(host.named("respondPermission").length, 0, "nothing answers for the person");

  // The same question is not announced twice.
  await view.dom.act(() => host.state(page("maps01", { url: "https://maps.example.com/", title: "Maps", permissionRequest: request, loading: true })));
  assert.equal(view.toasts().length, 1);

  // Show Page brings the tab into view, where the question is.
  const show = [...notice.querySelectorAll("button")].find((item) => item.textContent === "Show Page")!;
  await view.dom.act(() => show.click());
  assert.equal(view.layout(), "split");
  const question = view.pane()!.querySelector<HTMLElement>('.fm-browser-strip.is-question[role="alert"]')!;
  assert.equal(question.querySelector(".fm-browser-strip-text")!.textContent, "maps.example.com wants to use your camera and microphone.");
  const viewport = view.pane()!.querySelector(".fm-browser-viewport")!;
  assert.ok(question.compareDocumentPosition(viewport) & Node.DOCUMENT_POSITION_FOLLOWING, "above the page, in the window's own markup");
  assert.equal(viewport.contains(question), false);
  assert.equal(host.named("respondPermission").length, 0);

  // In view, the notice has said its piece: the question is in front of the person.
  await view.dom.waitFor(() => view.toasts().length === 0);

  // A press as the bar appears answers nothing.
  assert.equal(view.allow()!.disabled, true);
  await view.dom.act(() => view.allow()!.click());
  assert.equal(host.named("respondPermission").length, 0, "a press aimed at what was there a moment ago");
  await view.dom.act(pastQuestionGuard);
  assert.equal(view.allow()!.disabled, false);
  await view.dom.act(() => view.allow()!.click());
  assert.deepEqual(host.named("respondPermission").map((call) => call.args), [["maps01", "ask-1", "allow"]]);
  await view.dom.act(() => view.allow()!.click());
  assert.equal(host.named("respondPermission").length, 1, "one question takes one answer");

  // The host says the question is settled; the bar and the dot go.
  await view.dom.act(() => host.state(page("maps01", { url: "https://maps.example.com/", title: "Maps" })));
  assert.equal(view.pane()!.querySelector(".fm-browser-strip.is-question"), null);
  assert.equal(view.pane()!.querySelector(".fm-dot.is-ask"), null);
});

test("a second question gets its own bar and buttons, so a double press on Allow never answers it", async (t) => {
  const host = createBridge();
  const view = await mountWindow(t, host);
  const first = { requestId: "aaaaaaaaaaaaaaaa", origin: "https://maps.example.com", kinds: ["location"] as Array<"location"> };
  const second = { requestId: "bbbbbbbbbbbbbbbb", origin: "https://maps.example.com", kinds: ["camera", "microphone"] as Array<"camera" | "microphone"> };
  await view.dom.act(() => {
    host.open({ pageId: "maps01", url: "https://maps.example.com/", title: "Maps", show: true });
    host.state(page("maps01", { url: "https://maps.example.com/", permissionRequest: first }));
  });
  await view.dom.act(pastQuestionGuard);
  assert.equal(view.toasts().length, 0, "a question in view needs no notice");
  const before = view.allow()!;
  await view.dom.act(() => before.click());
  // The host settles the first and shows the queued second.
  await view.dom.act(() => host.state(page("maps01", { url: "https://maps.example.com/", permissionRequest: second })));
  const after = view.allow()!;
  assert.ok(after !== before, "each question has fresh buttons");
  assert.equal(after.disabled, true);
  // The second press of a double-click, on either button element.
  await view.dom.act(() => { before.click(); after.click(); });
  assert.deepEqual(host.named("respondPermission").map((call) => call.args), [["maps01", first.requestId, "allow"]], "the camera and microphone stay unanswered");
  assert.match(view.pane()!.querySelector(".fm-browser-strip.is-question .fm-browser-strip-text")!.textContent ?? "", /use your camera and microphone/);
  await view.dom.act(pastQuestionGuard);
  const block = [...view.pane()!.querySelectorAll<HTMLButtonElement>(".fm-browser-strip.is-question button")].find((item) => item.textContent === "Block")!;
  await view.dom.act(() => block.click());
  assert.deepEqual(host.named("respondPermission").at(-1)!.args, ["maps01", second.requestId, "block"]);
});

test("the waiting notice goes when its question is answered or its tab closes, and Show Page never opens another tab", async (t) => {
  const host = createBridge([page("first1")]);
  const view = await mountWindow(t, host);
  await view.dom.waitFor(() => view.tabs().length === 1);
  const request = { requestId: "ask-2", origin: "https://maps.example.com", kinds: ["location"] as Array<"location"> };
  await view.dom.act(() => {
    host.open({ pageId: "maps01", url: "https://maps.example.com/", title: "Maps", show: false });
    host.state(page("maps01", { url: "https://maps.example.com/", title: "Maps", permissionRequest: request }));
  });
  await view.dom.waitFor(() => view.toasts().length === 1);
  // The page leaves the question behind (a navigation drops it): the notice has nothing left to say.
  await view.dom.act(() => host.state(page("maps01", { url: "https://maps.example.com/next", title: "Maps" })));
  await view.dom.waitFor(() => view.toasts().length === 0);

  // Asked again, then the tab closes while the notice is up.
  await view.dom.act(() => host.state(page("maps01", { url: "https://maps.example.com/next", title: "Maps", permissionRequest: { ...request, requestId: "ask-3" } })));
  await view.dom.waitFor(() => view.toasts().length === 1);
  const show = [...view.toasts()[0]!.querySelectorAll("button")].find((item) => item.textContent === "Show Page")!;
  await view.dom.act(() => host.close("maps01"));
  await view.dom.waitFor(() => view.toasts().length === 0);
  await view.dom.act(() => show.click());
  assert.equal(view.layout(), "collapsed", "a late press on Show Page does not open the pane on a different tab");
});

test("pages the host already has come back as tabs, closing a tab closes its page, and Close Tab closes the one in front", async (t) => {
  const host = createBridge([page("first1"), page("second")]);
  const view = await mountWindow(t, host);
  await view.dom.waitFor(() => view.tabs().length === 2);
  assert.equal(view.layout(), "collapsed", "pages that outlived a window reload wait in the strip");
  await view.press("Show Browser");
  await view.dom.waitFor(() => host.named("mount").length === 1);
  assert.equal((host.named("mount")[0]!.args[0] as BrowserViewRequest).pageId, "first1");

  // Choosing the other tab moves the placeholder to its page.
  await view.dom.act(() => view.tabs()[1]!.click());
  await view.dom.waitFor(() => host.named("mount").length === 2);
  assert.deepEqual(host.named("unmount").map((call) => call.args[0]), ["first1"]);
  await view.dom.waitFor(() => host.lastSync()!.viewingPageId === "second");

  // ⌘W arrives as the menu's Close Tab command. It closes a browser tab only while the pane has the keyboard.
  await view.render({ desktopAction: { id: 1, command: "close-tab" } });
  assert.deepEqual(host.named("close"), [], "not from the folder's list");
  const messageBox = view.container.querySelector<HTMLInputElement>('input[aria-label="Message the Worker"]')!;
  await view.dom.act(() => messageBox.focus());
  await view.render({ desktopAction: { id: 2, command: "close-tab" } });
  assert.deepEqual(host.named("close"), [], "not while typing to the Worker");
  // With a dialog open, even with the keyboard last in the pane.
  await view.dom.act(() => view.tabs()[1]!.focus());
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  await view.render({ desktopAction: { id: 3, command: "close-tab" } });
  assert.deepEqual(host.named("close"), [], "not behind a dialog");
  dialog.remove();
  await view.render({ desktopAction: { id: 4, command: "close-tab" } });
  assert.deepEqual(host.named("close").map((call) => call.args[0]), ["second"]);
  assert.deepEqual(view.tabs().map((tab) => tab.getAttribute("aria-label")), ["Page first1"]);

  await view.press("Close Page first1");
  assert.deepEqual(host.named("close").map((call) => call.args[0]), ["second", "first1"]);
  assert.equal(view.pane(), null);

  // A state the host sent before it heard does not bring a closed tab back.
  await view.dom.act(() => host.state(page("first1")));
  assert.equal(view.pane(), null);
});

test("the slider keeps the browser's share of the area, and going to another place or opening Recents brings a folded folder back", async (t) => {
  const host = createBridge([page("first1")]);
  const view = await mountWindow(t, host);
  await view.dom.waitFor(() => view.tabs().length === 1);
  await view.press("Show Browser");
  const main = view.container.querySelector<HTMLElement>(".fm-main")!;
  assert.equal(main.style.getPropertyValue("--fm-browser-fraction"), "0.55");
  const slider = view.container.querySelector<HTMLElement>(".fm-browser-resize")!;
  await view.dom.act(() => { slider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); });
  assert.equal(main.style.getPropertyValue("--fm-browser-fraction"), "0.58");
  assert.equal(view.container.querySelector<HTMLElement>(".fm-browser-resize")!.getAttribute("aria-valuenow"), "58");
  await view.dom.act(() => { view.container.querySelector<HTMLElement>(".fm-browser-resize")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); });
  assert.equal(main.style.getPropertyValue("--fm-browser-fraction"), "0.85", "the folder always keeps a share");

  await view.press("Hide Folder");
  assert.equal(view.layout(), "full");
  const sidebarItem = (name: string) => [...view.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((item) => item.textContent?.includes(name))!;
  await view.dom.act(async () => { sidebarItem("Garden").click(); });
  assert.deepEqual(view.switched, ["garden"]);
  assert.equal(view.layout(), "split", "choosing a place in the sidebar shows the folder again");
  assert.equal(view.tabs().length, 1, "the tabs belong to no Connected Folder");

  await view.press("Hide Folder");
  await view.dom.act(async () => { sidebarItem("Recents").click(); });
  assert.equal(view.layout(), "split", "and so does opening Recents");
});

test("the page is placed over its placeholder, steps aside for the window's overlays, and Workers are told only what the person can see", async (t) => {
  const host = createBridge([page("first1")]);
  const view = await mountWindow(t, host);
  await view.dom.waitFor(() => view.tabs().length === 1);
  await view.press("Show Browser");
  await view.dom.waitFor(() => host.named("mount").length === 1);
  const mounted = host.named("mount")[0]!.args[0] as BrowserViewRequest;
  assert.deepEqual({ pageId: mounted.pageId, bounds: mounted.bounds, active: mounted.active, occluded: mounted.occluded },
    { pageId: "first1", bounds: { x: 228, y: 510, width: 892, height: 378 }, active: true, occluded: false }, "inside the placeholder, shown");
  await view.dom.waitFor(() => host.lastSync()?.viewingPageId === "first1");
  const layouts = () => host.named("layout").map((call) => call.args[0] as BrowserViewRequest);
  const sent = layouts().length;

  // The placeholder moves (the window was resized, the slider dragged): the page follows on the next frame.
  view.boxes.set("fm-browser-viewport", { left: 228, top: 548, width: 892, height: 340 });
  await view.dom.act(async () => { window.dispatchEvent(new window.Event("resize")); });
  await view.frame();
  assert.deepEqual(layouts().at(-1)!.bounds, { x: 228, y: 548, width: 892, height: 340 });
  assert.ok(layouts().length > sent);
  assert.ok(layouts().every((item, index, all) => index === 0 || item.sequence > all[index - 1]!.sequence), "each placement is newer than the last");

  // A dialog of the window's opens over the page: the page steps aside, and Workers stop being told the person is looking.
  const dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  view.boxes.set("modal-backdrop", { left: 0, top: 0, width: 1440, height: 900 });
  await view.dom.act(async () => { document.body.append(dialog); });
  await view.frame();
  assert.equal(layouts().at(-1)!.occluded, true);
  await view.dom.waitFor(() => host.lastSync()?.viewingPageId === null);
  await view.dom.act(async () => { dialog.remove(); });
  await view.frame();
  assert.equal(layouts().at(-1)!.occluded, false, "and comes back when the dialog closes");
  await view.dom.waitFor(() => host.lastSync()?.viewingPageId === "first1");

  // Nothing new to say sends nothing.
  const quiet = layouts().length;
  await view.dom.act(async () => { window.dispatchEvent(new window.Event("resize")); });
  await view.frame();
  assert.equal(layouts().length, quiet);

  // A site's question pushes the page down in the same commit, never a frame later.
  view.boxes.set("fm-browser-viewport", { left: 228, top: 586, width: 892, height: 302 });
  await view.dom.act(() => host.state(page("first1", { permissionRequest: { requestId: "ask-9", origin: "https://first1.example.com", kinds: ["location"] } })));
  assert.deepEqual(layouts().at(-1)!.bounds, { x: 228, y: 586, width: 892, height: 302 }, "before any frame runs");

  // A page that failed to load shows the window's message instead, and nobody is looking at a page.
  await view.dom.act(() => host.state(page("first1", { error: { code: -105, description: "The site can’t be found.", url: "https://first1.example.com/" } })));
  await view.frame();
  assert.equal(layouts().at(-1)!.occluded, true);
  await view.dom.waitFor(() => host.lastSync()?.viewingPageId === null);
});

test("keys pressed in a page reach the window's own controls: the address field, Find, new and closed tabs, and the next tab", async (t) => {
  const host = createBridge([page("first1"), page("second")]);
  const view = await mountWindow(t, host);
  await view.dom.waitFor(() => view.tabs().length === 2);
  await view.press("Show Browser");
  await view.dom.waitFor(() => host.named("mount").length === 1);
  const pane = view.pane()!;
  const address = () => pane.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;

  // ⌘L: the address field has the keyboard.
  await view.dom.act(async () => { host.shortcut("first1", "l"); });
  await view.frame();
  assert.ok(document.activeElement === address(), "the keyboard is there");
  // ⌘F: Find in Page opens, ready to type.
  await view.dom.act(async () => { host.shortcut("first1", "f"); });
  await view.frame();
  assert.ok(document.activeElement === pane.querySelector('input[aria-label="Find in Page"]'), "the keyboard is there");
  // A key from a tab that is not in front is not this tab's to act on.
  await view.dom.act(async () => { host.shortcut("second", "l"); });
  await view.frame();
  assert.ok(document.activeElement === pane.querySelector('input[aria-label="Find in Page"]'), "the keyboard is there");

  // ⌃Tab: the next tab comes forward and its page takes the keyboard, as the page it was pressed in had it.
  await view.dom.act(async () => { host.shortcut("first1", "Tab", { ctrlKey: true, metaKey: false }); });
  await view.dom.waitFor(() => host.named("mount").length === 2);
  assert.equal(view.tabs()[1]!.getAttribute("aria-selected"), "true");
  await view.dom.waitFor(() => host.named("command").some((call) => call.args[0] === "second" && (call.args[1] as { type: string }).type === "focus"));
  // ⌘1: the first tab again.
  await view.dom.act(async () => { host.shortcut("second", "1"); });
  assert.equal(view.tabs()[0]!.getAttribute("aria-selected"), "true");

  // ⌘W closes the tab it was pressed in, whichever is in front.
  await view.dom.act(async () => { host.shortcut("second", "w"); });
  assert.deepEqual(host.named("close").map((call) => call.args[0]), ["second"]);
  assert.deepEqual(view.tabs().map((tab) => tab.getAttribute("aria-label")), ["Page first1"]);
  // ⇧⌘T reopens it, and ⌘T opens a new tab ready to type into.
  await view.dom.act(async () => { host.shortcut("first1", "t", { shiftKey: true }); });
  assert.deepEqual(view.tabs().map((tab) => tab.getAttribute("aria-label")), ["Page first1", "Page second"]);
  await view.dom.act(async () => { host.shortcut("first1", "t"); });
  await view.frame();
  assert.equal(view.tabs().at(-1)!.getAttribute("aria-label"), "New Tab");
  assert.ok(document.activeElement === address(), "the keyboard is there");
});

test("the browser's keys work wherever in the pane the keyboard is, and the folder's Search keeps ⌘F elsewhere", async (t) => {
  const host = createBridge([page("first1"), page("second")]);
  const view = await mountWindow(t, host);
  await view.dom.waitFor(() => view.tabs().length === 2);
  await view.press("Show Browser");
  const pane = view.pane()!;
  // The stand-in desktop is a Mac, so the browser's keys are ⌘ keys; changing tabs is Control-Tab on every platform.
  const key = (target: Element, init: KeyboardEventInit) => view.dom.act(async () => { target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, metaKey: init.key !== "Tab", ctrlKey: init.key === "Tab", ...init })); });
  const search = view.container.querySelector<HTMLInputElement>(".fm-search input")!;

  // With the keyboard on a tab in the strip, ⌘F is Find in Page, not the folder's Search.
  await view.dom.act(() => view.tabs()[0]!.focus());
  await key(view.tabs()[0]!, { key: "f" });
  await view.frame();
  assert.ok(document.activeElement === pane.querySelector('input[aria-label="Find in Page"]'), "the keyboard is there");
  assert.equal(view.layout(), "split");
  await key(view.tabs()[0]!, { key: "l" });
  await view.frame();
  assert.ok(document.activeElement === pane.querySelector('input[aria-label="Address"]'), "the keyboard is there");
  await key(view.tabs()[0]!, { key: "2" });
  assert.equal(view.tabs()[1]!.getAttribute("aria-selected"), "true");
  await key(view.tabs()[1]!, { key: "Tab" });
  assert.equal(view.tabs()[0]!.getAttribute("aria-selected"), "true");

  // Elsewhere in the window the same keys are the window's: ⌘F searches the folder, and ⌘T opens nothing.
  const list = view.container.querySelector<HTMLElement>(".fm-content")!;
  await view.dom.act(() => list.focus());
  await key(list, { key: "f" });
  await view.frame();
  assert.ok(document.activeElement === search, "the keyboard is there");
  await key(list, { key: "t" });
  assert.equal(view.tabs().length, 2);
});

test("a tab duplicated or reopened from the folded strip is shown, an address the browser cannot open is searched for, and clearing history asks first", async (t) => {
  const host = createBridge([page("first1")]);
  const view = await mountWindow(t, host);
  await view.dom.waitFor(() => view.tabs().length === 1);
  assert.equal(view.layout(), "collapsed");

  // Duplicate, from the tab's menu while the browser is folded away.
  host.menuAnswers.push("duplicate");
  await view.dom.act(async () => { view.tabs()[0]!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 700 })); });
  await view.dom.waitFor(() => view.tabs().length === 2);
  assert.equal(view.layout(), "split", "the tab that came to the front is shown");
  await view.dom.waitFor(() => host.named("mount").some((call) => (call.args[0] as BrowserViewRequest).url === "https://first1.example.com/"), 3_000);

  // Close it, fold the browser, and reopen it from the menu.
  await view.dom.act(async () => { view.pane()!.querySelectorAll<HTMLButtonElement>(".fm-browser-tab-close")[1]!.click(); });
  await view.press("Hide Browser");
  host.menuAnswers.push("reopen-closed");
  await view.dom.act(async () => { view.tabs()[0]!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 700 })); });
  await view.dom.waitFor(() => view.tabs().length === 2);
  assert.equal(view.layout(), "split");

  // A new tab: an address only another program could open becomes a search, so no tab is left blank.
  await view.press("New Tab");
  const address = view.pane()!.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
  await view.dom.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(address, "chrome://settings");
    address.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.match(view.pane()!.querySelector(".fm-browser-suggestions li")!.textContent ?? "", /Search Google for “chrome:\/\/settings”/);
  await view.dom.act(async () => { address.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await view.dom.waitFor(() => host.named("navigate").length === 1);
  assert.equal(host.named("navigate")[0]!.args[1], "https://www.google.com/search?q=chrome%3A%2F%2Fsettings");

  // Clear Browsing History… asks, says it cannot be undone, and does nothing on Cancel.
  await view.press("New Tab");
  await view.dom.waitFor(() => view.pane()!.textContent?.includes("Recent Page") === true);
  const clear = () => [...view.pane()!.querySelectorAll("button")].find((item) => item.textContent === "Clear Browsing History…")!;
  await view.dom.act(async () => { clear().click(); });
  const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
  await view.dom.waitFor(() => Boolean(confirm()));
  assert.match(confirm()!.textContent ?? "", /Clear Browsing History\?[\s\S]*can’t be undone/);
  await view.dom.act(async () => { [...confirm()!.querySelectorAll("button")].find((item) => item.textContent === "Cancel")!.click(); });
  assert.equal(host.named("clearHistory").length, 0);
  await view.dom.waitFor(() => !confirm());
  await view.dom.act(async () => { clear().click(); });
  await view.dom.waitFor(() => Boolean(confirm()));
  await view.dom.act(async () => { [...confirm()!.querySelectorAll("button")].find((item) => item.textContent === "Clear History")!.click(); });
  await view.dom.waitFor(() => host.named("clearHistory").length === 1);
});

test("a refusal from the desktop is said in its own words, without Electron's prefix", async (t) => {
  const host = createBridge([page("first1")]);
  const view = await mountWindow(t, host);
  await view.dom.waitFor(() => view.tabs().length === 1);
  await view.press("Show Browser");
  host.failures.set("command", new Error("Error invoking remote method 'amplefile:browser:command': Error: The browser command is invalid."));
  await view.press("Reload");
  await view.dom.waitFor(() => view.errors.length === 1);
  assert.deepEqual(view.errors, ["The browser command is invalid."]);
});

test("the panel button is the toolbar's last control, after Search, and the Browser button sits before Search", async (t) => {
  const view = await mountWindow(t, createBridge());
  const toolbar = view.container.querySelector<HTMLElement>(".fm-toolbar")!;
  const toggle = () => toolbar.querySelector<HTMLButtonElement>('[aria-label="Show or hide the panel"]')!;
  const controls = [...toolbar.querySelectorAll<HTMLElement>("button, input")];
  assert.equal(controls.at(-1), toggle(), "nearest the panel it shows and hides");
  const search = toolbar.querySelector<HTMLElement>(".fm-search")!;
  assert.ok(search.compareDocumentPosition(toggle()) & Node.DOCUMENT_POSITION_FOLLOWING, "to the right of the search field");
  assert.ok(view.button("Browser")!.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(toggle().getAttribute("aria-pressed"), "true");
  assert.equal(toggle().getAttribute("title"), "Hide Panel");
  const panel = view.container.querySelector<HTMLElement>("aside.fm-panel")!;
  assert.equal(panel.querySelector('[aria-label="Hide Panel"], [aria-label="Show or hide the panel"]'), null, "one control, and it is not in the panel");

  await view.dom.act(() => toggle().click());
  assert.equal(view.container.querySelector("aside.fm-panel"), null);
  assert.equal(toggle().getAttribute("aria-pressed"), "false");
  assert.equal(toggle().getAttribute("title"), "Show Panel");
  await view.dom.act(() => toggle().click());
  assert.ok(view.container.querySelector("aside.fm-panel"));
});
