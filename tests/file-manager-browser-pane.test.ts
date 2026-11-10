import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { createFileManagerHarness } from "./support/file-manager.js";
import type { BrowserOpenTabCommand, BrowserPageState, BrowserTabsSync, BrowserViewRequest } from "../src/shared/browser.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";

// The Browser pane in the real file manager window (jsdom, a mocked local API)
// against a stand-in for the desktop bridge: these tests observe what the
// window asks the host to do, and what a person would see and press.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const answer = (path: string) => {
  if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true } };
  if (path.startsWith("/api/agent/composer")) return { composer: null };
  if (path === "/api/standard-folders") return { folders: [] };
  if (path.includes("/tree")) return { tree: [] };
  if (path.endsWith("/automations")) return { automations: [] };
  if (path.endsWith("/conversations")) return { conversations: [] };
  if (path.includes("/conversations/")) return { conversation: { id: "chat-1", title: "Order the parts", messages: [] }, messages: [] };
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
  const listeners = { state: new Set<(value: BrowserPageState) => void>(), open: new Set<(value: BrowserOpenTabCommand) => void>(), close: new Set<(value: { pageId: string }) => void>() };
  const record = <T,>(name: string, result: T) => (...args: unknown[]) => { calls.push({ name, args }); return result; };
  const subscribe = <T,>(set: Set<(value: T) => void>) => (listener: (value: T) => void) => { set.add(listener); return () => { set.delete(listener); }; };
  const bridge = {
    mount: (request: BrowserViewRequest) => { calls.push({ name: "mount", args: [request] }); return Promise.resolve(null); },
    layout: record("layout", undefined),
    unmount: record("unmount", Promise.resolve()),
    navigate: (pageId: string, address: string) => { calls.push({ name: "navigate", args: [pageId, address] }); return Promise.resolve(page(pageId, { url: `https://${address}/`, title: address })); },
    command: record("command", Promise.resolve()),
    close: record("close", Promise.resolve()),
    respondPermission: record("respondPermission", Promise.resolve()),
    sync: record("sync", undefined),
    states: () => Promise.resolve(initial),
    showDownload: record("showDownload", Promise.resolve()),
    popupTabMenu: record("popupTabMenu", Promise.resolve(null)),
    suggest: () => Promise.resolve([]),
    recent: () => Promise.resolve([{ url: "https://recent.example.com/", title: "Recent Page", visits: 1, lastVisitedAt: "2026-11-01T00:00:00Z" }]),
    clearHistory: record("clearHistory", Promise.resolve()),
    onState: subscribe(listeners.state),
    onOpenTab: subscribe(listeners.open),
    onCloseTab: subscribe(listeners.close),
    onShortcut: () => () => undefined,
    onFindResult: () => () => undefined,
    onDownload: () => () => undefined,
  };
  return {
    bridge,
    calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    lastSync: () => calls.filter((call) => call.name === "sync").at(-1)?.args[0] as BrowserTabsSync | undefined,
    state: (value: BrowserPageState) => { for (const listener of listeners.state) listener(value); },
    open: (value: BrowserOpenTabCommand) => { for (const listener of listeners.open) listener(value); },
    close: (pageId: string) => { for (const listener of listeners.close) listener({ pageId }); },
  };
}

async function mountWindow(t: Parameters<typeof createFileManagerHarness>[0], host: ReturnType<typeof createBridge> | null) {
  const harness = await createFileManagerHarness(t, answer);
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  if (host) {
    scope.ampleFileDesktop = { desktop: true, app: { name: "AmpleFile", version: "0", platform: "darwin", iconUrl: "" }, connectedFolder: {}, shell: { openExternal: async () => undefined }, browser: host.bridge };
    t.after(() => { delete scope.ampleFileDesktop; });
  }
  const feedback = await import("../web-local/src/ui/feedback.js");
  const errors: Array<string | null> = [];
  const props = {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError(message: string | null) { errors.push(message); },
  };
  const render = (extra: Record<string, unknown> = {}) => harness.dom.render(createElement(Fragment, null, createElement(harness.module.FileManagerView, { ...props, ...extra }), createElement(feedback.ToastHost)));
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
    ...harness, container, errors, render, button, press,
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
  assert.ok(view.container.querySelector('.fm-browser-resize[role="separator"][aria-orientation="horizontal"]'), "with a slider between them");
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

  // The marker leads to the Worker's Chat, in the panel, in its own Connected Folder.
  await view.press("Open the Chat");
  await view.dom.waitFor(() => Boolean(view.container.querySelector(".fm-panel.is-chat")));
  assert.equal(view.layout(), "split", "the page stays in view beside the Chat");

  // Hide Folder gives the page the whole area; the folder stays mounted but out of reach.
  await view.press("Hide Folder");
  assert.equal(view.layout(), "full");
  const files = view.container.querySelector<HTMLElement>(".fm-files")!;
  assert.equal(files.hasAttribute("inert"), true);
  assert.equal(view.container.querySelector(".fm-browser-resize"), null);
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

  const allow = [...question.querySelectorAll("button")].find((item) => item.textContent === "Allow")!;
  await view.dom.act(() => allow.click());
  assert.deepEqual(host.named("respondPermission").map((call) => call.args), [["maps01", "ask-1", "allow"]]);

  // The host says the question is settled; the bar and the dot go.
  await view.dom.act(() => host.state(page("maps01", { url: "https://maps.example.com/", title: "Maps" })));
  assert.equal(view.pane()!.querySelector(".fm-browser-strip.is-question"), null);
  assert.equal(view.pane()!.querySelector(".fm-dot.is-ask"), null);
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
  assert.equal(host.lastSync()!.viewingPageId, "second");

  // ⌘W arrives as the menu's Close Tab command.
  await view.render({ desktopAction: { id: 1, command: "close-tab" } });
  assert.deepEqual(host.named("close").map((call) => call.args[0]), ["second"]);
  assert.deepEqual(view.tabs().map((tab) => tab.getAttribute("aria-label")), ["Page first1"]);

  await view.press("Close Page first1");
  assert.deepEqual(host.named("close").map((call) => call.args[0]), ["second", "first1"]);
  assert.equal(view.pane(), null);

  // A state the host sent before it heard does not bring a closed tab back.
  await view.dom.act(() => host.state(page("first1")));
  assert.equal(view.pane(), null);
});

test("the slider keeps the browser's share of the area, and going somewhere brings a folded folder back", async (t) => {
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
  const recents = [...view.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((item) => item.textContent?.includes("Recents"))!;
  await view.dom.act(() => recents.click());
  assert.equal(view.layout(), "split", "choosing a place in the sidebar shows the folder again");
});

test("the panel hides from its own corner and is shown again from the toolbar", async (t) => {
  const view = await mountWindow(t, createBridge());
  const toolbar = view.container.querySelector<HTMLElement>(".fm-toolbar")!;
  const panel = view.container.querySelector<HTMLElement>("aside.fm-panel")!;
  assert.ok(panel.contains(view.button("Hide Panel")), "Hide Panel is in the panel");
  assert.equal(toolbar.querySelector('[aria-label="Show Panel"]'), null);
  assert.equal(toolbar.querySelector('[aria-label="Hide Panel"]'), null);
  await view.press("Hide Panel");
  assert.equal(view.container.querySelector("aside.fm-panel"), null);
  assert.ok(toolbar.contains(view.button("Show Panel")), "Show Panel takes its place in the toolbar");
  await view.press("Show Panel");
  assert.ok(view.container.querySelector("aside.fm-panel"));
  assert.equal(toolbar.querySelector('[aria-label="Show Panel"]'), null);
});
