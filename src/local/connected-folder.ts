import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync } from "node:fs";
import {
  copyFile,
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import { isOfficeDocumentPath, isOfficeLockFileName, officeDocumentLockPresent } from "./office-lock-files.js";
import {
  managedConnectedFolderRoot,
  connectedFolderStateDir,
  ampleFileStateRoot,
  connectedFolderManifestFile,
  connectedFolderRegistryFile,
} from "./state-paths.js";
import { isAlwaysHiddenConnectedFolderEntry, isConnectedFolderIgnored, readConnectedFolderIgnoreState } from "./connected-folder-ignore.js";
import { containsReservedConnectedFolderPathSegment } from "./connected-folder-path-policy.js";
import { productIdentity } from "../shared/product-identity.js";

import type { ConnectedFolderLocation, ConnectedFolderSummary } from "../shared/connected-folder-summary.js";
export type { ConnectedFolderLocation, ConnectedFolderSummary } from "../shared/connected-folder-summary.js";

export interface TreeEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt?: string;
  ignored?: boolean;
  descendantIgnoredCount?: number;
  hasChildren?: boolean;
  children?: TreeEntry[];
  /** This folder is its own registered Connected Folder: the walk stops at its boundary. */
  nestedFolder?: true;
}

export interface ConnectedFolderEntryInfo {
  name: string;
  path: string;
  kind: "file" | "folder";
  sizeBytes: number;
  createdAt: string;
  modifiedAt: string;
  extension: string | null;
  mimeType: string;
  hashSha256: string | null;
  officeDocument: boolean;
  openInOffice: boolean;
}

export interface ConnectedFolderMovedEntry {
  fromPath: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  updatedAt: string;
}

export interface ConnectedFolderCreatedEntry {
  path: string;
  name: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt: string;
}

export interface ConnectedFolderTreeOptions {
  includeIgnored?: boolean;
  /**
   * Relative paths of Connected Folders registered inside this one. Each is listed as a
   * boundary entry with no children, the same separate ownership History and
   * Search already honor; a lazy read below one returns nothing.
   */
  nestedFolderPaths?: readonly string[];
}

export interface ConnectedFolderRemovalIntent {
  transactionId: string;
  connectedFolderId: string;
  connectedFolderRoot: string;
  storage: ConnectedFolderLocation["storage"];
  managedBase: string | null;
  managedRootIdentity: ManagedConnectedFolderRootIdentity | null;
  managedRootClaimed: boolean;
  /**
   * Present exactly on a managed registration removal that keeps the folder
   * (`connected-folders unregister` for managed storage, docs/act-ledger.md). A
   * preserve intent carries no managed-content deletion authority — no base,
   * no root identity, no claim — so neither finalization nor crash recovery
   * can ever delete under it. Absent means the managed folder is deleted,
   * exactly the pre-existing intent shape.
   */
  folderDisposition?: "preserve";
  /**
   * `app-state-removed` is read only: an earlier build marked an intent once
   * the Connected Folder's app state was gone. Either phase finalizes.
   */
  phase: "requested" | "app-state-removed";
  requestedAt: string;
}

export interface ManagedConnectedFolderRootIdentity {
  realPath: string;
  managedBaseRealPath: string;
  device: string;
  inode: string;
}

export interface ConnectedFolderRemovalResult {
  removed: true;
  deleted: boolean;
  connectedFolderRoot: string;
  cleanupPending: boolean;
}

export interface ConnectedFolderRegistry {
  version: 1;
  connectedFolders: ConnectedFolderSummary[];
  pendingRemovals: ConnectedFolderRemovalIntent[];
}

export interface ConnectedFolderRemovalIo {
  persistRegistry(registry: ConnectedFolderRegistry): Promise<void>;
  claimManagedRoot(connectedFolderRoot: string, claimPath: string): Promise<void>;
  restoreMismatchedManagedClaim(claimPath: string, connectedFolderRoot: string): Promise<void>;
  removeClaimedManagedRoot(claimPath: string): Promise<void>;
  removeConnectedFolderState(connectedFolderRoot: string): Promise<void>;
}

interface PortableConnectedFolderManifest {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

const maxPreviewBytes = 2 * 1024 * 1024;
const treeScanConcurrency = 64;

export async function listConnectedFolders(): Promise<ConnectedFolderSummary[]> {
  const connectedFolders = listedConnectedFolders(await readRegistry());
  await Promise.all(connectedFolders.map(refreshPortableManifest));
  return connectedFolders;
}

/** Registered Connected Folders a listing shows: not being removed, present on disk, and (when linked) clear of app state. */
function listedConnectedFolders(registry: ConnectedFolderRegistry, connectedFolderId?: string): ConnectedFolderSummary[] {
  const removingIds = new Set(registry.pendingRemovals.map((intent) => intent.connectedFolderId));
  return registry.connectedFolders
    .filter((connectedFolder) => connectedFolderId === undefined || connectedFolder.id === connectedFolderId)
    .filter((connectedFolder) => !removingIds.has(connectedFolder.id))
    .filter((connectedFolder) => existsSync(connectedFolder.connectedFolderRoot))
    .filter((connectedFolder) => connectedFolder.location.storage !== "linked" || linkedConnectedFolderStateSeparated(connectedFolder.connectedFolderRoot) || insideManagedConnectedFolder(connectedFolder.connectedFolderRoot, registry))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function refreshPortableManifest(connectedFolder: ConnectedFolderSummary): Promise<void> {
  try {
    await writePortableManifest(connectedFolder);
  } catch {
    // A previously linked folder can become read-only or temporarily unavailable.
    // Registry-backed listing must remain usable; the next successful mutation retries.
  }
}

export async function createManagedConnectedFolder(name: string, baseDir = managedConnectedFolderRoot()): Promise<ConnectedFolderSummary> {
  const normalizedName = normalizeConnectedFolderName(name);
  await mkdir(baseDir, { recursive: true });
  const connectedFolderRoot = await nextAvailableDirectory(baseDir, safeSegment(normalizedName) || "connected-folder");
  await mkdir(connectedFolderRoot, { recursive: false });
  try {
    return await registerConnectedFolder({
      name: normalizedName,
      connectedFolderRoot,
      location: { kind: "local", storage: "managed" },
    });
  } catch (error) {
    await rm(connectedFolderRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Registers a managed folder that already exists inside the managed base —
 * the path a Connected Folder's folder takes when it comes back from Recently deleted
 * (docs/act-ledger.md). The folder's portable
 * `.amplefile/connected-folder.json` identity is reused, so a restored Connected Folder keeps its
 * id, its Chats, and its History. Creating a brand-new managed folder stays
 * `createManagedConnectedFolder`.
 */
export async function registerManagedConnectedFolder(
  connectedFolderRoot: string,
  name: string,
  baseDir = managedConnectedFolderRoot(),
): Promise<ConnectedFolderSummary> {
  const safeRoot = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const base = resolve(baseDir);
  if (samePath(safeRoot, base) || !pathContains(base, safeRoot)) {
    throw new Error("AmpleFile only registers a managed Connected Folder inside its managed-content folder.");
  }
  const info = await stat(safeRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("The folder for this Connected Folder does not exist.");
  return registerConnectedFolder({
    name: normalizeConnectedFolderName(name),
    connectedFolderRoot: safeRoot,
    location: { kind: "local", storage: "managed" },
  });
}

/**
 * Records a content mutation a caller performed through another path (the
 * trash move behind `files delete`), so the registry's `updatedAt` and the
 * portable manifest stay as truthful as they are after `deleteConnectedFolderEntry`.
 */
export async function touchConnectedFolderRoot(connectedFolderRoot: string): Promise<void> {
  await touchConnectedFolder(ensureSafeConnectedFolderRoot(connectedFolderRoot));
}

export async function registerLinkedConnectedFolder(connectedFolderRoot: string, providerHint?: "google-drive"): Promise<ConnectedFolderSummary> {
  const safeRoot = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  if (!insideManagedConnectedFolder(safeRoot, await readRegistry())) assertLinkedConnectedFolderStateSeparation(safeRoot);
  const info = await stat(safeRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("The folder selected for this Connected Folder does not exist.");
  return registerConnectedFolder({
    name: basename(safeRoot),
    connectedFolderRoot: safeRoot,
    location: {
      kind: "local",
      storage: "linked",
      ...(providerHint === "google-drive" || looksLikeGoogleDrivePath(safeRoot) ? { providerHint: "google-drive" as const } : {}),
    },
  });
}

/**
 * The lookup nearly every request makes. It applies listConnectedFolders()'s
 * filters to this one Connected Folder and refreshes only its manifest, rather
 * than reading and rewriting every registered Connected Folder's manifest.
 */
export async function getConnectedFolder(connectedFolderId: string): Promise<ConnectedFolderSummary> {
  assertId(connectedFolderId);
  const [connectedFolder] = listedConnectedFolders(await readRegistry(), connectedFolderId);
  if (!connectedFolder) throw notFound("Connected Folder not found.");
  await refreshPortableManifest(connectedFolder);
  return connectedFolder;
}

export async function renameConnectedFolder(connectedFolderId: string, name: string): Promise<ConnectedFolderSummary> {
  assertId(connectedFolderId);
  const normalizedName = normalizeConnectedFolderName(name);
  return withRegistryMutation(async () => {
    const registry = await readRegistry();
    const connectedFolder = registry.connectedFolders.find((item) => item.id === connectedFolderId);
    if (!connectedFolder || registry.pendingRemovals.some((intent) => intent.connectedFolderId === connectedFolderId)
      || !existsSync(connectedFolder.connectedFolderRoot)) throw notFound("Connected Folder not found.");
    connectedFolder.name = normalizedName;
    connectedFolder.updatedAt = new Date().toISOString();
    await commitRegistryAndPortableManifest(registry, connectedFolder);
    return connectedFolder;
  });
}

/**
 * Persists the user-authorized removal before any content cleanup. From
 * this point the Connected Folder is intentionally hidden from every registry projection;
 * startup recovery can safely roll the operation forward after a crash.
 */
export async function beginConnectedFolderRemoval(
  connectedFolderId: string,
  managedBase = managedConnectedFolderRoot(),
  io: Partial<ConnectedFolderRemovalIo> = {},
  options: { folderDisposition?: "delete" | "preserve" } = {},
): Promise<ConnectedFolderRemovalIntent> {
  assertId(connectedFolderId);
  const requestedDisposition = options.folderDisposition ?? "delete";
  return withRegistryOwnershipMutation(() => registeredRootsForId(connectedFolderId), async (claim) => {
    const registry = await readRegistry();
    const existing = registry.pendingRemovals.find((intent) => intent.connectedFolderId === connectedFolderId);
    if (existing) {
      claim(existing.connectedFolderRoot);
      // An in-flight intent's folder authority is settled; converting a
      // pending deletion into a preservation (or the reverse) mid-flight
      // would make crash recovery act on an authority the caller never held.
      if (existing.storage === "managed"
        && (existing.folderDisposition === "preserve") !== (requestedDisposition === "preserve")) {
        throw new Error("A Connected Folder removal with a different folder disposition is already in progress.");
      }
      if (existing.storage === "managed" && existing.folderDisposition !== "preserve") {
        assertNoNestedConnectedFolderDeletion(registry, existing.connectedFolderId, existing.connectedFolderRoot);
      }
      return structuredClone(existing);
    }
    const connectedFolder = registry.connectedFolders.find((item) => item.id === connectedFolderId);
    if (!connectedFolder || !existsSync(connectedFolder.connectedFolderRoot)) throw notFound("Connected Folder not found.");
    claim(connectedFolder.connectedFolderRoot);
    const connectedFolderRoot = ensureSafeConnectedFolderRoot(connectedFolder.connectedFolderRoot);
    // A preserve removal deletes nothing, so it records no managed-content
    // boundary and no root identity: the intent shape itself proves the
    // deletion machinery has nothing to act on.
    const preserveManagedFolder = connectedFolder.location.storage === "managed" && requestedDisposition === "preserve";
    const base = connectedFolder.location.storage === "managed" && !preserveManagedFolder ? resolve(managedBase) : null;
    if (base) assertNoNestedConnectedFolderDeletion(registry, connectedFolder.id, connectedFolderRoot);
    if (base && (samePath(connectedFolderRoot, base) || !pathContains(base, connectedFolderRoot))) {
      throw new Error("AmpleFile will only delete a managed Connected Folder inside its registered managed-content folder.");
    }
    const managedRootIdentity = base !== null
      ? await captureManagedRootIdentity(connectedFolderRoot, base)
      : null;
    const intent: ConnectedFolderRemovalIntent = {
      transactionId: `space-removal_${randomUUID()}`,
      connectedFolderId: connectedFolder.id,
      connectedFolderRoot,
      storage: connectedFolder.location.storage,
      managedBase: base,
      managedRootIdentity,
      managedRootClaimed: false,
      ...(preserveManagedFolder ? { folderDisposition: "preserve" as const } : {}),
      phase: "requested",
      requestedAt: new Date().toISOString(),
    };
    registry.pendingRemovals.push(intent);
    await removalIo(io).persistRegistry(registry);
    return structuredClone(intent);
  });
}

export async function listPendingConnectedFolderRemovals(): Promise<ConnectedFolderRemovalIntent[]> {
  return (await readRegistry()).pendingRemovals.map((intent) => structuredClone(intent));
}

export async function finalizeConnectedFolderRemoval(
  connectedFolderId: string,
  io: Partial<ConnectedFolderRemovalIo> = {},
): Promise<ConnectedFolderRemovalResult> {
  assertId(connectedFolderId);
  return withRegistryOwnershipMutation(() => registeredRootsForId(connectedFolderId), async (claim) => {
    const registry = await readRegistry();
    const intent = registry.pendingRemovals.find((item) => item.connectedFolderId === connectedFolderId);
    if (!intent) throw new Error("Connected Folder removal intent not found.");
    claim(intent.connectedFolderRoot);
    const connectedFolder = registry.connectedFolders.find((item) => item.id === connectedFolderId);
    if (!connectedFolder || !samePath(connectedFolder.connectedFolderRoot, intent.connectedFolderRoot)
      || connectedFolder.location.storage !== intent.storage) {
      throw new Error("Connected Folder removal intent no longer matches the registered Connected Folder.");
    }
    validateConnectedFolderRemovalIntent(intent);
    if (intent.storage === "managed" && intent.folderDisposition !== "preserve") {
      assertNoNestedConnectedFolderDeletion(registry, intent.connectedFolderId, intent.connectedFolderRoot);
    }
    const operations = removalIo(io);
    let deleted = false;
    // A preserve intent carries no deletion authority (null base, null root
    // identity), so the managed claim-and-delete machinery below must never
    // run for it: the registration goes, the folder stays.
    if (intent.storage === "managed" && intent.folderDisposition !== "preserve") {
      const claimPath = managedRemovalClaimPath(intent);
      let claimStatus = await managedClaimStatus(intent);
      if (claimStatus === "mismatch") {
        if (await managedRootStatus(intent) === "absent") {
          await operations.restoreMismatchedManagedClaim(claimPath, intent.connectedFolderRoot).catch(() => undefined);
        }
        return connectedFolderRemovalPendingResult(intent);
      }
      if (claimStatus === "unavailable") {
        return connectedFolderRemovalPendingResult(intent);
      }

      if (claimStatus === "absent") {
        const rootStatus = await managedRootStatus(intent);
        if (rootStatus === "absent") {
          deleted = true;
        } else if (rootStatus === "mismatch" && intent.managedRootClaimed) {
          // The approved identity was durably claimed and is now absent. A new
          // occupant at the old path is unrelated and must be left untouched.
          deleted = true;
        } else if (rootStatus !== "matching") {
          return connectedFolderRemovalPendingResult(intent);
        } else {
          try {
            await operations.claimManagedRoot(intent.connectedFolderRoot, claimPath);
          } catch {
            return connectedFolderRemovalPendingResult(intent);
          }
          claimStatus = await managedClaimStatus(intent);
          if (claimStatus !== "matching") {
            if (claimStatus === "mismatch" && await managedRootStatus(intent) === "absent") {
              await operations.restoreMismatchedManagedClaim(claimPath, intent.connectedFolderRoot).catch(() => undefined);
            }
            return connectedFolderRemovalPendingResult(intent);
          }
        }
      }

      if (!deleted && !intent.managedRootClaimed) {
        intent.managedRootClaimed = true;
        try {
          await operations.persistRegistry(registry);
        } catch {
          return connectedFolderRemovalPendingResult(intent);
        }
      }

      if (!deleted) {
        claimStatus = await managedClaimStatus(intent);
        if (claimStatus === "matching") {
          try {
            await operations.removeClaimedManagedRoot(claimPath);
          } catch {
            return connectedFolderRemovalPendingResult(intent);
          }
          claimStatus = await managedClaimStatus(intent);
        }
        if (claimStatus !== "absent") return connectedFolderRemovalPendingResult(intent);
        deleted = true;
      }
    }
    try {
      await operations.removeConnectedFolderState(intent.connectedFolderRoot);
    } catch {
      return connectedFolderRemovalPendingResult(intent);
    }

    const next: ConnectedFolderRegistry = {
      ...registry,
      connectedFolders: registry.connectedFolders.filter((item) => item.id !== connectedFolderId),
      pendingRemovals: registry.pendingRemovals.filter((item) => item.connectedFolderId !== connectedFolderId),
    };
    try {
      await operations.persistRegistry(next);
    } catch {
      return connectedFolderRemovalPendingResult(intent);
    }
    return { removed: true, deleted, connectedFolderRoot: intent.connectedFolderRoot, cleanupPending: false };
  });
}

/**
 * Effect-time pin recheck for the prepared `connected-folder.delete-folder` act
 * (docs/act-ledger.md): re-verifies the pinned Connected Folder identity
 * and canonical root against the live registry immediately before the
 * deletion executes. There is no decision time — the verb runs on its first
 * call — so this is the recheck the prepare-pin-journal-execute path performs
 * on its way to the effect. Identity only: managed-base containment and
 * managed-root identity claims are re-verified by the removal machinery
 * itself at execution, exactly as they are for a desktop-initiated deletion.
 */
export async function managedConnectedFolderDeletionPinIssue(
  pins: { connectedFolderId: string; connectedFolderRoot: string },
): Promise<string | null> {
  const connectedFolder = (await listConnectedFolders()).find((item) => item.id === pins.connectedFolderId);
  if (!connectedFolder) return "The pinned Connected Folder is no longer registered.";
  if (connectedFolder.location.storage !== "managed") {
    return "The pinned Connected Folder is not managed by AmpleFile; only a managed Connected Folder's folder can be deleted.";
  }
  if (!samePath(connectedFolder.connectedFolderRoot, pins.connectedFolderRoot)) {
    return "The registered Connected Folder's folder no longer matches the pinned canonical root.";
  }
  return null;
}

export async function connectedFolderRemovalPendingResult(
  intent: Pick<ConnectedFolderRemovalIntent,
    "transactionId" | "connectedFolderRoot" | "storage" | "managedBase" | "managedRootIdentity" | "managedRootClaimed" | "folderDisposition">,
): Promise<ConnectedFolderRemovalResult> {
  const deletes = intent.storage === "managed" && intent.folderDisposition !== "preserve";
  const rootStatus = deletes ? await managedRootStatus(intent) : "mismatch";
  const deleted = deletes
    && await managedClaimStatus(intent) === "absent"
    && (rootStatus === "absent" || (intent.managedRootClaimed && rootStatus === "mismatch"));
  return {
    removed: true,
    deleted,
    connectedFolderRoot: intent.connectedFolderRoot,
    cleanupPending: true,
  };
}

export interface ConnectedFolderTreeScan {
  entries: TreeEntry[];
  /** True when the entry budget stopped the walk before the folder was exhausted. */
  truncated: boolean;
}

interface TreeScanBudget {
  remaining: number;
  truncated: boolean;
}

export async function scanConnectedFolderTree(
  connectedFolderRoot: string,
  maxDepth = 20,
  relativePath = "",
  options: ConnectedFolderTreeOptions = {},
): Promise<ConnectedFolderTreeScan> {
  const safeRoot = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const scanRoot = resolveConnectedFolderPath(safeRoot, relativePath || ".");
  const info = await stat(scanRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Requested Connected Folder tree path is not a folder.");
  const ignoreState = await readConnectedFolderIgnoreState(safeRoot);
  const boundaries = new Set(options.nestedFolderPaths ?? []);
  // Compare the resolved location, as the file system sees it, so
  // `packages//api`, `packages/./api`, or `Packages/api` cannot list a nested
  // Connected Folder's contents through its parent.
  const requested = comparableRelative(relative(safeRoot, scanRoot));
  const comparableBoundaries = [...boundaries].map(comparableRelative);
  if (requested && comparableBoundaries.some((boundary) => requested === boundary || requested.startsWith(`${boundary}/`))) {
    return { entries: [], truncated: false };
  }
  // A Connected Folder is an arbitrary folder and may hold far more entries than a
  // navigator can present. The walk stops at a total entry budget and says so,
  // so a partial tree is never mistaken for the whole Connected Folder.
  const budget: TreeScanBudget = { remaining: maxTreeEntries(), truncated: false };
  const entries = await scanDirectory(
    safeRoot,
    scanRoot,
    0,
    Math.min(Math.max(maxDepth, 0), 50),
    ignoreState.patterns,
    options.includeIgnored !== false,
    createFilesystemLimiter(treeScanConcurrency),
    budget,
    boundaries,
  );
  return { entries, truncated: budget.truncated };
}

function maxTreeEntries(): number {
  const configured = Number(process.env.AMPLEFILE_TREE_MAX_ENTRIES);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 20_000;
}

export async function readConnectedFolderTextFile(connectedFolderRoot: string, relativePath: string): Promise<{ text: string; hashSha256: string }> {
  const path = resolveConnectedFolderPath(connectedFolderRoot, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  if (info.size > maxPreviewBytes) throw new Error("This file is too large to preview (2 MB maximum).");
  const bytes = await readFile(path);
  if (looksBinary(bytes)) throw new Error("This file is binary and cannot be previewed as text.");
  return { text: bytes.toString("utf8"), hashSha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Saves the in-app editor's text over the file in place, so the file keeps its
 * identity: Finder tags and other extended attributes, ACLs, its creation date,
 * hard links, and a read-only file's refusal. The server's "Before editing"
 * restore point covers a write cut short by a crash. When `expectedHashSha256`
 * is given (the hash the editor read), a save over content that changed since,
 * by a Worker or another app, is refused with a 409 instead of silently
 * overwriting it.
 */
export async function writeConnectedFolderTextFile(
  connectedFolderRoot: string,
  relativePath: string,
  text: string,
  options: { expectedHashSha256?: string } = {},
): Promise<{ path: string; text: string; hashSha256: string }> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const path = resolveConnectedFolderPath(root, relativePath);
  await assertOutsideNestedFolders(root, normalizeRelative(relative(root, path)));
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > maxPreviewBytes) throw new Error("This file is too large to edit (2 MB maximum).");
  const expected = options.expectedHashSha256?.trim().toLowerCase();
  if (expected && await sha256File(path).catch(() => null) !== expected) {
    throw Object.assign(new Error("This file changed since it was opened. Reopen it to see the latest version, then make your edit again."), { status: 409, statusCode: 409 });
  }
  await writeFile(path, bytes);
  await touchConnectedFolder(connectedFolderRoot);
  return { path: normalizeRelative(relative(root, path)), text, hashSha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function getConnectedFolderEntryInfo(connectedFolderRoot: string, relativePath: string, options: { hash?: boolean } = {}): Promise<ConnectedFolderEntryInfo> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const path = resolveConnectedFolderPath(root, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw notFound("Connected Folder item not found.");
  const extension = info.isFile() ? extname(path).toLowerCase() || null : null;
  const officeDocument = info.isFile() && isOfficeDocumentPath(path);
  return {
    name: basename(path),
    path: normalizeRelative(relative(root, path)),
    kind: info.isDirectory() ? "folder" : "file",
    sizeBytes: info.isFile() ? info.size : 0,
    createdAt: info.birthtime.toISOString(),
    modifiedAt: info.mtime.toISOString(),
    extension,
    mimeType: info.isDirectory() ? "inode/directory" : contentTypeForExtension(extension),
    hashSha256: info.isFile() && options.hash !== false ? await sha256File(path) : null,
    officeDocument,
    openInOffice: officeDocument ? await officeDocumentLockPresent(path) : false,
  };
}

/**
 * The file tab's read-only inline preview. Text renders from a bounded head
 * read with the truncation disclosed; recognized image types defer to the
 * raw-file route, as do PDFs; binary or oversized content declines with its reason
 * instead of decoding garbage. The read honors the same Connected Folder path policy as
 * every other entry route.
 */
const previewTextByteLimit = 256 * 1024;
const previewImageByteLimit = 12 * 1024 * 1024;
const previewPdfByteLimit = 200 * 1024 * 1024;
const previewImageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg"]);

export interface ConnectedFolderFilePreview {
  kind: "text" | "image" | "pdf" | "none";
  reason?: "folder" | "binary" | "too-large";
  content?: string;
  truncated?: boolean;
  sizeBytes: number;
}

export async function getConnectedFolderFilePreview(connectedFolderRoot: string, relativePath: string): Promise<ConnectedFolderFilePreview> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const path = resolveConnectedFolderPath(root, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw notFound("Connected Folder item not found.");
  if (info.isDirectory()) return { kind: "none", reason: "folder", sizeBytes: 0 };
  const extension = extname(path).toLowerCase();
  if (previewImageExtensions.has(extension)) {
    return info.size <= previewImageByteLimit
      ? { kind: "image", sizeBytes: info.size }
      : { kind: "none", reason: "too-large", sizeBytes: info.size };
  }
  // PDFs render in the built-in viewer from the raw-file route. The renderer
  // holds the whole file as a blob, so very large ones fall back to Open.
  if (extension === ".pdf") {
    return info.size <= previewPdfByteLimit
      ? { kind: "pdf", sizeBytes: info.size }
      : { kind: "none", reason: "too-large", sizeBytes: info.size };
  }
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(Math.min(info.size, previewTextByteLimit));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, bytesRead);
    if (previewLooksBinary(head)) return { kind: "none", reason: "binary", sizeBytes: info.size };
    const truncated = info.size > previewTextByteLimit;
    // A bounded read can split a UTF-8 sequence; drop the dangling
    // replacement character rather than rendering it as content.
    const content = truncated ? head.toString("utf8").replace(/�+$/, "") : head.toString("utf8");
    return { kind: "text", content, truncated, sizeBytes: info.size };
  } finally {
    await handle.close();
  }
}

/** Mirrors the content-search admission rule in search.ts (looksBinary). */
function previewLooksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  return sample.length > 0 && controls / sample.length > 0.1;
}

export async function findExistingConnectedFolderFilePaths(connectedFolderRoot: string, requestedPaths: string[]): Promise<string[]> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const requests = [...new Set(requestedPaths.map(normalizeRelative).filter(Boolean))].slice(0, 32);
  const existing = new Set<string>();
  const unresolvedNames = new Set<string>();
  for (const request of requests) {
    try {
      const path = resolveConnectedFolderPath(root, request);
      if ((await stat(path)).isFile()) {
        existing.add(normalizeRelative(relative(root, path)));
        continue;
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!request.includes("/")) unresolvedNames.add(request.toLocaleLowerCase());
  }
  if (unresolvedNames.size) {
    const matches = new Map<string, string[]>();
    for (const name of unresolvedNames) matches.set(name, []);
    await visitConnectedFolderFiles(root, root, (path, name) => matches.get(name.toLocaleLowerCase())?.push(path));
    for (const paths of matches.values()) if (paths.length === 1 && paths[0]) existing.add(paths[0]);
  }
  return [...existing].sort((left, right) => left.localeCompare(right));
}

/** Every check a move makes before it renames anything; `moveConnectedFolderEntry` and a several-item move both run it. */
async function prepareConnectedFolderMove(
  root: string,
  input: { sourcePath: string; targetFolderPath?: string },
): Promise<{ sourcePath: string; source: string; destination: string }> {
  const sourcePath = normalizeRelative(input.sourcePath);
  const targetFolderPath = normalizeRelative(input.targetFolderPath ?? "");
  if (!sourcePath || sourcePath === ".") throw new Error("Select a file or folder to move.");
  if (targetFolderPath === sourcePath || targetFolderPath.startsWith(`${sourcePath}/`)) throw new Error("Folders cannot be moved into themselves.");
  await assertOutsideNestedFolders(root, sourcePath);
  if (targetFolderPath) await assertOutsideNestedFolders(root, `${targetFolderPath}/${basename(sourcePath)}`);
  const source = resolveConnectedFolderPath(root, sourcePath);
  if (samePath(source, root)) throw new Error("The Connected Folder root cannot be moved.");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) throw notFound(`Connected Folder item not found: ${sourcePath}`);
  const targetFolder = resolveConnectedFolderPath(root, targetFolderPath || ".");
  if (!(await stat(targetFolder)).isDirectory()) throw new Error("Move items into a folder.");
  if (dirname(source) === targetFolder) throw new Error(`${basename(source)} is already in the selected folder.`);
  const destination = join(targetFolder, basename(source));
  if (existsSync(destination)) throw new Error(`A file or folder named ${basename(source)} already exists there.`);
  return { sourcePath, source, destination };
}

/**
 * Several items into one folder, checked together before any of them moves:
 * each passes every check one move makes, and no two share a name. Returns
 * each item's Connected Folder–relative source and destination, in order.
 */
export async function checkConnectedFolderMoves(
  connectedFolderRoot: string,
  sourcePaths: readonly string[],
  targetFolderPath: string,
): Promise<Array<{ fromPath: string; toPath: string }>> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const plans: Array<{ fromPath: string; toPath: string }> = [];
  const named = new Map<string, string>();
  for (const sourcePath of sourcePaths) {
    const plan = await prepareConnectedFolderMove(root, { sourcePath, targetFolderPath });
    const name = basename(plan.destination);
    const other = named.get(name);
    if (other) throw new Error(`${other} and ${plan.sourcePath} have the same name, so they cannot go into one folder.`);
    named.set(name, plan.sourcePath);
    plans.push({ fromPath: plan.sourcePath, toPath: normalizeRelative(relative(root, plan.destination)) });
  }
  return plans;
}

/** The items a several-item move or delete acts on, in order: an item inside another one listed goes with it. */
export function outermostConnectedFolderPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths.map(normalizeRelative))].filter((path) => path && path !== ".");
  const sorted = [...unique].sort((left, right) => left.replaceAll("/", "\u0000") < right.replaceAll("/", "\u0000") ? -1 : 1);
  const kept = new Set<string>();
  let last: string | null = null;
  for (const path of sorted) {
    if (last !== null && path.startsWith(`${last}/`)) continue;
    kept.add(path);
    last = path;
  }
  return unique.filter((path) => kept.has(path));
}

export async function moveConnectedFolderEntry(
  connectedFolderRoot: string,
  input: { sourcePath: string; targetFolderPath?: string },
): Promise<ConnectedFolderMovedEntry> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const { sourcePath, source, destination } = await prepareConnectedFolderMove(root, input);
  await rename(source, destination);
  const movedInfo = await stat(destination);
  await touchConnectedFolder(root);
  return {
    fromPath: sourcePath,
    path: normalizeRelative(relative(root, destination)),
    name: basename(destination),
    kind: movedInfo.isDirectory() ? "folder" : "file",
    updatedAt: movedInfo.mtime.toISOString(),
  };
}

export async function renameConnectedFolderEntry(
  connectedFolderRoot: string,
  input: { path: string; newName: string },
): Promise<ConnectedFolderMovedEntry> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const sourcePath = normalizeRelative(input.path);
  if (!sourcePath || sourcePath === ".") throw new Error("Select a file or folder to rename.");
  const newName = safeFileName(input.newName);
  await assertOutsideNestedFolders(root, sourcePath);
  const source = resolveConnectedFolderPath(root, sourcePath);
  if (samePath(source, root)) throw new Error("The Connected Folder root cannot be renamed.");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) throw notFound("Connected Folder item not found.");
  if (basename(source) === newName) throw new Error("That item already has this name.");
  const destination = join(dirname(source), newName);
  resolveConnectedFolderPath(root, normalizeRelative(relative(root, destination)));
  if (existsSync(destination)) throw new Error(`A file or folder named ${newName} already exists there.`);
  await rename(source, destination);
  const renamedInfo = await stat(destination);
  await touchConnectedFolder(root);
  return {
    fromPath: sourcePath,
    path: normalizeRelative(relative(root, destination)),
    name: newName,
    kind: renamedInfo.isDirectory() ? "folder" : "file",
    updatedAt: renamedInfo.mtime.toISOString(),
  };
}

export async function createConnectedFolderFolder(
  connectedFolderRoot: string,
  parentPath: string,
  name: string,
): Promise<ConnectedFolderCreatedEntry> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const parent = resolveConnectedFolderPath(root, parentPath || ".");
  if (!(await stat(parent)).isDirectory()) throw new Error("Create folders inside a Connected Folder.");
  const safeName = safeFileName(name);
  const destination = join(parent, safeName);
  await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
  if (existsSync(destination)) throw new Error(`A file or folder named ${safeName} already exists there.`);
  await mkdir(destination, { recursive: false });
  const info = await stat(destination);
  await touchConnectedFolder(root);
  return {
    path: normalizeRelative(relative(root, destination)),
    name: safeName,
    kind: "folder",
    updatedAt: info.mtime.toISOString(),
  };
}

export async function createConnectedFolderTextFile(
  connectedFolderRoot: string,
  parentPath: string,
  name: string,
  text = "",
): Promise<ConnectedFolderCreatedEntry> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const parent = resolveConnectedFolderPath(root, parentPath || ".");
  if (!(await stat(parent)).isDirectory()) throw new Error("Create files inside a Connected Folder.");
  const safeName = safeFileName(name);
  const destination = join(parent, safeName);
  await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
  if (Buffer.byteLength(text, "utf8") > maxPreviewBytes) throw new Error("The new file is too large (2 MB maximum).");
  await writeFile(destination, text, { encoding: "utf8", flag: "wx" });
  const info = await stat(destination);
  await touchConnectedFolder(root);
  return {
    path: normalizeRelative(relative(root, destination)),
    name: safeName,
    kind: "file",
    sizeBytes: info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

/**
 * The one resolution a delete performs before it commits to erasing or
 * moving: the same path policy, root refusal, and existence check
 * `deleteConnectedFolderEntry` applies, exposed so the Recently deleted lane
 * (docs/act-ledger.md) can move the exact entry instead.
 */
export async function resolveConnectedFolderDeleteTarget(
  connectedFolderRoot: string,
  relativePath: string,
): Promise<{ absolutePath: string; path: string; kind: "file" | "folder" }> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized === ".") throw new Error("Select a file or folder to delete.");
  await assertOutsideNestedFolders(root, normalized);
  const path = resolveConnectedFolderPath(root, normalized);
  if (samePath(path, root)) throw new Error("The Connected Folder root cannot be deleted.");
  const info = await stat(path).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw notFound("Connected Folder item not found.");
  return { absolutePath: path, path: normalized, kind: info.isDirectory() ? "folder" : "file" };
}

export async function deleteConnectedFolderEntry(connectedFolderRoot: string, relativePath: string): Promise<{ deleted: true; path: string; kind: "file" | "folder" }> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const target = await resolveConnectedFolderDeleteTarget(root, relativePath);
  await rm(target.absolutePath, { recursive: target.kind === "folder", force: false });
  await touchConnectedFolder(root);
  return { deleted: true, path: target.path, kind: target.kind };
}

export async function writeUploadedFiles(
  connectedFolderRoot: string,
  targetFolderPath: string,
  files: Array<{ fileName: string; relativePath?: string; data: Buffer }>,
): Promise<Array<{ path: string; sizeBytes: number }>> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const targetFolder = resolveConnectedFolderPath(root, targetFolderPath || ".");
  const uploads = files.map((file) => ({
    desired: resolveConnectedFolderPath(targetFolder, safeUploadPath(file.relativePath || file.fileName)),
    data: file.data,
  }));
  // Validate the whole batch before making directories or writing an earlier
  // file. The collision name may be a sibling of a nested Connected Folder, so check
  // the actual available destination rather than refusing its occupied name.
  for (const { desired } of uploads) {
    const destination = await nextAvailableFile(desired);
    await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
  }
  await mkdir(targetFolder, { recursive: true });
  const written: Array<{ path: string; sizeBytes: number }> = [];
  const destinations: string[] = [];
  let attempted: string | null = null;
  try {
    for (const { desired, data } of uploads) {
      await mkdir(dirname(desired), { recursive: true });
      const destination = await nextAvailableFile(desired);
      await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
      attempted = destination;
      await writeFile(destination, data, { flag: "wx" });
      attempted = null;
      destinations.push(destination);
      written.push({ path: normalizeRelative(relative(root, destination)), sizeBytes: data.byteLength });
    }
  } catch (error) {
    // The upload batch is one action: a mid-batch failure must not strand the
    // files that already landed, nor a partially written current file.
    await Promise.all([...destinations, ...(attempted ? [attempted] : [])].map((path) =>
      rm(path, { force: true }).catch(() => undefined)));
    throw error;
  }
  await touchConnectedFolder(connectedFolderRoot);
  return written;
}

export async function copyPathIntoConnectedFolder(
  sourcePath: string,
  connectedFolderRoot: string,
  targetFolderPath: string,
): Promise<string> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const targetFolder = resolveConnectedFolderPath(root, targetFolderPath || ".");
  const destination = await nextAvailablePath(join(targetFolder, safeFileName(basename(sourcePath))));
  await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
  await mkdir(targetFolder, { recursive: true });
  try {
    await copyVisiblePath(sourcePath, destination);
  } catch (error) {
    // A folder copy that fails partway must not strand a partial destination.
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await touchConnectedFolder(connectedFolderRoot);
  return normalizeRelative(relative(connectedFolderRoot, destination));
}

export function resolveConnectedFolderPath(connectedFolderRoot: string, relativePath: string): string {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const normalized = normalizeRelative(relativePath || ".");
  if (isAbsolute(relativePath) || normalized.split("/").includes("..")) {
    throw new Error("Path escapes the selected Connected Folder.");
  }
  if (containsReservedConnectedFolderPathSegment(normalized)) {
    throw new Error("Path selects reserved .amplefile, .work-fold, or .pi metadata.");
  }
  const path = resolve(root, normalized || ".");
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Path escapes the selected Connected Folder.");
  assertNoLinkSegments(root, path);
  return path;
}

export function ensureSafeConnectedFolderRoot(connectedFolderRoot: string): string {
  const resolved = resolve(connectedFolderRoot);
  if (!isAbsolute(resolved) || resolved === parse(resolved).root) throw new Error("A filesystem root cannot be used as a Connected Folder.");
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) throw new Error("A Connected Folder cannot be a symbolic link or junction.");
  return resolved;
}

export function assertConnectedFolderDoesNotContainState(connectedFolderRoot: string): void {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const stateRoot = resolve(ampleFileStateRoot());
  if (pathContains(root, stateRoot)) {
    throw new Error("Choose a narrower folder that does not contain AmpleFile application data.");
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function registerConnectedFolder(input: Omit<ConnectedFolderSummary, "id" | "createdAt" | "updatedAt">): Promise<ConnectedFolderSummary> {
  const connectedFolderRoot = resolve(input.connectedFolderRoot);
  return withRegistryOwnershipMutation(() => registrationRoots(connectedFolderRoot), async (claim) => {
    claim(connectedFolderRoot);
    const registry = await readRegistry();
    if (registry.pendingRemovals.some((intent) => intent.storage === "managed"
      && intent.folderDisposition !== "preserve" && !samePath(intent.connectedFolderRoot, connectedFolderRoot)
      && pathContains(intent.connectedFolderRoot, connectedFolderRoot))) {
      throw Object.assign(new Error("This folder belongs to a Connected Folder that is still being removed. Wait for its cleanup before registering it."), { status: 409, statusCode: 409 });
    }
    const existing = registry.connectedFolders.find((connectedFolder) => samePath(connectedFolder.connectedFolderRoot, connectedFolderRoot));
    if (existing) {
      if (registry.pendingRemovals.some((intent) => intent.connectedFolderId === existing.id)) {
        throw new Error("This Connected Folder is still being removed. Restart AmpleFile to retry its cleanup.");
      }
      await writePortableManifest(existing);
      return existing;
    }
    const portableIdentity = await readExistingConnectedFolderManifest(connectedFolderRoot);
    const now = new Date().toISOString();
    if (portableIdentity) {
      const identityOwner = registry.connectedFolders.find((connectedFolder) => connectedFolder.id === portableIdentity.id);
      if (identityOwner) {
        if (registry.pendingRemovals.some((intent) => intent.connectedFolderId === identityOwner.id)) {
          throw new Error("This Connected Folder is still being removed. Restart AmpleFile to retry its cleanup.");
        }
        if (existsSync(identityOwner.connectedFolderRoot)) {
          throw new Error("This Connected Folder identity is already linked to another folder.");
        }
        claim(identityOwner.connectedFolderRoot);
        await relocateConnectedFolderState(identityOwner.connectedFolderRoot, connectedFolderRoot, identityOwner.id);
        identityOwner.name = portableIdentity.name;
        identityOwner.connectedFolderRoot = connectedFolderRoot;
        identityOwner.location = input.location;
        identityOwner.createdAt = portableIdentity.createdAt;
        identityOwner.updatedAt = now;
        await commitRegistryAndPortableManifest(registry, identityOwner);
        return identityOwner;
      }
    }
    const id = portableIdentity?.id ?? stableConnectedFolderId(connectedFolderRoot);
    const identityCollision = registry.connectedFolders.find((connectedFolder) => connectedFolder.id === id);
    if (identityCollision) throw new Error("This Connected Folder identity is already registered to another folder.");
    const connectedFolder: ConnectedFolderSummary = {
      ...input,
      id,
      name: portableIdentity?.name ?? input.name,
      connectedFolderRoot,
      createdAt: portableIdentity?.createdAt ?? now,
      updatedAt: now,
    };
    registry.connectedFolders.push(connectedFolder);
    await commitRegistryAndPortableManifest(registry, connectedFolder);
    return connectedFolder;
  });
}

const touchBatchContext = new AsyncLocalStorage<Set<string>>();

/**
 * Runs a several-item act so the Connected Folders it changes are touched once
 * at its end rather than once per item. Each touch commits the registry and the
 * portable `.amplefile/connected-folder.json` with fsync, so per-item touches
 * multiply disk work and churn a cloud-synced folder. Nested batches join the
 * outermost one. The touch is maintenance after content changes that already
 * happened, so its failure never fails the act.
 */
export async function withConnectedFolderTouchBatch<T>(operation: () => Promise<T>): Promise<T> {
  if (touchBatchContext.getStore()) return operation();
  const roots = new Set<string>();
  try {
    return await touchBatchContext.run(roots, operation);
  } finally {
    for (const root of roots) await touchConnectedFolderNow(root).catch(() => undefined);
  }
}

/** The root a registration change on this id will touch, from a read before its claim. */
async function registeredRootsForId(connectedFolderId: string): Promise<string[]> {
  const registry = await readRegistry();
  const root = registry.connectedFolders.find((item) => item.id === connectedFolderId)?.connectedFolderRoot
    ?? registry.pendingRemovals.find((intent) => intent.connectedFolderId === connectedFolderId)?.connectedFolderRoot;
  return root ? [root] : [];
}

/** The folder being registered and, when its portable identity belongs to a
 * registration whose folder moved, that registration's old root. */
async function registrationRoots(connectedFolderRoot: string): Promise<string[]> {
  const roots = [connectedFolderRoot];
  const portableIdentity = await readExistingConnectedFolderManifest(connectedFolderRoot);
  if (!portableIdentity) return roots;
  const owner = (await readRegistry()).connectedFolders.find((connectedFolder) => connectedFolder.id === portableIdentity.id);
  if (owner && !samePath(owner.connectedFolderRoot, connectedFolderRoot)) roots.push(owner.connectedFolderRoot);
  return roots;
}

async function touchConnectedFolder(connectedFolderRoot: string): Promise<void> {
  const batch = touchBatchContext.getStore();
  if (batch) {
    batch.add(resolve(connectedFolderRoot));
    return;
  }
  await touchConnectedFolderNow(connectedFolderRoot);
}

async function touchConnectedFolderNow(connectedFolderRoot: string): Promise<void> {
  await withRegistryMutation(async () => {
    const registry = await readRegistry();
    const connectedFolder = registry.connectedFolders.find((item) => samePath(item.connectedFolderRoot, connectedFolderRoot));
    if (!connectedFolder || registry.pendingRemovals.some((intent) => intent.connectedFolderId === connectedFolder.id)) return;
    connectedFolder.updatedAt = new Date().toISOString();
    try {
      await commitRegistryAndPortableManifest(registry, connectedFolder);
    } catch {
      // The content mutation already succeeded. Leave both metadata records at their
      // previous values and retry maintenance on a later mutation or Connected Folder listing.
    }
  });
}

async function readRegistry(): Promise<ConnectedFolderRegistry> {
  const file = connectedFolderRegistryFile();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ConnectedFolderRegistry>;
    if (!Array.isArray(parsed.connectedFolders)) throw new Error("Connected Folder registry Connected Folders are invalid.");
    const connectedFolders = parsed.connectedFolders.map((connectedFolder) => {
      if (!isConnectedFolderSummary(connectedFolder)) throw new Error("Connected Folder registry contains an invalid Connected Folder.");
      return { ...connectedFolder, connectedFolderRoot: resolve(connectedFolder.connectedFolderRoot) };
    });
    const pendingRemovals = parsed.pendingRemovals === undefined
      ? []
      : parsed.pendingRemovals.map((intent) => connectedFolderRemovalIntent(intent));
    const connectedFolderById = new Map(connectedFolders.map((connectedFolder) => [connectedFolder.id, connectedFolder]));
    if (new Set(pendingRemovals.map((intent) => intent.connectedFolderId)).size !== pendingRemovals.length
      || new Set(pendingRemovals.map((intent) => intent.transactionId)).size !== pendingRemovals.length
      || pendingRemovals.some((intent) => {
        const connectedFolder = connectedFolderById.get(intent.connectedFolderId);
        return !connectedFolder
          || !samePath(connectedFolder.connectedFolderRoot, intent.connectedFolderRoot)
          || connectedFolder.location.storage !== intent.storage;
      })) {
      throw new Error("Connected Folder registry removal intents are inconsistent.");
    }
    return {
      version: 1,
      connectedFolders,
      pendingRemovals,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConnectedFolderRegistry();
    // An I/O failure or malformed registry is not evidence that the person has
    // no Connected Folders. Keep the last rendered state and surface a retryable failure.
    throw new Error("Connected Folder registry could not be read safely.", { cause: error });
  }
}

async function writeRegistry(registry: ConnectedFolderRegistry): Promise<void> {
  const file = connectedFolderRegistryFile();
  await mkdir(dirname(file), { recursive: true });
  await atomicJsonWrite(file, registry);
}

function emptyConnectedFolderRegistry(): ConnectedFolderRegistry {
  return { version: 1, connectedFolders: [], pendingRemovals: [] };
}

function removalIo(overrides: Partial<ConnectedFolderRemovalIo>): ConnectedFolderRemovalIo {
  return {
    persistRegistry: writeRegistry,
    claimManagedRoot: async (connectedFolderRoot, claimPath) => {
      await rename(connectedFolderRoot, claimPath);
      await syncDirectoriesBestEffort([dirname(connectedFolderRoot), dirname(claimPath)]);
    },
    restoreMismatchedManagedClaim: async (claimPath, connectedFolderRoot) => {
      await rename(claimPath, connectedFolderRoot);
      await syncDirectoriesBestEffort([dirname(claimPath), dirname(connectedFolderRoot)]);
    },
    removeClaimedManagedRoot: async (claimPath) => {
      await rm(claimPath, { recursive: true, force: true });
      await syncDirectoriesBestEffort([dirname(claimPath)]);
    },
    removeConnectedFolderState: async (connectedFolderRoot) => rm(connectedFolderStateDir(connectedFolderRoot), { recursive: true, force: true }),
    ...overrides,
  };
}

type ManagedRootStatus = "matching" | "absent" | "mismatch" | "unavailable";

async function captureManagedRootIdentity(connectedFolderRoot: string, managedBase: string): Promise<ManagedConnectedFolderRootIdentity> {
  const initialInfo = await lstat(connectedFolderRoot, { bigint: true });
  if (!initialInfo.isDirectory() || initialInfo.isSymbolicLink()) {
    throw new Error("A managed Connected Folder root must be an ordinary directory.");
  }
  if (initialInfo.ino === 0n) throw new Error("This filesystem does not expose a stable managed Connected Folder directory identity.");
  const [realPath, managedBaseRealPath] = await Promise.all([realpath(connectedFolderRoot), realpath(managedBase)]);
  const confirmedInfo = await lstat(connectedFolderRoot, { bigint: true });
  if (!confirmedInfo.isDirectory() || confirmedInfo.isSymbolicLink()
    || confirmedInfo.dev !== initialInfo.dev || confirmedInfo.ino !== initialInfo.ino) {
    throw new Error("The managed Connected Folder root changed while its removal identity was being recorded.");
  }
  if (samePath(realPath, managedBaseRealPath) || !pathContains(managedBaseRealPath, realPath)) {
    throw new Error("A managed Connected Folder root must resolve inside its managed-content folder.");
  }
  return {
    realPath: resolve(realPath),
    managedBaseRealPath: resolve(managedBaseRealPath),
    device: confirmedInfo.dev.toString(10),
    inode: confirmedInfo.ino.toString(10),
  };
}

async function managedRootStatus(
  intent: Pick<ConnectedFolderRemovalIntent, "connectedFolderRoot" | "storage" | "managedBase" | "managedRootIdentity">,
): Promise<ManagedRootStatus> {
  return managedDirectoryStatus(intent, intent.connectedFolderRoot, intent.managedRootIdentity?.realPath ?? intent.connectedFolderRoot);
}

async function managedClaimStatus(
  intent: Pick<ConnectedFolderRemovalIntent,
    "transactionId" | "connectedFolderRoot" | "storage" | "managedBase" | "managedRootIdentity">,
): Promise<ManagedRootStatus> {
  const claimPath = managedRemovalClaimPath(intent);
  return managedDirectoryStatus(intent, claimPath, claimPath);
}

async function managedDirectoryStatus(
  intent: Pick<ConnectedFolderRemovalIntent, "storage" | "managedBase" | "managedRootIdentity">,
  path: string,
  expectedRealPath: string,
): Promise<ManagedRootStatus> {
  if (intent.storage !== "managed" || !intent.managedRootIdentity) return "mismatch";
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    return isFileNotFound(error) ? "absent" : "unavailable";
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return "mismatch";
  let currentRealPath: string;
  let currentManagedBaseRealPath: string;
  try {
    [currentRealPath, currentManagedBaseRealPath] = await Promise.all([
      realpath(path),
      realpath(intent.managedBase!),
    ]);
  } catch {
    // Only the lstat above may establish absence. A failure or race after that
    // point is uncertain and must preserve the cleanup intent.
    return "unavailable";
  }
  return info.dev.toString(10) === intent.managedRootIdentity.device
    && info.ino.toString(10) === intent.managedRootIdentity.inode
    && samePath(currentRealPath, expectedRealPath)
    && samePath(currentManagedBaseRealPath, intent.managedRootIdentity.managedBaseRealPath)
    ? "matching"
    : "mismatch";
}

function managedRemovalClaimPath(
  intent: Pick<ConnectedFolderRemovalIntent, "transactionId" | "storage" | "managedRootIdentity">,
): string {
  if (intent.storage !== "managed" || !intent.managedRootIdentity
    || !/^space-removal_[0-9a-f-]{36}$/.test(intent.transactionId)) {
    throw new Error("Managed Connected Folder removal intent cannot derive a safe claim path.");
  }
  const claimPath = resolve(
    intent.managedRootIdentity.managedBaseRealPath,
    `.space-removal-${intent.transactionId.slice("space-removal_".length)}`,
  );
  if (dirname(claimPath) !== resolve(intent.managedRootIdentity.managedBaseRealPath)) {
    throw new Error("Managed Connected Folder removal claim escapes its content boundary.");
  }
  return claimPath;
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

async function syncDirectoriesBestEffort(paths: readonly string[]): Promise<void> {
  for (const path of new Set(paths.map((item) => resolve(item)))) {
    try {
      const directory = await open(path, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Windows does not consistently allow directory handles. The same-volume
      // rename remains the claim point and exact identity is rechecked afterward.
    }
  }
}

const historyContext = new AsyncLocalStorage<Set<string>>();
const ownershipContext = new AsyncLocalStorage<true>();
const activeHistoryRoots = new Set<string>();
const activeOwnershipClaims = new Set<HistoryGateClaim & { kind: "ownership" }>();

/**
 * One History operation on a root, or one change to which folders are
 * registered. A registration change names the roots it registers, relocates,
 * or removes.
 */
type HistoryGateClaim = { kind: "history"; root: string } | { kind: "ownership"; roots: string[] };
const historyGateWaiters: Array<{ claim: HistoryGateClaim; grant: () => void }> = [];

/** A capture or restore on `historyRoot` reads the registrations nested in it,
 * so a registration change conflicts with History on a root that contains one
 * of its roots, sits inside one, or is one. */
function ownershipOverlapsHistory(roots: readonly string[], historyRoot: string): boolean {
  return roots.some((root) => pathContains(root, historyRoot) || pathContains(historyRoot, root));
}

/** History on one root runs one at a time and beside History on other roots;
 * registration changes run beside each other (the registry queue orders them)
 * and beside History on unrelated roots. */
function historyClaimsCompatible(left: HistoryGateClaim, right: HistoryGateClaim): boolean {
  if (left.kind === "ownership" && right.kind === "ownership") return true;
  if (left.kind === "ownership") return right.kind === "history" && !ownershipOverlapsHistory(left.roots, right.root);
  if (right.kind === "ownership") return !ownershipOverlapsHistory(right.roots, left.root);
  return left.root !== right.root;
}

function historyClaimCanStart(claim: HistoryGateClaim): boolean {
  if (claim.kind === "history") {
    return !activeHistoryRoots.has(claim.root)
      && [...activeOwnershipClaims].every((active) => !ownershipOverlapsHistory(active.roots, claim.root));
  }
  return [...activeHistoryRoots].every((root) => !ownershipOverlapsHistory(claim.roots, root));
}

function holdHistoryClaim(claim: HistoryGateClaim): void {
  if (claim.kind === "history") activeHistoryRoots.add(claim.root);
  else activeOwnershipClaims.add(claim);
}

function releaseHistoryClaim(claim: HistoryGateClaim): void {
  if (claim.kind === "history") activeHistoryRoots.delete(claim.root);
  else activeOwnershipClaims.delete(claim);
  pumpHistoryGate();
}

/** Grants waiters in arrival order. A waiter may pass an earlier one only when
 * the two could run together, so a registration change is never starved by a
 * stream of captures on the folders it touches, a capture never overtakes a
 * conflicting earlier one, and work on unrelated folders is never held up. */
function pumpHistoryGate(): void {
  const blocked: HistoryGateClaim[] = [];
  for (let index = 0; index < historyGateWaiters.length;) {
    const waiter = historyGateWaiters[index]!;
    if (historyClaimCanStart(waiter.claim) && blocked.every((earlier) => historyClaimsCompatible(earlier, waiter.claim))) {
      historyGateWaiters.splice(index, 1);
      holdHistoryClaim(waiter.claim);
      waiter.grant();
    } else {
      blocked.push(waiter.claim);
      index += 1;
    }
  }
}

async function acquireHistoryClaim(claim: HistoryGateClaim): Promise<void> {
  await new Promise<void>((grant) => {
    historyGateWaiters.push({ claim, grant });
    pumpHistoryGate();
  });
}

function historyBusyError(message: string): Error {
  return Object.assign(new Error(message), { status: 409, statusCode: 409 });
}

/**
 * Runs `operation` as the one History operation on `connectedFolderRoot`,
 * holding folder ownership stable through a complete capture or restore.
 * Callers queue: an operation on the same root waits for the current one to
 * finish, one on another root runs alongside it, and a registration change
 * waits only for History on the folders it touches. Nested calls for the same
 * root are reentrant. An operation that already holds History or a
 * registration change and asks for a different, busy claim is refused with a
 * 409 rather than queued, because waiting while holding a claim could deadlock.
 */
export async function withConnectedFolderHistoryOperation<T>(connectedFolderRoot: string, operation: () => Promise<T>): Promise<T> {
  const root = resolve(connectedFolderRoot);
  const held = historyContext.getStore();
  if (held?.has(root)) return operation();
  const claim: HistoryGateClaim = { kind: "history", root };
  if (held?.size || ownershipContext.getStore()) {
    if (!historyClaimCanStart(claim)) throw historyBusyError("Wait for the current History or Connected Folder registration operation to finish.");
    holdHistoryClaim(claim);
  } else {
    await acquireHistoryClaim(claim);
  }
  try {
    return await historyContext.run(new Set([...(held ?? []), root]), operation);
  } finally { releaseHistoryClaim(claim); }
}

/** Thrown inside a registration change that found it touches a root its claim did not name. */
class OwnershipClaimTooNarrow extends Error {
  constructor(readonly root: string) { super("Connected Folder registration claim must be widened."); }
}

/**
 * Runs a change to which folders are registered. `claimRoots` names, from a
 * registry read before the claim, the roots the change will touch. Inside,
 * `claim(root)` must be called for every root the change touches before it
 * changes anything; if the registry moved on in between and a new root turns
 * up, the change starts over with a wider claim.
 */
async function withRegistryOwnershipMutation<T>(
  claimRoots: () => Promise<string[]>,
  operation: (claim: (root: string) => void) => Promise<T>,
): Promise<T> {
  let roots = (await claimRoots().catch(() => [] as string[])).map((root) => resolve(root));
  for (let attempt = 0; ; attempt += 1) {
    const claimed = [...roots];
    const claimRoot = (root: string): void => {
      if (!claimed.some((item) => samePath(item, root))) throw new OwnershipClaimTooNarrow(resolve(root));
    };
    try {
      return await withOwnershipClaim({ kind: "ownership", roots: claimed }, () => operation(claimRoot));
    } catch (error) {
      if (!(error instanceof OwnershipClaimTooNarrow) || attempt >= 4) {
        if (error instanceof OwnershipClaimTooNarrow) throw historyBusyError("Connected Folder registrations kept changing. Try again.");
        throw error;
      }
      roots = [...roots, error.root];
    }
  }
}

async function withOwnershipClaim<T>(claim: HistoryGateClaim & { kind: "ownership" }, operation: () => Promise<T>): Promise<T> {
  if (historyContext.getStore()?.size || ownershipContext.getStore()) {
    if (!historyClaimCanStart(claim)) throw historyBusyError("Wait for History to finish before changing registered Connected Folders.");
    holdHistoryClaim(claim);
  } else {
    await acquireHistoryClaim(claim);
  }
  try { return await ownershipContext.run(true, () => withRegistryMutation(operation)); }
  finally { releaseHistoryClaim(claim); }
}

function assertNoNestedConnectedFolderDeletion(registry: ConnectedFolderRegistry, connectedFolderId: string, connectedFolderRoot: string): void {
  if (registry.connectedFolders.some((nested) => nested.id !== connectedFolderId && pathContains(connectedFolderRoot, nested.connectedFolderRoot))) {
    throw Object.assign(new Error("Remove the nested Connected Folder registrations before deleting this Connected Folder."), { status: 409, statusCode: 409 });
  }
}

/**
 * The registered Connected Folders' ids, names, and roots straight from the registry,
 * excluding pending removals. Unlike listConnectedFolders() it never rewrites portable
 * manifests, so a hot path (every turn) can read nesting without
 * touching any Connected Folder on disk.
 */
export async function registeredConnectedFolderOutline(): Promise<Array<{ id: string; name: string; connectedFolderRoot: string }>> {
  const registry = await readRegistry();
  const removingIds = new Set(registry.pendingRemovals.map((intent) => intent.connectedFolderId));
  return registry.connectedFolders
    .filter((connectedFolder) => !removingIds.has(connectedFolder.id))
    .map((connectedFolder) => ({ id: connectedFolder.id, name: connectedFolder.name, connectedFolderRoot: connectedFolder.connectedFolderRoot }));
}

/**
 * Refuses a parent Connected Folder's file operation on a folder that holds a nested
 * registered Connected Folder, or on anything inside one: that content belongs to the
 * nested Connected Folder's own Worker and History.
 */
async function assertOutsideNestedFolders(connectedFolderRoot: string, relativePath: string): Promise<void> {
  const path = comparableRelative(relativePath);
  if (!path) return;
  for (const nested of await nestedRegisteredConnectedFolderPaths(connectedFolderRoot)) {
    const boundary = comparableRelative(nested);
    if (path === boundary || boundary.startsWith(`${path}/`)) {
      throw Object.assign(new Error(`${relativePath} holds the ${nested} Connected Folder, which has its own Worker. Remove that Connected Folder from AmpleFile first, or change it in ${process.platform === "darwin" ? "Finder" : "your file manager"}.`), { status: 409, statusCode: 409 });
    }
    if (path.startsWith(`${boundary}/`)) {
      throw Object.assign(new Error(`${relativePath} belongs to the ${nested} Connected Folder. Open that Connected Folder to change it.`), { status: 409, statusCode: 409 });
    }
  }
}

/**
 * Resolves a folder inside a registered Connected Folder that may become a nested Connected Folder
 * of its own: a real, visible directory below the root that is not
 * already a Connected Folder and does not sit inside one. Returns its absolute path.
 */
export async function resolveNestableFolderPath(connectedFolderRoot: string, relativePath: string): Promise<string> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const normalized = normalizeRelative(relativePath).split("/").filter((part) => part && part !== ".").join("/");
  if (!normalized) throw Object.assign(new Error("Choose a folder inside this Connected Folder."), { status: 400, statusCode: 400 });
  if (normalized.split("/").some((part) => isAlwaysHiddenConnectedFolderEntry(part))) throw Object.assign(new Error("That folder is hidden AmpleFile or Pi data."), { status: 400, statusCode: 400 });
  let target: string;
  try { target = resolveConnectedFolderPath(root, normalized); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error("Choose a folder inside this Connected Folder."), { status: 400, statusCode: 400 }); }
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw notFound("That folder no longer exists here.");
  const path = comparableRelative(normalized);
  for (const nested of await nestedRegisteredConnectedFolderPaths(root)) {
    const boundary = comparableRelative(nested);
    if (path === boundary) throw Object.assign(new Error(`${normalized} already has its own Worker.`), { status: 409, statusCode: 409 });
    if (path.startsWith(`${boundary}/`)) throw Object.assign(new Error(`${normalized} belongs to the ${nested} Connected Folder. Open that Connected Folder to do this.`), { status: 409, statusCode: 409 });
  }
  return target;
}

/** Relative paths as the file system compares them: macOS and Windows ignore case. */
const boundaryKeyCache = new WeakMap<ReadonlySet<string>, Set<string>>();
function boundaryKeys(boundaries: ReadonlySet<string>): Set<string> {
  let keys = boundaryKeyCache.get(boundaries);
  if (!keys) { keys = new Set([...boundaries].map(comparableRelative)); boundaryKeyCache.set(boundaries, keys); }
  return keys;
}

function comparableRelative(value: string): string {
  const normalized = normalizeRelative(value).split("/").filter((part) => part && part !== ".").join("/");
  return process.platform === "darwin" || process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

/** Includes pending removals: their content is still separately owned. */
export async function nestedRegisteredConnectedFolderPaths(connectedFolderRoot: string): Promise<string[]> {
  const root = resolve(connectedFolderRoot);
  const registry = await readRegistry();
  return registry.connectedFolders.filter((connectedFolder) => !samePath(root, connectedFolder.connectedFolderRoot) && pathContains(root, connectedFolder.connectedFolderRoot))
    .map((connectedFolder) => normalizeRelative(relative(root, connectedFolder.connectedFolderRoot)));
}

/** Moves only this product's machine-local state. A marker makes a crash before
 * the registry commit resumable; conflicting destination state is never merged. */
async function relocateConnectedFolderState(fromRoot: string, toRoot: string, connectedFolderId: string): Promise<void> {
  const from = connectedFolderStateDir(fromRoot);
  const to = connectedFolderStateDir(toRoot);
  if (from === to) return;
  const marker = { version: 1, connectedFolderId, fromRoot, toRoot };
  const markerName = "state-relocation.json";
  if (!existsSync(from)) {
    if (existsSync(join(to, markerName))) {
      const prior = JSON.parse(await readFile(join(to, markerName), "utf8"));
      if (JSON.stringify(prior) !== JSON.stringify(marker)) throw new Error("Connected Folder state relocation does not match this folder.");
    } else if (existsSync(to)) throw new Error("Connected Folder state relocation has unrelated destination state.");
    return;
  }
  if ((await lstat(from)).isSymbolicLink() || existsSync(to)) throw new Error("Connected Folder state relocation has a conflicting destination.");
  await atomicJsonWrite(join(from, markerName), marker);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

let registryMutationQueue: Promise<void> = Promise.resolve();

async function withRegistryMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = registryMutationQueue.then(operation, operation);
  registryMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function writePortableManifest(connectedFolder: ConnectedFolderSummary): Promise<void> {
  const file = connectedFolderManifestFile(connectedFolder.connectedFolderRoot);
  await mkdir(dirname(file), { recursive: true });
  let existingFields: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const existing = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (existing && typeof existing === "object" && !Array.isArray(existing)) existingFields = existing as Record<string, unknown>;
    } catch {
      // Invalid fields are replaced by the canonical manifest below.
    }
  }
  const manifest: PortableConnectedFolderManifest & Record<string, unknown> = {
    ...existingFields,
    version: 1,
    id: connectedFolder.id,
    name: connectedFolder.name,
    createdAt: connectedFolder.createdAt,
    updatedAt: connectedFolder.updatedAt,
  };
  await atomicJsonWrite(file, manifest);
}

async function commitRegistryAndPortableManifest(registry: ConnectedFolderRegistry, connectedFolder: ConnectedFolderSummary): Promise<void> {
  const manifestFile = connectedFolderManifestFile(connectedFolder.connectedFolderRoot);
  const previousManifest = await snapshotFile(manifestFile);
  await writePortableManifest(connectedFolder);
  try {
    await writeRegistry(registry);
  } catch (error) {
    try {
      await restoreFileSnapshot(manifestFile, previousManifest);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Connected Folder metadata commit failed and its portable manifest could not be restored.");
    }
    throw error;
  }
}

type FileSnapshot = { exists: false } | { exists: true; contents: string };

async function snapshotFile(file: string): Promise<FileSnapshot> {
  if (!existsSync(file)) return { exists: false };
  return { exists: true, contents: await readFile(file, "utf8") };
}

async function restoreFileSnapshot(file: string, snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.exists) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.rollback.tmp`;
  await writeFile(temp, snapshot.contents, "utf8");
  await rename(temp, file);
}

async function readExistingConnectedFolderManifest(connectedFolderRoot: string): Promise<PortableConnectedFolderManifest | null> {
  const file = connectedFolderManifestFile(connectedFolderRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PortableConnectedFolderManifest>;
    if (!isConnectedFolderId(parsed.id) || typeof parsed.name !== "string") return null;
    if (typeof parsed.createdAt !== "string" || !isValidTimestamp(parsed.createdAt)) return null;
    if (typeof parsed.updatedAt !== "string" || !isValidTimestamp(parsed.updatedAt)) return null;
    return {
      version: 1,
      id: parsed.id,
      name: normalizeConnectedFolderName(parsed.name),
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    // An invalid or partially written AmpleFile manifest must not make its folder unusable.
    return null;
  }
}

async function atomicJsonWrite(file: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(file)) {
    try {
      if (await readFile(file, "utf8") === serialized) return;
    } catch {
      // Replace unreadable or concurrently changed metadata through the atomic path below.
    }
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    const directory = await open(dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Windows does not consistently allow directory handles. The fsynced temp
    // plus atomic rename remains the commit; directory sync is best-effort.
  }
}

async function scanDirectory(
  root: string,
  directory: string,
  depth: number,
  maxDepth: number,
  ignorePatterns: string[],
  includeIgnored: boolean,
  limit: FilesystemLimiter,
  budget: TreeScanBudget,
  boundaries: ReadonlySet<string> = new Set(),
): Promise<TreeEntry[]> {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }
  const entries = (await limit(() => readdir(directory, { withFileTypes: true })))
    .filter((entry) => !entry.isSymbolicLink() && !isAlwaysHiddenConnectedFolderEntry(entry.name) && !isOfficeLockFileName(entry.name))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => {
      const path = join(directory, entry.name);
      const relativePath = normalizeRelative(relative(root, path));
      return { entry, path, relativePath, ignored: isConnectedFolderIgnored(relativePath, ignorePatterns) };
    })
    .filter((item) => includeIgnored || !item.ignored)
    .sort((left, right) => left.entry.isDirectory() === right.entry.isDirectory()
      ? left.entry.name.localeCompare(right.entry.name)
      : left.entry.isDirectory() ? -1 : 1);

  // The budget is applied before inspection, not after. A folder can hold far
  // more entries than the whole walk is allowed to return, and statting all of
  // them to then discard most is the cost this bound exists to avoid.
  const considered = entries.length > budget.remaining ? entries.slice(0, budget.remaining) : entries;
  if (considered.length < entries.length) budget.truncated = true;

  // Every entry needs its own stat for size and modification time. Inspecting a
  // folder's entries together turns one round trip per entry into one bounded
  // batch per folder, which is what a Connected Folder with a large flat folder pays for.
  const inspected = await Promise.all(considered.map(async (item) => {
    // A tree walk races ordinary file activity, so an entry that disappears
    // between readdir and stat is skipped rather than failing the whole Connected Folder.
    const info = await limit(() => stat(item.path).catch(() => null));
    if (!info) return null;
    return { ...item, info };
  }));

  const result: TreeEntry[] = [];
  for (const item of inspected) {
    if (!item) continue;
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;
    if (item.entry.isDirectory() && boundaries.size && boundaryKeys(boundaries).has(comparableRelative(item.relativePath))) {
      result.push({
        name: item.entry.name,
        path: item.relativePath,
        kind: "folder",
        updatedAt: item.info.mtime.toISOString(),
        ...(item.ignored ? { ignored: true } : {}),
        hasChildren: false,
        children: [],
        nestedFolder: true,
      });
      continue;
    }
    if (item.entry.isDirectory()) {
      const childrenLoaded = depth < maxDepth;
      const children = childrenLoaded
        ? await scanDirectory(root, item.path, depth + 1, maxDepth, ignorePatterns, includeIgnored, limit, budget, boundaries)
        : [];
      // An empty child list means "no children" only when the walk was free to
      // look. If the budget ran out first, the folder has to be probed, or a
      // folder that does have contents would present as an empty one.
      const childrenAreComplete = childrenLoaded && budget.remaining > 0;
      const descendantIgnoredCount = children.reduce((total, child) => total + (child.ignored ? 1 : 0) + (child.descendantIgnoredCount ?? 0), 0);
      result.push({
        name: item.entry.name,
        path: item.relativePath,
        kind: "folder",
        updatedAt: item.info.mtime.toISOString(),
        ...(item.ignored ? { ignored: true } : {}),
        ...(descendantIgnoredCount ? { descendantIgnoredCount } : {}),
        hasChildren: childrenAreComplete
          ? children.length > 0
          : children.length > 0 || await directoryHasVisibleEntries(root, item.path, ignorePatterns, includeIgnored, limit),
        children,
      });
    } else {
      result.push({
        name: item.entry.name,
        path: item.relativePath,
        kind: "file",
        sizeBytes: item.info.size,
        updatedAt: item.info.mtime.toISOString(),
        ...(item.ignored ? { ignored: true } : {}),
      });
    }
  }
  return result.sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "folder" ? -1 : 1);
}

async function directoryHasVisibleEntries(
  root: string,
  directory: string,
  ignorePatterns: string[],
  includeIgnored: boolean,
  limit: FilesystemLimiter,
): Promise<boolean> {
  for (const entry of await limit(() => readdir(directory, { withFileTypes: true }).catch(() => []))) {
    if (entry.isSymbolicLink() || isAlwaysHiddenConnectedFolderEntry(entry.name) || isOfficeLockFileName(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const relativePath = normalizeRelative(relative(root, join(directory, entry.name)));
    if (!includeIgnored && isConnectedFolderIgnored(relativePath, ignorePatterns)) continue;
    return true;
  }
  return false;
}

type FilesystemLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Caps how many filesystem calls the tree walk keeps in flight. Only leaf
 * operations pass through the limiter; recursion never holds a slot while
 * waiting for one, so a deep Connected Folder cannot deadlock its own walk.
 */
function createFilesystemLimiter(limit: number): FilesystemLimiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A finished task hands its slot directly to the next waiter instead of
    // releasing it and waking one. Releasing first lets a fresh caller claim
    // the free slot before the woken waiter resumes, so both proceed and the
    // cap is exceeded.
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

async function visitConnectedFolderFiles(root: string, directory: string, visitor: (relativePath: string, name: string) => void): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || isAlwaysHiddenConnectedFolderEntry(entry.name) || isOfficeLockFileName(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visitConnectedFolderFiles(root, path, visitor);
    else if (entry.isFile()) visitor(normalizeRelative(relative(root, path)), entry.name);
  }
}

function contentTypeForExtension(extension: string | null): string {
  switch (extension) {
    case ".txt": return "text/plain";
    case ".md": case ".markdown": return "text/markdown";
    case ".json": return "application/json";
    case ".csv": return "text/csv";
    case ".html": case ".htm": return "text/html";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

async function copyVisiblePath(source: string, destination: string): Promise<void> {
  const info = await stat(source).catch(() => null);
  if (!info) throw notFound("Source not found.");
  if (lstatSync(source).isSymbolicLink()) throw new Error("Symbolic links cannot be copied into a Connected Folder.");
  if (info.isFile()) {
    await copyFile(source, destination, 1);
    return;
  }
  if (!info.isDirectory()) throw new Error("Only ordinary files and folders can be copied.");
  await mkdir(destination, { recursive: false });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    await copyVisiblePath(join(source, entry.name), join(destination, entry.name));
  }
}

async function nextAvailableDirectory(parent: string, segment: string): Promise<string> {
  let candidate = join(parent, segment);
  for (let index = 2; existsSync(candidate); index += 1) candidate = join(parent, `${segment}-${index}`);
  return candidate;
}

async function nextAvailableFile(desired: string): Promise<string> {
  if (!existsSync(desired)) return desired;
  const extension = extname(desired);
  const stem = basename(desired, extension);
  let index = 2;
  let candidate = join(dirname(desired), `${stem} (${index})${extension}`);
  while (existsSync(candidate)) candidate = join(dirname(desired), `${stem} (${index += 1})${extension}`);
  return candidate;
}

async function nextAvailablePath(desired: string): Promise<string> {
  if (!existsSync(desired)) return desired;
  const info = await stat(desired);
  return info.isDirectory() ? nextAvailableDirectory(dirname(desired), basename(desired)) : nextAvailableFile(desired);
}

function assertNoLinkSegments(root: string, path: string): void {
  const rel = relative(root, path);
  if (!rel || rel === ".") return;
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) return;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("Connected Folder paths cannot traverse symbolic links or junctions.");
  }
}

function safeUploadPath(value: string): string {
  const segments = normalizeRelative(value).split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "..")) throw new Error("Uploaded file path is not allowed.");
  return segments.map(safeFileName).join("/");
}

function safeFileName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) throw new Error("File name is not allowed.");
  const windowsStem = name.split(".")[0]?.toLocaleUpperCase() ?? "";
  if (/[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem)) {
    throw new Error("File name is reserved by Windows.");
  }
  return name.slice(0, 240);
}

function normalizeConnectedFolderName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new Error("Connected Folder name is required.");
  return name;
}

function safeSegment(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function normalizeRelative(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "");
}

function stableConnectedFolderId(connectedFolderRoot: string): string {
  const normalized = process.platform === "win32" ? resolve(connectedFolderRoot).toLocaleLowerCase() : resolve(connectedFolderRoot);
  return `space-${createHash("sha256")
    .update(`${productIdentity.productName}:connected-folder-id:v1\0${normalized}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function isConnectedFolderId(value: unknown): value is string {
  return typeof value === "string" && /^space-[a-f0-9]{16}$/.test(value);
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase() : resolve(left) === resolve(right);
}

function assertLinkedConnectedFolderStateSeparation(connectedFolderRoot: string): void {
  if (linkedConnectedFolderStateSeparated(connectedFolderRoot)) return;
  throw new Error("Linked folders cannot contain, or be contained by, AmpleFile application data. Choose a different folder.");
}

/**
 * A folder strictly inside a registered managed Connected Folder is that
 * Connected Folder's own content, not app data, so it may become a sub
 * Connected Folder even though managed Connected Folders live in the app's data
 * folder. Hidden folders there (`.amplefile/`, a removal's claimed
 * folder) stay off limits.
 */
function insideManagedConnectedFolder(connectedFolderRoot: string, registry: ConnectedFolderRegistry): boolean {
  const root = normalizeComparisonPath(connectedFolderRoot);
  return registry.connectedFolders.some((candidate) => {
    if (candidate.location.storage !== "managed") return false;
    const parent = normalizeComparisonPath(candidate.connectedFolderRoot);
    if (!root.startsWith(`${parent}${sep}`)) return false;
    return !root.slice(parent.length + 1).split(sep).some((part) => part.startsWith("."));
  });
}

function linkedConnectedFolderStateSeparated(connectedFolderRoot: string): boolean {
  const root = resolve(connectedFolderRoot);
  const stateRoot = resolve(ampleFileStateRoot());
  return !pathContains(root, stateRoot) && !pathContains(stateRoot, root);
}

function pathContains(parentPath: string, childPath: string): boolean {
  const parent = normalizeComparisonPath(parentPath);
  const child = normalizeComparisonPath(childPath);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function normalizeComparisonPath(value: string): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function looksLikeGoogleDrivePath(path: string): boolean {
  return /(^|[\\/])(google drive|my drive|shared drives|drivefs)([\\/]|$)/i.test(path);
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  return sample.length > 0 && controls / sample.length > 0.1;
}

function isConnectedFolderSummary(value: unknown): value is ConnectedFolderSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ConnectedFolderSummary>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.connectedFolderRoot === "string"
    && item.location?.kind === "local" && (item.location.storage === "managed" || item.location.storage === "linked")
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

function connectedFolderRemovalIntent(value: unknown): ConnectedFolderRemovalIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connected Folder registry contains an invalid removal intent.");
  }
  const item = value as Partial<ConnectedFolderRemovalIntent>;
  const requiredKeys = [
    "transactionId", "connectedFolderId", "connectedFolderRoot", "storage", "managedBase", "managedRootIdentity", "managedRootClaimed", "phase", "requestedAt",
  ];
  const keys = Object.keys(value).sort();
  // The one optional key is the preserve marker; every other shape mismatch
  // stays a hard failure exactly as before.
  const expectedKeys = keys.includes("folderDisposition") ? [...requiredKeys, "folderDisposition"] : requiredKeys;
  if (keys.join("\0") !== [...expectedKeys].sort().join("\0")
    || typeof item.transactionId !== "string"
    || !/^space-removal_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.transactionId)
    || !isConnectedFolderId(item.connectedFolderId)
    || typeof item.connectedFolderRoot !== "string"
    || (item.storage !== "managed" && item.storage !== "linked")
    || typeof item.managedRootClaimed !== "boolean"
    || (item.folderDisposition !== undefined && item.folderDisposition !== "preserve")
    || (item.phase !== "requested" && item.phase !== "app-state-removed")
    || typeof item.requestedAt !== "string" || !isValidTimestamp(item.requestedAt)) {
    throw new Error("Connected Folder registry contains an invalid removal intent.");
  }
  const preserves = item.storage === "managed" && item.folderDisposition === "preserve";
  if (item.folderDisposition === "preserve" && item.storage !== "managed") {
    throw new Error("Only a managed Connected Folder removal intent may carry a preserve disposition.");
  }
  if (item.storage === "managed" && !preserves && (typeof item.managedBase !== "string" || !isAbsolute(item.managedBase))) {
    throw new Error("Managed Connected Folder removal intent has no content boundary.");
  }
  if (item.storage === "managed" && !preserves && !item.managedRootIdentity) {
    throw new Error("Managed Connected Folder removal intent has no root identity.");
  }
  if (item.storage === "linked" && (item.managedBase !== null || item.managedRootIdentity !== null || item.managedRootClaimed)) {
    throw new Error("Linked Connected Folder removal intent has unexpected managed-content authority.");
  }
  if (preserves && (item.managedBase !== null || item.managedRootIdentity !== null || item.managedRootClaimed)) {
    throw new Error("A preserve removal intent cannot hold managed-content deletion authority.");
  }
  const intent: ConnectedFolderRemovalIntent = {
    transactionId: item.transactionId,
    connectedFolderId: item.connectedFolderId,
    connectedFolderRoot: lexicalConnectedFolderRoot(item.connectedFolderRoot),
    storage: item.storage,
    managedBase: item.managedBase === null || item.managedBase === undefined ? null : resolve(item.managedBase),
    managedRootIdentity: item.managedRootIdentity === null || item.managedRootIdentity === undefined
      ? null
      : managedRootIdentity(item.managedRootIdentity),
    managedRootClaimed: item.managedRootClaimed,
    ...(preserves ? { folderDisposition: "preserve" as const } : {}),
    phase: item.phase,
    requestedAt: item.requestedAt,
  };
  validateConnectedFolderRemovalIntent(intent);
  return intent;
}

function validateConnectedFolderRemovalIntent(intent: ConnectedFolderRemovalIntent): void {
  const connectedFolderRoot = lexicalConnectedFolderRoot(intent.connectedFolderRoot);
  if (intent.storage === "managed" && intent.folderDisposition !== "preserve") {
    const base = resolve(intent.managedBase!);
    if (samePath(connectedFolderRoot, base) || !pathContains(base, connectedFolderRoot)) {
      throw new Error("Managed Connected Folder removal intent escapes its registered content boundary.");
    }
    const identity = intent.managedRootIdentity;
    if (!identity || samePath(identity.realPath, identity.managedBaseRealPath)
      || !pathContains(identity.managedBaseRealPath, identity.realPath)) {
      throw new Error("Managed Connected Folder removal intent has an invalid canonical content boundary.");
    }
  } else if (intent.managedBase !== null || intent.managedRootIdentity !== null || intent.managedRootClaimed) {
    throw new Error(intent.storage === "linked"
      ? "Linked Connected Folder removal intent cannot delete managed content."
      : "A preserve removal intent cannot hold managed-content deletion authority.");
  }
}

function lexicalConnectedFolderRoot(connectedFolderRoot: string): string {
  if (!isAbsolute(connectedFolderRoot)) throw new Error("Connected Folder removal intent root must be absolute.");
  const resolved = resolve(connectedFolderRoot);
  if (resolved === parse(resolved).root) throw new Error("A filesystem root cannot be used as a Connected Folder removal intent.");
  return resolved;
}

function managedRootIdentity(value: unknown): ManagedConnectedFolderRootIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed Connected Folder removal intent has an invalid root identity.");
  }
  const item = value as Partial<ManagedConnectedFolderRootIdentity>;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["device", "inode", "managedBaseRealPath", "realPath"].sort().join("\0")
    || typeof item.realPath !== "string" || !isAbsolute(item.realPath)
    || typeof item.managedBaseRealPath !== "string" || !isAbsolute(item.managedBaseRealPath)
    || typeof item.device !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(item.device)
    || typeof item.inode !== "string" || !/^[1-9][0-9]*$/.test(item.inode)) {
    throw new Error("Managed Connected Folder removal intent has an invalid root identity.");
  }
  return {
    realPath: resolve(item.realPath),
    managedBaseRealPath: resolve(item.managedBaseRealPath),
    device: item.device,
    inode: item.inode,
  };
}

function assertId(value: string): void {
  if (!isConnectedFolderId(value)) throw new Error("Invalid Connected Folder id.");
}

function notFound(message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 404;
  return error;
}
