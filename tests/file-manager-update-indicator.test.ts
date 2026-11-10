import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness } from "./support/file-manager.js";
import type { ConnectedFolderSummary, DesktopUpdateStatus } from "../web-local/src/types.js";

// Its own file (and process): the file manager harness binds the module graph to this file's mock.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
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
const status = (phase: DesktopUpdateStatus["phase"]): DesktopUpdateStatus => ({
  supported: true, phase, currentVersion: "0.1.4", availableVersion: "0.1.5", progressPercent: null, checkedAt: null, message: "", error: null,
});

test("the update indicator sits at the foot of the sidebar, after its lists, and acts through the window's props", async (t) => {
  const { dom, module } = await createFileManagerHarness(t, answer);
  let updates = 0;
  const settingsPages: unknown[] = [];
  const props = {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings(page?: unknown) { settingsPages.push(page); }, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
    onUpdateAction: () => { updates += 1; },
  };
  const sidebar = () => dom.container.querySelector<HTMLElement>("nav.fm-sidebar")!;
  const indicator = () => sidebar().querySelector<HTMLButtonElement>(".fm-update-button");

  await dom.render(createElement(module.FileManagerView, { ...props, updateStatus: status("not_available") }));
  await dom.waitFor(() => Boolean(sidebar()));
  assert.equal(sidebar().querySelector(".fm-update"), null, "nothing is drawn while AmpleFile is up to date");

  await dom.render(createElement(module.FileManagerView, { ...props, updateStatus: status("ready") }));
  const foot = sidebar().querySelector(".fm-update")!;
  assert.equal(foot.previousElementSibling?.classList.contains("fm-sidebar-scroll"), true, "outside the scrolling lists, so it stays put");
  assert.equal(foot, sidebar().lastElementChild);
  const buttons = [...sidebar().querySelectorAll("button")];
  assert.equal(buttons.at(-1), indicator(), "the last stop in the sidebar's keyboard order");
  await dom.act(() => indicator()!.click());
  assert.equal(updates, 1);

  await dom.render(createElement(module.FileManagerView, { ...props, updateStatus: status("error") }));
  await dom.act(() => indicator()!.click());
  assert.deepEqual(settingsPages, ["about"]);
  assert.equal(updates, 1);

  await dom.render(createElement(module.FileManagerView, { ...props, onUpdateAction: undefined, updateStatus: status("available") }));
  assert.equal(indicator(), null, "a window without an update action draws no indicator");
});
