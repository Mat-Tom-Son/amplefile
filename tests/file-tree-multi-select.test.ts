import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React, { createElement } from "react";
import { registerHooks } from "node:module";
import test from "node:test";
import { createDomHarness } from "./support/dom.js";
import { fileSelectionLabel } from "../src/shared/file-selection.js";
import { nativeFileMenuItems, parseNativeFileMenuRequest } from "../desktop/src/file-context-menu.js";
import { draggedConnectedFolderPaths } from "../web-local/src/lib/file-actions.js";
import type { FileContextMenuState, TreeEntry } from "../web-local/src/types.js";

const assets = registerHooks({
  load(url, context, next) { return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context); },
});
const { FileContextMenu } = await import("../web-local/src/components/tree/FileContextMenu.js");
assets.deregister();

const file = (path: string): TreeEntry => ({ kind: "file", path, name: path.split("/").pop()! });
const folder = (path: string, children: TreeEntry[]): TreeEntry => ({ kind: "folder", path, name: path.split("/").pop()!, hasChildren: true, children });
const entries: TreeEntry[] = [
  folder("Notes", [file("Notes/a.md"), file("Notes/b.md")]),
  folder("Reports", [file("Reports/q3.xlsx")]),
  { kind: "folder", path: "Client", name: "Client", nestedFolder: true },
  file("readme.md"),
  file("todo.txt"),
];

test("the selection toggle key is Cmd on the Mac and Ctrl elsewhere", async () => {
  // Ctrl-click is a right-click on the Mac, so only Cmd toggles a row there.
  const fileManager = await readFile("web-local/src/components/file-manager/FileManagerView.tsx", "utf8");
  assert.match(fileManager, /const mac = isMacOS\(\);/);
  assert.match(fileManager, /function clickEntry\(entry: TreeEntry, event: MouseEvent<HTMLElement>\) \{[\s\S]*?const toggle = mac \? event\.metaKey : event\.ctrlKey;[\s\S]*?if \(toggle\) \{/);
});

test("selection labels name the kinds selected", () => {
  assert.equal(fileSelectionLabel(3, 0), "3 Files");
  assert.equal(fileSelectionLabel(0, 2), "2 Folders");
  assert.equal(fileSelectionLabel(2, 1), "3 Items");
});

test("a drag of several rows carries every path, and a one-row drag still reads as before", () => {
  const transfer = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? "" }) as unknown as DataTransfer;
  assert.deepEqual(draggedConnectedFolderPaths(transfer({
    "application/x-amplefile-connected-folder-path": "Notes/a.md",
    "application/x-amplefile-connected-folder-paths": JSON.stringify(["Notes/a.md", "readme.md"]),
  })), ["Notes/a.md", "readme.md"]);
  assert.deepEqual(draggedConnectedFolderPaths(transfer({ "application/x-amplefile-connected-folder-path": "Notes/a.md" })), ["Notes/a.md"]);
  assert.deepEqual(draggedConnectedFolderPaths(transfer({ "application/x-amplefile-connected-folder-paths": "not json", "text/plain": "readme.md" })), ["readme.md"]);
  assert.deepEqual(draggedConnectedFolderPaths(transfer({})), []);
});

test("the native Mac menu for several rows offers only what applies to all of them", () => {
  const base = {
    connectedFolderId: "connected-folder-1",
    path: "Notes/a.md",
    kind: "file",
    capabilities: { open: false, attach: true, history: false, upload: false, rename: false, delete: true },
    point: { x: 10, y: 20 },
  } as const;
  const files = parseNativeFileMenuRequest({ ...base, selection: { files: 3, folders: 0 } });
  assert.deepEqual(nativeFileMenuItems(files), [
    { type: "item", label: "Attach to Chat", command: "attach-chat" },
    { type: "item", label: "Copy Paths", command: "copy-path" },
    { type: "separator" },
    { type: "item", label: "Delete 3 Files", command: "delete" },
  ]);
  const mixed = parseNativeFileMenuRequest({ ...base, selection: { files: 2, folders: 1 } });
  assert.deepEqual(nativeFileMenuItems(mixed).map((item) => item.type === "item" ? item.label : "—"), ["Copy Paths", "—", "Delete 3 Items"], "folders cannot be attached");
  const guarded = parseNativeFileMenuRequest({ ...base, capabilities: { ...base.capabilities, delete: false }, selection: { files: 0, folders: 2 } });
  assert.deepEqual(nativeFileMenuItems(guarded).map((item) => item.type === "item" ? item.command : "—"), ["copy-path"], "a folder holding a nested Connected Folder keeps the selection undeletable");
  assert.equal(parseNativeFileMenuRequest(base).selection, undefined, "older renderers omit the selection");
  for (const selection of [{ files: 1, folders: 0 }, { files: -1, folders: 3 }, { files: 1.5, folders: 1 }, { files: 2, folders: 0, label: "x" }, "2"]) {
    assert.throws(() => parseNativeFileMenuRequest({ ...base, selection }), /selection is invalid/);
  }
});

test("the Files menu for several rows offers attach, copy, and delete for all of them", async (t) => {
  const scope = globalThis as unknown as { React?: typeof React };
  const previousReact = scope.React; scope.React = React;
  t.after(() => { if (previousReact) scope.React = previousReact; else delete scope.React; });
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const calls: Array<[string, string[]]> = [];
  const render = (selection: TreeEntry[], canDelete = true) => {
    const state: FileContextMenuState = { entry: selection[0]!, selection, x: 0, y: 0 };
    return dom.render(createElement(FileContextMenu, {
      state, canDelete, fixtureMode: true,
      onSelect() {}, onOpenLocal() {}, onAddToChatContext() {}, onCopyPath() {}, onShowVersionHistory() {}, onDelete() {}, onClose() {},
      onRename: () => calls.push(["rename", []]),
      onAttachSelection: (paths: string[]) => calls.push(["attach", paths]),
      onCopyPaths: (paths: string[]) => calls.push(["copy", paths]),
      onDeleteSelection: (paths: string[]) => calls.push(["delete", paths]),
    }));
  };
  const labels = () => [...dom.container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

  await render([file("Notes/a.md"), file("readme.md")]);
  assert.deepEqual(labels(), ["Attach to Chat", "Copy Paths", "Delete 2 Files"]);
  await dom.act(() => { (dom.container.querySelector('[role="menuitem"]') as HTMLButtonElement).click(); });
  assert.deepEqual(calls, [["attach", ["Notes/a.md", "readme.md"]]]);

  await render([entries[0]!, file("readme.md")]);
  assert.deepEqual(labels(), ["Copy Paths", "Delete 2 Items"], "a folder in the selection leaves out Attach to Chat; Rename never shows");
  await dom.act(() => { (dom.container.querySelector(".context-menu .danger") as HTMLButtonElement).click(); });
  assert.deepEqual(calls.at(-1), ["delete", ["Notes", "readme.md"]]);

  await render([entries[0]!, entries[1]!], false);
  assert.deepEqual(labels(), ["Copy Paths"], "a folder holding a nested Connected Folder keeps the selection undeletable");
});
