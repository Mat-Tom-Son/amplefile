/**
 * The host runs one History operation at a time in each Connected Folder and turns
 * a second one away. Every History request the app sends for a Connected Folder
 * (the list, a restore point's preview, Compare, Restore, saving a restore
 * point, file versions) waits its turn here, so open History tabs never refuse
 * each other. Different Connected Folders never wait on each other.
 *
 * Queue single requests only: a queued request that queues another for the
 * same Connected Folder would wait on itself.
 */
const queues = new Map<string, Promise<void>>();

export function queueHistoryRequest<T>(connectedFolderId: string, request: () => Promise<T>): Promise<T> {
  const turn = (queues.get(connectedFolderId) ?? Promise.resolve()).then(request);
  const settled = turn.then(() => undefined, () => undefined);
  queues.set(connectedFolderId, settled);
  void settled.then(() => { if (queues.get(connectedFolderId) === settled) queues.delete(connectedFolderId); });
  return turn;
}
