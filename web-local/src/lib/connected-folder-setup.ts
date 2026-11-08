/**
 * Set up for me: one click asks the Connected Folder's Worker to look
 * the folder over and set it up, through the included set-up-connected-folder
 * Skill. "Set up for me" organizes it, writes Worker instructions, and gives
 * it a look; "Just the look" sets the banner, icon, and color and never
 * touches a file.
 */
import { readStoredJsonValue, writeStoredJsonValue } from "./storage";

export type ConnectedFolderSetUpMode = "full" | "look";

/** The first message each choice sends; the Skill does the rest. */
export function connectedFolderSetUpMessage(mode: ConnectedFolderSetUpMode): string {
  return mode === "full"
    ? "Set up this Connected Folder for me."
    : "Just the look: give this Connected Folder a banner, icon, and color that fit it, without changing any of its files.";
}

/** Connected Folders just added whose setup card is still showing; × or either choice removes one for good. */
export const connectedFolderSetUpOffersKey = "amplefile.connected-folder.setup-offers.v1";

export function readConnectedFolderSetUpOffers(): string[] {
  return readStoredJsonValue(
    connectedFolderSetUpOffersKey,
    (parsed) => (Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []),
    [],
  );
}

export function writeConnectedFolderSetUpOffers(ids: readonly string[]): void {
  writeStoredJsonValue(connectedFolderSetUpOffersKey, [...new Set(ids)]);
}
