import assert from "node:assert/strict";
import test from "node:test";

import { nativeFileMenuItems, parseNativeFileMenuRequest } from "../desktop/src/file-context-menu.js";

const fileRequest = {
  connectedFolderId: "connected-folder-1",
  path: "Reports/Q3.xlsx",
  kind: "file",
  capabilities: { open: true, attach: true, history: true, upload: false, rename: true, delete: true },
  point: { x: 23.6, y: 42.2 },
} as const;

test("native file menus use host-owned labels and a bounded command set", () => {
  const request = parseNativeFileMenuRequest(fileRequest);
  assert.deepEqual(request.point, { x: 24, y: 42 });
  assert.deepEqual(nativeFileMenuItems(request), [
    { type: "item", label: "Open in Excel", command: "open" },
    { type: "item", label: "Open With", command: "open-with" },
    { type: "item", label: "Show in Finder", command: "reveal" },
    { type: "item", label: "Copy File Path", command: "copy-path" },
    { type: "item", label: "Get Info", command: "get-info" },
    { type: "item", label: "Attach to Chat", command: "attach-chat" },
    { type: "item", label: "Version History", command: "version-history" },
    { type: "separator" },
    { type: "item", label: "Rename…", command: "rename" },
    { type: "item", label: "Delete File", command: "delete" },
  ]);
});

test("native folder menus expose only applicable fixed actions", () => {
  const request = parseNativeFileMenuRequest({
    ...fileRequest,
    path: "Notes",
    kind: "folder",
    capabilities: { open: true, attach: true, history: true, upload: true, rename: false, delete: false },
  });
  assert.deepEqual(nativeFileMenuItems(request).map((item) => item.type === "separator" ? "separator" : item.command), [
    "open", "reveal", "copy-path", "get-info", "separator", "new-folder", "upload-here", "refresh",
  ]);
  const promotable = parseNativeFileMenuRequest({ ...request, capabilities: { ...request.capabilities, worker: true } });
  assert.deepEqual(nativeFileMenuItems(promotable).slice(-2).map((item) => item.type === "separator" ? "separator" : item.label), ["separator", "Connect This Folder"]);
  assert.throws(() => parseNativeFileMenuRequest({ ...request, capabilities: { ...request.capabilities, worker: "yes" } }), /capabilities are invalid/);
  const root = parseNativeFileMenuRequest({ ...request, path: "", capabilities: { ...request.capabilities, upload: false } });
  assert.ok(nativeFileMenuItems(root).some((item) => item.type === "item" && item.command === "new-folder"));
});

test("native file menu requests reject unbounded or path-escaping renderer input", () => {
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, label: "Run arbitrary command" }), /invalid/i);
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, path: "../outside.txt" }), /safe relative/i);
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, path: "/tmp/outside.txt" }), /safe relative/i);
  const { path: _path, ...missingPath } = fileRequest;
  assert.throws(() => parseNativeFileMenuRequest(missingPath), /safe relative/i);
  assert.throws(() => parseNativeFileMenuRequest({
    ...fileRequest,
    capabilities: { ...fileRequest.capabilities, callback: "evil" },
  }), /capabilities/i);
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, path: "", kind: "file" }), /root must be a folder/i);
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, point: { x: Number.NaN, y: 10 } }), /position/i);
});

test("a link's menu reaches its target with Open and Show Original, and acts on the link itself otherwise", () => {
  const request = parseNativeFileMenuRequest({ ...fileRequest, capabilities: { ...fileRequest.capabilities, organize: true, link: true, original: true } });
  assert.equal(request.capabilities.link, true);
  assert.deepEqual(nativeFileMenuItems(request), [
    { type: "item", label: "Open", command: "open" },
    { type: "item", label: "Show Original", command: "show-original" },
    { type: "item", label: "Show in Finder", command: "reveal" },
    { type: "item", label: "Copy Link Path", command: "copy-path" },
    { type: "item", label: "Get Info", command: "get-info" },
    { type: "separator" },
    { type: "item", label: "Copy “Q3.xlsx”", command: "copy" },
    { type: "item", label: "Cut “Q3.xlsx”", command: "cut" },
    { type: "item", label: "Duplicate", command: "duplicate" },
    { type: "item", label: "Compress “Q3.xlsx”", command: "compress" },
    { type: "separator" },
    { type: "item", label: "Rename…", command: "rename" },
    { type: "item", label: "Delete Link", command: "delete" },
  ]);
  // A broken link has nothing to open or show; in a Standard Folder it goes to the Trash.
  const broken = parseNativeFileMenuRequest({ ...fileRequest, connectedFolderId: undefined, standardFolderId: "downloads", kind: "folder", capabilities: { ...fileRequest.capabilities, open: false, organize: true, link: true } });
  assert.deepEqual(nativeFileMenuItems(broken, "linux").map((item) => item.type === "item" ? item.command : "separator"), ["copy-path", "get-info", "separator", "copy", "cut", "duplicate", "compress", "separator", "rename", "delete"]);
  assert.equal(nativeFileMenuItems(broken, "linux").at(-1)?.type === "item" && (nativeFileMenuItems(broken, "linux").at(-1) as { label: string }).label, "Move to Trash");
  assert.throws(() => parseNativeFileMenuRequest({ ...fileRequest, capabilities: { ...fileRequest.capabilities, link: "yes" } }), /capabilities/);
});

test("an archive offers Extract beside Compress, and Cut sits beside Copy", () => {
  const archive = parseNativeFileMenuRequest({ ...fileRequest, path: "Downloads/photos.tar.gz", capabilities: { ...fileRequest.capabilities, organize: true, extract: true } });
  assert.deepEqual(nativeFileMenuItems(archive).filter((item) => item.type === "item").map((item) => item.type === "item" ? item.command : ""), [
    "open", "open-with", "reveal", "copy-path", "get-info", "copy", "cut", "duplicate", "compress", "extract", "attach-chat", "version-history", "rename", "delete",
  ]);
  assert.ok(nativeFileMenuItems(archive).some((item) => item.type === "item" && item.label === "Extract “photos.tar.gz”"));
  const several = parseNativeFileMenuRequest({ ...fileRequest, capabilities: { ...fileRequest.capabilities, organize: true }, selection: { files: 2, folders: 1 } });
  assert.ok(nativeFileMenuItems(several).some((item) => item.type === "item" && item.command === "cut" && item.label === "Cut 3 Items"));
});
