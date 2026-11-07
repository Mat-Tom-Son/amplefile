import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const surfaceTabsModuleUrl = pathToFileURL(join(process.cwd(), "web-local/src/hooks/useSurfaceTabs.ts")).href;
const {
  activeTabAfterConversationActivation,
  appStudioSurfaceTab,
  checksSurfaceTab,
  closeFileSurfaceTabs,
  closeUnavailableRestrictedAppSurfaceTabs,
  fileSurfaceTab,
  normalizeStoredSurfaceTabsValue,
  recordActiveSurfaceTabConnectedFolderRecency,
  readStoredSurfaceTabsState,
  restoreStoredSurfaceTabsForConnectedFolders,
  retargetFileSurfaceTabs,
  reorderSurfaceTabList,
  restrictedAppSurfaceTabId,
  spaceAutomationsSurfaceTab,
  connectedFolderAutomationSurfaceTab,
  surfaceTabActivationForConnectedFolder,
  surfaceTabConnectedFolderSwitchTarget,
  upsertSurfaceTab,
  useSurfaceTabs,
} = await import(surfaceTabsModuleUrl) as SurfaceTabsExports;

interface ConnectedFolderSummary {
  id: string;
  name: string;
  connectedFolderRoot: string;
  location: { kind: "local"; storage: "managed" | "linked" };
  createdAt: string;
  updatedAt: string;
}

interface SurfaceTab {
  id: string;
  kind: "chat" | "file" | "history" | "app-studio" | "checks" | "connected-folder-automations" | "connected-folder-automation" | "extension" | "restricted-app";
  connectedFolderId: string;
  conversationId?: string | null;
  path?: string;
  checkpointId?: string;
  automationId?: string;
  surfaceId?: string;
  surfaceExecution?: "full-trust-pi";
  viewId?: string;
  view?: "installed" | "discover";
  appId?: string;
  digest?: string;
  appTabId?: string;
  route?: string;
  state?: unknown;
  title: string;
}

interface SurfaceTabsExports {
  activeTabAfterConversationActivation: (currentActiveTabId: string | null, sourceTabId: string, duplicateTabId: string) => string | null;
  appStudioSurfaceTab: (connectedFolder: ConnectedFolderSummary) => SurfaceTab;
  checksSurfaceTab: (connectedFolder: ConnectedFolderSummary) => SurfaceTab;
  spaceAutomationsSurfaceTab: (connectedFolder: ConnectedFolderSummary) => SurfaceTab;
  connectedFolderAutomationSurfaceTab: (connectedFolder: ConnectedFolderSummary, automation: { automationId: string; title: string }) => SurfaceTab;
  closeFileSurfaceTabs: (tabs: SurfaceTab[], connectedFolderId: string, deletedPaths: Set<string>) => SurfaceTab[];
  closeUnavailableRestrictedAppSurfaceTabs: (
    tabs: SurfaceTab[],
    appsByConnectedFolder: Record<string, Array<{ manifest: { id: string }; digest: string }>>,
    knownConnectedFolderIds: ReadonlySet<string>,
  ) => SurfaceTab[];
  fileSurfaceTab: (connectedFolder: ConnectedFolderSummary, path: string) => SurfaceTab;
  normalizeStoredSurfaceTabsValue: (parsed: unknown) => { tabs: SurfaceTab[]; activeTabId: string | null };
  recordActiveSurfaceTabConnectedFolderRecency: (recent: Map<string, string>, tabs: SurfaceTab[], activeTabId: string | null) => void;
  readStoredSurfaceTabsState: (connectedFolder: ConnectedFolderSummary, connectedFolders: ConnectedFolderSummary[]) => { tabs: SurfaceTab[]; activeTabId: string | null };
  restoreStoredSurfaceTabsForConnectedFolders: (
    state: { tabs: SurfaceTab[]; activeTabId: string | null },
    connectedFolders: ConnectedFolderSummary[],
  ) => { tabs: SurfaceTab[]; activeTabId: string | null };
  retargetFileSurfaceTabs: (tabs: SurfaceTab[], connectedFolderId: string, sourcePath: string, movedPath: string) => SurfaceTab[];
  reorderSurfaceTabList: (tabs: SurfaceTab[], ids: string[]) => SurfaceTab[];
  restrictedAppSurfaceTabId: (connectedFolderId: string, appId: string, digest: string, appTabId: string) => string;
  surfaceTabActivationForConnectedFolder: (input: {
    activeTabId: string | null;
    recentTabIdsByConnectedFolder: Map<string, string>;
    tabs: SurfaceTab[];
    connectedFolder: ConnectedFolderSummary;
  }) => { tabId: string; tabToAdd?: SurfaceTab } | null;
  surfaceTabConnectedFolderSwitchTarget: (input: {
    activeTabId: string | null;
    activeConnectedFolderId: string;
    tabs: SurfaceTab[];
    connectedFolders: ConnectedFolderSummary[];
  }) => ConnectedFolderSummary | null;
  upsertSurfaceTab: (tabs: SurfaceTab[], tab: SurfaceTab) => SurfaceTab[];
  useSurfaceTabs: (input: { connectedFolder: ConnectedFolderSummary; connectedFolders: ConnectedFolderSummary[] }) => { surfaceTabs: SurfaceTab[]; activeSurfaceTabId: string | null; reorderSurfaceTabs: (ids: string[]) => void; setActiveSurfaceTabId: (id: string) => void };
}

const connectedFolder: ConnectedFolderSummary = {
  id: "connected-folder-1",
  name: "First Connected Folder",
  connectedFolderRoot: "C:/connected-folders/First",
  location: { kind: "local", storage: "linked" },
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

const otherConnectedFolder: ConnectedFolderSummary = {
  ...connectedFolder,
  id: "connected-folder-2",
  name: "Other Connected Folder",
  connectedFolderRoot: "C:/connected-folders/Other",
};

test("reordering preserves tab identities, active restoration, and tabs added during the gesture", () => {
  const tabs = [fileSurfaceTab(connectedFolder, "draft.md"), fileSurfaceTab(otherConnectedFolder, "budget.csv"), checksSurfaceTab(connectedFolder)];
  const next = reorderSurfaceTabList(tabs, [tabs[2]!.id, "closed-tab", tabs[0]!.id, tabs[2]!.id]);
  assert.deepEqual(next, [tabs[2], tabs[1], tabs[0]]);
  assert.equal(next[0], tabs[2]); assert.equal(next[1], tabs[1]);
  assert.deepEqual(normalizeStoredSurfaceTabsValue({ tabs: next, activeTabId: tabs[0]!.id }), { tabs: next, activeTabId: tabs[0]!.id });
  assert.equal(reorderSurfaceTabList(next, next.map((tab) => tab.id)), next);
});

test("each file opens its own tab, and opening an open file selects its tab", () => {
  const first = fileSurfaceTab(connectedFolder, "Notes/Draft.md");
  const second = fileSurfaceTab(connectedFolder, "Notes/Final.md");
  const tabs = upsertSurfaceTab(upsertSurfaceTab(upsertSurfaceTab([], first), second), fileSurfaceTab(connectedFolder, "Notes/Draft.md"));

  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs.map((tab) => tab.id), ["file:connected-folder-1:Notes/Draft.md", "file:connected-folder-1:Notes/Final.md"]);
  assert.deepEqual(tabs[1], {
    id: "file:connected-folder-1:Notes/Final.md",
    kind: "file",
    connectedFolderId: "connected-folder-1",
    path: "Notes/Final.md",
    title: "Final.md",
  });
});

test("file tabs follow moved paths and close when their file is deleted", () => {
  const tabs: SurfaceTab[] = [
    fileSurfaceTab(connectedFolder, "Notes/Draft.md"),
    { id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" },
  ];
  const moved = retargetFileSurfaceTabs(tabs, connectedFolder.id, "Notes", "Archive/Notes");

  assert.equal(moved[0]?.path, "Archive/Notes/Draft.md");
  assert.equal(moved[0]?.title, "Draft.md");
  assert.equal(moved[0]?.id, "file:connected-folder-1:Archive/Notes/Draft.md", "a tab's id follows its file");
  // A moved file landing on a path already open in another tab leaves one tab for it.
  const merged = retargetFileSurfaceTabs([fileSurfaceTab(connectedFolder, "a.md"), fileSurfaceTab(connectedFolder, "b.md")], connectedFolder.id, "a.md", "b.md");
  assert.deepEqual(merged.map((tab) => tab.id), ["file:connected-folder-1:b.md"]);
  assert.deepEqual(
    closeFileSurfaceTabs(moved, connectedFolder.id, new Set(["Archive/Notes/Draft.md"])).map((tab) => tab.id),
    ["chat:connected-folder-1:new"],
  );
});

test("Checks use one canonical Connected Folder–owned work tab", () => {
  assert.deepEqual(checksSurfaceTab(connectedFolder), {
    id: "checks:connected-folder-1",
    kind: "checks",
    connectedFolderId: "connected-folder-1",
    title: "Checks",
  });
});

test("Automations use one canonical Connected Folder–owned tab", () => {
  // docs/automations.md, F15 as amended 2026-09-24.
  assert.deepEqual(spaceAutomationsSurfaceTab(connectedFolder), {
    id: "connected-folder-automations:connected-folder-1",
    kind: "connected-folder-automations",
    connectedFolderId: "connected-folder-1",
    title: "Automations",
  });
});

test("each automation opened from the left pane gets its own canonical tab", () => {
  assert.deepEqual(connectedFolderAutomationSurfaceTab(connectedFolder, { automationId: "sort-screenshots", title: "Sort screenshots" }), {
    id: "connected-folder-automation:connected-folder-1:sort-screenshots",
    kind: "connected-folder-automation",
    connectedFolderId: "connected-folder-1",
    automationId: "sort-screenshots",
    title: "Sort screenshots",
  });
});

test("tab restore falls back cleanly when persisted JSON is corrupt", () => {
  withStoredTabs("{not valid json", () => {
    assert.deepEqual(readStoredSurfaceTabsState(connectedFolder, [connectedFolder]), {
      tabs: [{ id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" }],
      activeTabId: "chat:connected-folder-1:new",
    });
  });
});

test("tab restore accepts only known, well-formed surface types", () => {
  assert.deepEqual(normalizeStoredSurfaceTabsValue({
    tabs: [
      { id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat", extra: true },
      { id: "mystery:connected-folder-1", kind: "mystery", connectedFolderId: "connected-folder-1", title: "Mystery" },
      { id: 4, kind: "file", connectedFolderId: "connected-folder-1", path: "Notes.md", title: "Notes.md" },
      { id: "file:connected-folder-1", kind: "file", connectedFolderId: "connected-folder-1", path: "Notes.md", title: "Notes.md", ignored: "yes" },
      { id: "history:connected-folder-1", kind: "history", connectedFolderId: "connected-folder-1", title: "History" },
      { id: "spoofed-library", kind: "library", connectedFolderId: "connected-folder-1", title: "Renamed Library" },
      { id: "spoofed-studio", kind: "app-studio", connectedFolderId: "connected-folder-1", title: "Renamed Studio" },
      { id: "spoofed-tools", kind: "assistant-tools", connectedFolderId: "connected-folder-1", view: "discover", title: "Renamed Tools" },
      { id: "broken-tools", kind: "assistant-tools", connectedFolderId: "connected-folder-1", view: "packages", title: "Broken Tools" },
      { id: "spoofed-checks", kind: "checks", connectedFolderId: "connected-folder-1", title: "All files are healthy" },
      { id: "spoofed-automations", kind: "connected-folder-automations", connectedFolderId: "connected-folder-1", title: "Everything is on" },
      { id: "spoofed-automation", kind: "connected-folder-automation", connectedFolderId: "connected-folder-1", automationId: "sort-screenshots", title: "Sort screenshots" },
      { id: "broken-automation", kind: "connected-folder-automation", connectedFolderId: "connected-folder-1", title: "No id" },
      { id: "extension:connected-folder-1:inbox:overview", kind: "extension", connectedFolderId: "connected-folder-1", surfaceId: "inbox", viewId: "overview", title: "Overview", ignored: true },
      { id: "restricted:bad", kind: "restricted-app", featureInstallationId: "feature-installation_original", connectedFolderId: "connected-folder-1", appId: "mail", digest: "bad", appTabId: "message:release", route: "/message/release", title: "Bad app tab" },
      { id: "app-controlled-spoof", kind: "restricted-app", featureInstallationId: "feature-installation_original", connectedFolderId: "connected-folder-1", appId: "mail", digest: "a".repeat(64), appTabId: "message:release", route: "/message/release", state: { selected: true }, title: "Release checklist" },
      { id: "extension:connected-folder-1:broken", kind: "extension", connectedFolderId: "connected-folder-1", surfaceId: "inbox", title: "Broken" },
    ],
    activeTabId: "file:connected-folder-1",
  }), {
    tabs: [
      { id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" },
      { id: "file:connected-folder-1:Notes.md", kind: "file", connectedFolderId: "connected-folder-1", path: "Notes.md", title: "Notes.md" },
      { id: "history:connected-folder-1", kind: "history", connectedFolderId: "connected-folder-1", checkpointId: undefined, title: "History" },
      { id: "app-studio:connected-folder-1", kind: "app-studio", connectedFolderId: "connected-folder-1", title: "Renamed Studio" },
      { id: "checks:connected-folder-1", kind: "checks", connectedFolderId: "connected-folder-1", title: "Checks" },
      { id: "connected-folder-automations:connected-folder-1", kind: "connected-folder-automations", connectedFolderId: "connected-folder-1", title: "Automations" },
      { id: "connected-folder-automation:connected-folder-1:sort-screenshots", kind: "connected-folder-automation", connectedFolderId: "connected-folder-1", automationId: "sort-screenshots", title: "Sort screenshots" },
      { id: "extension:connected-folder-1:inbox:overview", kind: "extension", connectedFolderId: "connected-folder-1", surfaceId: "inbox", surfaceExecution: "full-trust-pi", viewId: "overview", title: "Overview" },
      { id: restrictedAppSurfaceTabId("connected-folder-1", "mail", "a".repeat(64), "message:release", "feature-installation_original"), kind: "restricted-app", featureInstallationId: "feature-installation_original", connectedFolderId: "connected-folder-1", appId: "mail", digest: "a".repeat(64), appTabId: "message:release", route: "/message/release", state: { selected: true }, title: "Release checklist" },
    ],
    activeTabId: "file:connected-folder-1:Notes.md",
  });
});

test("restored tabs belonging to removed Connected Folders are discarded", () => {
  assert.deepEqual(restoreStoredSurfaceTabsForConnectedFolders({
    tabs: [
      { id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" },
      { id: "history:connected-folder-2", kind: "history", connectedFolderId: "connected-folder-2", title: "History" },
    ],
    activeTabId: "history:connected-folder-2",
  }, [connectedFolder]), {
    tabs: [{ id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" }],
    activeTabId: "chat:connected-folder-1:new",
  });
});

test("a registry read that removes nothing keeps the same tab list", () => {
  // Each window focus re-reads the registry; an unchanged list must not re-render or re-save the tabs.
  const tabs: SurfaceTab[] = [
    { id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" },
    { id: "history:connected-folder-2", kind: "history", connectedFolderId: "connected-folder-2", title: "History" },
  ];
  assert.equal(restoreStoredSurfaceTabsForConnectedFolders({ tabs, activeTabId: tabs[0].id }, [{ ...connectedFolder }, { ...otherConnectedFolder }]).tabs, tabs);
});

test("retired Customize tabs are discarded without losing other tabs or leaving a blank active tab", () => {
  assert.deepEqual(normalizeStoredSurfaceTabsValue({
    tabs: [
      { id: "appearance:connected-folder-1", kind: "appearance", connectedFolderId: "connected-folder-1", title: "Customize Old name" },
      { id: "chat:connected-folder-1:keep", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: "keep", title: "Keep my Chat" },
    ],
    activeTabId: "appearance:connected-folder-1",
  }), {
    tabs: [
      { id: "chat:connected-folder-1:keep", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: "keep", title: "Keep my Chat" },
    ],
    activeTabId: "chat:connected-folder-1:keep",
  });
  withStoredTabs(JSON.stringify({ tabs: [{ id: "appearance:connected-folder-1", kind: "appearance", connectedFolderId: "connected-folder-1", title: "Customize" }], activeTabId: "appearance:connected-folder-1" }), () => {
    assert.deepEqual(readStoredSurfaceTabsState(connectedFolder, [connectedFolder]), {
      tabs: [{ id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" }],
      activeTabId: "chat:connected-folder-1:new",
    });
  });
});

test("restricted app tabs close when their installed revision changes", () => {
  const currentDigest = "a".repeat(64);
  const staleDigest = "b".repeat(64);
  const tabs: SurfaceTab[] = [
    { id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" },
    {
      id: restrictedAppSurfaceTabId("connected-folder-1", "trip-studio", staleDigest, "destination:lisbon", "feature-installation_original"),
      kind: "restricted-app", featureInstallationId: "feature-installation_original",
      connectedFolderId: "connected-folder-1",
      appId: "trip-studio",
      digest: staleDigest,
      appTabId: "destination:lisbon",
      route: "/destination/lisbon",
      title: "Lisbon pulse",
    },
    {
      id: restrictedAppSurfaceTabId("connected-folder-1", "trip-studio", currentDigest, "destination:copenhagen", "feature-installation_original"),
      kind: "restricted-app", featureInstallationId: "feature-installation_original",
      connectedFolderId: "connected-folder-1",
      appId: "trip-studio",
      digest: currentDigest,
      appTabId: "destination:copenhagen",
      route: "/destination/copenhagen",
      title: "Copenhagen pulse",
    },
    {
      id: restrictedAppSurfaceTabId("connected-folder-2", "unknown", staleDigest, "overview", "feature-installation_original"),
      kind: "restricted-app", featureInstallationId: "feature-installation_original",
      connectedFolderId: "connected-folder-2",
      appId: "unknown",
      digest: staleDigest,
      appTabId: "overview",
      route: "/",
      title: "Still loading",
    },
  ];

  assert.deepEqual(closeUnavailableRestrictedAppSurfaceTabs(tabs, {
    "connected-folder-1": [{ manifest: { id: "trip-studio" }, digest: currentDigest, featureInstallationId: "feature-installation_original" }],
  }, new Set(["connected-folder-1"])), [tabs[0], tabs[2], tabs[3]]);
  assert.equal(closeUnavailableRestrictedAppSurfaceTabs(tabs, {}, new Set()), tabs);
});

test("each Connected Folder remembers its most recently active tab", () => {
  const recent = new Map<string, string>([["connected-folder-1", "chat:connected-folder-1:old"]]);
  const tabs: SurfaceTab[] = [
    { id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" },
    { id: "history:connected-folder-2", kind: "history", connectedFolderId: "connected-folder-2", title: "History" },
  ];

  recordActiveSurfaceTabConnectedFolderRecency(recent, tabs, "history:connected-folder-2");
  recordActiveSurfaceTabConnectedFolderRecency(recent, tabs, "missing-tab");

  assert.equal(recent.get("connected-folder-1"), "chat:connected-folder-1:old");
  assert.equal(recent.get("connected-folder-2"), "history:connected-folder-2");
});

test("activating a draft conversation never steals focus from another surface", () => {
  assert.equal(
    activeTabAfterConversationActivation("library:connected-folder-1", "chat:connected-folder-1:new", "chat:connected-folder-1:existing"),
    "library:connected-folder-1",
  );
  assert.equal(
    activeTabAfterConversationActivation("chat:connected-folder-1:new", "chat:connected-folder-1:new", "chat:connected-folder-1:existing"),
    "chat:connected-folder-1:existing",
  );
  assert.equal(
    activeTabAfterConversationActivation(null, "chat:connected-folder-1:new", "chat:connected-folder-1:existing"),
    null,
  );
});

test("activating a cross-connected-folder tab switches to the tab's Connected Folder", () => {
  const tabs: SurfaceTab[] = [
    { id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" },
    appStudioSurfaceTab(otherConnectedFolder),
  ];

  assert.equal(surfaceTabConnectedFolderSwitchTarget({
    activeTabId: "chat:connected-folder-1:new",
    activeConnectedFolderId: "connected-folder-1",
    tabs,
    connectedFolders: [connectedFolder, otherConnectedFolder],
  }), null);
  assert.deepEqual(surfaceTabConnectedFolderSwitchTarget({
    activeTabId: "app-studio:connected-folder-2",
    activeConnectedFolderId: "connected-folder-1",
    tabs,
    connectedFolders: [connectedFolder, otherConnectedFolder],
  }), otherConnectedFolder);
});

test("App Studio uses one canonical persistent tab per Connected Folder", () => {
  const first = appStudioSurfaceTab(connectedFolder);
  const second = appStudioSurfaceTab({ ...connectedFolder, name: "Renamed Connected Folder" });

  assert.deepEqual(first, {
    id: "app-studio:connected-folder-1",
    kind: "app-studio",
    connectedFolderId: "connected-folder-1",
    title: "App Studio",
  });
  assert.deepEqual(upsertSurfaceTab(upsertSurfaceTab([], first), second), [second]);
});

test("switching Connected Folders activates the recent tab, then draft, then creates a draft", () => {
  const tabs: SurfaceTab[] = [
    { id: "chat:connected-folder-1:new", kind: "chat", connectedFolderId: "connected-folder-1", conversationId: null, title: "New Chat" },
    { id: "history:connected-folder-2", kind: "history", connectedFolderId: "connected-folder-2", title: "History" },
    { id: "chat:connected-folder-2:new", kind: "chat", connectedFolderId: "connected-folder-2", conversationId: null, title: "New Chat" },
  ];

  assert.deepEqual(surfaceTabActivationForConnectedFolder({
    activeTabId: "chat:connected-folder-1:new",
    recentTabIdsByConnectedFolder: new Map([["connected-folder-2", "history:connected-folder-2"]]),
    tabs,
    connectedFolder: otherConnectedFolder,
  }), { tabId: "history:connected-folder-2" });

  assert.deepEqual(surfaceTabActivationForConnectedFolder({
    activeTabId: "chat:connected-folder-1:new",
    recentTabIdsByConnectedFolder: new Map([["connected-folder-2", "missing-tab"]]),
    tabs,
    connectedFolder: otherConnectedFolder,
  }), { tabId: "chat:connected-folder-2:new" });

  const thirdConnectedFolder = { ...connectedFolder, id: "connected-folder-3", name: "Third Connected Folder", connectedFolderRoot: "C:/connected-folders/Third" };
  assert.deepEqual(surfaceTabActivationForConnectedFolder({
    activeTabId: "chat:connected-folder-1:new",
    recentTabIdsByConnectedFolder: new Map(),
    tabs,
    connectedFolder: thirdConnectedFolder,
  }), {
    tabId: "chat:connected-folder-3:new",
    tabToAdd: { id: "chat:connected-folder-3:new", kind: "chat", connectedFolderId: "connected-folder-3", conversationId: null, title: "New Chat" },
  });
});

function withStoredTabs(value: string, run: () => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => key === "amplefile.connected-folder.surface-tabs.v1" ? value : null,
        removeItem: () => undefined,
        setItem: () => undefined,
      },
    },
  });
  try {
    run();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
}

test("identical app revisions keep separate installation tabs and a reinstall cannot inherit an old tab", () => {
  const digest = "a".repeat(64);
  const original = { id: restrictedAppSurfaceTabId("connected-folder-1", "mail", digest, "inbox", "feature-installation_original"),
    kind: "restricted-app" as const, connectedFolderId: "connected-folder-1", appId: "mail", digest, featureInstallationId: "feature-installation_original",
    appTabId: "inbox", route: "/", title: "Inbox" };
  const sibling = { ...original, featureInstallationId: "feature-installation_sibling",
    id: restrictedAppSurfaceTabId("connected-folder-1", "mail", digest, "inbox", "feature-installation_sibling") };
  assert.notEqual(original.id, sibling.id);
  const catalogue = (ids: string[]) => ({ "connected-folder-1": ids.map((featureInstallationId) => ({ manifest: { id: "mail" }, digest, featureInstallationId })) });
  assert.deepEqual(closeUnavailableRestrictedAppSurfaceTabs([original, sibling], catalogue([original.featureInstallationId, sibling.featureInstallationId]), new Set(["connected-folder-1"])), [original, sibling]);
  assert.deepEqual(closeUnavailableRestrictedAppSurfaceTabs([original, sibling], catalogue(["feature-installation_reinstalled", sibling.featureInstallationId]), new Set(["connected-folder-1"])), [sibling]);
  const { featureInstallationId: _identity, ...unpinned } = original;
  assert.deepEqual(normalizeStoredSurfaceTabsValue({ tabs: [unpinned], activeTabId: original.id }).tabs, [], "old unpinned tabs cannot attach to whichever installation is present");
});

test("the tab strip tightens early, fades its overflowing edges, and lists every open tab in its menu", async (t) => {
  const { createRequire, registerHooks } = await import("node:module");
  const { createElement } = await import("react");
  const { createDomHarness } = await import("./support/dom.js");
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:tab-bar-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:tab-bar-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (/\.(css|svg|png)(?:\?|$)/.test(url)) return { format: "module", source: "export default '';", shortCircuit: true };
      return next(url, context);
    },
  });
  const { ConnectedFolderSurfaceTabBar, surfaceTabCountTier, surfaceTabOverflow } = await import(pathToFileURL(join(process.cwd(), "web-local/src/components/chat/ConnectedFolderSurfaceTabBar.tsx")).href);
  assets.deregister();

  assert.equal(surfaceTabCountTier(3), "");
  assert.equal(surfaceTabCountTier(4), "tab-count-compact");
  assert.equal(surfaceTabCountTier(6), "tab-count-compact");
  assert.equal(surfaceTabCountTier(7), "tab-count-dense");
  assert.equal(surfaceTabOverflow(0, 600, 600), null);
  assert.equal(surfaceTabOverflow(0, 900, 600), "end");
  assert.equal(surfaceTabOverflow(150, 900, 600), "both");
  assert.equal(surfaceTabOverflow(300, 900, 600), "start");

  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const scrolled: string[] = [];
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) { scrolled.push(this.querySelector("[role=tab]")?.id ?? ""); };
  const connectedFolder = { id: "connected-folder-1", name: "Workshop", connectedFolderRoot: "/synthetic/workshop", location: { kind: "local", storage: "linked" }, createdAt: "", updatedAt: "" };
  const tabs = Array.from({ length: 6 }, (_, index) => ({ id: `chat:connected-folder-1:${index}`, kind: "chat", connectedFolderId: "connected-folder-1", title: `Chat ${index + 1}`, conversationId: `c${index}` }));
  const activated: string[] = [];
  await dom.render(createElement(ConnectedFolderSurfaceTabBar, {
    tabs, connectedFolders: [connectedFolder], connectedFolderCustomizations: {}, conversations: {}, chatActivityStatuses: {}, activeTabId: tabs[0]!.id, newChatConnectedFolderId: "connected-folder-1",
    onActivate: (id: string) => { activated.push(id); }, onClose() {}, onReorder() {}, onNewChatInConnectedFolder() {}, onChatActions() {},
  }));
  const strip = document.querySelector<HTMLElement>(".surface-tabs")!;
  assert.match(strip.className, /tab-count-compact/);
  assert.equal(strip.hasAttribute("data-overflow"), false, "a strip that fits has no fade");
  assert.ok(scrolled.length > 0, "the active tab is revealed");

  await dom.act(() => document.querySelector<HTMLButtonElement>(".surface-tab-new-chat-trigger")!.click());
  const items = [...document.querySelectorAll<HTMLButtonElement>('#new-chat-connected-folder-menu [role="menuitemradio"]')];
  assert.deepEqual(items.map((item) => item.textContent), tabs.map((tab) => tab.title));
  assert.equal(items[0]!.getAttribute("aria-checked"), "true");
  const navigable = [...document.querySelectorAll<HTMLButtonElement>('#new-chat-connected-folder-menu [role^="menuitem"]')];
  navigable[0]!.focus();
  await dom.act(() => { document.querySelector("#new-chat-connected-folder-menu")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  assert.equal(document.activeElement, items[0], "arrow keys move from New Chat into the open tabs");
  await dom.act(() => items[3]!.click());
  assert.deepEqual(activated, [tabs[3]!.id]);
  assert.equal(document.querySelector("#new-chat-connected-folder-menu"), null, "choosing a tab closes the menu");

  const storedValues = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
    removeItem: (key: string) => storedValues.delete(key),
  } });
  window.localStorage.setItem("amplefile.connected-folder.surface-tabs.v1", JSON.stringify({ tabs, activeTabId: tabs[0]!.id }));
  const registeredConnectedFolders = [connectedFolder];
  function Host() {
    const state = useSurfaceTabs({ connectedFolder, connectedFolders: registeredConnectedFolders });
    return createElement("div", null,
      createElement(ConnectedFolderSurfaceTabBar, {
        tabs: state.surfaceTabs, connectedFolders: [connectedFolder], connectedFolderCustomizations: {}, conversations: {}, chatActivityStatuses: {}, activeTabId: state.activeSurfaceTabId, newChatConnectedFolderId: connectedFolder.id,
        onActivate: state.setActiveSurfaceTabId, onReorder: state.reorderSurfaceTabs, onClose() {}, onNewChatInConnectedFolder() {}, onChatActions() {},
      }),
      state.surfaceTabs.map(tab => createElement("input", { key: tab.id, "data-panel": tab.id, defaultValue: `Draft ${tab.id}` })),
    );
  }
  await dom.render(createElement(Host));
  const firstButton = document.querySelector<HTMLButtonElement>('[role="tab"]')!;
  const draft = document.querySelector<HTMLInputElement>("input")!;
  draft.value = "Unsent message";
  firstButton.focus();
  await dom.press("ArrowRight", { altKey: true, shiftKey: true });
  assert.deepEqual([...document.querySelectorAll("[role=tab]")].map(el => el.textContent), [tabs[1]!.title, tabs[0]!.title, ...tabs.slice(2).map(tab => tab.title)]);
  assert.equal(document.activeElement, firstButton, "keyboard reordering retains focus on the moved tab");
  assert.equal(firstButton.getAttribute("aria-selected"), "true", "reordering preserves selection");
  assert.equal(document.querySelector(`[data-panel="${tabs[0]!.id}"]`), draft, "work surfaces stay mounted");
  assert.equal(draft.value, "Unsent message");
  assert.match(document.querySelector('[role="status"]')!.textContent!, /position 2 of 6/);
  const stored = JSON.parse(window.localStorage.getItem("amplefile.connected-folder.surface-tabs.v1")!);
  assert.deepEqual(stored.tabs.map((tab: SurfaceTab) => tab.id), [tabs[1]!.id, tabs[0]!.id, ...tabs.slice(2).map(tab => tab.id)]);
  assert.equal(stored.activeTabId, tabs[0]!.id);
});
