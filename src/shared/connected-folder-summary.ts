/** The Connected Folder summary returned by the local API and consumed by the desktop UI. */
export interface ConnectedFolderLocation {
  kind: "local";
  storage: "managed" | "linked";
  providerHint?: "google-drive";
}

export interface ConnectedFolderSummary {
  id: string;
  name: string;
  connectedFolderRoot: string;
  location: ConnectedFolderLocation;
  createdAt: string;
  updatedAt: string;
}
