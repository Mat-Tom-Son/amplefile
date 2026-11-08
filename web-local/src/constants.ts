import { maxConnectedFolderAppearanceBannerImageDataUrlLength, connectedFolderAppearanceBannerNames } from "../../src/shared/connected-folder-appearance";
import type { AppTypographyFont, ConnectedFolderBannerOption } from "./types";

export const productName = "AmpleFile";

export const desktopTitleBarMenus = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "help", label: "Help" },
] as const;
export const connectedFolderPathDragType = "application/x-amplefile-connected-folder-path";
/** Several Files rows dragged together, as a JSON list of Connected Folder paths. */
export const connectedFolderPathsDragType = "application/x-amplefile-connected-folder-paths";
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
export const genericChatEmptyGreetings = [
  "What should we work on?",
  "Ready when you are.",
  "Where should we start?",
  "New chat, clean slate.",
  "Let's make some progress.",
];
export const defaultConnectedFolderBannerName = "classic";
export const maxConnectedFolderBannerImageDataUrlLength = maxConnectedFolderAppearanceBannerImageDataUrlLength;
export const maxConnectedFolderBannerImageFileBytes = 12 * 1024 * 1024;
export const connectedFolderBannerOptions: ConnectedFolderBannerOption[] = connectedFolderAppearanceBannerNames.map((name) => ({
  name,
  label: name[0]!.toUpperCase() + name.slice(1),
}));
