import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The file manager window's source: FileManagerView.tsx and the parts it was
 * split into (navigation, selection, file changes, the clipboard, drops,
 * menus, the sidebar, folder tabs, and per-folder views), read as one text for
 * tests that check how the window is written.
 */
export const fileManagerWindowFiles = [
  "FileManagerView.tsx",
  "FileManagerSidebar.tsx",
  "FileManagerMenus.tsx",
  "FileManagerPanelParts.tsx",
  "useFileManagerNavigation.ts",
  "useFileSelection.ts",
  "useFileChanges.ts",
  "useFileClipboard.ts",
  "useFileDrops.ts",
  "useFileManagerMenus.ts",
  "file-manager-navigation.ts",
  "file-manager-drops.ts",
  "file-manager-menus.ts",
  "file-manager-undo.ts",
  "file-manager-view-helpers.ts",
  "file-manager-fixture-places.ts",
] as const;

export async function readFileManagerWindowSource(root = process.cwd()): Promise<string> {
  const sources = await Promise.all(fileManagerWindowFiles.map((name) => readFile(join(root, "web-local/src/components/file-manager", name), "utf8")));
  return sources.join("\n");
}
