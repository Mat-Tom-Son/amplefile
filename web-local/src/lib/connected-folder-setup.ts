/**
 * Set Up for Me: one click asks the Connected Folder's Worker to look the
 * folder over and set it up, through the included set-up-connected-folder
 * Skill: it organizes the folder, writes Worker instructions, and gives it a
 * look. It is offered once, on a card in the panel right after a folder is
 * connected.
 */
import { readStoredJsonValue, writeStoredJsonValue } from "./storage";

/** The message Set Up for Me sends; the Skill does the rest. */
export const connectedFolderSetUpMessage = "Set up this Connected Folder for me.";

/** Connected Folders just added whose set-up card is still showing; either button removes one for good. */
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
