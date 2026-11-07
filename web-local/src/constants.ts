import { maxConnectedFolderAppearanceBannerImageDataUrlLength, connectedFolderAppearanceBannerNames } from "../../src/shared/connected-folder-appearance";
import type { AppTypographyFont, CommandPaletteGroupId, ConnectedFolderBannerOption } from "./types";

export const productName = "AmpleFile";

export const desktopTitleBarMenus = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "help", label: "Help" },
] as const;

export const connectedFolderFileRefreshDelayMs = 160;
export const loadedTreeRefreshConcurrency = 4;
export const connectedFolderPathDragType = "application/x-amplefile-connected-folder-path";
/** Several Files rows dragged together, as a JSON list of Connected Folder paths. */
export const connectedFolderPathsDragType = "application/x-amplefile-connected-folder-paths";
export const connectedFolderSidebarWidthPreferenceKey = "amplefile.connected-folder.sidebar-width";
/** Whether the navigation pane (Files, Chats, History) is hidden; the rail stays. */
export const sidebarCollapsedStorageKey = "amplefile.layout.sidebar-collapsed";
/** The AmpleFile agent panel beside the work area: open state and width. */
export const agentPanelStorageKey = "amplefile.layout.agent-panel.v1";
export const connectedFolderSidebarPreferredMinWidth = 280;
export const connectedFolderSidebarPreferredMaxWidth = 640;
export const connectedFolderChatPreferredMinWidth = 430;
export const connectedFolderPaneResizeHandleWidth = 16;
export const connectedFolderPaneKeyboardStep = 24;
export const connectedFolderPaneKeyboardLargeStep = 64;
export const chatDraftKeyPrefix = "amplefile.connected-folder.chat-draft";
export const chatDraftNewConversationId = "new-chat";
export const chatDraftDebounceMs = 300;
/** Drafts live in browser storage, which has a few megabytes for everything. */
export const chatDraftMaxStoredChars = 500_000;
export const apiGetRetryDelaysMs = [500, 1_500, 3_500] as const;
export const eventStreamReconnectDelaysMs = [250, 750, 1_500, 3_000, 5_000] as const;
export const typographyFontOptions: Array<{ value: AppTypographyFont; label: string; detail: string }> = [
  { value: "default", label: "Default", detail: "Inter" },
  { value: "stable", label: "Segoe UI", detail: "Non-variable" },
  { value: "verdana", label: "Verdana", detail: "Wide letters" },
  { value: "aptos", label: "Aptos", detail: "Document style" },
];
export function typographyFontOptionsForPlatform(platform: NodeJS.Platform | undefined): Array<{ value: AppTypographyFont; label: string; detail: string }> {
  if (platform !== "darwin") return typographyFontOptions;
  return typographyFontOptions.filter((option) => option.value !== "stable");
}
export const untitledChatLabel = "Untitled chat";
export const commandPaletteGroupOrder: CommandPaletteGroupId[] = ["go-to", "switch-connected-folder", "chats", "files", "actions"];
export const commandPaletteGroupCap = 8;
export const commandPaletteOverallCap = 24;
export const genericChatEmptyGreetings = [
  "What should we work on?",
  "Ready when you are.",
  "Where should we start?",
  "New chat, clean slate.",
  "Let's make some progress.",
];
export const connectedFolderCustomizationStorageKey = "amplefile.connected-folder.appearance.v1";
export const defaultConnectedFolderBannerName = "classic";
export const maxConnectedFolderBannerImageDataUrlLength = maxConnectedFolderAppearanceBannerImageDataUrlLength;
export const maxConnectedFolderBannerImageFileBytes = 12 * 1024 * 1024;
export const connectedFolderBannerOptions: ConnectedFolderBannerOption[] = connectedFolderAppearanceBannerNames.map((name) => ({
  name,
  label: name[0]!.toUpperCase() + name.slice(1),
}));
