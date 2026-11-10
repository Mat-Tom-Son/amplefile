import assert from "node:assert/strict";
import test from "node:test";

import { nativeConnectedFolderMenuItems, parseNativeConnectedFolderMenuRequest } from "../desktop/src/connected-folder-context-menu.js";

function outline(value: unknown): string[] {
  return nativeConnectedFolderMenuItems(parseNativeConnectedFolderMenuRequest(value)).map((item) => item.type === "separator" ? "—" : `${item.label} (${item.command})`);
}

const point = { x: 12.6, y: 40.2 };

test("the Connected Folder header's native menu offers the same actions as the in-app menu", () => {
  assert.deepEqual(outline({ actions: { newChat: true, customize: true, organize: true, reveal: true }, point }), [
    "New Chat (new-chat)",
    "Customize Connected Folder (customize)",
    "Organize (organize)",
    "Show in Finder (reveal)",
    "—",
    "Manage Connected Folders (manage)",
  ]);
  assert.deepEqual(outline({ actions: { newChat: false, customize: false, organize: false, reveal: false }, point }), ["Manage Connected Folders (manage)"]);
  assert.deepEqual(parseNativeConnectedFolderMenuRequest({ actions: { newChat: true, customize: false, organize: false, reveal: false }, point }).point, { x: 13, y: 40 });
});

test("the Connected Folder header's native menu rejects malformed requests", () => {
  const actions = { newChat: true, customize: true, organize: true, reveal: true };
  for (const bad of [
    null,
    { actions, point, extra: true },
    { actions: { ...actions, delete: true }, point },
    { actions: { ...actions, newChat: "yes" }, point },
    { actions: { newChat: true, customize: true, organize: true }, point },
    { actions, point: { x: Number.NaN, y: 0 } },
  ]) {
    assert.throws(() => parseNativeConnectedFolderMenuRequest(bad), /invalid/);
  }
});

test("the file manager's Action menu adds Skills & Extensions and Settings and leaves out Manage", () => {
  const request = parseNativeConnectedFolderMenuRequest({
    actions: { newChat: false, customize: false, organize: true, reveal: true, skills: true, settings: true, manage: false },
    point: { x: 10, y: 20 },
  });
  assert.deepEqual(nativeConnectedFolderMenuItems(request).map((item) => item.type === "item" ? item.label : "—"), [
    "Organize", "Show in Finder", "Skills & Extensions…", "—", "Settings…",
  ]);
  // A Connected Folder's menu, as the Action button and the sidebar's right-click send it.
  const connectedFolder = (removeDeletes: boolean) => nativeConnectedFolderMenuItems(parseNativeConnectedFolderMenuRequest({
    actions: { newChat: false, customize: true, organize: true, reveal: true, skills: true, settings: true, manage: false, remove: true, removeDeletes },
    point: { x: 10, y: 20 },
  })).map((item) => item.type === "item" ? `${item.label} (${item.command})` : "—");
  assert.deepEqual(connectedFolder(false), [
    "Customize Connected Folder (customize)", "Organize (organize)", "Show in Finder (reveal)", "Skills & Extensions… (skills)", "—", "Disconnect… (remove-connected-folder)", "Settings… (settings)",
  ]);
  assert.equal(connectedFolder(true)[5], "Delete Connected Folder… (remove-connected-folder)");
  // Set Up for Me is offered on its card only, and the menu has no look-only command.
  assert.throws(() => parseNativeConnectedFolderMenuRequest({ actions: { newChat: false, customize: true, setUp: true, reveal: true }, point: { x: 0, y: 0 } }), /invalid/);
  assert.throws(() => parseNativeConnectedFolderMenuRequest({ actions: { newChat: false, customize: true, organize: true, setUp: true, reveal: true }, point: { x: 0, y: 0 } }), /invalid/);
  // Older renderers send only the four header actions and still get Manage Connected Folders.
  const header = parseNativeConnectedFolderMenuRequest({ actions: { newChat: true, customize: true, organize: false, reveal: false }, point: { x: 0, y: 0 } });
  assert.equal(nativeConnectedFolderMenuItems(header).at(-1)?.type === "item" && (nativeConnectedFolderMenuItems(header).at(-1) as { label: string }).label, "Manage Connected Folders");
  assert.throws(() => parseNativeConnectedFolderMenuRequest({ actions: { newChat: true, customize: true, organize: false, reveal: false, skills: "yes" }, point: { x: 0, y: 0 } }), /invalid/);
});

test("the file manager's sidebar menus: a Standard Folder's right-click and the + beside Connected Folders", () => {
  const labels = (actions: Record<string, boolean>) => nativeConnectedFolderMenuItems(parseNativeConnectedFolderMenuRequest({
    actions: { newChat: false, customize: false, organize: false, reveal: false, manage: false, ...actions },
    point: { x: 0, y: 0 },
  })).map((item) => item.type === "item" ? item.label : "—");
  assert.deepEqual(labels({ reveal: true, putToWork: true }), ["Show in Finder", "Connect This Folder"]);
  assert.deepEqual(labels({ reveal: true, putToWork: true, removeFromSidebar: true }), ["Show in Finder", "Connect This Folder", "—", "Remove from Sidebar"]);
  assert.deepEqual(labels({ createConnectedFolder: true, useExistingFolder: true }), ["New Connected Folder…", "Connect Folder…"]);
  assert.deepEqual(labels({ customize: true, settings: true, remove: true }), ["Customize Connected Folder", "—", "Disconnect…", "Settings…"]);
  // A managed folder is deleted to Recently Deleted, not disconnected.
  assert.deepEqual(labels({ remove: true, removeDeletes: true }), ["Delete Connected Folder…"]);
});
