/**
 * Keeps each Connected Folder's index current (docs/index-and-recall.md).
 *
 * A sync walks the folder's metadata, compares size and modification time
 * with what the index holds, hashes, extracts, and embeds what changed, and
 * drops what is gone. Then it does the same for the folder's Chats.
 *
 * It is a good citizen:
 * - one Connected Folder at a time, in small steps, abortable at every await;
 * - no file is held open across an await beyond one bounded read;
 * - while a deletion, restore, Eject, or any other Connected Folder
 *   reservation is held, it stops at the next step and holds no handle on
 *   the folder; it never reserves anything itself, so it never causes a busy
 *   refusal;
 * - it checks the folder is still registered at that root right before it
 *   opens the index, so it never recreates the state of a folder being
 *   removed.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { conversationsDir, listConversations, readConversation } from "../agent/chat-store.js";
import { listIndexableFiles, type IndexWalkOptions } from "./content-policy.js";
import { createDefaultConnectedFolderIndexEmbedder, type ConnectedFolderIndexEmbedder } from "./embedder.js";
import { chunkChatMessage, extractIndexableFile, type ExtractOptions } from "./extract.js";
import { recallConnectedFolder, readConnectedFolderIndexCoverage, type RecallCoverage, type RecallOptions, type RecallResult } from "./recall.js";
import { ConnectedFolderIndexStore, deleteConnectedFolderIndex, type IndexedFileRow } from "./store.js";

export interface IndexedConnectedFolder {
  id: string;
  connectedFolderRoot: string;
}

export interface ConnectedFolderIndexServiceOptions {
  embedder?: ConnectedFolderIndexEmbedder;
  /** True while any reservation is held on the folder; the indexer stops and waits. */
  isReserved?: (connectedFolderId: string) => boolean;
  /** The folder as registered now, or null when it is no longer registered. */
  resolve?: (connectedFolderId: string) => Promise<IndexedConnectedFolder | null>;
  extract?: ExtractOptions;
  walkBounds?: IndexWalkOptions["bounds"];
  /** Debounces for the background triggers. */
  delays?: Partial<{ shownMs: number; changedMs: number; turnMs: number; retryMs: number }>;
}

export interface ConnectedFolderIndexStatus extends RecallCoverage {
  connectedFolderId: string;
  /** Set when the last sync stopped for a reservation and will try again. */
  stoppedFor?: "reserved";
}

export type ConnectedFolderIndexTrigger = "query" | "shown" | "changed" | "turn" | "stale" | "retry";

const chatMessageKindsLeftOut = new Set(["conversation_lifecycle", "conversation_title", "assistant_continuation", "context_compaction"]);
const maxConversations = 2_000;
const maxMessagesPerConversation = 5_000;
const embedBatch = 16;
const maxEmbedCharacters = 2_000;
const defaultMaxPassages = 6;
const defaultPassageWords = 12;

export class ConnectedFolderIndexService {
  readonly embedder: ConnectedFolderIndexEmbedder;
  readonly #isReserved: (connectedFolderId: string) => boolean;
  readonly #resolve: (connectedFolderId: string) => Promise<IndexedConnectedFolder | null>;
  readonly #extract: ExtractOptions;
  readonly #walkBounds: IndexWalkOptions["bounds"];
  readonly #delays: { shownMs: number; changedMs: number; turnMs: number; retryMs: number };
  readonly #queue = new Map<string, IndexedConnectedFolder>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #due = new Map<string, number>();
  readonly #waiters = new Map<string, Array<() => void>>();
  readonly #stoppedFor = new Map<string, "reserved">();
  #running: { folder: IndexedConnectedFolder; controller: AbortController; done: Promise<void> } | null = null;
  #closed = false;

  constructor(options: ConnectedFolderIndexServiceOptions = {}) {
    this.embedder = options.embedder ?? createDefaultConnectedFolderIndexEmbedder();
    this.#isReserved = options.isReserved ?? (() => false);
    this.#resolve = options.resolve ?? (async () => null);
    this.#extract = options.extract ?? {};
    this.#walkBounds = options.walkBounds;
    this.#delays = { shownMs: 2_000, changedMs: 5_000, turnMs: 3_000, retryMs: 15_000, ...options.delays };
  }

  /** Asks for a sync after the trigger's debounce; a later request for the same folder replaces an earlier one. */
  schedule(folder: IndexedConnectedFolder, trigger: ConnectedFolderIndexTrigger): void {
    if (this.#closed) return;
    const delay = trigger === "shown" ? this.#delays.shownMs
      : trigger === "changed" ? this.#delays.changedMs
      : trigger === "turn" ? this.#delays.turnMs
      : trigger === "retry" ? this.#delays.retryMs
      : 0;
    const due = Date.now() + Math.max(0, delay);
    const existing = this.#timers.get(folder.id);
    // A burst of changes keeps the earliest pending sync rather than pushing it back.
    if (existing && (this.#due.get(folder.id) ?? Infinity) <= due) return;
    if (existing) clearTimeout(existing);
    this.#timers.delete(folder.id);
    this.#due.delete(folder.id);
    if (delay <= 0) { this.#enqueue(folder); return; }
    const timer = setTimeout(() => { this.#timers.delete(folder.id); this.#due.delete(folder.id); this.#enqueue(folder); }, delay);
    timer.unref();
    this.#timers.set(folder.id, timer);
    this.#due.set(folder.id, due);
  }

  /** Syncs now (queued behind the folder being synced, if any) and resolves when that sync ends, or after `waitMs`. */
  async sync(folder: IndexedConnectedFolder, options: { waitMs?: number } = {}): Promise<void> {
    if (this.#closed) return;
    const done = new Promise<void>((resolve) => {
      const list = this.#waiters.get(folder.id) ?? [];
      list.push(resolve);
      this.#waiters.set(folder.id, list);
    });
    this.schedule(folder, "query");
    if (options.waitMs === undefined) return done;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([done, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.waitMs); timer.unref(); })]);
    clearTimeout(timer);
  }

  /**
   * Ranked search: brings the index up to date (waiting at most `waitMs`),
   * then queries it. A stale hit queues its folder for another pass.
   */
  async recall(folder: IndexedConnectedFolder, query: string, options: Omit<RecallOptions, "embedder" | "onStale" | "running"> & {
    waitMs?: number;
    /**
     * `wait` (the default) syncs first, waiting at most `waitMs`; `background`
     * answers from the index as it is and asks for a sync after the shown
     * debounce, so a search across many folders never queues a pass per query.
     */
    refresh?: "wait" | "background";
  } = {}): Promise<RecallResult> {
    const { waitMs = 1_500, refresh = "wait", ...recallOptions } = options;
    if (refresh === "background") this.schedule(folder, "shown");
    else if (!this.#isReserved(folder.id)) await this.sync(folder, { waitMs });
    let stale = false;
    const result = await recallConnectedFolder(folder.connectedFolderRoot, query, {
      ...recallOptions,
      embedder: this.embedder,
      running: this.#isRunning(folder.id),
      onStale: () => { stale = true; },
    });
    if (stale) this.schedule(folder, "stale");
    return result;
  }

  status(folder: IndexedConnectedFolder): ConnectedFolderIndexStatus {
    const stoppedFor = this.#stoppedFor.get(folder.id);
    return {
      connectedFolderId: folder.id,
      ...readConnectedFolderIndexCoverage(folder.connectedFolderRoot, this.embedder, this.#isRunning(folder.id)),
      ...(stoppedFor ? { stoppedFor } : {}),
    };
  }

  /** Stops any work on the folder and deletes its index; used when the folder is removed or disconnected. */
  async forget(folder: IndexedConnectedFolder): Promise<void> {
    const timer = this.#timers.get(folder.id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(folder.id);
    this.#due.delete(folder.id);
    this.#queue.delete(folder.id);
    this.#stoppedFor.delete(folder.id);
    const running = this.#running;
    if (running?.folder.id === folder.id) {
      running.controller.abort();
      await running.done.catch(() => undefined);
    }
    this.#release(folder.id);
    await deleteConnectedFolderIndex(folder.connectedFolderRoot);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#queue.clear();
    const running = this.#running;
    running?.controller.abort();
    await running?.done.catch(() => undefined);
    for (const id of [...this.#waiters.keys()]) this.#release(id);
    await this.embedder.close();
  }

  #isRunning(connectedFolderId: string): boolean {
    return this.#running?.folder.id === connectedFolderId || this.#queue.has(connectedFolderId);
  }

  #enqueue(folder: IndexedConnectedFolder): void {
    if (this.#closed) return;
    // A sync already running picks up later changes on its next pass.
    this.#queue.set(folder.id, folder);
    this.#pump();
  }

  #release(connectedFolderId: string): void {
    const waiters = this.#waiters.get(connectedFolderId);
    this.#waiters.delete(connectedFolderId);
    for (const resolve of waiters ?? []) resolve();
  }

  #pump(): void {
    if (this.#running || this.#closed) return;
    const next = this.#queue.entries().next();
    if (next.done) return;
    const [id, folder] = next.value;
    this.#queue.delete(id);
    const controller = new AbortController();
    const done = (async () => {
      try {
        const outcome = await syncConnectedFolderIndex(folder, {
          signal: controller.signal,
          shouldStop: () => this.#closed || this.#isReserved(id),
          resolve: this.#resolve,
          embedder: this.embedder,
          extract: this.#extract,
          walkBounds: this.#walkBounds,
        });
        if (outcome === "reserved") {
          this.#stoppedFor.set(id, "reserved");
          this.schedule(folder, "retry");
        } else {
          this.#stoppedFor.delete(id);
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.warn(`AmpleFile could not update a Connected Folder's index: ${(error as Error).message}`);
      }
    })();
    this.#running = { folder, controller, done };
    void done.finally(() => {
      if (this.#running?.done === done) this.#running = null;
      if (!this.#queue.has(id)) this.#release(id);
      this.#pump();
    });
  }
}

interface SyncContext {
  signal: AbortSignal;
  shouldStop: () => boolean;
  resolve: (connectedFolderId: string) => Promise<IndexedConnectedFolder | null>;
  embedder: ConnectedFolderIndexEmbedder;
  extract: ExtractOptions;
  walkBounds?: IndexWalkOptions["bounds"];
}

/**
 * One pass over one Connected Folder. Returns `reserved` when it stopped for
 * a reservation, `gone` when the folder is no longer registered at that root,
 * and `done` otherwise.
 */
export async function syncConnectedFolderIndex(folder: IndexedConnectedFolder, context: SyncContext): Promise<"done" | "reserved" | "gone"> {
  const root = folder.connectedFolderRoot;
  const stop = (): "reserved" | null => {
    if (context.signal.aborted) throw Object.assign(new Error("Indexing stopped."), { name: "AbortError" });
    return context.shouldStop() ? "reserved" : null;
  };
  if (stop()) return "reserved";
  const walk = await listIndexableFiles(root, { signal: context.signal, shouldStop: context.shouldStop, bounds: context.walkBounds })
    .catch((error: Error) => { if (error.name === "AbortError" && !context.signal.aborted) return null; throw error; });
  if (!walk || stop()) return "reserved";
  const registered = await context.resolve(folder.id).catch(() => null);
  if (!registered || registered.connectedFolderRoot !== root) return "gone";
  // Nothing is awaited between this check and opening the index.
  if (stop()) return "reserved";
  const store = ConnectedFolderIndexStore.open(root);
  if (!store) return "gone";
  try {
    // Compare metadata and queue what changed.
    const known = new Map(store.listFiles().map((row) => [row.path, row]));
    const work: Array<{ path: string; size: number; mtimeMs: number; previous?: IndexedFileRow }> = [];
    store.transaction(() => {
      const seen = new Set<string>();
      for (const file of walk.files) {
        seen.add(file.path);
        const previous = known.get(file.path);
        if (file.notDownloaded) {
          if (previous?.status !== "not-downloaded" || previous.size !== file.size || previous.mtimeMs !== file.mtimeMs) {
            store.putFile({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, sha256: null, status: "not-downloaded", indexedAt: null });
          }
          continue;
        }
        if (previous && previous.status !== "pending" && previous.size === file.size && previous.mtimeMs === file.mtimeMs) continue;
        store.putFile({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, sha256: previous?.sha256 ?? null, status: "pending", indexedAt: previous?.indexedAt ?? null });
        work.push({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, ...(previous ? { previous } : {}) });
      }
      // An incomplete walk (a bound, an unreadable directory, a file that
      // vanished mid-walk) proves nothing about what it did not see; those
      // rows stay until a complete walk, and a hit on one is checked at return.
      if (walk.complete) for (const path of known.keys()) if (!seen.has(path)) store.deleteFile(path);
      store.setMeta("walk", JSON.stringify({ complete: walk.complete, stoppedBy: walk.stoppedBy, excluded: walk.excluded }));
    });
    // Extract what changed, one bounded read at a time.
    for (const item of work) {
      if (stop()) return "reserved";
      const extraction = await extractIndexableFile(root, item.path, item, { ...context.extract, signal: context.signal });
      if (stop()) return "reserved";
      store.transaction(() => {
        const indexedAt = new Date().toISOString();
        if (extraction.status === "changed") return;
        if (extraction.status === "indexed") {
          store.putContent(extraction.sha256, extraction.kind, extraction.chunks, extraction.truncated);
          store.putFile({ path: item.path, size: item.size, mtimeMs: item.mtimeMs, sha256: extraction.sha256, status: "indexed", indexedAt });
        } else {
          store.putFile({ path: item.path, size: item.size, mtimeMs: item.mtimeMs, sha256: extraction.sha256, status: extraction.status, indexedAt });
        }
      });
      await yieldTurn();
    }
    // Chats.
    if (stop()) return "reserved";
    const chatsComplete = await syncChats(root, store, stop);
    if (chatsComplete === "reserved") return "reserved";
    store.setMeta("chatsComplete", chatsComplete ? "true" : "false");
    store.collectGarbage();
    store.setMeta("lastSyncAt", new Date().toISOString());
    // Embeddings last: lexical search is useful as soon as text is in.
    if (context.embedder.available()) {
      for (;;) {
        if (stop()) return "reserved";
        const batch = store.chunksToEmbed(context.embedder.id, embedBatch);
        if (!batch.length) break;
        const passages = batch.map((chunk) => embeddingPassages(chunk.text));
        // One language detection per chunk, not per passage.
        const vectors = await context.embedder.embed(passages.flatMap((texts, group) => texts.map((text) => ({ text, group }))), context.signal);
        // A helper that failed mid-batch is not a "no vector" answer for these chunks.
        if (!context.embedder.available()) break;
        if (stop()) return "reserved";
        store.transaction(() => {
          let at = 0;
          batch.forEach((chunk, index) => {
            const count = passages[index]!.length;
            store.putVectors(chunk.chunkId, context.embedder.id, vectors.slice(at, at + count));
            at += count;
          });
        });
        await yieldTurn();
      }
    }
    store.setMeta("lastSyncAt", new Date().toISOString());
    return "done";
  } finally {
    store.close();
  }
}

/** Indexes the folder's Chat messages; returns whether every Chat was covered. */
async function syncChats(root: string, store: ConnectedFolderIndexStore, stop: () => "reserved" | null): Promise<boolean | "reserved"> {
  const conversations = await listConversations(root).catch(() => null);
  if (!conversations) return false;
  if (stop()) return "reserved";
  const known = store.listConversationVersions();
  const listed = new Set<string>();
  let complete = conversations.length <= maxConversations;
  for (const conversation of conversations.slice(0, maxConversations)) {
    listed.add(conversation.id);
    const info = await stat(join(conversationsDir(root), `${conversation.id}.jsonl`)).catch(() => null);
    if (stop()) return "reserved";
    if (!info) { complete = false; continue; }
    const version = { size: info.size, mtimeMs: info.mtimeMs, title: conversation.title };
    const previous = known.get(conversation.id);
    if (previous && previous.size === version.size && previous.mtimeMs === version.mtimeMs && previous.title === version.title) continue;
    const messages = await readConversation(root, conversation.id).catch(() => null);
    if (stop()) return "reserved";
    if (!messages) { complete = false; continue; }
    if (messages.length > maxMessagesPerConversation) complete = false;
    store.transaction(() => {
      const rows: Array<{ messageId: string; role: string; createdAt: string; sha256: string }> = [];
      for (const message of messages.slice(0, maxMessagesPerConversation)) {
        if (chatMessageKindsLeftOut.has(message.kind ?? "") || !message.content?.trim()) continue;
        const sha256 = createHash("sha256").update(`chat\0${message.content}`).digest("hex");
        if (!store.hasContent(sha256)) store.putContent(sha256, "chat", chunkChatMessage(message.content), false);
        rows.push({ messageId: message.id, role: message.role, createdAt: message.createdAt, sha256 });
      }
      store.replaceConversation(conversation.id, version, rows);
    });
    await yieldTurn();
  }
  for (const id of known.keys()) if (!listed.has(id)) store.transaction(() => store.deleteConversation(id));
  return complete;
}

/**
 * A chunk as at most six passages of whole sentences for the sentence
 * embedder, with Markdown and table punctuation removed. Each passage stays
 * short enough for a sentence embedding to keep its meaning.
 */
export function embeddingPassages(text: string, options: { maxPassages?: number; passageWords?: number } = {}): string[] {
  const maxPassages = options.maxPassages ?? defaultMaxPassages;
  const passageWords = options.passageWords ?? defaultPassageWords;
  const plain = text
    .replace(/```[^\n]*\n?/gu, " ")
    .replace(/^\s{0,3}#{1,6}\s+(.*)$/gmu, "$1.")
    .replace(/[*_`|>#]+/gu, " ")
    .slice(0, maxEmbedCharacters * maxPassages);
  const sentences = plain.split(/(?<=[.!?])\s+|\n+/u).map((sentence) => sentence.replace(/\s+/gu, " ").trim()).filter(Boolean);
  const words = sentences.reduce((sum, sentence) => sum + sentence.split(" ").length, 0);
  if (!words) return [];
  const perPassage = Math.max(passageWords, Math.ceil(words / maxPassages));
  const passages: string[] = [];
  let current: string[] = [];
  let count = 0;
  for (const sentence of sentences) {
    const length = sentence.split(" ").length;
    if (current.length && count + length > perPassage && passages.length < maxPassages - 1) {
      passages.push(current.join(" "));
      current = []; count = 0;
    }
    current.push(sentence); count += length;
  }
  if (current.length) passages.push(current.join(" "));
  return passages.map((passage) => passage.slice(0, maxEmbedCharacters));
}

function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
