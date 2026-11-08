/**
 * The included tools are machine-wide: their setup reads and acts
 * through a Connected Folder when one is open, and the AmpleFile Agent's scope
 * otherwise, as on first run.
 */
export function includedToolsPath(connectedFolderId?: string): string {
  return connectedFolderId ? `/api/agent/included-tools?connectedFolderId=${encodeURIComponent(connectedFolderId)}` : "/api/agent/included-tools";
}

export function includedToolSetupBody(connectedFolderId: string | undefined, id: string, action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(connectedFolderId ? { connectedFolderId } : {}), id, action, ...extra };
}
