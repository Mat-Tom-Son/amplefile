/**
 * When the window is the file manager and when it is first run's welcome
 * (docs/product-model.md, "First run"). The welcome is for a fresh profile: it
 * shows only while no Connected Folder exists and the person has not left it
 * with Browse Files. A folder handed to AmpleFile (a launcher, a second launch,
 * the system's file manager request) is always shown, welcome or not.
 */

/** Kept on this computer once the welcome is left or a folder is connected. */
export const welcomeDoneStorageKey = "amplefile.file-manager.welcome-done.v1";

export function showsFileManager(state: { connectedFolders: number; welcomeDone: boolean; locationHanded: boolean }): boolean {
  return state.connectedFolders > 0 || state.welcomeDone || state.locationHanded;
}
