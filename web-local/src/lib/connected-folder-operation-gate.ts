export interface ConnectedFolderOperationToken {
  connectedFolderId: string;
  generation: number;
}

export interface ConnectedFolderOperationGate {
  activate: (connectedFolderId: string) => void;
  capture: () => ConnectedFolderOperationToken;
  isCurrent: (token: ConnectedFolderOperationToken) => boolean;
}

/** Invalidates pending UI completions whenever the active Connected Folder changes. */
export function createConnectedFolderOperationGate(initialConnectedFolderId: string): ConnectedFolderOperationGate {
  let connectedFolderId = initialConnectedFolderId;
  let generation = 0;
  return {
    activate(nextConnectedFolderId) {
      if (connectedFolderId === nextConnectedFolderId) return;
      connectedFolderId = nextConnectedFolderId;
      generation += 1;
    },
    capture() {
      return { connectedFolderId, generation };
    },
    isCurrent(token) {
      return token.connectedFolderId === connectedFolderId && token.generation === generation;
    },
  };
}
