/**
 * A Connected Folder's Role (docs/product-model.md, "Role"): the window reads
 * and saves it here, and the act verbs `connected-folders role show|set|clear`
 * go through the same change path, so both surfaces refresh Chats the same way.
 *
 *   GET    /api/connected-folders/:id/role   the Role, or null
 *   PUT    /api/connected-folders/:id/role   { purpose?, askFor?, produces?, accepts? }
 *   DELETE /api/connected-folders/:id/role   remove the Role
 */
import {
  ConnectedFolderRoleError,
  clearConnectedFolderRole,
  readConnectedFolderRole,
  writeConnectedFolderRole,
  type ConnectedFolderRoleChange,
  type ConnectedFolderRoleInput,
} from "../connected-folder-role.js";
import { getConnectedFolder } from "../connected-folder.js";
import { detachCachedClient } from "./conversation-clients.js";
import { publishControlHint } from "./event-streams.js";
import { badRequest, busyRefusal, errorMessage, httpError, match, readJsonBody, sendJson } from "./http.js";
import { globalCapabilityMutationKey } from "./reservations.js";
import type { LocalApiRequest, LocalApiState } from "./state.js";

/**
 * Runs a Role change for one Connected Folder. A Role shapes only later
 * turns, so the change never waits on or interrupts work: idle Chats rebuild
 * now, and a Chat that is mid-turn or compacting (including the Worker that
 * changed its own Role) rebuilds as soon as that work ends, exactly as for
 * Worker instructions. A Connected Folder whose deletion, restore, or Eject
 * holds its reservation is refused, never raced.
 */
export async function changeConnectedFolderRole(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  operation: () => Promise<ConnectedFolderRoleChange>,
): Promise<ConnectedFolderRoleChange> {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(connectedFolder.id)) {
    throw busyRefusal("Wait for the current change to this Connected Folder to finish.");
  }
  let change: ConnectedFolderRoleChange;
  try {
    change = await operation();
  } catch (error) {
    if (error instanceof ConnectedFolderRoleError) {
      throw error.code === "invalid" ? badRequest(error.message) : httpError(409, error.message);
    }
    throw error;
  }
  if (!change.changed) return change;
  for (const [key, client] of [...state.clients]) {
    if (!key.startsWith(`${connectedFolder.id}:`)) continue;
    if (state.runningTurns.has(key) || state.compactingConversations.has(key)) {
      state.clientsToRefresh.add(key);
      continue;
    }
    await detachCachedClient(state, key, client)?.stop().catch(() => undefined);
  }
  publishControlHint(state, "connected-folders");
  return change;
}

export async function saveConnectedFolderRole(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  input: ConnectedFolderRoleInput,
): Promise<ConnectedFolderRoleChange> {
  return changeConnectedFolderRole(state, connectedFolder, () => writeConnectedFolderRole(connectedFolder.connectedFolderRoot, input));
}

export async function removeConnectedFolderRole(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
): Promise<ConnectedFolderRoleChange> {
  return changeConnectedFolderRole(state, connectedFolder, () => clearConnectedFolderRole(connectedFolder.connectedFolderRoot));
}

/** The body the window sends: only the fields it names change. */
export function connectedFolderRoleInputFromBody(body: unknown): ConnectedFolderRoleInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("A Role object is required.");
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["purpose", "askFor", "produces", "accepts"].includes(key)) throw badRequest(`A Role has no ${key} field.`);
  }
  const input: ConnectedFolderRoleInput = {};
  if (record.purpose !== undefined) {
    if (typeof record.purpose !== "string") throw badRequest("The purpose must be text.");
    input.purpose = record.purpose;
  }
  for (const field of ["askFor", "produces", "accepts"] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw badRequest(`${field} must be a list of text entries.`);
    input[field] = value as string[];
  }
  return input;
}

export async function handleConnectedFolderRoleRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  const roleMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/role$/);
  if (!roleMatch) return false;
  const connectedFolder = await getConnectedFolder(roleMatch[1]);
  if (method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, { role: await readConnectedFolderRole(connectedFolder.connectedFolderRoot) });
    return true;
  }
  if (method === "PUT") {
    const body = await readJsonBody<unknown>(state, req);
    let input: ConnectedFolderRoleInput;
    try {
      input = connectedFolderRoleInputFromBody(body);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    const change = await saveConnectedFolderRole(state, connectedFolder, input);
    sendJson(res, { role: change.role, previousRole: change.previousRole, changed: change.changed });
    return true;
  }
  if (method === "DELETE") {
    const change = await removeConnectedFolderRole(state, connectedFolder);
    sendJson(res, { role: null, previousRole: change.previousRole, changed: change.changed });
    return true;
  }
  return false;
}
