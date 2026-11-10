/** Revoke a controlling Chat's share before its durable context disappears. */
import { ampleFileAgentScopeId } from "../state-paths.js";
import type { LocalApiState } from "./state.js";

export async function stopComputerSharingForScope(state: LocalApiState, root: string, connectedFolderId?: string, conversationId?: string): Promise<void> {
  const service = (await state.runtimeProvider.resolveRuntime(root)).includedTools?.computerSession;
  const owner = service?.status().owner;
  if (!owner) return;
  if (connectedFolderId !== undefined && (connectedFolderId === ampleFileAgentScopeId ? owner.scope !== "management" : owner.scope !== "connected-folder" || owner.connectedFolderId !== connectedFolderId)) return;
  if (conversationId !== undefined && owner.conversationId !== conversationId) return;
  await service!.stop();
}
