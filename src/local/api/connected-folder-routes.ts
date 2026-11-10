/**
 * Connected Folder registry routes (health, the bootstrap read, creating,
 * connecting, renaming, removing, appearance) and the registration changes
 * they share with the act lane, prepared acts, and startup recovery.
 */

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  accentIdentityFromHex,
  defaultConnectedFolderAccent,
  primaryAccentIdentity,
  startingConnectedFolderAccentHex,
} from "../../shared/connected-folder-appearance.js";
import { connectedFolderStateDir, ampleFileAgentScopeId } from "../state-paths.js";
import { AmpleFileRecentlyDeletedStore, type AmpleFileRecentlyDeletedEntry } from "../recently-deleted-store.js";
import {
  beginConnectedFolderRemoval,
  createManagedConnectedFolder,
  finalizeConnectedFolderRemoval,
  getConnectedFolder,
  listPendingConnectedFolderRemovals,
  registerLinkedConnectedFolder,
  renameConnectedFolder,
  registeredConnectedFolderOutline,
  resolveNestableFolderPath,
  connectedFolderRemovalPendingResult,
  type ConnectedFolderRemovalIo,
  type ConnectedFolderRemovalResult,
  type ConnectedFolderSummary,
} from "../connected-folder.js";
import { emptyAgentStatus, runDesktopSettingsAct, safeAgentStatus } from "../server.js";
import { invalidateAmpleFileClients } from "./conversation-clients.js";
import { closeConnectedFolderStreams, publishControlHint } from "./event-streams.js";
import { badRequest, forbidden, match, readJsonBody, sendJson } from "./http.js";
import { runConnectedFolderMutations, runSettledConnectedFolderDeletion } from "./reservations.js";
import { connectedFolderRootKey, type LocalApiRequest, type LocalApiState } from "./state.js";

/** Health, the bootstrap read, and the Connected Folder registry: listing, creating, connecting, renaming, and removing Connected Folders. */
export async function handleConnectedFolderRegistryRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(res, { ok: true, app: "amplefile", mode: state.appMode });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const connectedFolders = (await state.kernel.getConnectedFolders({ kind: "renderer" })).connectedFolders;
    const agent = connectedFolders[0] ? await safeAgentStatus(connectedFolders[0].connectedFolderRoot, state.runtimeProvider) : emptyAgentStatus();
    sendJson(res, { connectedFolders, agent, appearance: state.appearance.snapshot() });
    return true;
  }

  // Which Connected Folder Workers are mid-turn right now, including turns no Chat tab
  // is showing (a handoff into a nested Connected Folder). Content-free: ids only. The
  // renderer requeries on the "activity" control hint.
  // The registered Connected Folders' ids, names, and roots for the @ menus: read from
  // the registry alone, with no manifest writes or setup checks, so a
  // popover can ask on every show.
  if (method === "GET" && url.pathname === "/api/connected-folders/outline") {
    const connectedFolders = (await registeredConnectedFolderOutline()).filter((connectedFolder) => existsSync(connectedFolder.connectedFolderRoot));
    sendJson(res, { connectedFolders });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/connected-folders/activity") {
    const running = [...state.activeTurnTasks.values()]
      .filter((task) => task.connectedFolderId !== ampleFileAgentScopeId)
      .map((task) => ({ connectedFolderId: task.connectedFolderId, conversationId: task.conversationId }));
    sendJson(res, { running });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/appearance") {
    sendJson(res, { appearance: state.appearance.snapshot() });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/connected-folders") {
    const body = await readJsonBody<{ name?: string }>(state, req);
    const connectedFolder = await createConnectedFolderInternal(state, body.name ?? "Personal Connected Folder");
    sendJson(res, { connectedFolder }, 201);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/connected-folders/local-folder") {
  const body = await readJsonBody<{ connectedFolderRoot?: string; folderGrantId?: string; providerHint?: "google-drive" }>(state, req);
    if (!body.connectedFolderRoot?.trim()) throw badRequest("Choose a local folder to turn into a Connected Folder.");
    if (state.localFolderGrantProvider) {
      if (!body.folderGrantId || !await state.localFolderGrantProvider.consumeLocalFolderGrant({ connectedFolderRoot: body.connectedFolderRoot, grantId: body.folderGrantId })) {
        throw forbidden("The folder selection expired. Choose the folder again to add it.");
      }
    } else if (state.appMode === "desktop") {
      throw forbidden("A folder must be selected in the desktop app before it can become a Connected Folder.");
    }
    const connectedFolder = await registerConnectedFolderInternal(state, body.connectedFolderRoot!, body.providerHint);
    sendJson(res, { connectedFolder }, 201);
    return true;
  }

  // "Connect This Folder": a person registers a folder inside
  // a Connected Folder they already registered, from Files. The parent's registration
  // is the trust root for the path, so no fresh folder picker grant is asked
  // for; the explicit click is this Connected Folder's registration act, exactly as
  // choosing a folder in the picker is.
  const nestedFolderMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/nested-folders$/);
  if (method === "POST" && nestedFolderMatch) {
    const parent = await getConnectedFolder(nestedFolderMatch[1]);
    const body = await readJsonBody<{ path?: unknown }>(state, req);
    if (typeof body.path !== "string" || !body.path.trim()) throw badRequest("Choose a folder inside this Connected Folder.");
    const target = await resolveNestableFolderPath(parent.connectedFolderRoot, body.path);
    const connectedFolder = await registerConnectedFolderInternal(state, target);
    sendJson(res, { connectedFolder }, 201);
    return true;
  }

  const connectedFolderMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)$/);
  if (connectedFolderMatch && (method === "PUT" || method === "PATCH")) {
    const body = await readJsonBody<{ name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A Connected Folder name is required.");
    sendJson(res, { connectedFolder: await renameConnectedFolder(connectedFolderMatch[1], body.name) });
    publishControlHint(state, "connected-folders");
    return true;
  }
  if (connectedFolderMatch && method === "DELETE") {
    const connectedFolder = await getConnectedFolder(connectedFolderMatch[1]);
    // Every deletion the desktop performs leaves a receipt
    // (docs/act-ledger.md): the same journal the act lane writes,
    // stamped with the main-window surface. Removing a linked registration
    // destroys nothing, so it is journaled as the unregister it is.
    const command = connectedFolder.location.storage === "managed" ? "connected-folders.delete" : "connected-folders.unregister";
    const removal = await runDesktopSettingsAct(state, command, async (requestId) => {
      const value = await removeConnectedFolderRegistrationInternal(state, connectedFolder, { receiptId: requestId });
      return {
        value,
        detail: `Connected Folder ${connectedFolder.id}${value.recentlyDeleted ? `; trash ${value.recentlyDeleted.entryId}` : ""}`,
      };
    });
    sendJson(res, removal.value);
    return true;
  }
  return false;
}

/** A Connected Folder's look: applying and resetting its appearance. */
export async function handleConnectedFolderAppearanceRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  const connectedFolderAppearanceMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/appearance$/);
  if (connectedFolderAppearanceMatch && method === "PUT") {
    const connectedFolder = await getConnectedFolder(connectedFolderAppearanceMatch[1]);
    const body = await readJsonBody<{ customization?: unknown }>(state, req);
    if (!body.customization || typeof body.customization !== "object" || Array.isArray(body.customization)) {
      throw badRequest("A Connected Folder appearance object is required.");
    }
    const appearance = await state.appearance.replaceConnectedFolder(
      connectedFolder.id,
      body.customization,
    );
    sendJson(res, { appearance });
    return true;
  }
  if (connectedFolderAppearanceMatch && method === "DELETE") {
    const connectedFolder = await getConnectedFolder(connectedFolderAppearanceMatch[1]);
    sendJson(res, { appearance: await state.appearance.removeConnectedFolder(connectedFolder.id) });
    return true;
  }
  return false;
}

export async function createConnectedFolderInternal(state: LocalApiState, name: string): Promise<ConnectedFolderSummary> {
  const connectedFolder = await createManagedConnectedFolder(name, state.connectedFolderBase);
  state.connectedFolderTrustAuthority.grant(connectedFolder.connectedFolderRoot);
  await giveStartingColor(state, connectedFolder.id);
  publishControlHint(state, "connected-folders");
  return connectedFolder;
}

export async function registerConnectedFolderInternal(state: LocalApiState, rootPath: string, providerHint?: "google-drive"): Promise<ConnectedFolderSummary> {
  const known = new Set((await registeredConnectedFolderOutline()).map((item) => item.id));
  const connectedFolder = await registerLinkedConnectedFolder(rootPath, providerHint);
  state.connectedFolderTrustAuthority.grant(connectedFolder.connectedFolderRoot);
  // A folder that already carried a Connected Folder identity keeps the color it had.
  if (!known.has(connectedFolder.id) && connectedFolder.createdAt === connectedFolder.updatedAt) await giveStartingColor(state, connectedFolder.id);
  // Copy-level note when a suspended automation's missing Connected Folder returns with its
  // portable identity; the automation stays suspended — registration never
  // silently re-arms standing behavior — so a failure to note it is tolerable.
  await state.automations.handleConnectedFolderReRegistered(connectedFolder.id).catch(() => undefined);
  publishControlHint(state, "connected-folders");
  return connectedFolder;
}

/**
 * A new Connected Folder starts in the color the fewest others use, so two rarely
 * share one. Nothing is saved when that is already the color its
 * id picks, and a saved choice always wins. The color is a nicety: failing to
 * save it never fails the creation.
 */
async function giveStartingColor(state: LocalApiState, connectedFolderId: string): Promise<void> {
  try {
    const { customizations } = state.appearance.snapshot();
    if (customizations[connectedFolderId]) return;
    const others = (await registeredConnectedFolderOutline())
      .filter((item) => item.id !== connectedFolderId)
      .map((item) => primaryAccentIdentity(customizations[item.id], defaultConnectedFolderAccent(item.id).hex).referenceHex);
    const hex = startingConnectedFolderAccentHex(connectedFolderId, others);
    if (hex === defaultConnectedFolderAccent(connectedFolderId).hex) return;
    await state.appearance.replaceConnectedFolder(connectedFolderId, { primary: accentIdentityFromHex(hex) });
  } catch {
    // The Connected Folder keeps the color its id picks.
  }
}

/**
 * The one connected-folder-removal path, shared by the desktop DELETE route, the
 * `connected-folder.delete-folder` prepared act behind `connected-folders delete`, and the act
 * facade's `connected-folders unregister`:
 * automation suspension, the durable removal intent, runtime-authorization
 * revocation with the crash-safe pending result, and finalization. A linked registration removal always leaves the
 * folder and its portable `.amplefile/` identity in place; a managed Connected Folder
 * deletes its folder tree unless the caller passes the preserve disposition
 * (the act lane's `connected-folders unregister`), which records an intent that provably
 * holds no deletion authority.
 */
/**
 * The managed-deletion seam of docs/act-ledger.md: the folder the
 * removal machinery has already claimed by exact identity is *moved* into
 * Recently deleted with the Connected Folder's machine-local History state, never
 * erased. Everything about the claim-verified removal above it is unchanged —
 * this only replaces the final erase.
 *
 * An injected `removeClaimedManagedRoot`/`removeConnectedFolderState` still wins, so
 * the removal-atomicity failure-injection seams keep working, and a preserve
 * removal (`connected-folders unregister`) never reaches the claim path at all: its
 * state directory is removed exactly as before.
 */
function managedConnectedFolderRemovalIo(
  recentlyDeleted: AmpleFileRecentlyDeletedStore,
  overrides: Partial<ConnectedFolderRemovalIo>,
  context: { connectedFolderId: string; connectedFolderRoot: string; connectedFolderName?: string; receiptId: string | null; managedDeletion: boolean },
): { io: Partial<ConnectedFolderRemovalIo>; entry: () => AmpleFileRecentlyDeletedEntry | null } {
  let entry: AmpleFileRecentlyDeletedEntry | null = null;
  const io: Partial<ConnectedFolderRemovalIo> = {
    ...overrides,
    removeClaimedManagedRoot: overrides.removeClaimedManagedRoot ?? (async (claimPath) => {
      const connectedFolderName = context.connectedFolderName ?? await claimedConnectedFolderName(claimPath) ?? basename(context.connectedFolderRoot);
      entry = await recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: "connected-folder",
        reason: "connected-folders.delete",
        sourcePath: claimPath,
        connectedFolderId: context.connectedFolderId,
        connectedFolderName,
        originalPath: context.connectedFolderRoot,
        receiptId: context.receiptId,
        stateDirPath: connectedFolderStateDir(context.connectedFolderRoot),
      });
    }),
    removeConnectedFolderState: async (connectedFolderRoot) => {
      // The folder's move already carried the History state into the entry.
      if (entry) return;
      if (overrides.removeConnectedFolderState) return overrides.removeConnectedFolderState(connectedFolderRoot);
      // On restart the claimed folder may already have reached Recently
      // deleted while its History directory is still at the old state path.
      // Recover that second move before committing removal; never erase the
      // remaining History when its destination cannot be proved.
      if (context.managedDeletion && !overrides.removeClaimedManagedRoot && existsSync(connectedFolderStateDir(connectedFolderRoot))) {
        const listing = await recentlyDeleted.list();
        const matching = listing.entries.filter((item) => item.kind === "connected-folder"
          && item.reason === "connected-folders.delete"
          && item.connectedFolderId === context.connectedFolderId
          && connectedFolderRootKey(item.originalPath) === connectedFolderRootKey(context.connectedFolderRoot));
        if (matching.length !== 1 || listing.damaged.length) {
          throw new Error("The deleted Connected Folder's History could not be matched to one intact Recently deleted entry. It was kept at its original state path.");
        }
        entry = await recentlyDeleted.attachConnectedFolderState(matching[0]!.id, connectedFolderStateDir(connectedFolderRoot));
        return;
      }
      await rm(connectedFolderStateDir(connectedFolderRoot), { recursive: true, force: true });
    },
  };
  return { io, entry: () => entry };
}

/** Best-effort display name for a folder already claimed for removal. */
async function claimedConnectedFolderName(claimPath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(claimPath, ".amplefile", "connected-folder.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

export async function removeConnectedFolderRegistrationInternal(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  options: { managedFolderDisposition?: "delete" | "preserve"; receiptId?: string | null } = {},
): Promise<ConnectedFolderRemovalResult & {
  recentlyDeleted: { entryId: string; restoreBy: string } | null;
}> {
  // A preserve removal keeps the folder, so it keeps the plain state-directory
  // removal; a delete removal sends the claimed folder to Recently deleted.
  const removal = options.managedFolderDisposition === "preserve"
    ? { io: state.connectedFolderRemovalIo, entry: () => null as AmpleFileRecentlyDeletedEntry | null }
    : managedConnectedFolderRemovalIo(state.recentlyDeleted, state.connectedFolderRemovalIo, {
      connectedFolderId: connectedFolder.id,
      connectedFolderRoot: connectedFolder.connectedFolderRoot,
      connectedFolderName: connectedFolder.name,
      receiptId: options.receiptId ?? null,
      managedDeletion: connectedFolder.location.storage === "managed",
    });
  const withRecentlyDeleted = <T extends ConnectedFolderRemovalResult>(result: T): T & {
    recentlyDeleted: { entryId: string; restoreBy: string } | null;
  } => {
    const entry = removal.entry();
    return {
      ...result,
      recentlyDeleted: entry ? { entryId: entry.id, restoreBy: entry.restoreBy } : null,
    };
  };
  return runConnectedFolderMutations(state, [connectedFolder.id], () => runSettledConnectedFolderDeletion(state, connectedFolder.id, async () => {
    try {
      const intent = await beginConnectedFolderRemoval(connectedFolder.id, state.connectedFolderBase, removal.io, {
        ...(options.managedFolderDisposition ? { folderDisposition: options.managedFolderDisposition } : {}),
      });
      state.connectedFolderTrustAuthority.revoke(connectedFolder.connectedFolderRoot);
      state.connectedFolderIdsByRoot.delete(connectedFolderRootKey(connectedFolder.connectedFolderRoot));
      await invalidateAmpleFileClients(state, connectedFolder.id);
      closeConnectedFolderStreams(state, connectedFolder.id);
      for (const request of [...state.extensionRequests.values()]) {
        if (request.connectedFolderRoot !== connectedFolder.connectedFolderRoot) continue;
        state.extensionUi.cancel(request.id);
        state.extensionRequests.delete(request.id);
      }
      // Enabled automations referencing this Connected Folder suspend (their
      // active runs stop) at the same revocation moment. Suspension
      // failing leaves the durable intent pending — startup retries the
      // cascade.
      try {
        await state.automations.handleConnectedFolderRemoved(connectedFolder.id);
      } catch {
        return withRecentlyDeleted(await connectedFolderRemovalPendingResult(intent));
      }
      const result = await finalizeConnectedFolderRemoval(intent.connectedFolderId, removal.io);
      if (!result.cleanupPending) await state.appearance.removeConnectedFolder(connectedFolder.id);
      return withRecentlyDeleted(result);
    } finally {
      publishControlHint(state, "connected-folders");
    }
  }), { requiredConnectedFolderIds: [connectedFolder.id] });
}

export async function recoverPendingConnectedFolderRemovals(
  io: Partial<ConnectedFolderRemovalIo>,
  recentlyDeleted: AmpleFileRecentlyDeletedStore,
): Promise<{ connectedFolderRoots: string[]; connectedFolderIds: string[] }> {
  const pendingRemovals = await listPendingConnectedFolderRemovals();
  for (const pending of pendingRemovals) {
    try {
      const intent = pending;
      // An interrupted managed deletion finishes into Recently deleted, not
      // into an erase: the folder this start finds claimed is still the
      // person's (docs/act-ledger.md).
      const removalIo = managedConnectedFolderRemovalIo(recentlyDeleted, io, {
        connectedFolderId: intent.connectedFolderId,
        connectedFolderRoot: intent.connectedFolderRoot,
        receiptId: null,
        managedDeletion: intent.storage === "managed" && intent.folderDisposition !== "preserve",
      });
      await finalizeConnectedFolderRemoval(intent.connectedFolderId, removalIo.io);
    } catch {
      // The durable intent keeps this Connected Folder hidden and untrusted. Recovery of
      // other Connected Folders and normal startup can proceed; a later startup retries it.
    }
  }
  return {
    connectedFolderRoots: pendingRemovals.map((intent) => intent.connectedFolderRoot),
    connectedFolderIds: pendingRemovals.map((intent) => intent.connectedFolderId),
  };
}
