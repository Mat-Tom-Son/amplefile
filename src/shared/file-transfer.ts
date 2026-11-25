/**
 * A copy, move, Duplicate, Compress, Extract, or paste as the transfer engine
 * answers it (src/local/file-operations.ts, src/local/file-conflicts.ts), and
 * the person's answers to a name clash. The window reads these answers from the
 * local API and, for a paste, from the desktop bridge (src/shared/desktop-ipc.ts).
 */

/**
 * A place the file manager shows: a Connected Folder, or a Standard Folder
 * (Desktop, Documents, Downloads, the computer, and every other folder under
 * the Standard Folder rules), each by its id.
 */
export type FileManagerPlace =
  | { kind: "connected-folder"; id: string }
  | { kind: "standard"; id: string };

export type ConflictChoice = "keep-both" | "skip" | "replace" | "merge";
export type InsideChoice = "keep-both" | "skip" | "replace";

export interface ConflictItemSummary { kind: "file" | "folder" | "link" | "other"; sizeBytes: number | null; modifiedAt: string }

export interface TransferConflict {
  key: string;
  name: string;
  source: ConflictItemSummary;
  existing: ConflictItemSummary;
  canMerge: boolean;
  insideClashes?: number | null;
}

export interface ConflictPolicy {
  apply?: ConflictChoice;
  items?: Record<string, ConflictChoice>;
  /** Same-named items inside every merged folder without an answer of its own. */
  inside?: InsideChoice;
  /** Same-named items inside one merged folder, by that folder's key: the answer given when Merge was chosen for it. */
  insideItems?: Record<string, InsideChoice>;
}

export type TransferRestorePoint = { connectedFolderId: string; checkpointId: string };

export interface ReplacedItem { path: string; recovery: "history" | "recently-deleted" | "trash" | "gone"; entryId?: string; restoreBy?: string }

/** The transfer engine's answer to a copy, move, Duplicate, paste, Compress, or Extract, every optional part included. */
export interface TransferAnswer {
  mode?: string;
  /** Compress and Extract: the new archive, or what Extract made (the archive's one item or a new folder), or null when nothing was made. */
  path?: string | null;
  written: string[];
  restorePoints: TransferRestorePoint[];
  copiedInstead?: boolean;
  /** Each item a move took out of its folder, for Undo to move back: every move between places, and between plain folders. */
  moves?: Array<{ from: string; to: string; fromPlace?: FileManagerPlace }>;
  /** Each item in both places (`notRemoved`), with where its copy is. */
  copies?: Array<{ from: string; to: string; fromPlace?: FileManagerPlace }>;
  /** Sources that were no longer there, when the request asked to go on without them. */
  missing?: Array<{ place: FileManagerPlace; path: string }>;
  cancelled?: boolean;
  notDone?: string[];
  leftInTarget?: string[];
  /** Items a move copied that could not leave their source, where they are still whole: they are in both places. */
  notRemoved?: string[];
  /** Items a move took out of their source except for a part it could not remove, which is still there. */
  partlyRemoved?: Array<{ path: string; error: string }>;
  replaced?: ReplacedItem[];
  skipped?: Array<{ path: string; reason: string }>;
  skippedClashes?: Array<{ path: string; reason: string }>;
  merged?: string[];
  /** The first item that did not go as asked, and why. */
  failed?: { path: string; error: string };
  /** Every item a move could not take out of its source, and why. */
  failures?: Array<{ path: string; error: string }>;
  recentlyDeleted?: Array<{ path: string; entryId: string; restoreBy: string }>;
  conflicts?: TransferConflict[];
  // Paste through the desktop.
  nothing?: boolean;
  /** The items were cut in a window of this app or copied in this one, and pasted by place. */
  fromHere?: boolean;
  count?: number;
  moved?: boolean;
  cut?: boolean;
  /** Where the items pasted by place came from (a Cut in any window, or this window's Copy). */
  from?: { place: FileManagerPlace; paths: string[] } | null;
  /** What the paste carries, as the desktop planned it; the run after the conflicts check sends it back. */
  plan?: string;
}
