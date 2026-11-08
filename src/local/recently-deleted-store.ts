/**
 * Recently deleted (the machine-local trash) for reversible destruction
 * (docs/act-ledger.md).
 *
 * Nothing AmpleFile destroys is permanent at the moment it happens. History
 * covers ordinary deletion; whatever History cannot capture (oversized,
 * unreadable, symbolic-link, or always-excluded content), a deleted managed
 * Connected Folder, and a removed imported Skill is moved here instead of
 * erased, and stays restorable for a retention window (default 30 days,
 * 1..365).
 *
 * An earlier build also kept Connected Folder app data, App Studio Releases,
 * and App Studio history here. Those entries still list, expire, and can be
 * deleted, but nothing restores or reads them.
 *
 * Layout under `rootPath` (`ampleFileRecentlyDeletedRoot()` in production):
 *
 *   settings.json                              { version: 1, retentionDays, lastPurgeAt }
 *   entries/<entryId>/manifest.json            AmpleFileRecentlyDeletedManifest — the only commit marker
 *   entries/<entryId>/payload/<name>           file | folder | Connected Folder | skill: the moved tree, original basename
 *   entries/<entryId>/payload/app-data.json    app-storage | app-retained (older builds only; never read)
 *   entries/<entryId>/payload/app-release.json app-release (older builds only; never read)
 *   entries/<entryId>/payload/app-studio/      app-studio (older builds only; never read)
 *   entries/<entryId>/state/                   Connected Folder only: the Connected Folder's machine-local state dir (History)
 *   incoming/<uuid>/                           cross-device copy staging, swept on open()
 *
 * Entry ids are `trash-<yyyymmddHHMMSS>-<uuid8>` (see
 * `ampleFileRecentlyDeletedEntryIdPattern`). Directories are 0o700 and files
 * 0o600, like the other machine-local stores.
 *
 * API (every method serializes through one in-process queue):
 *
 *   AmpleFileRecentlyDeletedStore.open(options)   create the layout, load settings, sweep debris
 *   store.moveTreeToRecentlyDeleted(input)       move a file, folder, Connected Folder, or Skill folder in
 *   store.list() / store.get(id)                 tolerant listing; damaged records are reported, never dropped
 *   store.attachConnectedFolderState(id, path)        finish carrying History after an interrupted Connected Folder deletion
 *   store.restoreTree(id, destination)           move a tree back, collision-renaming like connected-folder.ts
 *   store.remove(id)                             "Delete now"; refuses (HELD) for trees it cannot fully list
 *   store.purgeExpired(now)                      retention purge; fails closed on trees it cannot fully list
 *   store.purgeExpiredIfDue(intervalMs)          the wake-tolerant "once a day while awake" wrapper
 *   store.retentionDays() / setRetentionDays(days)   1..365; rewrites every entry's `restoreBy`
 *
 * Invariants:
 *
 * - Nothing inside a moved tree is read except during size measurement and
 *   the hold walk; symbolic links are never followed (`lstat`
 *   everywhere; the copy fallback copies links verbatim).
 * - `manifest.json` is the commit marker. `moveTreeToRecentlyDeleted` writes
 *   it `complete: false`, moves the source with `rename` (falling back to a
 *   verbatim copy into `incoming/`, fsync, rename into place, then release of
 *   the source when the devices differ), and rewrites it `complete: true`. A crash
 *   therefore leaves either nothing (the source untouched, the entry
 *   directory removed) or a listable entry whose payload exists; `list()`
 *   repairs the latter's `complete` flag lazily.
 * - Manifests are validated on read (closed shape, enums, ISO dates, id
 *   pattern, payload shape). Anything else lands in `damaged` with the
 *   reason and is never removed silently.
 * - Ids come only from the store and are re-validated against
 *   `ampleFileRecentlyDeletedEntryIdPattern` before any path join.
 * - Reserved names inside payloads (`.amplefile`, `.pi`) are data, never
 *   interpreted.
 * - A tree the store cannot fully list is never erased by retention or
 *   "Delete now": it cannot prove what the tree holds. Such an entry is marked
 *   `held`; the person can still restore it or handle the folder outside the
 *   product.
 */
import { randomUUID } from "node:crypto";
import { existsSync, type CopyOptions, type Stats } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
  ampleFileRecentlyDeletedDefaultRetentionDays,
  ampleFileRecentlyDeletedMaxRetentionDays,
  ampleFileRecentlyDeletedMinRetentionDays,
} from "../shared/amplefile-limits.js";
import { writeFileAtomic } from "./agent/turn-store.js";

export const AMPLEFILE_RECENTLY_DELETED_DEFAULT_RETENTION_DAYS = ampleFileRecentlyDeletedDefaultRetentionDays;
export const AMPLEFILE_RECENTLY_DELETED_MIN_RETENTION_DAYS = ampleFileRecentlyDeletedMinRetentionDays;
export const AMPLEFILE_RECENTLY_DELETED_MAX_RETENTION_DAYS = ampleFileRecentlyDeletedMaxRetentionDays;
/** "Daily while awake": `purgeExpiredIfDue` runs at most this often by default. */
export const AMPLEFILE_RECENTLY_DELETED_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Shape of every entry id; CLI and route input must match it before any path join. */
export const ampleFileRecentlyDeletedEntryIdPattern = /^trash-\d{14}-[0-9a-f]{8}$/;

/**
 * `app-storage`, `app-retained`, `app-release`, and `app-studio` are read
 * only: entries an earlier build kept for Connected Folder apps. They list
 * and expire like any entry; nothing creates one.
 */
export type AmpleFileRecentlyDeletedKind = "file" | "folder" | "connected-folder" | "skill" | "app-storage" | "app-retained" | "app-release" | "app-studio";

export type AmpleFileRecentlyDeletedReason =
  | "files.delete"
  /** Deleting an AmpleFile Agent Chat keeps its transcript recoverable. */
  | "agent.chat.delete"
  /** Deleting a Worker Chat keeps its portable transcript recoverable. */
  | "chats.delete"
  | "connected-folders.delete"
  /** Removing an imported Skill keeps its whole folder; `.pi/` and Pi's own folder are outside History. */
  | "skills.remove"
  /** The `apps.*` reasons are read only, on entries older builds kept for Connected Folder apps. */
  | "apps.remove"
  | "apps.connected-folder.removed"
  | "apps.storage.clear"
  | "apps.retained.purge"
  | "apps.uninstall.purge"
  | "apps.release.delete";

/** Why History alone could not keep a copy of one path inside a Recently deleted entry. */
export interface AmpleFileRecentlyDeletedUncoveredPath {
  /** Connected Folder–relative path inside the moved entry. */
  path: string;
  /** Mirrors `CheckpointSkippedFile.reason` in history.ts. */
  reason: "too_large" | "unreadable" | "symbolic_link" | "excluded";
}

/** Read only: what an `app-storage`/`app-retained` entry from an older build names. */
export type AmpleFileRecentlyDeletedAppDataIdentity = {
  kind: "app-data";
  appId: string;
  appDigest: string;
  featureInstallationId: string;
  runtimeInstanceId: string;
  dataNamespaceId: string;
  sourceConnectedFolderId: string;
  projectId: string;
  releaseDigest: string | null;
  /** app-retained only. */
  retainedDataId?: string;
};

/** Read only: which Release an `app-release` entry from an older build keeps. */
export type AmpleFileRecentlyDeletedAppReleaseIdentity = {
  kind: "app-release";
  projectId: string;
  releaseDigest: string;
  displayVersion: string;
  sourceConnectedFolderId: string;
};

/** Read only: whose App Studio history an `app-studio` entry from an older build keeps. */
export type AmpleFileRecentlyDeletedAppStudioIdentity = {
  kind: "app-studio";
  connectedFolderId: string;
  projectId: string | null;
};

/**
 * A removed Skill's folder, kept like a tree, and where it goes back: the
 * same scope's skills folder (Pi's own for Everywhere, the Connected Folder's
 * `.pi/skills` otherwise), at the entry's `originalPath` inside it.
 */
export type AmpleFileRecentlyDeletedSkillPayload = {
  kind: "skill";
  scope: "everywhere" | "connected-folder";
  /** The basename of the moved Skill folder under `payload/`. */
  name: string;
  /** The name Pi loads the Skill under; another Skill with it in the same scope blocks the restore. */
  skillName: string;
};

export type AmpleFileRecentlyDeletedPayload =
  /** file | folder | Connected Folder: the basename of the moved tree under `payload/`. */
  | { kind: "tree"; name: string }
  | AmpleFileRecentlyDeletedSkillPayload
  | AmpleFileRecentlyDeletedAppDataIdentity
  | AmpleFileRecentlyDeletedAppReleaseIdentity
  | AmpleFileRecentlyDeletedAppStudioIdentity;

export interface AmpleFileRecentlyDeletedHold {
  /**
   * `unreadable`: a directory inside the tree could not be listed (or the
   * walk hit its budget), so the store cannot prove what it holds. A hold
   * with any other reason, which an earlier build may have recorded, is
   * ignored on read: the entry is then handled like any other.
   */
  reason: "unreadable";
  noticedAt: string;
}

export interface AmpleFileRecentlyDeletedManifest {
  version: 1;
  id: string;
  kind: AmpleFileRecentlyDeletedKind;
  reason: AmpleFileRecentlyDeletedReason;
  connectedFolderId: string;
  /** Display and Connected Folder re-registration. */
  connectedFolderName?: string;
  /** Person-facing label; the payload name remains the recovery identity. */
  displayName?: string;
  /** file/folder: Connected Folder–relative path. Connected Folder: absolute managed folder path. skill: the Skill folder's `/`-separated path inside its scope's skills folder. app-storage/app-retained: `<appId>/<dataNamespaceId>`. app-release: `<projectId>/<releaseDigest>`. app-studio: the project id, or the Connected Folder id when there is no Project. */
  originalPath: string;
  sizeBytes: number;
  /** The measurement walk hit its budget, so `sizeBytes` is a lower bound. */
  sizeApproximate?: true;
  deletedAt: string;
  restoreBy: string;
  /** The act request id (CLI) or the desktop's minted `settings:`/`desktop:` request id that produced the entry. */
  receiptId: string | null;
  payload: AmpleFileRecentlyDeletedPayload;
  /** False until the move landed (crash marker). */
  complete: boolean;
  /** files.delete: why History alone could not cover it. */
  uncovered?: AmpleFileRecentlyDeletedUncoveredPath[];
  /** Set at purge or "Delete now" time; a held entry is never erased by the store. */
  held?: AmpleFileRecentlyDeletedHold;
  /** Connected Folder: the History state dir travelled with the folder and sits under `state/`. */
  stateDir?: true;
}

export interface AmpleFileRecentlyDeletedEntry extends AmpleFileRecentlyDeletedManifest {
  entryPath: string;
  payloadPath: string;
}

export interface AmpleFileRecentlyDeletedDamagedRecord {
  id: string;
  error: string;
}

export interface AmpleFileRecentlyDeletedListing {
  /** Newest first. */
  entries: AmpleFileRecentlyDeletedEntry[];
  /** Records the store cannot read or trust. They are never removed silently. */
  damaged: AmpleFileRecentlyDeletedDamagedRecord[];
  retentionDays: number;
}

export type AmpleFileRecentlyDeletedErrorCode = "NOT_FOUND" | "INPUT_INVALID" | "STORE_DAMAGED" | "HELD" | "MOVE_FAILED";

export class AmpleFileRecentlyDeletedError extends Error {
  readonly code: AmpleFileRecentlyDeletedErrorCode;
  /** Present when the failure left (or refused to remove) a specific entry. */
  readonly entryId?: string;

  constructor(code: AmpleFileRecentlyDeletedErrorCode, message: string, options: { entryId?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AmpleFileRecentlyDeletedError";
    this.code = code;
    if (options.entryId !== undefined) this.entryId = options.entryId;
  }
}

/** Filesystem seams for tests (cross-device fallback, failing moves). Production uses node:fs. */
export interface AmpleFileRecentlyDeletedStoreIo {
  rename?(from: string, to: string): Promise<void>;
  cp?(from: string, to: string, options: CopyOptions): Promise<void>;
}

export interface AmpleFileRecentlyDeletedStoreOptions {
  /** `ampleFileRecentlyDeletedRoot()` in production; a temporary directory in tests. */
  rootPath: string;
  now?: () => Date;
  /** 1..365; default 30. Applied only when `settings.json` does not exist yet. */
  defaultRetentionDays?: number;
  io?: AmpleFileRecentlyDeletedStoreIo;
}

export interface AmpleFileRecentlyDeletedTreeInput {
  kind: "file" | "folder" | "connected-folder" | "skill";
  reason: AmpleFileRecentlyDeletedReason;
  /** Absolute path of the file or directory to move (for `connected-folder`, the removal claim path). */
  sourcePath: string;
  connectedFolderId: string;
  connectedFolderName?: string;
  /** Optional Recently deleted label; it never affects the restore path. */
  displayName?: string;
  /** Connected Folder–relative path (file/folder), the absolute original root (Connected Folder), or the path inside the scope's skills folder (skill). Its basename names the payload. */
  originalPath: string;
  receiptId: string | null;
  uncovered?: AmpleFileRecentlyDeletedUncoveredPath[];
  /** Connected Folder: absolute `connectedFolderStateDir` to move under `state/`; a missing directory is fine. */
  stateDirPath?: string;
  /** skill only, and required there: the scope it goes back into and the name Pi loads it under. */
  skill?: { scope: AmpleFileRecentlyDeletedSkillPayload["scope"]; skillName: string };
}

export interface AmpleFileRecentlyDeletedRestoreDestination {
  /** Where the tree goes back. An occupied path is collision-renamed (`stem (2).ext` / `name-2`). */
  absolutePath: string;
  /** Transcript filenames are identities and must never be collision-renamed. */
  onConflict?: "rename" | "error";
  /** Connected Folder entries whose History state travelled: where `state/` goes back. */
  stateDirPath?: string;
  /** Alternative to `stateDirPath` that sees the final (possibly renamed) path first. */
  stateDirFor?: (restoredPath: string) => string;
}

export interface AmpleFileRecentlyDeletedRestoreResult {
  restoredPath: string;
  renamed: boolean;
  stateDirMovedTo?: string;
}

export interface AmpleFileRecentlyDeletedPurgeResult {
  purged: string[];
  held: string[];
  failed: AmpleFileRecentlyDeletedDamagedRecord[];
}

const RECENTLY_DELETED_KINDS: readonly AmpleFileRecentlyDeletedKind[] = ["file", "folder", "connected-folder", "skill", "app-storage", "app-retained", "app-release", "app-studio"];
const RECENTLY_DELETED_REASONS: readonly AmpleFileRecentlyDeletedReason[] = [
  "files.delete", "agent.chat.delete", "chats.delete", "connected-folders.delete", "skills.remove", "apps.remove", "apps.connected-folder.removed",
  "apps.storage.clear", "apps.retained.purge", "apps.uninstall.purge", "apps.release.delete",
];
const SKILL_SCOPES: readonly AmpleFileRecentlyDeletedSkillPayload["scope"][] = ["everywhere", "connected-folder"];
const UNCOVERED_REASONS: readonly AmpleFileRecentlyDeletedUncoveredPath["reason"][] = ["too_large", "unreadable", "symbolic_link", "excluded"];
const MANIFEST_KEYS = new Set([
  "version", "id", "kind", "reason", "connectedFolderId", "connectedFolderName", "displayName", "originalPath", "sizeBytes", "sizeApproximate",
  "deletedAt", "restoreBy", "receiptId", "payload", "complete", "uncovered", "held", "stateDir",
]);
const APP_DATA_IDENTITY_KEYS = new Set([
  "kind", "appId", "appDigest", "featureInstallationId", "runtimeInstanceId", "dataNamespaceId",
  "sourceConnectedFolderId", "projectId", "releaseDigest", "retainedDataId",
]);
const APP_RELEASE_IDENTITY_KEYS = new Set(["kind", "projectId", "releaseDigest", "displayVersion", "sourceConnectedFolderId"]);
const APP_STUDIO_IDENTITY_KEYS = new Set(["kind", "connectedFolderId", "projectId"]);
const APP_DATA_FILE = "app-data.json";
const APP_RELEASE_FILE = "app-release.json";
const APP_STUDIO_DIR = "app-studio";
const MANIFEST_FILE = "manifest.json";
const MEASURE_ENTRY_BUDGET = 64 * 1024;
const MAX_UNCOVERED_PATHS = 65536;
const MAX_TEXT_LENGTH = 4096;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const RECENTLY_DELETED = "Recently deleted";

interface RecentlyDeletedSettingsFile {
  version: 1;
  retentionDays: number;
  lastPurgeAt: string | null;
}

type EntryRead =
  | { state: "entry"; entry: AmpleFileRecentlyDeletedEntry }
  | { state: "damaged"; id: string; error: string }
  | { state: "absent" };

/** Thrown by `#move`; `landed` says whether the destination already holds a complete copy. */
class MoveError extends Error {
  constructor(readonly landed: boolean, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "MoveError";
  }
}

export class AmpleFileRecentlyDeletedStore {
  readonly rootPath: string;
  readonly #now: () => Date;
  readonly #io: Required<AmpleFileRecentlyDeletedStoreIo>;
  #settings: RecentlyDeletedSettingsFile;
  #queue: Promise<void> = Promise.resolve();

  private constructor(rootPath: string, options: AmpleFileRecentlyDeletedStoreOptions, settings: RecentlyDeletedSettingsFile) {
    this.rootPath = rootPath;
    this.#now = options.now ?? (() => new Date());
    this.#io = {
      rename: options.io?.rename ?? ((from, to) => rename(from, to)),
      cp: options.io?.cp ?? ((from, to, copyOptions) => cp(from, to, copyOptions)),
    };
    this.#settings = settings;
  }

  /**
   * Creates the layout, reads or creates `settings.json`, sweeps `incoming/`
   * and pure debris under `entries/` (a directory with neither a manifest, a
   * payload, nor state). Never deletes anything that holds a payload, even
   * without a manifest: `list()` reports it under `damaged`.
   */
  static async open(options: AmpleFileRecentlyDeletedStoreOptions): Promise<AmpleFileRecentlyDeletedStore> {
    const rootPath = resolve(options.rootPath);
    const defaultRetentionDays = options.defaultRetentionDays ?? AMPLEFILE_RECENTLY_DELETED_DEFAULT_RETENTION_DAYS;
    assertRetentionDays(defaultRetentionDays);
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    await mkdir(join(rootPath, "entries"), { recursive: true, mode: 0o700 });
    await mkdir(join(rootPath, "incoming"), { recursive: true, mode: 0o700 });
    const settings = await loadSettings(join(rootPath, "settings.json"), defaultRetentionDays);
    const store = new AmpleFileRecentlyDeletedStore(rootPath, options, settings);
    await store.#sweep();
    return store;
  }

  retentionDays(): number {
    return this.#settings.retentionDays;
  }

  /** Last retention purge, or null when none has run at this root yet. */
  lastPurgeAt(): string | null {
    return this.#settings.lastPurgeAt;
  }

  /** Validates 1..365, rewrites `settings.json`, and rewrites `restoreBy` on every readable complete manifest. */
  async setRetentionDays(days: number): Promise<void> {
    assertRetentionDays(days);
    await this.#mutate(async () => {
      await this.#writeSettings({ ...this.#settings, retentionDays: days });
      let firstFailure: unknown = null;
      for (const entry of (await this.#readAll(false)).entries) {
        if (!entry.complete) continue;
        try {
          await this.#writeManifest(entry.entryPath, { ...manifestOf(entry), restoreBy: addDays(entry.deletedAt, days) });
        } catch (error) {
          firstFailure ??= error;
        }
      }
      if (firstFailure !== null) {
        throw new AmpleFileRecentlyDeletedError(
          "STORE_DAMAGED",
          `AmpleFile saved the new retention but could not update every item in ${RECENTLY_DELETED}: ${errorMessage(firstFailure)}`,
          { cause: firstFailure },
        );
      }
    });
  }

  /**
   * Moves a file, folder, Connected Folder, or Skill folder into Recently deleted.
   * Crash-safe order: entry dir → manifest `{complete:false}` → move source →
   * optional state dir → measure → manifest `{complete:true}`. A failure
   * before the source moved removes the entry directory and throws
   * MOVE_FAILED (nothing was moved). A failure after the copy landed keeps
   * the entry — the copy is now the only complete one — and throws
   * MOVE_FAILED naming it.
   */
  async moveTreeToRecentlyDeleted(input: AmpleFileRecentlyDeletedTreeInput): Promise<AmpleFileRecentlyDeletedEntry> {
    const sourcePath = requireAbsolutePath(input.sourcePath, "The path to move");
    if (input.kind !== "file" && input.kind !== "folder" && input.kind !== "connected-folder" && input.kind !== "skill") {
      throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "Only files, folders, Connected Folders, and Skills can be moved as trees.");
    }
    assertReason(input.reason);
    const connectedFolderId = requireText(input.connectedFolderId, "Connected Folder id", 160);
    const connectedFolderName = input.connectedFolderName === undefined ? undefined : requireText(input.connectedFolderName, "Connected Folder name", 200);
    const displayName = input.displayName === undefined ? undefined : requireText(input.displayName, "Display name", 200);
    const originalPath = requireText(input.originalPath, "The original path", MAX_TEXT_LENGTH);
    const receiptId = requireReceiptId(input.receiptId);
    const uncovered = normalizeUncovered(input.uncovered);
    const name = payloadNameFor(originalPath);
    const stateDirPath = input.stateDirPath === undefined ? undefined : requireAbsolutePath(input.stateDirPath, "The Connected Folder state path");
    if (stateDirPath !== undefined && input.kind !== "connected-folder") {
      throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "Only a Connected Folder carries History state with it.");
    }
    if ((input.kind === "skill") !== (input.skill !== undefined)) {
      throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "A Skill, and only a Skill, names the scope it goes back into.");
    }
    const payload: AmpleFileRecentlyDeletedPayload = input.skill === undefined
      ? { kind: "tree", name }
      : normalizeSkillPayload({ kind: "skill", scope: input.skill.scope, name, skillName: input.skill.skillName });
    const sourceInfo = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
      throw new AmpleFileRecentlyDeletedError("MOVE_FAILED", `AmpleFile could not move ${sourcePath} into ${RECENTLY_DELETED}: ${errorMessage(error)}. Nothing was moved.`, { cause: error });
    });
    if (input.kind === "file" ? sourceInfo.isDirectory() : !sourceInfo.isDirectory()) {
      throw new AmpleFileRecentlyDeletedError(
        "INPUT_INVALID",
        input.kind === "file" ? `${sourcePath} is a folder, not a file.` : `${sourcePath} is not a folder.`,
      );
    }

    return await this.#mutate(async () => {
      const deletedAt = this.#now().toISOString();
      const id = newEntryId(deletedAt);
      const entryPath = join(this.rootPath, "entries", id);
      const payloadDir = join(entryPath, "payload");
      const payloadPath = join(payloadDir, name);
      const manifest: AmpleFileRecentlyDeletedManifest = {
        version: 1,
        id,
        kind: input.kind,
        reason: input.reason,
        connectedFolderId,
        ...(connectedFolderName === undefined ? {} : { connectedFolderName }),
        ...(displayName === undefined ? {} : { displayName }),
        originalPath,
        sizeBytes: 0,
        deletedAt,
        restoreBy: addDays(deletedAt, this.#settings.retentionDays),
        receiptId,
        payload,
        complete: false,
        ...(uncovered.length ? { uncovered } : {}),
      };
      try {
        await mkdir(entryPath, { mode: 0o700 });
        await mkdir(payloadDir, { mode: 0o700 });
        await this.#writeManifest(entryPath, manifest);
      } catch (error) {
        await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
        throw new AmpleFileRecentlyDeletedError("MOVE_FAILED", `AmpleFile could not prepare ${RECENTLY_DELETED}: ${errorMessage(error)}. Nothing was moved.`, { cause: error });
      }
      try {
        await this.#move(sourcePath, payloadPath, { stagingDir: this.#newStagingDir() });
      } catch (error) {
        if (error instanceof MoveError && error.landed) {
          throw new AmpleFileRecentlyDeletedError(
            "MOVE_FAILED",
            `AmpleFile copied ${sourcePath} into ${RECENTLY_DELETED} (${id}) but could not release the original: ${error.message}. The copy is kept there.`,
            { entryId: id, cause: error },
          );
        }
        await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
        throw new AmpleFileRecentlyDeletedError("MOVE_FAILED", `AmpleFile could not move ${sourcePath} into ${RECENTLY_DELETED}: ${errorMessage(error)}. Nothing was moved.`, { cause: error });
      }
      // From here the source is gone: the entry stays whatever happens next.
      let stateDir = false;
      if (stateDirPath !== undefined) {
        const stateInfo = await lstat(stateDirPath).catch(() => null);
        if (stateInfo?.isDirectory()) {
          try {
            await this.#move(stateDirPath, join(entryPath, "state"), { stagingDir: this.#newStagingDir() });
            stateDir = true;
          } catch (error) {
            throw new AmpleFileRecentlyDeletedError(
              "MOVE_FAILED",
              `AmpleFile moved ${sourcePath} into ${RECENTLY_DELETED} (${id}) but could not move its History state along: ${errorMessage(error)}.`,
              { entryId: id, cause: error },
            );
          }
        }
      }
      const measured = await measureTree(payloadPath);
      const completed: AmpleFileRecentlyDeletedManifest = {
        ...manifest,
        sizeBytes: measured.sizeBytes,
        ...(measured.approximate ? { sizeApproximate: true as const } : {}),
        complete: true,
        ...(stateDir ? { stateDir: true as const } : {}),
      };
      await this.#writeManifest(entryPath, completed).catch(() => undefined); // list() repairs a missed commit
      return { ...completed, entryPath, payloadPath };
    });
  }

  /** Every readable entry, newest first, plus the records that could not be trusted. Repairs missed commits. */
  async list(): Promise<AmpleFileRecentlyDeletedListing> {
    return await this.#mutate(async () => {
      const { entries, damaged } = await this.#readAll(true);
      return { entries, damaged, retentionDays: this.#settings.retentionDays };
    });
  }

  /** One entry by id; null when nothing has that id; STORE_DAMAGED when its record cannot be trusted. */
  async get(id: string): Promise<AmpleFileRecentlyDeletedEntry | null> {
    assertEntryId(id);
    return await this.#mutate(async () => this.#requireReadable(id, true));
  }

  /**
   * Finishes an interrupted Connected Folder deletion whose folder reached Recently
   * deleted before its History state. Existing state is never merged or replaced;
   * a missing source is already finished, and a missed marker write is
   * reconstructed from the carried directory by the normal read path.
   */
  async attachConnectedFolderState(id: string, stateDirPath: string): Promise<AmpleFileRecentlyDeletedEntry> {
    assertEntryId(id);
    const source = requireAbsolutePath(stateDirPath, "The Connected Folder state path");
    return await this.#mutate(async () => {
      const entry = await this.#requireEntry(id, true);
      if (entry.kind !== "connected-folder" || entry.payload.kind !== "tree") {
        throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "Only a Connected Folder can carry History state.", { entryId: id });
      }
      const sourceInfo = await lstat(source).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return null;
        throw new AmpleFileRecentlyDeletedError("MOVE_FAILED", `AmpleFile could not inspect the remaining History state: ${errorMessage(error)}.`, { entryId: id, cause: error });
      });
      if (!sourceInfo) return entry;
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
        throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "The remaining History state must be a real directory.", { entryId: id });
      }
      if (entry.stateDir) {
        throw new AmpleFileRecentlyDeletedError("MOVE_FAILED", "History state is present both in Recently deleted and at its original path. Neither copy was changed.", { entryId: id });
      }
      try {
        await this.#move(source, join(entry.entryPath, "state"), { stagingDir: this.#newStagingDir() });
      } catch (error) {
        throw new AmpleFileRecentlyDeletedError("MOVE_FAILED", `AmpleFile could not keep the remaining History state with ${id}: ${errorMessage(error)}.`, { entryId: id, cause: error });
      }
      const completed = { ...manifestOf(entry), stateDir: true as const };
      await this.#writeManifest(entry.entryPath, completed).catch(() => undefined);
      return { ...completed, entryPath: entry.entryPath, payloadPath: entry.payloadPath };
    });
  }

  /**
   * Moves a file, folder, Connected Folder, or Skill folder back. An occupied
   * destination is collision-renamed with the connected-folder.ts rules
   * (`stem (2).ext` for files, `name-2` for folders) unless the caller says
   * the name is an identity. On success the entry directory is removed. On
   * failure the entry is left intact and MOVE_FAILED is thrown.
   */
  async restoreTree(id: string, destination: AmpleFileRecentlyDeletedRestoreDestination): Promise<AmpleFileRecentlyDeletedRestoreResult> {
    assertEntryId(id);
    const desired = requireAbsolutePath(destination.absolutePath, "The restore destination");
    return await this.#mutate(async () => {
      const entry = await this.#requireEntry(id, true);
      if (entry.payload.kind !== "tree" && entry.payload.kind !== "skill") {
        throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", `${id} holds data a Connected Folder app kept before apps were removed from AmpleFile; it cannot be restored. It is deleted when it expires, or delete it now.`);
      }
      if (destination.onConflict === "error" && existsSync(desired)) {
        throw new AmpleFileRecentlyDeletedError(
          "MOVE_FAILED",
          `AmpleFile could not restore ${basename(desired)}: that identity already exists. It is still in ${RECENTLY_DELETED}.`,
          { entryId: id },
        );
      }
      const finalPath = existsSync(desired)
        ? (entry.kind === "file" ? nextAvailableFile(desired) : nextAvailableDirectory(dirname(desired), basename(desired)))
        : desired;
      let stateTarget: string | undefined;
      if (entry.stateDir) {
        const chosen = destination.stateDirFor ? destination.stateDirFor(finalPath) : destination.stateDirPath;
        if (chosen === undefined) {
          throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", `${id} carries the Connected Folder's History state; say where that state goes back.`);
        }
        stateTarget = requireAbsolutePath(chosen, "The History state destination");
        if (existsSync(stateTarget)) {
          throw new AmpleFileRecentlyDeletedError(
            "MOVE_FAILED",
            `AmpleFile could not restore ${basename(finalPath)}: History state already exists at ${stateTarget}. It is still in ${RECENTLY_DELETED}.`,
            { entryId: id },
          );
        }
      }
      const failure = (error: unknown): AmpleFileRecentlyDeletedError => new AmpleFileRecentlyDeletedError(
        "MOVE_FAILED",
        `AmpleFile could not restore ${entry.payload.kind === "tree" || entry.payload.kind === "skill" ? entry.payload.name : id} to ${finalPath}: ${errorMessage(error)}. It is still in ${RECENTLY_DELETED}.`,
        { entryId: id, cause: error },
      );
      try {
        await mkdir(dirname(finalPath), { recursive: true });
        await this.#move(entry.payloadPath, finalPath);
      } catch (error) {
        if (error instanceof MoveError && error.landed) {
          // The copy is in place but Recently deleted still holds the original; keep it so nothing is lost twice.
          throw new AmpleFileRecentlyDeletedError(
            "MOVE_FAILED",
            `AmpleFile copied ${basename(finalPath)} back to ${finalPath} but could not clear the copy in ${RECENTLY_DELETED}: ${error.message}.`,
            { entryId: id, cause: error },
          );
        }
        throw failure(error);
      }
      let stateDirMovedTo: string | undefined;
      if (stateTarget !== undefined) {
        try {
          await mkdir(dirname(stateTarget), { recursive: true, mode: 0o700 });
          await this.#move(join(entry.entryPath, "state"), stateTarget);
          stateDirMovedTo = stateTarget;
        } catch (error) {
          // Best-effort rollback so the entry stays restorable as a whole.
          await this.#io.rename(finalPath, entry.payloadPath).catch(() => undefined);
          throw failure(error);
        }
      }
      await this.#erase(entry.entryPath);
      return { restoredPath: finalPath, renamed: finalPath !== desired, ...(stateDirMovedTo === undefined ? {} : { stateDirMovedTo }) };
    });
  }

  /**
   * "Delete now". Refuses with HELD when the tree cannot be fully listed and
   * marks the manifest `held`. A damaged record is removed only when the same
   * walk clears it.
   */
  async remove(id: string): Promise<{ removed: boolean }> {
    assertEntryId(id);
    return await this.#mutate(async () => {
      const read = await this.#readEntry(id, false);
      if (read.state === "absent") return { removed: false };
      const entryPath = join(this.rootPath, "entries", id);
      if (read.state === "entry" && read.entry.held) throw heldError(id, entryPath);
      const hold = await holdReasonFor(entryPath);
      if (hold) {
        const held: AmpleFileRecentlyDeletedHold = { reason: hold, noticedAt: this.#now().toISOString() };
        if (read.state === "entry") {
          await this.#writeManifest(entryPath, { ...manifestOf(read.entry), held }).catch(() => undefined);
        }
        throw heldError(id, entryPath);
      }
      await this.#erase(entryPath);
      return { removed: true };
    });
  }

  /**
   * Erases every complete entry whose `restoreBy` has passed, except trees
   * that cannot be fully listed: those become `held` and stay. Never throws
   * for a single entry; records
   * `lastPurgeAt` in `settings.json`.
   */
  async purgeExpired(now: Date = this.#now()): Promise<AmpleFileRecentlyDeletedPurgeResult> {
    return await this.#mutate(async () => {
      const result: AmpleFileRecentlyDeletedPurgeResult = { purged: [], held: [], failed: [] };
      for (const entry of (await this.#readAll(false)).entries) {
        if (entry.held) {
          result.held.push(entry.id);
          continue;
        }
        if (!entry.complete || Date.parse(entry.restoreBy) > now.getTime()) continue;
        try {
          const hold = await holdReasonFor(entry.entryPath);
          if (hold) {
            await this.#writeManifest(entry.entryPath, { ...manifestOf(entry), held: { reason: hold, noticedAt: now.toISOString() } });
            result.held.push(entry.id);
            continue;
          }
          await this.#erase(entry.entryPath);
          result.purged.push(entry.id);
        } catch (error) {
          result.failed.push({ id: entry.id, error: errorMessage(error) });
        }
      }
      await this.#writeSettings({ ...this.#settings, lastPurgeAt: now.toISOString() });
      return result;
    });
  }

  /** Runs `purgeExpired` only when at least `intervalMs` passed since the last purge (wake-tolerant daily cadence). */
  async purgeExpiredIfDue(intervalMs: number = AMPLEFILE_RECENTLY_DELETED_PURGE_INTERVAL_MS): Promise<AmpleFileRecentlyDeletedPurgeResult | null> {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "The purge interval must be a non-negative number of milliseconds.");
    }
    const now = this.#now();
    const last = this.#settings.lastPurgeAt === null ? Number.NaN : Date.parse(this.#settings.lastPurgeAt);
    if (Number.isFinite(last) && now.getTime() - last < intervalMs) return null;
    return await this.purgeExpired(now);
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }

  #newStagingDir(): string {
    return join(this.rootPath, "incoming", randomUUID());
  }

  async #sweep(): Promise<void> {
    const incoming = join(this.rootPath, "incoming");
    for (const name of await readdir(incoming).catch(() => [] as string[])) {
      await rm(join(incoming, name), { recursive: true, force: true }).catch(() => undefined);
    }
    const entries = join(this.rootPath, "entries");
    for (const name of await readdir(entries).catch(() => [] as string[])) {
      const entryPath = join(entries, name);
      const keeps = [MANIFEST_FILE, "payload", "state"].some((child) => existsSync(join(entryPath, child)));
      if (!keeps) await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #writeSettings(settings: RecentlyDeletedSettingsFile): Promise<void> {
    await writeFileAtomic(join(this.rootPath, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    this.#settings = settings;
  }

  async #writeManifest(entryPath: string, manifest: AmpleFileRecentlyDeletedManifest): Promise<void> {
    await writeFileAtomic(join(entryPath, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /**
   * Moves `source` to `destination`: `rename` first; when the devices differ,
   * a verbatim copy (symbolic links copied as links, never followed) into
   * `stagingDir` (or straight to the destination), fsync, rename into place,
   * then release of the source. Throws `MoveError` with `landed: true` only
   * once the destination holds a complete copy.
   */
  async #move(source: string, destination: string, options: { stagingDir?: string } = {}): Promise<void> {
    try {
      await this.#io.rename(source, destination);
      return;
    } catch (error) {
      if (!isNodeError(error, "EXDEV")) throw new MoveError(false, error);
    }
    const stagingDir = options.stagingDir;
    const copyTarget = stagingDir === undefined ? destination : join(stagingDir, basename(destination));
    try {
      if (stagingDir !== undefined) await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      await this.#io.cp(source, copyTarget, {
        recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
      });
      await syncTree(copyTarget);
      if (stagingDir !== undefined) await this.#io.rename(copyTarget, destination);
    } catch (error) {
      await rm(stagingDir ?? copyTarget, { recursive: true, force: true }).catch(() => undefined);
      throw new MoveError(false, error);
    }
    if (stagingDir !== undefined) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    try {
      await rm(source, { recursive: true, force: true });
    } catch (error) {
      throw new MoveError(true, error);
    }
  }

  /** Removes an entry directory atomically from the listing: rename into `incoming/`, then erase. */
  async #erase(entryPath: string): Promise<void> {
    const parked = this.#newStagingDir();
    try {
      await rename(entryPath, parked);
    } catch {
      await rm(entryPath, { recursive: true, force: true });
      return;
    }
    await rm(parked, { recursive: true, force: true });
  }

  async #readAll(repair: boolean): Promise<{ entries: AmpleFileRecentlyDeletedEntry[]; damaged: AmpleFileRecentlyDeletedDamagedRecord[] }> {
    const entriesDir = join(this.rootPath, "entries");
    const entries: AmpleFileRecentlyDeletedEntry[] = [];
    const damaged: AmpleFileRecentlyDeletedDamagedRecord[] = [];
    for (const name of await readdir(entriesDir).catch(() => [] as string[])) {
      if (!ampleFileRecentlyDeletedEntryIdPattern.test(name)) {
        const info = await lstat(join(entriesDir, name)).catch(() => null);
        if (info?.isDirectory()) damaged.push({ id: name, error: `${name} is not a ${RECENTLY_DELETED} record name.` });
        continue;
      }
      const read = await this.#readEntry(name, repair);
      if (read.state === "entry") entries.push(read.entry);
      else if (read.state === "damaged") damaged.push({ id: read.id, error: read.error });
    }
    entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt) || right.id.localeCompare(left.id));
    damaged.sort((left, right) => left.id.localeCompare(right.id));
    return { entries, damaged };
  }

  async #requireReadable(id: string, repair: boolean): Promise<AmpleFileRecentlyDeletedEntry | null> {
    const read = await this.#readEntry(id, repair);
    if (read.state === "absent") return null;
    if (read.state === "damaged") {
      throw new AmpleFileRecentlyDeletedError("STORE_DAMAGED", `The ${RECENTLY_DELETED} record ${id} is damaged: ${read.error}`, { entryId: id });
    }
    return read.entry;
  }

  async #requireEntry(id: string, repair: boolean): Promise<AmpleFileRecentlyDeletedEntry> {
    const entry = await this.#requireReadable(id, repair);
    if (!entry) throw new AmpleFileRecentlyDeletedError("NOT_FOUND", `Nothing in ${RECENTLY_DELETED} has the id ${id}.`, { entryId: id });
    return entry;
  }

  async #readEntry(id: string, repair: boolean): Promise<EntryRead> {
    const entryPath = join(this.rootPath, "entries", id);
    const info = await lstat(entryPath).catch(() => null);
    if (!info) return { state: "absent" };
    if (!info.isDirectory()) return { state: "damaged", id, error: "the record is not a directory." };
    let raw: string;
    try {
      raw = await readFile(join(entryPath, MANIFEST_FILE), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        const hasContent = ["payload", "state"].some((child) => existsSync(join(entryPath, child)));
        return hasContent ? { state: "damaged", id, error: "manifest.json is missing but content is present." } : { state: "absent" };
      }
      return { state: "damaged", id, error: `manifest.json cannot be read: ${errorMessage(error)}` };
    }
    let manifest: AmpleFileRecentlyDeletedManifest;
    try {
      manifest = parseManifest(JSON.parse(raw));
    } catch (error) {
      return { state: "damaged", id, error: `manifest.json is not a valid record: ${errorMessage(error)}` };
    }
    if (manifest.id !== id) return { state: "damaged", id, error: `manifest.json names ${manifest.id} instead of ${id}.` };
    const payloadPath = join(entryPath, "payload", manifest.payload.kind === "tree" || manifest.payload.kind === "skill"
      ? manifest.payload.name
      : manifest.payload.kind === "app-release"
        ? APP_RELEASE_FILE
        : manifest.payload.kind === "app-studio" ? APP_STUDIO_DIR : APP_DATA_FILE);
    const payloadInfo = await lstat(payloadPath).catch(() => null);
    if (!payloadInfo) {
      return { state: "damaged", id, error: manifest.complete ? "its content is missing." : "its content never arrived." };
    }
    let stateInfo: Stats | null;
    try {
      stateInfo = await lstat(join(entryPath, "state"));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) return { state: "damaged", id, error: "its History state cannot be inspected." };
      stateInfo = null;
    }
    if (stateInfo && (manifest.kind !== "connected-folder" || !stateInfo.isDirectory() || stateInfo.isSymbolicLink())) {
      return { state: "damaged", id, error: "its carried History state is not a valid Connected Folder state directory." };
    }
    if (manifest.stateDir && !stateInfo) {
      return { state: "damaged", id, error: "its History state is missing." };
    }
    let repaired = false;
    if (stateInfo && !manifest.stateDir) {
      // The state move can land before the final manifest commit. Also repair
      // complete records that an earlier version recovered without this flag.
      manifest = { ...manifest, stateDir: true };
      repaired = true;
    }
    if (!manifest.complete) {
      // The move landed but the commit never happened (a crash between the two manifest writes).
      const measured = manifest.payload.kind === "tree" || manifest.payload.kind === "skill" || manifest.payload.kind === "app-studio"
        ? await measureTree(payloadPath)
        : { sizeBytes: payloadInfo.size, approximate: false };
      manifest = {
        ...manifest,
        sizeBytes: measured.sizeBytes,
        ...(measured.approximate ? { sizeApproximate: true as const } : {}),
        complete: true,
      };
      repaired = true;
    }
    if (repair && repaired) await this.#writeManifest(entryPath, manifest).catch(() => undefined);
    return { state: "entry", entry: { ...manifest, entryPath, payloadPath } };
  }
}

function manifestOf(entry: AmpleFileRecentlyDeletedEntry): AmpleFileRecentlyDeletedManifest {
  const { entryPath: _entryPath, payloadPath: _payloadPath, ...manifest } = entry;
  return manifest;
}

function heldError(id: string, entryPath: string): AmpleFileRecentlyDeletedError {
  return new AmpleFileRecentlyDeletedError(
    "HELD",
    `AmpleFile could not look through everything in this item, so it will not erase it. Open its folder to handle it yourself: ${entryPath}`,
    { entryId: id },
  );
}

function newEntryId(deletedAt: string): string {
  return `trash-${deletedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}

function assertRetentionDays(days: number): void {
  if (!Number.isInteger(days) || days < AMPLEFILE_RECENTLY_DELETED_MIN_RETENTION_DAYS || days > AMPLEFILE_RECENTLY_DELETED_MAX_RETENTION_DAYS) {
    throw new AmpleFileRecentlyDeletedError(
      "INPUT_INVALID",
      `Deleted items can be kept for a whole number of days between ${AMPLEFILE_RECENTLY_DELETED_MIN_RETENTION_DAYS} and ${AMPLEFILE_RECENTLY_DELETED_MAX_RETENTION_DAYS}.`,
    );
  }
}

function assertEntryId(id: string): void {
  if (typeof id !== "string" || !ampleFileRecentlyDeletedEntryIdPattern.test(id)) {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", `${RECENTLY_DELETED} ids look like trash-YYYYMMDDHHMMSS-xxxxxxxx.`);
  }
}

function assertReason(reason: unknown): asserts reason is AmpleFileRecentlyDeletedReason {
  if (!RECENTLY_DELETED_REASONS.includes(reason as AmpleFileRecentlyDeletedReason)) {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "The reason must name the delete, Connected Folder, Skill, app-data, or Release command that produced the item.");
  }
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || FORBIDDEN_TEXT.test(value)) {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", `${label} must be plain text of at most ${maxLength} characters.`);
  }
  return value;
}

function requireReceiptId(value: unknown): string | null {
  if (value === null) return null;
  return requireText(value, "The receipt id", 200);
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value) || FORBIDDEN_TEXT.test(value)) {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", `${label} must be an absolute path.`);
  }
  return resolve(value);
}

function payloadNameFor(originalPath: string): string {
  const name = basename(originalPath.replace(/[\\/]+$/, ""));
  if (!isSafeSegment(name)) {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "The original path must end in a file or folder name.");
  }
  return name;
}

function isSafeSegment(name: string): boolean {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && name !== "." && name !== ".."
    && !/[\\/\u0000-\u001f]/.test(name);
}

function normalizeUncovered(value: unknown): AmpleFileRecentlyDeletedUncoveredPath[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_UNCOVERED_PATHS) {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", `The uncovered paths must be a list of at most ${MAX_UNCOVERED_PATHS} items.`);
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => key !== "path" && key !== "reason")
      || !UNCOVERED_REASONS.includes((item as AmpleFileRecentlyDeletedUncoveredPath).reason)) {
      throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "Each uncovered path needs a path and one of the History skip reasons.");
    }
    return { path: requireText((item as AmpleFileRecentlyDeletedUncoveredPath).path, "An uncovered path", MAX_TEXT_LENGTH), reason: (item as AmpleFileRecentlyDeletedUncoveredPath).reason };
  });
}

function normalizeSkillPayload(value: unknown): AmpleFileRecentlyDeletedSkillPayload {
  const invalid = (): never => {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "A kept Skill must name its scope, its folder, and the name Pi loads it under.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const raw = value as Partial<AmpleFileRecentlyDeletedSkillPayload>;
  if (Object.keys(raw).some((key) => !["kind", "scope", "name", "skillName"].includes(key)) || raw.kind !== "skill") return invalid();
  if (!SKILL_SCOPES.includes(raw.scope as AmpleFileRecentlyDeletedSkillPayload["scope"]) || !isSafeSegment(raw.name as string)) return invalid();
  if (typeof raw.skillName !== "string" || !raw.skillName.trim() || raw.skillName.length > 200 || FORBIDDEN_TEXT.test(raw.skillName)) return invalid();
  return { kind: "skill", scope: raw.scope!, name: raw.name!, skillName: raw.skillName };
}

function normalizeAppDataIdentity(value: unknown): AmpleFileRecentlyDeletedAppDataIdentity {
  const invalid = (): never => {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "The app data identity must name the app, its revision, installation, instance, namespace, source Connected Folder, and project.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.keys(value).some((key) => !APP_DATA_IDENTITY_KEYS.has(key))) return invalid();
  const raw = value as Partial<AmpleFileRecentlyDeletedAppDataIdentity>;
  if (raw.kind !== "app-data") return invalid();
  const text = (field: unknown): string => {
    if (typeof field !== "string" || !field.trim() || field.length > 512 || FORBIDDEN_TEXT.test(field)) return invalid();
    return field;
  };
  const identity: AmpleFileRecentlyDeletedAppDataIdentity = {
    kind: "app-data",
    appId: text(raw.appId),
    appDigest: text(raw.appDigest),
    featureInstallationId: text(raw.featureInstallationId),
    runtimeInstanceId: text(raw.runtimeInstanceId),
    dataNamespaceId: text(raw.dataNamespaceId),
    sourceConnectedFolderId: text(raw.sourceConnectedFolderId),
    projectId: text(raw.projectId),
    releaseDigest: raw.releaseDigest === null ? null : text(raw.releaseDigest),
  };
  if (raw.retainedDataId !== undefined) identity.retainedDataId = text(raw.retainedDataId);
  return identity;
}

function normalizeAppReleaseIdentity(value: unknown): AmpleFileRecentlyDeletedAppReleaseIdentity {
  const invalid = (): never => {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "The Release identity must name its App Project, digest, version, and source Connected Folder.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.keys(value).some((key) => !APP_RELEASE_IDENTITY_KEYS.has(key))) return invalid();
  const raw = value as Partial<AmpleFileRecentlyDeletedAppReleaseIdentity>;
  if (raw.kind !== "app-release") return invalid();
  const text = (field: unknown): string => {
    if (typeof field !== "string" || !field.trim() || field.length > 512 || FORBIDDEN_TEXT.test(field)) return invalid();
    return field;
  };
  return {
    kind: "app-release",
    projectId: text(raw.projectId),
    releaseDigest: text(raw.releaseDigest),
    displayVersion: text(raw.displayVersion),
    sourceConnectedFolderId: text(raw.sourceConnectedFolderId),
  };
}

function normalizeAppStudioIdentity(value: unknown): AmpleFileRecentlyDeletedAppStudioIdentity {
  const invalid = (): never => {
    throw new AmpleFileRecentlyDeletedError("INPUT_INVALID", "The App Studio identity must name its Connected Folder and App Project.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.keys(value).some((key) => !APP_STUDIO_IDENTITY_KEYS.has(key))) return invalid();
  const raw = value as Partial<AmpleFileRecentlyDeletedAppStudioIdentity>;
  if (raw.kind !== "app-studio" || !Object.hasOwn(raw, "projectId")) return invalid();
  const text = (field: unknown): string => {
    if (typeof field !== "string" || !field.trim() || field.length > 512 || FORBIDDEN_TEXT.test(field)) return invalid();
    return field;
  };
  return {
    kind: "app-studio",
    connectedFolderId: text(raw.connectedFolderId),
    projectId: raw.projectId === null ? null : text(raw.projectId),
  };
}

function parseManifest(value: unknown): AmpleFileRecentlyDeletedManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  const unknownKey = Object.keys(value).find((key) => !MANIFEST_KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`unknown field ${unknownKey}`);
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("unsupported version");
  if (typeof raw.id !== "string" || !ampleFileRecentlyDeletedEntryIdPattern.test(raw.id)) throw new Error("invalid id");
  if (!RECENTLY_DELETED_KINDS.includes(raw.kind as AmpleFileRecentlyDeletedKind)) throw new Error("invalid kind");
  if (!RECENTLY_DELETED_REASONS.includes(raw.reason as AmpleFileRecentlyDeletedReason)) throw new Error("invalid reason");
  if (typeof raw.connectedFolderId !== "string" || !raw.connectedFolderId.trim()) throw new Error("invalid spaceId");
  if (raw.connectedFolderName !== undefined && (typeof raw.connectedFolderName !== "string" || !raw.connectedFolderName.trim())) throw new Error("invalid spaceName");
  if (raw.displayName !== undefined && (typeof raw.displayName !== "string" || !raw.displayName.trim())) throw new Error("invalid displayName");
  if (typeof raw.originalPath !== "string" || !raw.originalPath.trim()) throw new Error("invalid originalPath");
  if (!Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 0) throw new Error("invalid sizeBytes");
  if (raw.sizeApproximate !== undefined && raw.sizeApproximate !== true) throw new Error("invalid sizeApproximate");
  for (const field of ["deletedAt", "restoreBy"]) {
    if (typeof raw[field] !== "string" || !Number.isFinite(Date.parse(raw[field] as string))) throw new Error(`invalid ${field}`);
  }
  if (raw.receiptId !== null && (typeof raw.receiptId !== "string" || !raw.receiptId.trim())) throw new Error("invalid receiptId");
  if (typeof raw.complete !== "boolean") throw new Error("invalid complete");
  if (raw.stateDir !== undefined && raw.stateDir !== true) throw new Error("invalid stateDir");
  const payload = parsePayload(raw.payload, raw.kind as AmpleFileRecentlyDeletedKind);
  const manifest: AmpleFileRecentlyDeletedManifest = {
    version: 1,
    id: raw.id,
    kind: raw.kind as AmpleFileRecentlyDeletedKind,
    reason: raw.reason as AmpleFileRecentlyDeletedReason,
    connectedFolderId: raw.connectedFolderId,
    originalPath: raw.originalPath,
    sizeBytes: raw.sizeBytes as number,
    deletedAt: raw.deletedAt as string,
    restoreBy: raw.restoreBy as string,
    receiptId: raw.receiptId as string | null,
    payload,
    complete: raw.complete,
  };
  if (raw.connectedFolderName !== undefined) manifest.connectedFolderName = raw.connectedFolderName as string;
  if (raw.displayName !== undefined) manifest.displayName = raw.displayName as string;
  if (raw.sizeApproximate === true) manifest.sizeApproximate = true;
  if (raw.stateDir === true) {
    if (manifest.kind !== "connected-folder") throw new Error("only a Connected Folder entry carries state");
    manifest.stateDir = true;
  }
  if (raw.uncovered !== undefined) {
    try {
      manifest.uncovered = normalizeUncovered(raw.uncovered);
    } catch {
      throw new Error("invalid uncovered");
    }
  }
  if (raw.held !== undefined) {
    const held = raw.held as { reason?: unknown; noticedAt?: unknown } | null;
    if (!held || typeof held !== "object" || Array.isArray(held)
      || Object.keys(held).some((key) => key !== "reason" && key !== "noticedAt")
      || typeof held.reason !== "string"
      || typeof held.noticedAt !== "string" || !Number.isFinite(Date.parse(held.noticedAt))) {
      throw new Error("invalid held");
    }
    // Any other hold reason (an earlier build could record one more) is
    // dropped, so the entry lists, expires, and can be deleted like any
    // other; the next purge or "Delete now" walks it again.
    if (held.reason === "unreadable") manifest.held = { reason: "unreadable", noticedAt: held.noticedAt };
  }
  return manifest;
}

function parsePayload(value: unknown, kind: AmpleFileRecentlyDeletedKind): AmpleFileRecentlyDeletedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid payload");
  const raw = value as Record<string, unknown>;
  if (kind === "file" || kind === "folder" || kind === "connected-folder") {
    if (raw.kind !== "tree" || Object.keys(raw).some((key) => key !== "kind" && key !== "name") || !isSafeSegment(raw.name as string)) {
      throw new Error("invalid tree payload");
    }
    return { kind: "tree", name: raw.name as string };
  }
  if (kind === "skill") {
    try {
      return normalizeSkillPayload(raw);
    } catch {
      throw new Error("invalid Skill payload");
    }
  }
  if (kind === "app-release") {
    try {
      return normalizeAppReleaseIdentity(raw);
    } catch {
      throw new Error("invalid Release payload");
    }
  }
  if (kind === "app-studio") {
    try {
      return normalizeAppStudioIdentity(raw);
    } catch {
      throw new Error("invalid App Studio payload");
    }
  }
  try {
    return normalizeAppDataIdentity(raw);
  } catch {
    throw new Error("invalid app data payload");
  }
}

async function loadSettings(path: string, defaultRetentionDays: number): Promise<RecentlyDeletedSettingsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw new AmpleFileRecentlyDeletedError("STORE_DAMAGED", `The ${RECENTLY_DELETED} settings at ${path} cannot be read: ${errorMessage(error)}`, { cause: error });
    }
    const settings: RecentlyDeletedSettingsFile = { version: 1, retentionDays: defaultRetentionDays, lastPurgeAt: null };
    await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AmpleFileRecentlyDeletedError("STORE_DAMAGED", `The ${RECENTLY_DELETED} settings at ${path} are not valid JSON. Nothing is guessed from a damaged file.`, { cause: error });
  }
  const record = parsed as Partial<RecentlyDeletedSettingsFile> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some((key) => !["version", "retentionDays", "lastPurgeAt"].includes(key))
    || record.version !== 1
    || !Number.isInteger(record.retentionDays) || record.retentionDays! < AMPLEFILE_RECENTLY_DELETED_MIN_RETENTION_DAYS || record.retentionDays! > AMPLEFILE_RECENTLY_DELETED_MAX_RETENTION_DAYS
    || (record.lastPurgeAt !== null && (typeof record.lastPurgeAt !== "string" || !Number.isFinite(Date.parse(record.lastPurgeAt))))) {
    throw new AmpleFileRecentlyDeletedError("STORE_DAMAGED", `The ${RECENTLY_DELETED} settings at ${path} are not a valid record. Nothing is guessed from a damaged file.`);
  }
  return { version: 1, retentionDays: record.retentionDays!, lastPurgeAt: record.lastPurgeAt ?? null };
}

/** Best-effort durability for a copied tree: fsync every regular file and directory, never following links. */
async function syncTree(path: string): Promise<void> {
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    const info = await lstat(current).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      for (const name of await readdir(current).catch(() => [] as string[])) stack.push(join(current, name));
      await syncDirectory(current);
    } else if (info.isFile()) {
      const handle = await open(current, "r").catch(() => null);
      if (!handle) continue;
      try {
        await handle.sync().catch(() => undefined);
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Bounded size walk (lstat only; links count their own size). */
async function measureTree(path: string): Promise<{ sizeBytes: number; approximate: boolean }> {
  let visited = 0;
  let sizeBytes = 0;
  let approximate = false;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    if (++visited > MEASURE_ENTRY_BUDGET) {
      approximate = true;
      break;
    }
    const info = await lstat(current).catch(() => null);
    if (!info) {
      approximate = true;
      continue;
    }
    if (info.isDirectory()) {
      const names = await readdir(current).catch(() => null);
      if (!names) {
        approximate = true;
        continue;
      }
      for (const name of names) stack.push(join(current, name));
    } else {
      sizeBytes += info.size;
    }
  }
  return { sizeBytes, approximate };
}

/**
 * Whether this entry must be held rather than erased, with the same visited
 * budget `measureTree` uses. Directories only (symbolic links are not
 * descended); an unlistable directory fails closed as `"unreadable"`, and so
 * does the budget: one pathological tree then becomes a held entry a person
 * can deal with, instead of an unbounded walk that stalls every later purge
 * behind it. Holding is always the safe answer — it never erases anything.
 */
async function holdReasonFor(entryPath: string): Promise<AmpleFileRecentlyDeletedHold["reason"] | null> {
  const stack = [entryPath];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop()!;
    const children = await readdir(current, { withFileTypes: true }).catch(() => null);
    if (!children) return "unreadable";
    for (const child of children) {
      if (++visited > MEASURE_ENTRY_BUDGET) return "unreadable";
      if (child.isDirectory()) stack.push(join(current, child.name));
    }
  }
  return null;
}

function nextAvailableDirectory(parent: string, segment: string): string {
  let candidate = join(parent, segment);
  for (let index = 2; existsSync(candidate); index += 1) candidate = join(parent, `${segment}-${index}`);
  return candidate;
}

function nextAvailableFile(desired: string): string {
  const extension = extname(desired);
  const stem = basename(desired, extension);
  let index = 2;
  let candidate = join(dirname(desired), `${stem} (${index})${extension}`);
  while (existsSync(candidate)) candidate = join(dirname(desired), `${stem} (${index += 1})${extension}`);
  return candidate;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
