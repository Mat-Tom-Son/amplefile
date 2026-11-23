import { fileSelectionLabel } from "./file-selection.js";

/**
 * The file manager's item menu (docs/product-model.md, "Finder's file
 * actions"): one list of items for both renderers, the native menu the Mac
 * desktop pops up (desktop/src/file-context-menu.ts) and the window's own
 * menu elsewhere, so both offer the same actions with the same words.
 */

export type FileMenuCommand =
  | "open"
  | "open-in-new-tab"
  | "open-in-new-window"
  | "open-with"
  | "reveal"
  | "show-original"
  | "copy-path"
  | "attach-chat"
  | "version-history"
  | "new-folder"
  | "upload-here"
  | "refresh"
  | "give-worker"
  | "rename"
  | "delete"
  | "copy"
  | "cut"
  | "paste"
  | "duplicate"
  | "compress"
  | "extract"
  | "new-folder-with-selection";

export interface FileMenuCapabilities {
  open: boolean;
  attach: boolean;
  history: boolean;
  upload: boolean;
  rename: boolean;
  delete: boolean;
  /** A plain folder inside this Connected Folder that can become its own Connected Folder. */
  worker?: boolean;
  /** Copy, Cut, Duplicate, Compress, and New Folder with Selection for items. */
  organize?: boolean;
  /** Paste Here on a folder. */
  paste?: boolean;
  /** Extract, on a `.zip`, `.tar`, `.tar.gz`, or `.tgz` archive. */
  extract?: boolean;
  /**
   * The row is a symbolic link: Open (when `open`) and Show Original (when
   * `original`) reach what it points to; everything else acts on the link
   * itself.
   */
  link?: boolean;
  /** Show Original, for a link whose target is there. */
  original?: boolean;
  /** Open in New Tab, for a folder in a window with folder tabs. */
  newTab?: boolean;
  /** Open in New Window, for a folder where the desktop can open another window. */
  newWindow?: boolean;
}

export interface FileMenuTarget {
  /** Set for an item in a Standard Folder or an other folder, where Delete is Move to Trash. */
  standardFolderId?: string;
  path: string;
  kind: "file" | "folder";
  capabilities: FileMenuCapabilities;
  /** Several rows selected together: only the actions that apply to all of them. */
  selection?: { files: number; folders: number };
}

export type FileMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; command: FileMenuCommand; icon?: "amplefile" };

const archiveName = /\.(?:zip|tar|tar\.gz|tgz)$/i;

/** Whether Extract is offered for a file, by its name. */
export function isExtractableArchive(name: string): boolean {
  return archiveName.test(name);
}

export function fileMenuItems(request: FileMenuTarget, platform: string = "darwin"): FileMenuItem[] {
  if (request.selection) return selectionMenuItems(request, request.selection);
  const items: FileMenuItem[] = [];
  const reveal: FileMenuItem = { type: "item", label: platform === "darwin" ? "Show in Finder" : platform === "win32" ? "Show in File Explorer" : "Show in File Manager", command: "reveal" };
  const name = request.path.slice(request.path.lastIndexOf("/") + 1);
  const deleteLabel = request.standardFolderId ? "Move to Trash" : `Delete ${request.capabilities.link ? "Link" : request.kind === "folder" ? "Folder" : "File"}`;
  if (request.capabilities.link) {
    // Open and Show Original reach what the link points to; the rest act on the link itself.
    if (request.capabilities.open) items.push({ type: "item", label: request.kind === "folder" ? "Open Folder" : "Open", command: "open" });
    if (request.capabilities.original) items.push({ type: "item", label: "Show Original", command: "show-original" });
    items.push(reveal, { type: "item", label: "Copy Link Path", command: "copy-path" });
    if (request.capabilities.organize && request.path) items.push({ type: "separator" }, ...organizeItems(`“${name}”`, false));
    if (request.path && (request.capabilities.rename || request.capabilities.delete)) {
      items.push({ type: "separator" });
      if (request.capabilities.rename) items.push({ type: "item", label: "Rename…", command: "rename" });
      if (request.capabilities.delete) items.push({ type: "item", label: deleteLabel, command: "delete" });
    }
    return items;
  }
  if (request.capabilities.open) {
    items.push({
      type: "item",
      label: request.kind === "folder" ? "Open Folder" : fileOpenLabel(request.path),
      command: "open",
    });
  }
  if (request.kind === "folder" && request.capabilities.newTab) items.push({ type: "item", label: "Open in New Tab", command: "open-in-new-tab" });
  if (request.kind === "folder" && request.capabilities.newWindow) items.push({ type: "item", label: "Open in New Window", command: "open-in-new-window" });
  if (request.kind === "file") items.push({ type: "item", label: "Open With", command: "open-with" });
  items.push(
    reveal,
    { type: "item", label: `Copy ${request.kind === "folder" ? "Folder" : "File"} Path`, command: "copy-path" },
  );
  if (request.capabilities.organize && request.path) {
    items.push({ type: "separator" }, ...organizeItems(`“${name}”`, false));
    if (request.kind === "file" && request.capabilities.extract) items.push({ type: "item", label: `Extract “${name}”`, command: "extract" });
  }
  if (request.kind === "file" && request.capabilities.attach) {
    items.push({ type: "item", label: "Attach to Chat", command: "attach-chat" });
  }
  if (request.kind === "file" && request.capabilities.history) {
    items.push({ type: "item", label: "Version History", command: "version-history" });
  }
  if (request.kind === "folder") {
    items.push(
      { type: "separator" },
      { type: "item", label: "New Folder Here…", command: "new-folder" },
    );
    if (request.capabilities.paste) items.push({ type: "item", label: "Paste Here", command: "paste" });
    if (request.capabilities.upload) items.push({ type: "item", label: "Add Files Here…", command: "upload-here" });
    // Files has no toolbar buttons: refreshing lives here with the other folder actions.
    items.push({ type: "item", label: "Refresh", command: "refresh" });
    if (request.capabilities.worker) {
      items.push({ type: "separator" }, { type: "item", label: "Connect This Folder", command: "give-worker", icon: "amplefile" });
    }
  }
  if (request.path && (request.capabilities.rename || request.capabilities.delete)) {
    items.push({ type: "separator" });
    if (request.capabilities.rename) items.push({ type: "item", label: "Rename…", command: "rename" });
    if (request.capabilities.delete) items.push({ type: "item", label: deleteLabel, command: "delete" });
  }
  return items;
}

function organizeItems(named: string, several: boolean): FileMenuItem[] {
  return [
    { type: "item", label: `Copy ${named}`, command: "copy" },
    { type: "item", label: `Cut ${named}`, command: "cut" },
    { type: "item", label: "Duplicate", command: "duplicate" },
    { type: "item", label: `Compress ${named}`, command: "compress" },
    ...(several ? [{ type: "item" as const, label: `New Folder with Selection (${named})`, command: "new-folder-with-selection" as const }] : []),
  ];
}

/** Several rows selected together: attach (files only), copy their paths, the Finder actions, delete them. */
function selectionMenuItems(request: FileMenuTarget, selection: { files: number; folders: number }): FileMenuItem[] {
  const items: FileMenuItem[] = [];
  if (request.capabilities.attach && selection.folders === 0) items.push({ type: "item", label: "Attach to Chat", command: "attach-chat" });
  items.push({ type: "item", label: "Copy Paths", command: "copy-path" });
  if (request.capabilities.organize) {
    const count = selection.files + selection.folders;
    items.push({ type: "separator" }, ...organizeItems(`${count} Items`, true));
  }
  if (request.capabilities.delete) {
    items.push({ type: "separator" }, { type: "item", label: request.standardFolderId ? "Move to Trash" : `Delete ${fileSelectionLabel(selection.files, selection.folders)}`, command: "delete" });
  }
  return items;
}

function fileOpenLabel(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot > path.lastIndexOf("/") ? path.slice(dot).toLocaleLowerCase() : "";
  if (extension === ".docx" || extension === ".dotx") return "Open in Word";
  if (extension === ".xlsx" || extension === ".csv") return "Open in Excel";
  if (extension === ".pptx" || extension === ".potx") return "Open in PowerPoint";
  return "Open";
}
