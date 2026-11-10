import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness } from "./support/file-manager.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";

// The Action menu, a Connected Folder's right-click menu, and the Set Up for
// Me card, in the real file manager window (jsdom, a mocked local API).
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const garden = { id: "garden", name: "Garden", connectedFolderRoot: "/tmp/garden", location: { storage: "managed" } } as ConnectedFolderSummary;
const answer = (path: string) => {
  if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true } };
  if (path.startsWith("/api/agent/composer")) return { composer: null };
  if (path === "/api/standard-folders") return { folders: [] };
  if (path.includes("/tree")) return { tree: [] };
  if (path.endsWith("/automations")) return { automations: [] };
  if (path.endsWith("/conversations")) return { conversations: [] };
  if (path === "/api/connected-folders/activity") return { running: [] };
  if (path.endsWith("/suggestions")) return { suggestions: [] };
  if (path.includes("/history/checkpoints")) return { checkpoints: [] };
  return undefined;
};

async function mountWindow(t: Parameters<typeof createFileManagerHarness>[0], extra: Record<string, unknown> = {}, desktop?: unknown) {
  const harness = await createFileManagerHarness(t, answer);
  if (desktop) {
    const scope = window as unknown as { ampleFileDesktop?: unknown };
    scope.ampleFileDesktop = desktop;
    t.after(() => { delete scope.ampleFileDesktop; });
  }
  const switched: string[] = [];
  const props = {
    connectedFolder: lab, connectedFolders: [lab, garden], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder(next: ConnectedFolderSummary) { switched.push(next.id); }, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  };
  const render = (more: Record<string, unknown> = {}) => harness.dom.render(createElement(harness.module.FileManagerView, { ...props, ...extra, ...more }));
  await render();
  const { container } = harness.dom;
  await harness.dom.waitFor(() => Boolean(container.querySelector("nav.fm-sidebar")));
  return {
    ...harness, container, render, switched,
    toolbar: () => container.querySelector<HTMLElement>(".fm-toolbar")!,
    menuItems: () => [...container.querySelectorAll<HTMLElement>('.fm-menu > *')].map((item) => item.getAttribute("role") === "menuitem" ? item.textContent : "—"),
    menuItem: (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.fm-menu [role="menuitem"]')].find((item) => item.textContent === label)!,
    chatTitle: () => container.querySelector(".fm-panel.is-chat .fm-ph-t")?.textContent ?? null,
    sidebarItem: (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((item) => item.textContent?.includes(name))!,
  };
}

test("the Action menu reads Customize, Organize, Skills & Extensions, then Disconnect and Settings, and the toolbar has no Organize", async (t) => {
  const view = await mountWindow(t);
  assert.equal([...view.toolbar().querySelectorAll("button")].some((item) => /Organize/.test(item.textContent ?? "") || item.getAttribute("title") === "Organize"), false, "Organize left the toolbar");
  await view.dom.act(() => view.toolbar().querySelector<HTMLButtonElement>('[aria-label="Action"]')!.click());
  assert.deepEqual(view.menuItems(), ["Customize Connected Folder", "Organize", "Skills & Extensions…", "—", "Disconnect…", "Settings…"]);
  assert.doesNotMatch(view.container.textContent ?? "", /Just the Look|Set Up for Me/);

  // Organize opens the panel's Chat with the message the toolbar button sent.
  await view.dom.act(async () => { view.menuItem("Organize").click(); });
  assert.equal(view.container.querySelector(".fm-menu"), null);
  await view.dom.waitFor(() => view.chatTitle() === "Organize this folder.");
  assert.deepEqual(view.switched, [], "the folder shown is already the one asked about");
});

test("a Connected Folder's right-click menu offers the same, names a managed one's deletion, and Organize goes to that Connected Folder first", async (t) => {
  const view = await mountWindow(t);
  await view.dom.act(() => { view.sidebarItem("Garden").dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 200 })); });
  assert.deepEqual(view.menuItems(), ["Customize Connected Folder", "Organize", "Skills & Extensions…", "—", "Delete Connected Folder…", "Settings…"]);
  await view.dom.act(async () => { view.menuItem("Organize").click(); });
  assert.deepEqual(view.switched, ["garden"], "the Chat belongs to the Connected Folder the menu was opened for");
});

test("the native menu is asked for Organize, never for Set Up for Me or a look, and its Organize starts the same Chat", async (t) => {
  const requests: Array<{ actions: Record<string, boolean> }> = [];
  const view = await mountWindow(t, {}, {
    desktop: true, app: { name: "AmpleFile", version: "0", platform: "darwin", iconUrl: "" }, shell: {},
    connectedFolder: { popupHeaderMenu: async (request: { actions: Record<string, boolean> }) => { requests.push(request); return "organize"; } },
  });
  await view.dom.act(async () => { view.toolbar().querySelector<HTMLButtonElement>('[aria-label="Action"]')!.click(); });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.actions, { newChat: false, customize: true, organize: true, reveal: true, skills: true, settings: true, manage: false, remove: true, removeDeletes: false });
  assert.equal(view.container.querySelector(".fm-menu"), null, "the Mac shows its own menu");
  await view.dom.waitFor(() => view.chatTitle() === "Organize this folder.");
});

test("Set Up for Me is offered once, on a card after a folder is connected, with one offer", async (t) => {
  const closed: string[] = [];
  const view = await mountWindow(t, { setUpOffers: ["garden"], onCloseSetUpOffer: (id: string) => { closed.push(id); } });
  const card = () => view.container.querySelector<HTMLElement>(".fm-setup-offer");
  assert.equal(card(), null, "the card belongs to the Connected Folder that was connected, not the one shown");

  // The folder just connected is the one shown: its card is at the top of Info.
  await view.render({ setUpOffers: ["lab"], onCloseSetUpOffer: (id: string) => { closed.push(id); } });
  const info = view.container.querySelector<HTMLElement>("aside.fm-panel .fm-pane")!;
  assert.equal(info.firstElementChild, card());
  assert.equal(card()!.getAttribute("aria-label"), "Set up Lab");
  assert.deepEqual([...card()!.querySelectorAll("button")].map((item) => item.textContent), ["Set Up for Me", "No Thanks"]);
  assert.doesNotMatch(view.container.textContent ?? "", /Just the Look/);

  // Set Up for Me closes the offer for good and starts the Chat the set-up Skill answers.
  await view.dom.act(async () => { card()!.querySelector<HTMLButtonElement>(".is-primary")!.click(); });
  assert.deepEqual(closed, ["lab"]);
  await view.dom.waitFor(() => view.chatTitle() === "Set Up for Me");
});

test("with no AI connected, Set Up for Me asks for it first and the card stays until the message goes", async (t) => {
  const closed: string[] = [];
  const view = await mountWindow(t, { setUpOffers: ["lab"], onCloseSetUpOffer: (id: string) => { closed.push(id); }, agent: { ready: true, configured: false } });
  const { onConnectAiRequested } = await import("../web-local/src/lib/connect-ai.js");
  const asked: Array<() => void> = [];
  const stop = onConnectAiRequested((then) => { if (then) asked.push(then); });
  await view.dom.act(async () => { view.container.querySelector<HTMLButtonElement>(".fm-setup-offer .is-primary")!.click(); });
  assert.equal(asked.length, 1, "Set Up AI comes first");
  assert.deepEqual(closed, [], "backing out of it leaves the offer where it was");
  assert.equal(view.chatTitle(), null);
  // AI is connected: the message goes and the offer closes.
  await view.dom.act(async () => { asked[0]!(); });
  assert.deepEqual(closed, ["lab"]);
  await view.dom.waitFor(() => view.chatTitle() === "Set Up for Me");
  stop();
});

test("No Thanks closes the offer, and a folder connected while the window is open brings its card into view", async (t) => {
  const closed: string[] = [];
  const onCloseSetUpOffer = (id: string) => { closed.push(id); };
  const view = await mountWindow(t, { setUpOffers: [], onCloseSetUpOffer });
  const toggle = view.toolbar().querySelector<HTMLButtonElement>('[aria-label="Show or hide the panel"]')!;
  await view.dom.act(() => toggle.click());
  assert.equal(view.container.querySelector("aside.fm-panel"), null);

  await view.render({ setUpOffers: ["lab"], onCloseSetUpOffer });
  const card = view.container.querySelector<HTMLElement>("aside.fm-panel .fm-setup-offer");
  assert.ok(card, "the panel opens on Info with the card");
  const decline = [...card.querySelectorAll("button")].find((item) => item.textContent === "No Thanks")!;
  await view.dom.act(() => decline.click());
  assert.deepEqual(closed, ["lab"]);
  await view.render({ setUpOffers: [], onCloseSetUpOffer });
  assert.equal(view.container.querySelector(".fm-setup-offer"), null);
  assert.equal(view.container.querySelector(".fm-panel.is-chat"), null, "declining sends nothing to the Worker");
});
