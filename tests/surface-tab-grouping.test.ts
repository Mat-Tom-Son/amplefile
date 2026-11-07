import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { ConnectedFolderSurfaceTab } from "../web-local/src/types";

const tabBarModuleUrl = pathToFileURL(join(process.cwd(), "web-local/src/lib/surface-tab-groups.ts")).href;
const { groupSurfaceTabsByConnectedFolder } = await import(tabBarModuleUrl) as {
  groupSurfaceTabsByConnectedFolder: (
    tabs: ConnectedFolderSurfaceTab[],
  ) => Array<{ connectedFolderId: string | null; tabs: ConnectedFolderSurfaceTab[] }>;
};

test("optional tab grouping keeps both Connected Folder and tab order stable", () => {
  const tabs: ConnectedFolderSurfaceTab[] = [
    chatTab("connected-folder-1", "one", "First"),
    chatTab("connected-folder-2", "two", "Second"),
    chatTab("connected-folder-1", "three", "Third"),
    chatTab("connected-folder-2", "four", "Fourth"),
  ];

  const groups = groupSurfaceTabsByConnectedFolder(tabs);

  assert.deepEqual(groups.map((group) => group.connectedFolderId), ["connected-folder-1", "connected-folder-2"]);
  assert.deepEqual(groups[0]?.tabs.map((tab) => tab.title), ["First", "Third"]);
  assert.deepEqual(groups[1]?.tabs.map((tab) => tab.title), ["Second", "Fourth"]);
});

test("browser tabs belong to no Connected Folder and group together", () => {
  const tabs: ConnectedFolderSurfaceTab[] = [
    browserTab("abc123", "Docs"),
    chatTab("connected-folder-1", "one", "First"),
    browserTab("def456", "News"),
  ];

  const groups = groupSurfaceTabsByConnectedFolder(tabs);

  assert.deepEqual(groups.map((group) => group.connectedFolderId), [null, "connected-folder-1"]);
  assert.deepEqual(groups[0]?.tabs.map((tab) => tab.title), ["Docs", "News"]);
});

function browserTab(pageId: string, title: string): ConnectedFolderSurfaceTab {
  return { id: `browser:${pageId}`, kind: "browser", connectedFolderId: null, pageId, url: `https://${title.toLowerCase()}.example/`, title };
}

function chatTab(connectedFolderId: string, conversationId: string, title: string): ConnectedFolderSurfaceTab {
  return {
    id: `chat:${connectedFolderId}:${conversationId}`,
    kind: "chat",
    connectedFolderId,
    conversationId,
    title,
  };
}
