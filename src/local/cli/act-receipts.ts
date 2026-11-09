import { appendFile, mkdir, open, readFile, rename, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";

import { AMPLEFILE_CLI_REQUEST_FUTURE_SKEW_MS, AMPLEFILE_CLI_REQUEST_MAX_AGE_MS, ampleFileCliBrokerPaths } from "./broker.js";
import { AmpleFileCliError, type AmpleFileCliErrorCode } from "./protocol.js";

/** Each journal generation rotates past this size once its oldest entry is outside the broker freshness window. */
export const AMPLEFILE_CLI_ACT_RECEIPTS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Durable, append-only journal of act-lane commands. Every authorized command
 * writes an `accepted` line BEFORE its mutation runs — the executor refuses to
 * run anything it could not journal — and a terminal `ok`/`error` line after,
 * so a crash can interrupt the pair but can never leave an applied action
 * without a trace. `accepted` lines are also the at-most-once ledger: a
 * request id that already has one is refused instead of re-executed, which is
 * what makes a replayed mutation safe even after the broker's response file
 * has been cleaned up. Terminal appends stay best-effort (an applied mutation
 * must not be failed retroactively); the executor surfaces a warning when one
 * cannot be written.
 */
export interface AmpleFileCliActReceiptV3 {
  v: 3;
  at: string;
  requestId: string;
  command: string;
  connectedFolderId?: string;
  conversationId?: string;
  outcome: "accepted" | "ok" | "error" | "rejected";
  errorCode?: AmpleFileCliErrorCode;
  checkpointId?: string;
  taskId?: string;
  /** Kernel task id of the AmpleFile Agent turn this act was performed for, when one was running. */
  parentTaskId?: string;
  detail?: string;
  surface?: AmpleFileCliActSurface;
  undoRef?: AmpleFileCliActUndoRef;
}

/**
 * Closed surface vocabulary for act receipts: the authenticated surface that
 * initiated an act — the act CLI, the menu-bar popover, or the main window's
 * Settings acts.
 */
export const AMPLEFILE_CLI_ACT_SURFACES = ["cli", "popover", "main-window"] as const;

export type AmpleFileCliActSurface = (typeof AMPLEFILE_CLI_ACT_SURFACES)[number];

/**
 * Typed pointer to the prior state an undo verb needs — identifiers, digests,
 * or short prior values (a title, a lifecycle state) only. Receipts never
 * grow file contents, message text, queries, or secrets.
 */
export interface AmpleFileCliActUndoRef {
  kind: string;
  value: string;
}

/** Journal lines are written and read at version 3, the version every AmpleFile build writes. */
export type AmpleFileCliActReceipt = AmpleFileCliActReceiptV3;

export interface AmpleFileCliActReceiptsIo {
  appendFile: typeof appendFile;
  stat: typeof stat;
}

export interface AmpleFileCliActReceiptsOptions {
  stateRoot: string;
  maxBytes?: number;
  /** File operations behind an append, replaceable only to inject faults in tests. */
  io?: Partial<AmpleFileCliActReceiptsIo>;
  now?: () => Date;
}

/**
 * Act verbs that only read AmpleFile's own recorded state: status, lists,
 * shows, and the overview. Their receipts go to a sibling journal
 * (`act-reads.jsonl`) so a `chat wait` poll, which reads status every two
 * seconds, never pushes the receipts of real acts out of the journal's
 * rotation window or out of the overview. Reads whose answer is also a
 * delivery (`chat result`, `agent result`, `jobs output`) and reads of a
 * person's files (History and search) stay with the acts.
 */
export const AMPLEFILE_CLI_ACT_READ_COMMANDS: ReadonlySet<string> = new Set([
  "chat.status",
  "chat.children",
  "chats.list",
  "agent.status",
  "agent.list",
  "agent.overview",
  "connected-folders.worker.show",
  "automations.list",
  "automations.models",
  "automations.show",
  "automations.receipts",
  "recently-deleted.list",
  "requests.list",
  "requests.show",
  "jobs.list",
  "jobs.show",
]);

/**
 * How long a damaged line can still matter: the broker refuses a request
 * older than its freshness window (allowing for future clock skew), so an
 * accepted id written before time T can no longer be replayed after
 * T + window + skew.
 */
const replayHorizonMs = AMPLEFILE_CLI_REQUEST_MAX_AGE_MS + AMPLEFILE_CLI_REQUEST_FUTURE_SKEW_MS;

const journalUnverifiable = "AmpleFile could not verify the act receipt journal.";

/** One live-plus-rotated journal pair and what this process knows about it. */
class ReceiptJournal {
  readonly path: string;
  readonly rotatedPath: string;
  liveIds = new Set<string>();
  rotatedIds = new Set<string>();
  /** The live file as of the last read or own append; null while it is absent. */
  live: { ino: number; size: number } | null = null;
  liveFirstAt: number | null = null;
  loaded = false;
  repaired = false;
  /** Until then a damaged line could still hide a replayable accepted id. */
  damagedUntil = 0;

  constructor(path: string, rotatedPath: string) {
    this.path = path;
    this.rotatedPath = rotatedPath;
  }

  has(requestId: string): boolean {
    return this.liveIds.has(requestId) || this.rotatedIds.has(requestId);
  }
}

export class AmpleFileCliActReceipts {
  readonly path: string;
  readonly rotatedPath: string;
  /** Receipts of the read-only verbs in `AMPLEFILE_CLI_ACT_READ_COMMANDS`. */
  readonly readsPath: string;
  readonly readsRotatedPath: string;
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  readonly #io: AmpleFileCliActReceiptsIo;
  readonly #acts: ReceiptJournal;
  readonly #reads: ReceiptJournal;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: AmpleFileCliActReceiptsOptions) {
    this.#directory = join(ampleFileCliBrokerPaths(options.stateRoot).root, "receipts");
    this.path = join(this.#directory, "act.jsonl");
    this.rotatedPath = join(this.#directory, "act.1.jsonl");
    this.readsPath = join(this.#directory, "act-reads.jsonl");
    this.readsRotatedPath = join(this.#directory, "act-reads.1.jsonl");
    this.#maxBytes = options.maxBytes ?? AMPLEFILE_CLI_ACT_RECEIPTS_MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
    this.#io = { appendFile, stat, ...options.io };
    this.#acts = new ReceiptJournal(this.path, this.rotatedPath);
    this.#reads = new ReceiptJournal(this.readsPath, this.readsRotatedPath);
  }

  /**
   * Serialized best-effort append; resolves false when the receipt could not
   * be written. An `accepted` line for a request id that already has one is
   * never written: the at-most-once ledger refuses it instead.
   */
  append(entry: Omit<AmpleFileCliActReceiptV3, "v" | "at">): Promise<boolean> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      const journal = AMPLEFILE_CLI_ACT_READ_COMMANDS.has(entry.command) ? this.#reads : this.#acts;
      try {
        const record: AmpleFileCliActReceiptV3 = {
          v: 3,
          at: this.#now().toISOString(),
          ...entry,
          command: scrubText(entry.command),
          ...(entry.detail !== undefined ? { detail: scrubText(entry.detail) } : {}),
          ...(entry.undoRef !== undefined
            ? { undoRef: { kind: entry.undoRef.kind, value: scrubText(entry.undoRef.value) } }
            : {}),
        };
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        await this.#sync(journal);
        if (record.outcome === "accepted" && (this.#acts.has(record.requestId) || this.#reads.has(record.requestId))) return false;
        await this.#rotateIfNeeded(journal);
        const line = `${JSON.stringify(record)}\n`;
        const before = journal.live?.size ?? 0;
        try {
          await this.#io.appendFile(journal.path, line, { mode: 0o600, flush: true });
        } catch (error) {
          await this.#discardTornAppend(journal);
          throw error;
        }
        if (record.outcome === "accepted") journal.liveIds.add(record.requestId);
        journal.liveFirstAt ??= Date.parse(record.at);
        // The line is durable now, so the append succeeded whatever happens
        // next; a file this process cannot stat is simply read again later.
        const info = await this.#io.stat(journal.path).catch(() => null);
        const expected = before + Buffer.byteLength(line, "utf8");
        if (info === null) {
          journal.loaded = false;
        } else if (journal.live === null || info.ino === journal.live.ino) {
          // A size other than expected means another writer appended too;
          // the next read picks its lines up from where this one began.
          journal.live = { ino: info.ino, size: info.size === expected ? expected : before };
        } else {
          journal.loaded = false;
        }
        return true;
      } catch {
        return false;
      }
    });
    this.#queue = operation;
    return operation;
  }

  /**
   * True when this request id already has an accepted record (live or
   * rotated, in either journal). Answered from memory: the journals are read
   * once, then only what was appended since. A journal that cannot be read,
   * or a damaged line recent enough to hide an id the broker could still
   * accept, fails closed rather than risk a replay.
   */
  hasAccepted(requestId: string): Promise<boolean> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      for (const journal of [this.#acts, this.#reads]) {
        await this.#sync(journal);
        if (this.#now().getTime() < journal.damagedUntil) {
          throw new AmpleFileCliError("failure", journalUnverifiable);
        }
      }
      return this.#acts.has(requestId) || this.#reads.has(requestId);
    });
    this.#queue = operation;
    return operation;
  }

  /** Brings what this process knows up to date with the journal on disk. */
  async #sync(journal: ReceiptJournal): Promise<void> {
    const info = await stat(journal.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AmpleFileCliError("failure", journalUnverifiable, { cause: error });
    });
    if (journal.loaded) {
      if (info === null && journal.live === null) return;
      if (info && journal.live && info.ino === journal.live.ino && info.size >= journal.live.size) {
        if (info.size > journal.live.size) await this.#readAppended(journal, info.ino);
        return;
      }
    }
    await this.#load(journal);
  }

  /** Reads both generations whole; at startup, also cuts a torn final append. */
  async #load(journal: ReceiptJournal): Promise<void> {
    journal.rotatedIds = new Set();
    journal.liveIds = new Set();
    journal.liveFirstAt = null;
    journal.damagedUntil = 0;
    const rotated = await readJournalText(journal.rotatedPath);
    if (rotated !== null) {
      const scan = scanLines(rotated.text, rotated.mtimeMs);
      for (const id of scan.accepted) journal.rotatedIds.add(id);
      journal.damagedUntil = Math.max(journal.damagedUntil, scan.damagedUntil);
    }
    const live = await readJournalText(journal.path);
    if (live === null) {
      journal.live = null;
    } else {
      const scan = scanLines(live.text, live.mtimeMs);
      for (const id of scan.accepted) journal.liveIds.add(id);
      journal.damagedUntil = Math.max(journal.damagedUntil, scan.damagedUntil);
      journal.liveFirstAt = scan.firstAt;
      let size = scan.completeBytes;
      if (scan.completeBytes < live.size && !journal.repaired) {
        // A final line without its newline is an append that never
        // completed — the executor ran nothing after it — so it is cut
        // rather than left for the next append to run into.
        await truncate(journal.path, scan.completeBytes).catch(() => {
          size = live.size;
        });
      }
      journal.live = { ino: live.ino, size };
    }
    journal.repaired = true;
    journal.loaded = true;
  }

  /** Reads only the complete lines appended since this process last looked. */
  async #readAppended(journal: ReceiptJournal, ino: number): Promise<void> {
    const offset = journal.live!.size;
    let text: string;
    let mtimeMs: number;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(journal.path, "r");
      const info = await handle.stat();
      const buffer = Buffer.alloc(Math.max(0, info.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
      text = buffer.subarray(0, bytesRead).toString("utf8");
      mtimeMs = info.mtimeMs;
    } catch (error) {
      throw new AmpleFileCliError("failure", journalUnverifiable, { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const scan = scanLines(text, mtimeMs);
    for (const id of scan.accepted) journal.liveIds.add(id);
    journal.damagedUntil = Math.max(journal.damagedUntil, scan.damagedUntil);
    journal.liveFirstAt ??= scan.firstAt;
    journal.live = { ino, size: offset + scan.completeBytes };
  }

  /**
   * Cuts back a line this process failed to finish appending, including the
   * first line of a journal the append itself created (a fresh journal, or
   * the first append after a rotation), so the next line never runs into it.
   */
  async #discardTornAppend(journal: ReceiptJournal): Promise<void> {
    const info = await stat(journal.path).catch(() => null);
    if (!info) return;
    if (journal.live && info.ino === journal.live.ino && info.size > journal.live.size) {
      await truncate(journal.path, journal.live.size).catch(() => undefined);
    } else if (!journal.live && journal.loaded) {
      // The journal was absent when this append began, so all of it is the
      // unfinished line.
      try {
        await truncate(journal.path, 0);
        journal.live = { ino: info.ino, size: 0 };
      } catch {
        journal.loaded = false;
        journal.repaired = false;
      }
    } else {
      // Unknown state: read it whole next time and cut an unfinished tail.
      journal.loaded = false;
      journal.repaired = false;
    }
  }

  async #rotateIfNeeded(journal: ReceiptJournal): Promise<void> {
    if (!journal.live || journal.live.size <= this.#maxBytes) return;
    // Accepted records are the at-most-once ledger, and the broker refuses
    // requests older than its freshness window, so the ledger only needs to
    // stay findable for that long. While the live file still holds an entry
    // younger than the window, rotating (which discards the previous rotated
    // file) could drop a gate-relevant accepted id — so rotation waits and
    // the file temporarily overgrows instead.
    const firstAt = journal.liveFirstAt;
    if (firstAt !== null && Number.isFinite(firstAt) && this.#now().getTime() - firstAt < AMPLEFILE_CLI_REQUEST_MAX_AGE_MS) return;
    await rm(journal.rotatedPath, { force: true });
    await rename(journal.path, journal.rotatedPath);
    journal.rotatedIds = journal.liveIds;
    journal.liveIds = new Set();
    journal.live = null;
    journal.liveFirstAt = null;
  }
}

async function readJournalText(path: string): Promise<{ text: string; size: number; ino: number; mtimeMs: number } | null> {
  try {
    const bytes = await readFile(path);
    const info = await stat(path);
    return { text: bytes.toString("utf8"), size: bytes.byteLength, ino: info.ino, mtimeMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AmpleFileCliError("failure", journalUnverifiable, { cause: error });
  }
}

/**
 * Parses the complete (newline-terminated) lines of a journal chunk. A line
 * that does not parse is damage: it might be an accepted record, so it keeps
 * the journal unverifiable until the broker would refuse any request it
 * could name — measured from the next readable line's time, which was
 * written after it, or else from the file's modification time.
 */
function scanLines(text: string, mtimeMs: number): { accepted: string[]; firstAt: number | null; damagedUntil: number; completeBytes: number } {
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
  const accepted: string[] = [];
  let firstAt: number | null = null;
  let damagedUntil = 0;
  let pendingDamage = false;
  for (const line of complete.split("\n")) {
    if (!line) continue;
    let record: Partial<AmpleFileCliActReceipt>;
    try {
      record = JSON.parse(line) as Partial<AmpleFileCliActReceipt>;
    } catch {
      pendingDamage = true;
      continue;
    }
    const at = typeof record?.at === "string" ? Date.parse(record.at) : Number.NaN;
    if (Number.isFinite(at)) {
      firstAt ??= at;
      if (pendingDamage) {
        damagedUntil = Math.max(damagedUntil, at + replayHorizonMs);
        pendingDamage = false;
      }
    }
    if (record && typeof record.requestId === "string" && record.outcome === "accepted") accepted.push(record.requestId);
  }
  if (pendingDamage) damagedUntil = Math.max(damagedUntil, mtimeMs + replayHorizonMs);
  return { accepted, firstAt, damagedUntil, completeBytes: Buffer.byteLength(complete, "utf8") };
}

function scrubText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "\uFFFD");
}
