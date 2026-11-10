/**
 * Settings → Recently Deleted routes and the restores behind them
 * (docs/act-ledger.md), which the act lane shares, with the request setting
 * under Settings → Automations → Limits.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { conversationsDir } from "../agent/chat-store.js";
import { PiSkillRestoreConflictError, restorePiSkill } from "../agent/skill-import.js";
import { createConnectedFolderMutationCheckpoint } from "../history.js";
import { connectedFolderStateDir, ampleFileAgentRoot, ampleFileAgentScopeId } from "../state-paths.js";
import {
  AmpleFileRecentlyDeletedError,
  ampleFileRecentlyDeletedEntryIdPattern,
  type AmpleFileRecentlyDeletedEntry,
  type AmpleFileRecentlyDeletedKind,
  type AmpleFileRecentlyDeletedReason,
  type AmpleFileRecentlyDeletedUncoveredPath,
} from "../recently-deleted-store.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import type { AmpleFileActConnectedFolderRef } from "../cli/act-facade.js";
import {
  getConnectedFolder,
  listConnectedFolders,
  registerManagedConnectedFolder,
  resolveConnectedFolderPath,
  touchConnectedFolderRoot,
  type ConnectedFolderSummary,
} from "../connected-folder.js";
import { runActOperation, toActConnectedFolderRef } from "./act-support.js";
import { runConversationMutation } from "./chat-routes.js";
import { publishControlHint } from "./event-streams.js";
import { normalizeConnectedFolderRelativePath, pathContainsPath } from "./file-changes.js";
import { badRequest, errorMessage, match, notFound, readJsonBody, sendJson } from "./http.js";
import { runDesktopSettingsAct } from "./prepared-act-adapters.js";
import { runCapabilityMutation } from "./reservations.js";
import type { LocalApiRequest, LocalApiState } from "./state.js";

/** Settings → Recently Deleted, and the request setting under Settings → Automations → Limits. */
export async function handleSettingsRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // Settings → Recently deleted (docs/act-ledger.md).
  // Listing is a plain read; restoring, removing one item, and changing how
  // long items are kept are journaled acts with the main-window surface, like
  // every other trusted-Settings mutation. Nothing here empties the store.
  if (url.pathname === "/api/settings/recently-deleted" && method === "GET") {
    const listing = await state.recentlyDeleted.list();
    const registered = new Set((await listConnectedFolders()).map((connectedFolder) => connectedFolder.id));
    const entries = [];
    for (const entry of listing.entries) entries.push(await recentlyDeletedEntryView(entry, registered));
    sendJson(res, { entries, damaged: listing.damaged, retentionDays: listing.retentionDays });
    return true;
  }
  if (url.pathname === "/api/settings/recently-deleted/retention" && method === "PUT") {
    const body = await readJsonBody<{ retentionDays?: unknown }>(state, req);
    const days = Number(body.retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw badRequest("Keep deleted items for between 1 and 365 days.");
    }
    const updated = await runDesktopSettingsAct(state, "recently-deleted.retention", async () => {
      await state.recentlyDeleted.setRetentionDays(days);
      return { value: { retentionDays: state.recentlyDeleted.retentionDays() }, detail: `days ${days}` };
    });
    sendJson(res, updated.value);
    return true;
  }
  // Settings → Automations → Limits: the one adjustable request setting.
  // Turning follow-up turns off changes nothing about what is recorded; it
  // only stops the host from bringing the results back as a turn.
  if (url.pathname === "/api/settings/requests" && method === "GET") {
    sendJson(res, { continuationsEnabled: state.requests.continuationsEnabled() });
    return true;
  }
  if (url.pathname === "/api/settings/requests/continuations" && method === "PUT") {
    const body = await readJsonBody<{ enabled?: unknown }>(state, req);
    if (typeof body.enabled !== "boolean") throw badRequest("Say whether follow-up turns are on or off.");
    const enabled = body.enabled;
    const updated = await runDesktopSettingsAct(state, "requests.continuations", async () => {
      await state.requests.setContinuationsEnabled(enabled);
      return { value: { continuationsEnabled: state.requests.continuationsEnabled() }, detail: enabled ? "on" : "off" };
    });
    sendJson(res, updated.value);
    return true;
  }
  const recentlyDeletedEntryMatch = match(url.pathname, /^\/api\/settings\/recently-deleted\/([^/]+)$/);
  if (recentlyDeletedEntryMatch && method === "DELETE") {
    const entryId = recentlyDeletedEntryMatch[1];
    if (!ampleFileRecentlyDeletedEntryIdPattern.test(entryId)) throw notFound("That item is no longer in Recently deleted.");
    try {
      const removed = await runDesktopSettingsAct(state, "recently-deleted.delete-now", async () => ({
        value: await state.recentlyDeleted.remove(entryId),
        detail: `entry ${entryId}`,
      }));
      sendJson(res, removed.value);
    } catch (error) {
      if (error instanceof AmpleFileRecentlyDeletedError && error.code === "HELD") {
        sendJson(res, { error: error.message }, 409);
        return true;
      }
      throw error;
    }
    return true;
  }
  const recentlyDeletedRestoreMatch = match(url.pathname, /^\/api\/settings\/recently-deleted\/([^/]+)\/restore$/);
  if (recentlyDeletedRestoreMatch && method === "POST") {
    await readJsonBody<Record<string, never>>(state, req);
    const restored = await runDesktopSettingsAct(state, "recently-deleted.restore", async (requestId) => {
      const value = await restoreRecentlyDeletedEntry(state, recentlyDeletedRestoreMatch[1], { receiptId: requestId });
      return { value, detail: `entry ${recentlyDeletedRestoreMatch[1]}; kind ${value.kind}` };
    });
    sendJson(res, { restored: restored.value });
    return true;
  }
  return false;
}

/** What a Recently deleted entry can still do, and why when it cannot go back. */
export interface AmpleFileRecentlyDeletedEntryView {
  id: string;
  kind: AmpleFileRecentlyDeletedKind;
  reason: AmpleFileRecentlyDeletedReason;
  connectedFolderId: string;
  connectedFolderName?: string;
  /** skill only: the scope it goes back into. */
  scope?: "everywhere" | "connected-folder";
  originalPath: string;
  name: string;
  sizeBytes: number;
  sizeApproximate?: true;
  deletedAt: string;
  restoreBy: string;
  receiptId: string | null;
  uncovered?: AmpleFileRecentlyDeletedUncoveredPath[];
  held?: { reason: "unreadable"; noticedAt: string };
  /**
   * `in-place` goes back where it came from; `blocked` cannot be brought back
   * right now (or ever, for what older builds kept for Connected Folder
   * apps), and `note` says why.
   */
  restorable: "in-place" | "blocked";
  note?: string;
}

export type AmpleFileRecentlyDeletedRestoreResult =
  /**
   * `safetyCheckpointId` is null when History could not record the restore
   * point. The content is back either way, and the entry is already gone, so
   * reporting the restore as a failure would be a lie that also removes the
   * thing the person would retry from.
   */
  | { kind: "file" | "folder"; entryId: string; connectedFolder: AmpleFileActConnectedFolderRef; path: string; renamed: boolean; safetyCheckpointId: string | null }
  | { kind: "connected-folder"; entryId: string; connectedFolder: AmpleFileActConnectedFolderRef; connectedFolderRoot: string; renamed: boolean }
  /** `workFolder` names the Connected Folder for that scope only; `path` is the restored Skill folder. */
  | { kind: "skill"; entryId: string; scope: "everywhere" | "connected-folder"; connectedFolder?: AmpleFileActConnectedFolderRef; name: string; path: string };

/**
 * Whether an entry can go back where it came from, and the plain reason when
 * it cannot. What older builds kept for Connected Folder apps never goes back:
 * AmpleFile has no apps, so those entries only wait to expire.
 */
export async function recentlyDeletedEntryView(
  entry: AmpleFileRecentlyDeletedEntry,
  registered?: ReadonlySet<string>,
): Promise<AmpleFileRecentlyDeletedEntryView> {
  const base: AmpleFileRecentlyDeletedEntryView = {
    id: entry.id,
    kind: entry.kind,
    reason: entry.reason,
    connectedFolderId: entry.connectedFolderId,
    ...(entry.connectedFolderName === undefined ? {} : { connectedFolderName: entry.connectedFolderName }),
    ...(entry.payload.kind === "skill" ? { scope: entry.payload.scope } : {}),
    originalPath: entry.originalPath,
    name: entry.displayName ?? (entry.payload.kind === "tree"
      ? entry.payload.name
      : entry.payload.kind === "skill"
        ? entry.payload.skillName
      : entry.payload.kind === "app-release"
        ? `Release ${entry.payload.displayVersion}`
        : entry.payload.kind === "app-studio" ? "App Studio history" : entry.payload.appId),
    sizeBytes: entry.sizeBytes,
    ...(entry.sizeApproximate ? { sizeApproximate: true as const } : {}),
    deletedAt: entry.deletedAt,
    restoreBy: entry.restoreBy,
    receiptId: entry.receiptId,
    ...(entry.uncovered ? { uncovered: entry.uncovered } : {}),
    ...(entry.held ? { held: entry.held } : {}),
    restorable: "in-place",
  };
  if (entry.kind === "file" || entry.kind === "folder") {
    if (isAmpleFileAgentConversationRecentlyDeletedEntry(entry)) return base;
    const present = registered ? registered.has(entry.connectedFolderId) : Boolean(await getConnectedFolder(entry.connectedFolderId).catch(() => null));
    // A file or folder goes back into its own Connected Folder or nowhere: AmpleFile
    // never guesses another Connected Folder for someone's content.
    return present
      ? base
      : { ...base, restorable: "blocked", note: "The Connected Folder this came from is no longer registered." };
  }
  if (entry.kind === "connected-folder") return base;
  if (entry.kind === "skill") {
    // A Connected Folder Skill goes back only into its own Connected Folder's .pi/skills.
    if (entry.payload.kind !== "skill") return { ...base, restorable: "blocked" };
    if (entry.payload.scope === "everywhere") return base;
    const present = registered ? registered.has(entry.connectedFolderId) : Boolean(await getConnectedFolder(entry.connectedFolderId).catch(() => null));
    return present
      ? base
      : { ...base, restorable: "blocked", note: "The Connected Folder this Skill came from is no longer registered." };
  }
  // Data, Releases, and App Studio history older builds kept for Connected
  // Folder apps: listed until they expire, never restored.
  return { ...base, restorable: "blocked", note: retiredAppEntryNote };
}

/** Why an entry an older build kept for a Connected Folder app cannot come back. */
const retiredAppEntryNote = "AmpleFile no longer has Connected Folder apps, so this cannot be restored. It is deleted when it expires.";

/**
 * Brings one Recently deleted entry back (docs/act-ledger.md).
 * A file or folder returns to its Connected Folder at its original path, renamed when
 * something else took the name, and the restore itself is History-undoable.
 * A Connected Folder's folder returns to the managed base and is re-registered with its
 * portable identity, so its Chats and History come with it. What older
 * builds kept for Connected Folder apps never comes back.
 */
export async function restoreRecentlyDeletedEntry(
  state: LocalApiState,
  id: string,
  context: { receiptId: string | null },
): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  if (!ampleFileRecentlyDeletedEntryIdPattern.test(id)) {
    throw new AmpleFileCliError("usage", "That is not a Recently deleted item id.");
  }
  const entry = await state.recentlyDeleted.get(id).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  if (!entry) throw new AmpleFileCliError("notFound", "That item is no longer in Recently deleted.");
  if (entry.kind === "app-storage" || entry.kind === "app-retained" || entry.kind === "app-release" || entry.kind === "app-studio") {
    throw new AmpleFileCliError("conflict", retiredAppEntryNote);
  }
  if (entry.kind === "skill") return restoreRecentlyDeletedSkill(state, entry);
  if (entry.kind === "connected-folder") return restoreRecentlyDeletedConnectedFolder(state, entry);
  if (isAmpleFileAgentConversationRecentlyDeletedEntry(entry)) return restoreAmpleFileAgentConversationRecentlyDeletedEntry(state, entry);
  if (isConnectedFolderConversationRecentlyDeletedEntry(entry)) return restoreConnectedFolderConversationRecentlyDeletedEntry(state, entry);
  const connectedFolder = await getConnectedFolder(entry.connectedFolderId).catch(() => null);
  if (!connectedFolder) {
    throw new AmpleFileCliError(
      "conflict",
      "The Connected Folder this came from is no longer registered, so there is nowhere to put it back. Register that Connected Folder again first.",
    );
  }
  const destination = resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, entry.originalPath);
  const restored = await state.recentlyDeleted.restoreTree(id, { absolutePath: destination }).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  const relativePath = normalizeConnectedFolderRelativePath(relative(connectedFolder.connectedFolderRoot, restored.restoredPath));
  // Restoring is additive, so its own undo is a restore point that removes
  // what came back — the same shape `files add` records. The tree is already
  // back and the entry is already gone by now, so a History failure here is
  // reported as a missing undo point, never as a failed restore: the
  // additive-write rollback helper is the wrong shape, because its rollback
  // would delete exactly the content just restored.
  const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
    deleteOnRestore: [relativePath],
    reason: "post_restore",
    label: `Before restoring ${basename(restored.restoredPath)} from Recently deleted`,
  }).catch(() => null);
  await touchConnectedFolderRoot(connectedFolder.connectedFolderRoot).catch(() => undefined);
  publishControlHint(state, "connected-folders");
  return {
    kind: entry.kind,
    entryId: entry.id,
    connectedFolder: toActConnectedFolderRef(connectedFolder),
    path: relativePath,
    renamed: restored.renamed,
    safetyCheckpointId: safety?.checkpointId ?? null,
  };
}

function isAmpleFileAgentConversationRecentlyDeletedEntry(entry: AmpleFileRecentlyDeletedEntry): boolean {
  return entry.kind === "file"
    && entry.reason === "agent.chat.delete"
    && entry.connectedFolderId === ampleFileAgentScopeId
    && /^\.amplefile\/conversations\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.jsonl$/.test(entry.originalPath);
}

function isConnectedFolderConversationRecentlyDeletedEntry(entry: AmpleFileRecentlyDeletedEntry): boolean {
  return entry.kind === "file"
    && entry.reason === "chats.delete"
    && entry.connectedFolderId !== ampleFileAgentScopeId
    && /^\.amplefile\/conversations\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.jsonl$/.test(entry.originalPath);
}

/**
 * A Worker Chat goes back into its own Connected Folder's `.amplefile/conversations/`
 * under the same transcript name, or nowhere: AmpleFile never guesses another
 * Connected Folder, and never collision-renames a transcript into a different identity.
 */
async function restoreConnectedFolderConversationRecentlyDeletedEntry(
  state: LocalApiState,
  entry: AmpleFileRecentlyDeletedEntry,
): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  const connectedFolder = await getConnectedFolder(entry.connectedFolderId).catch(() => null);
  if (!connectedFolder) {
    throw new AmpleFileCliError(
      "conflict",
      "The folder this Chat came from is no longer registered, so there is nowhere to put it back. Add that folder again first.",
    );
  }
  const conversationId = basename(entry.originalPath, ".jsonl");
  return runActOperation(() => runConversationMutation(state, connectedFolder.id, conversationId, async () => {
    const destination = resolve(connectedFolder.connectedFolderRoot, entry.originalPath);
    if (!pathContainsPath(conversationsDir(connectedFolder.connectedFolderRoot), destination)) {
      throw new AmpleFileCliError("failure", "This Chat recovery item has an invalid destination.");
    }
    if (existsSync(destination)) {
      throw new AmpleFileCliError("conflict", "A Chat with this identity already exists. Remove that Chat before restoring this one.");
    }
    await mkdir(conversationsDir(connectedFolder.connectedFolderRoot), { recursive: true });
    const restored = await state.recentlyDeleted.restoreTree(entry.id, { absolutePath: destination, onConflict: "error" }).catch((error: unknown) => {
      throw recentlyDeletedCliError(error);
    });
    publishControlHint(state, "connected-folders");
    return {
      kind: "file",
      entryId: entry.id,
      connectedFolder: toActConnectedFolderRef(connectedFolder),
      path: `.amplefile/conversations/${basename(restored.restoredPath)}`,
      renamed: restored.renamed,
      // `.amplefile/` is excluded from History capture, so there is no restore point.
      safetyCheckpointId: null,
    };
  }));
}

async function restoreAmpleFileAgentConversationRecentlyDeletedEntry(
  state: LocalApiState,
  entry: AmpleFileRecentlyDeletedEntry,
): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  const root = ampleFileAgentRoot();
  const destination = resolve(root, entry.originalPath);
  if (!pathContainsPath(root, destination)) {
    throw new AmpleFileCliError("failure", "This AmpleFile Agent Chat recovery item has an invalid destination.");
  }
  // A transcript filename is the Chat identity. Unlike ordinary Connected Folder files,
  // collision-renaming it would create an invalid or different conversation,
  // so leave the recovery item intact until the current Chat is removed.
  if (existsSync(destination)) {
    throw new AmpleFileCliError("conflict", "A Chat with this identity already exists. Remove that Chat before restoring this one.");
  }
  const restored = await state.recentlyDeleted.restoreTree(entry.id, { absolutePath: destination, onConflict: "error" }).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  return {
    kind: "file",
    entryId: entry.id,
    connectedFolder: { id: ampleFileAgentScopeId, name: "AmpleFile Agent", connectedFolderRoot: root },
    path: `.amplefile/conversations/${basename(restored.restoredPath)}`,
    renamed: restored.renamed,
    // Management Chats are machine-local and never belong to Connected Folder History.
    safetyCheckpointId: null,
  };
}

/**
 * A removed Skill goes back into the same scope's skills folder at the same
 * path, under the same capability fence and client reload as an install, so
 * the next turn loads it. It never lands beside a Skill Pi already loads under
 * the same name, or over an existing folder: the item stays in Recently
 * deleted until that one is removed.
 */
async function restoreRecentlyDeletedSkill(
  state: LocalApiState,
  entry: AmpleFileRecentlyDeletedEntry,
): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  const payload = entry.payload;
  if (payload.kind !== "skill") throw new AmpleFileCliError("failure", "This Skill recovery item is damaged.");
  let target: { id: string; connectedFolderRoot: string };
  let connectedFolder: ConnectedFolderSummary | null = null;
  if (payload.scope === "connected-folder") {
    connectedFolder = await getConnectedFolder(entry.connectedFolderId).catch(() => null);
    if (!connectedFolder) {
      throw new AmpleFileCliError(
        "conflict",
        "The Connected Folder this Skill came from is no longer registered, so there is nowhere to put it back. Register that Connected Folder again first.",
      );
    }
    target = connectedFolder;
  } else {
    // The same resolution context `tools remove --scope everywhere` uses.
    target = { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentRoot() };
  }
  const restored = await runActOperation(() => runCapabilityMutation(state, target, payload.scope === "connected-folder" ? "project" : "global", async () => {
    try {
      return await restorePiSkill(target.connectedFolderRoot, {
        scope: payload.scope === "connected-folder" ? "project" : "user",
        relativePath: entry.originalPath,
        skillName: payload.skillName,
        putBack: (destination) => state.recentlyDeleted.restoreTree(entry.id, { absolutePath: destination, onConflict: "error" }),
      }, state.runtimeProvider);
    } catch (error) {
      if (error instanceof PiSkillRestoreConflictError) throw new AmpleFileCliError("conflict", error.message, { cause: error });
      if (error instanceof AmpleFileRecentlyDeletedError) throw recentlyDeletedCliError(error);
      throw error;
    }
  }));
  return {
    kind: "skill",
    entryId: entry.id,
    scope: payload.scope,
    ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
    name: payload.skillName,
    path: restored.restored.restoredPath,
  };
}

async function restoreRecentlyDeletedConnectedFolder(state: LocalApiState, entry: AmpleFileRecentlyDeletedEntry): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  // A portable identity that is registered somewhere else is a real conflict:
  // AmpleFile never adopts one Connected Folder's records into another folder.
  if ((await listConnectedFolders()).some((connectedFolder) => connectedFolder.id === entry.connectedFolderId)) {
    throw new AmpleFileCliError(
      "conflict",
      `A Connected Folder with this identity is already registered. Remove that registration before restoring "${entry.connectedFolderName ?? entry.originalPath}".`,
    );
  }
  const restored = await state.recentlyDeleted.restoreTree(entry.id, {
    absolutePath: entry.originalPath,
    stateDirFor: (finalPath) => connectedFolderStateDir(finalPath),
  }).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  let connectedFolder: ConnectedFolderSummary;
  try {
    connectedFolder = await registerManagedConnectedFolder(
      restored.restoredPath,
      entry.connectedFolderName ?? basename(restored.restoredPath),
      state.connectedFolderBase,
    );
  } catch (error) {
    // The folder is back on disk with its portable identity; only the
    // registration failed, so say where it is instead of implying it is lost.
    throw new AmpleFileCliError(
      "conflict",
      `The folder is back at ${restored.restoredPath}, but AmpleFile could not register it as a Connected Folder: ${errorMessage(error)} `
        + "Connect Folder in Manage Connected Folders to finish bringing it back.",
      { cause: error },
    );
  }
  state.connectedFolderTrustAuthority.grant(connectedFolder.connectedFolderRoot);
  await state.automations.handleConnectedFolderReRegistered(connectedFolder.id).catch(() => undefined);
  publishControlHint(state, "connected-folders");
  return {
    kind: "connected-folder",
    entryId: entry.id,
    connectedFolder: toActConnectedFolderRef(connectedFolder),
    connectedFolderRoot: connectedFolder.connectedFolderRoot,
    renamed: restored.renamed,
  };
}

/** Store failures become the act lane's typed errors; nothing leaks a stack. */
function recentlyDeletedCliError(error: unknown): AmpleFileCliError {
  if (!(error instanceof AmpleFileRecentlyDeletedError)) {
    return new AmpleFileCliError("failure", errorMessage(error), { cause: error });
  }
  const code = error.code === "NOT_FOUND"
    ? "notFound"
    : error.code === "INPUT_INVALID"
      ? "usage"
      : error.code === "HELD"
        ? "conflict"
        : "failure";
  return new AmpleFileCliError(code, error.message, { cause: error });
}
