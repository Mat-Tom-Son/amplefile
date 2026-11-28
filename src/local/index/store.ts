/**
 * One Connected Folder's index database (docs/index-and-recall.md).
 *
 * It lives under the folder's machine-local state directory, never in the
 * folder, and is rebuildable: a database with another schema version, or one
 * SQLite cannot read, is deleted and made again.
 *
 * Extracted text is keyed by content hash, so a rename, a move, or a
 * duplicate costs nothing: files and Chat messages point at a sha256, and
 * chunks, full-text rows, and vectors belong to that sha256. Vectors are
 * keyed by embedder id, so a different embedder later re-embeds lazily.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { connectedFolderStateDir } from "../state-paths.js";

/**
 * 2: code and data are indexed by words only (`code` kind); prose chunks are
 * embedded as at most six passages, stored one row per chunk as sign bits;
 * chunk text is stored once, deflated, under a contentless full-text index.
 * A version-1 index is deleted and rebuilt, never mixed.
 */
export const connectedFolderIndexSchemaVersion = 2;

/** Content kinds whose chunks are embedded (kept in step with `embeddedContentKinds` in extract.ts). */
const embeddedKindsSql = "('text', 'markdown', 'docx', 'pptx', 'pdf', 'chat')";

export type IndexedFileStatus = "indexed" | "pending" | "not-downloaded" | "binary" | "too-large" | "unsupported" | "unreadable";
export const indexedFileStatuses: readonly IndexedFileStatus[] = ["indexed", "pending", "not-downloaded", "binary", "too-large", "unsupported", "unreadable"];

/** Where a chunk sits in its source. Every field is optional; a chunk carries the ones its kind has. */
export interface ChunkLocation {
  /** 1-based inclusive line range in a text or Markdown file. */
  lines?: { start: number; end: number };
  /** 1-based inclusive paragraph range in a word-processing document. */
  paragraphs?: { start: number; end: number };
  /** 1-based page of a PDF. */
  page?: number;
  /** 1-based slide of a presentation. */
  slide?: number;
  /** A spreadsheet's sheet name and 1-based inclusive row range. */
  sheet?: string;
  rows?: { start: number; end: number };
  /** Markdown or document headings enclosing the chunk, outermost first. */
  headings?: string[];
  /** 1-based part of a long Chat message. */
  part?: number;
}

export interface IndexedChunk {
  ordinal: number;
  location: ChunkLocation;
  text: string;
}

export interface IndexedFileRow {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string | null;
  status: IndexedFileStatus;
  indexedAt: string | null;
}

export interface IndexedChatRow {
  conversationId: string;
  messageId: string;
  role: string;
  createdAt: string;
  title: string;
  sha256: string;
}

export interface ChunkHitRow {
  chunkId: number;
  sha256: string;
  ordinal: number;
  location: ChunkLocation;
  text: string;
}

export function connectedFolderIndexDir(connectedFolderRoot: string): string {
  return join(connectedFolderStateDir(connectedFolderRoot), "index");
}

export function connectedFolderIndexFile(connectedFolderRoot: string): string {
  return join(connectedFolderIndexDir(connectedFolderRoot), "index.sqlite");
}

/** Removes a Connected Folder's index; it is rebuildable, so this never needs a recovery copy. */
export async function deleteConnectedFolderIndex(connectedFolderRoot: string): Promise<void> {
  await rm(connectedFolderIndexDir(connectedFolderRoot), { recursive: true, force: true });
}

const schema = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL,
  indexed_at TEXT
);
CREATE INDEX files_sha256 ON files(sha256);
CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  title TEXT NOT NULL
);
CREATE TABLE chat_messages (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);
CREATE INDEX chat_messages_sha256 ON chat_messages(sha256);
CREATE TABLE contents (
  sha256 TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  extracted_at TEXT NOT NULL
);
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  location TEXT NOT NULL,
  -- The chunk's text, raw-deflated: it is read back only for excerpts and embedding.
  body BLOB NOT NULL,
  UNIQUE (sha256, ordinal)
);
-- Contentless: the full-text index keeps only its index, never a copy of the text.
CREATE VIRTUAL TABLE chunk_text USING fts5(text, content = '', contentless_delete = 1, tokenize = 'porter unicode61');
-- One row per embedded chunk: its passages' encoded vectors back to back
-- (none when the embedder had no vector for it).
CREATE TABLE vectors (
  chunk_id INTEGER NOT NULL,
  embedder TEXT NOT NULL,
  language TEXT NOT NULL,
  passages INTEGER NOT NULL,
  encoded BLOB NOT NULL,
  PRIMARY KEY (chunk_id, embedder)
) WITHOUT ROWID;
`;

/**
 * A short-lived handle: open for one sync or one query, then close. No handle
 * outlives the operation, so a removal, a relocation, or a restore never
 * finds the database held open.
 */
export class ConnectedFolderIndexStore {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Opens (creating or rebuilding as needed). `create: false` returns null when no index exists yet. */
  static open(connectedFolderRoot: string, options: { create?: boolean } = {}): ConnectedFolderIndexStore | null {
    const file = connectedFolderIndexFile(connectedFolderRoot);
    if (options.create === false && !existsSync(file)) return null;
    for (let attempt = 0; ; attempt++) {
      let db: DatabaseSync | null = null;
      try {
        mkdirSync(connectedFolderIndexDir(connectedFolderRoot), { recursive: true });
        db = new DatabaseSync(file);
        db.exec("PRAGMA busy_timeout = 2000");
        const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
        if (version === 0) {
          const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number };
          if (Number(tables.n) !== 0) throw new Error("An index database without a schema version.");
          db.exec("PRAGMA journal_mode = WAL");
          db.exec("BEGIN");
          db.exec(schema);
          db.exec(`PRAGMA user_version = ${connectedFolderIndexSchemaVersion}`);
          db.exec("COMMIT");
        } else if (version !== connectedFolderIndexSchemaVersion) {
          throw new Error("The index database has another schema version.");
        } else {
          db.prepare("SELECT 1 FROM chunks LIMIT 1").get();
        }
        return new ConnectedFolderIndexStore(db);
      } catch (error) {
        try { db?.close(); } catch { /* Already unusable. */ }
        // Rebuildable data: a newer, older, or unreadable database is deleted and made again.
        rmIndexFiles(file);
        if (attempt >= 1) throw error;
      }
    }
  }

  close(): void {
    this.#statements.clear();
    try { this.#db.close(); } catch { /* Closing twice is harmless. */ }
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) { statement = this.#db.prepare(sql); this.#statements.set(sql, statement); }
    return statement;
  }

  transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* The failure is reported below. */ }
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.#prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  listFiles(): IndexedFileRow[] {
    return (this.#prepare("SELECT path, size, mtime_ms, sha256, status, indexed_at FROM files").all() as Array<Record<string, unknown>>).map(fileRow);
  }

  getFile(path: string): IndexedFileRow | null {
    const row = this.#prepare("SELECT path, size, mtime_ms, sha256, status, indexed_at FROM files WHERE path = ?").get(path) as Record<string, unknown> | undefined;
    return row ? fileRow(row) : null;
  }

  filesWithSha(sha256: string): IndexedFileRow[] {
    return (this.#prepare("SELECT path, size, mtime_ms, sha256, status, indexed_at FROM files WHERE sha256 = ? AND status = 'indexed' ORDER BY path").all(sha256) as Array<Record<string, unknown>>).map(fileRow);
  }

  putFile(row: IndexedFileRow): void {
    this.#prepare(`INSERT INTO files (path, size, mtime_ms, sha256, status, indexed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256, status = excluded.status, indexed_at = excluded.indexed_at`)
      .run(row.path, row.size, row.mtimeMs, row.sha256, row.status, row.indexedAt);
  }

  markPending(path: string): void {
    this.#prepare("UPDATE files SET status = 'pending' WHERE path = ?").run(path);
  }

  deleteFile(path: string): void {
    this.#prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  countFilesByStatus(): Record<IndexedFileStatus, number> {
    const counts = Object.fromEntries(indexedFileStatuses.map((status) => [status, 0])) as Record<IndexedFileStatus, number>;
    for (const row of this.#prepare("SELECT status, count(*) AS n FROM files GROUP BY status").all() as Array<{ status: string; n: number }>) {
      if ((indexedFileStatuses as readonly string[]).includes(row.status)) counts[row.status as IndexedFileStatus] = Number(row.n);
    }
    return counts;
  }

  hasContent(sha256: string): boolean {
    return this.#prepare("SELECT 1 FROM contents WHERE sha256 = ?").get(sha256) !== undefined;
  }

  /** Writes one content's chunks and their full-text rows. An existing content is left as it is. */
  putContent(sha256: string, kind: string, chunks: IndexedChunk[], truncated: boolean): void {
    if (this.hasContent(sha256)) return;
    this.#prepare("INSERT INTO contents (sha256, kind, chunk_count, truncated, extracted_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256, kind, chunks.length, truncated ? 1 : 0, new Date().toISOString());
    const insertChunk = this.#prepare("INSERT INTO chunks (sha256, ordinal, location, body) VALUES (?, ?, ?, ?)");
    const insertText = this.#prepare("INSERT INTO chunk_text (rowid, text) VALUES (?, ?)");
    for (const chunk of chunks) {
      const { lastInsertRowid } = insertChunk.run(sha256, chunk.ordinal, JSON.stringify(chunk.location), deflateRawSync(Buffer.from(chunk.text, "utf8")));
      insertText.run(lastInsertRowid, chunk.text);
    }
  }

  listConversationVersions(): Map<string, { size: number; mtimeMs: number; title: string }> {
    const rows = this.#prepare("SELECT conversation_id, size, mtime_ms, title FROM conversations").all() as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [String(row.conversation_id), { size: Number(row.size), mtimeMs: Number(row.mtime_ms), title: String(row.title) }]));
  }

  replaceConversation(conversationId: string, version: { size: number; mtimeMs: number; title: string }, messages: Array<Omit<IndexedChatRow, "conversationId" | "title">>): void {
    this.#prepare("DELETE FROM chat_messages WHERE conversation_id = ?").run(conversationId);
    const insert = this.#prepare("INSERT OR REPLACE INTO chat_messages (conversation_id, message_id, role, created_at, sha256) VALUES (?, ?, ?, ?, ?)");
    for (const message of messages) insert.run(conversationId, message.messageId, message.role, message.createdAt, message.sha256);
    this.#prepare(`INSERT INTO conversations (conversation_id, size, mtime_ms, title) VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, title = excluded.title`)
      .run(conversationId, version.size, version.mtimeMs, version.title);
  }

  deleteConversation(conversationId: string): void {
    this.#prepare("DELETE FROM chat_messages WHERE conversation_id = ?").run(conversationId);
    this.#prepare("DELETE FROM conversations WHERE conversation_id = ?").run(conversationId);
  }

  chatMessagesWithSha(sha256: string): IndexedChatRow[] {
    return (this.#prepare(`SELECT m.conversation_id, m.message_id, m.role, m.created_at, m.sha256, c.title
      FROM chat_messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE m.sha256 = ? ORDER BY m.created_at`).all(sha256) as Array<Record<string, unknown>>)
      .map((row) => ({
        conversationId: String(row.conversation_id), messageId: String(row.message_id), role: String(row.role),
        createdAt: String(row.created_at), title: String(row.title), sha256: String(row.sha256),
      }));
  }

  countChatMessages(): number {
    return Number((this.#prepare("SELECT count(*) AS n FROM chat_messages").get() as { n: number }).n);
  }

  /** Prose chunks this embedder has not seen yet, oldest first. Code and data chunks are never embedded. */
  chunksToEmbed(embedder: string, limit: number): Array<{ chunkId: number; text: string }> {
    return (this.#prepare(`SELECT c.id AS chunk_id, c.body FROM chunks c JOIN contents t ON t.sha256 = c.sha256
      WHERE t.kind IN ${embeddedKindsSql}
      AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_id = c.id AND v.embedder = ?) ORDER BY c.id LIMIT ?`).all(embedder, limit) as Array<{ chunk_id: number; body: Uint8Array }>)
      .map((row) => ({ chunkId: Number(row.chunk_id), text: inflateText(row.body) }));
  }

  countChunks(): number {
    return Number((this.#prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n);
  }

  /** Chunks of the kinds that are embedded (prose); the rest are searched by words only. */
  countEmbeddableChunks(): number {
    return Number((this.#prepare(`SELECT count(*) AS n FROM chunks c JOIN contents t ON t.sha256 = c.sha256 WHERE t.kind IN ${embeddedKindsSql}`).get() as { n: number }).n);
  }

  countEmbedded(embedder: string): number {
    return Number((this.#prepare("SELECT count(*) AS n FROM vectors WHERE embedder = ?").get(embedder) as { n: number }).n);
  }

  countVectors(embedder: string): number {
    return Number((this.#prepare("SELECT coalesce(sum(passages), 0) AS n FROM vectors WHERE embedder = ?").get(embedder) as { n: number }).n);
  }

  /**
   * Records a chunk as embedded with one vector per passage of it (sentence
   * embeddings blur over a long chunk, so a chunk is embedded a sentence or
   * two at a time and matches by its best passage). Passages with no vector are
   * left out; a chunk with none is still recorded, with no passages. The
   * passages of one chunk share one language.
   */
  putVectors(chunkId: number, embedder: string, vectors: ReadonlyArray<{ language: string; vector: Float32Array } | null>): void {
    const present = vectors.filter((vector): vector is { language: string; vector: Float32Array } => vector !== null);
    const encoded = present.map((vector) => encodeVector(vector.vector));
    this.#prepare("INSERT OR REPLACE INTO vectors (chunk_id, embedder, language, passages, encoded) VALUES (?, ?, ?, ?, ?)")
      .run(chunkId, embedder, present[0]?.language ?? "", encoded.length, Buffer.concat(encoded));
  }

  vectorLanguages(embedder: string): string[] {
    return (this.#prepare("SELECT DISTINCT language FROM vectors WHERE embedder = ? AND passages > 0").all(embedder) as Array<{ language: string }>).map((row) => row.language);
  }

  /** Each embedded chunk of one embedder and language with its passages still encoded, for a brute-force scan (see `encodedVectorScorer`). */
  *iterateEncodedVectors(embedder: string, language: string): Generator<{ chunkId: number; encoded: Uint8Array }> {
    const statement = this.#db.prepare("SELECT chunk_id, encoded FROM vectors WHERE embedder = ? AND language = ? AND passages > 0");
    for (const row of statement.iterate(embedder, language) as Iterable<{ chunk_id: number; encoded: Uint8Array }>) {
      yield { chunkId: Number(row.chunk_id), encoded: row.encoded };
    }
  }

  /** Vectors of one content's chunks, for "similar to this file". */
  vectorsForSha(sha256: string, embedder: string): Array<{ chunkId: number; language: string; vector: Float32Array }> {
    return (this.#prepare(`SELECT v.chunk_id, v.language, v.encoded FROM vectors v JOIN chunks c ON c.id = v.chunk_id
      WHERE c.sha256 = ? AND v.embedder = ? AND v.passages > 0 ORDER BY c.ordinal`).all(sha256, embedder) as Array<{ chunk_id: number; language: string; encoded: Uint8Array }>)
      .flatMap((row) => splitEncoded(row.encoded).map((part) => ({ chunkId: Number(row.chunk_id), language: row.language, vector: decodeVector(part) })));
  }

  chunkTextsForSha(sha256: string, limit: number): string[] {
    return (this.#prepare("SELECT body FROM chunks WHERE sha256 = ? ORDER BY ordinal LIMIT ?").all(sha256, limit) as Array<{ body: Uint8Array }>).map((row) => inflateText(row.body));
  }

  /** Lexical candidates by bm25 (best first). `match` is an FTS5 query this module's caller built. */
  lexical(match: string, limit: number): Array<{ chunkId: number; score: number }> {
    return (this.#prepare("SELECT rowid AS chunk_id, bm25(chunk_text) AS score FROM chunk_text WHERE chunk_text MATCH ? ORDER BY score LIMIT ?").all(match, limit) as Array<{ chunk_id: number; score: number }>)
      .map((row) => ({ chunkId: Number(row.chunk_id), score: Number(row.score) }));
  }

  chunk(chunkId: number): ChunkHitRow | null {
    const row = this.#prepare("SELECT id, sha256, ordinal, location, body FROM chunks WHERE id = ?").get(chunkId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let location: ChunkLocation = {};
    try { location = JSON.parse(String(row.location)) as ChunkLocation; } catch { /* An unreadable location is reported as none. */ }
    return { chunkId: Number(row.id), sha256: String(row.sha256), ordinal: Number(row.ordinal), location, text: inflateText(row.body as Uint8Array) };
  }

  /** Drops contents no file or Chat message points at any more, with their chunks, text, and vectors. */
  collectGarbage(): number {
    const orphaned = this.#prepare(`SELECT sha256 FROM contents WHERE sha256 NOT IN (SELECT sha256 FROM files WHERE sha256 IS NOT NULL)
      AND sha256 NOT IN (SELECT sha256 FROM chat_messages)`).all() as Array<{ sha256: string }>;
    for (const { sha256 } of orphaned) {
      const ids = (this.#prepare("SELECT id FROM chunks WHERE sha256 = ?").all(sha256) as Array<{ id: number }>).map((row) => Number(row.id));
      for (const id of ids) {
        this.#prepare("DELETE FROM chunk_text WHERE rowid = ?").run(id);
        this.#prepare("DELETE FROM vectors WHERE chunk_id = ?").run(id);
      }
      this.#prepare("DELETE FROM chunks WHERE sha256 = ?").run(sha256);
      this.#prepare("DELETE FROM contents WHERE sha256 = ?").run(sha256);
    }
    return orphaned.length;
  }
}

function fileRow(row: Record<string, unknown>): IndexedFileRow {
  return {
    path: String(row.path),
    size: Number(row.size),
    mtimeMs: Number(row.mtime_ms),
    sha256: row.sha256 === null || row.sha256 === undefined ? null : String(row.sha256),
    status: String(row.status) as IndexedFileStatus,
    indexedAt: row.indexed_at === null || row.indexed_at === undefined ? null : String(row.indexed_at),
  };
}

/**
 * A vector is stored as one bit per dimension (its sign) with one float
 * scale, the mean magnitude, so a stored vector reads back as ±scale: 70
 * bytes for a 512-dimension vector instead of 2 KiB. Layout: float32 scale,
 * uint16 dimension, then the sign bits. Measured on this repository's docs,
 * ranking with a float query against these vectors matched 8-bit storage
 * (docs/index-and-recall.md).
 */
export function encodeVector(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(6 + Math.ceil(vector.length / 8));
  let magnitude = 0;
  for (const value of vector) magnitude += Math.abs(value);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, vector.length ? magnitude / vector.length : 0, true);
  view.setUint16(4, vector.length, true);
  for (let index = 0; index < vector.length; index++) {
    if (vector[index]! >= 0) bytes[6 + (index >> 3)]! |= 1 << (index & 7);
  }
  return bytes;
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength < 6) return new Float32Array(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scale = view.getFloat32(0, true);
  const vector = new Float32Array(Math.min(view.getUint16(4, true), (bytes.byteLength - 6) * 8));
  for (let index = 0; index < vector.length; index++) vector[index] = bytes[6 + (index >> 3)]! & (1 << (index & 7)) ? scale : -scale;
  return vector;
}

/**
 * Scores encoded vectors against one float query by table lookup: for each
 * byte of sign bits, the query's contribution for all 256 patterns is
 * computed once, so a stored vector costs one lookup per eight dimensions.
 */
const signCosineCorrection = Math.PI / 2;

export function encodedVectorScorer(query: Float32Array): (bytes: Uint8Array) => number {
  const one = encodedPassageScorer(query);
  // A chunk's row holds its passages back to back; it scores as its best passage.
  return (bytes) => {
    let best = Number.NEGATIVE_INFINITY;
    for (let offset = 0; offset + 6 <= bytes.byteLength;) {
      const size = encodedSize(bytes, offset);
      best = Math.max(best, one(bytes.subarray(offset, offset + size)));
      offset += size;
    }
    return best;
  };
}

function encodedPassageScorer(query: Float32Array): (bytes: Uint8Array) => number {
  const groups = Math.ceil(query.length / 8);
  const table = new Float32Array(groups * 256);
  for (let group = 0; group < groups; group++) {
    for (let pattern = 0; pattern < 256; pattern++) {
      let sum = 0;
      for (let bit = 0; bit < 8; bit++) {
        const value = query[group * 8 + bit];
        if (value !== undefined) sum += pattern & (1 << bit) ? value : -value;
      }
      table[group * 256 + pattern] = sum;
    }
  }
  return (bytes) => {
    if (bytes.byteLength < 6) return 0;
    const scale = new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
    const length = Math.min(groups, bytes.byteLength - 6);
    let sum = 0;
    for (let group = 0; group < length; group++) sum += table[group * 256 + bytes[6 + group]!]!;
    // Against a sign-and-mean-magnitude vector a dot product comes out about
    // 2/π of the true cosine (measured 0.64–0.66 on this repository's docs),
    // so it is scaled back to read as a cosine.
    return sum * scale * signCosineCorrection;
  };
}

function encodedSize(bytes: Uint8Array, offset: number): number {
  const dimension = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 2).getUint16(0, true);
  return 6 + Math.ceil(dimension / 8);
}

/** The passages of one chunk's row, each still encoded. */
export function splitEncoded(bytes: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset + 6 <= bytes.byteLength;) {
    const size = encodedSize(bytes, offset);
    parts.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return parts;
}

function inflateText(body: Uint8Array): string {
  return inflateRawSync(body).toString("utf8");
}

function rmIndexFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { rmSync(`${file}${suffix}`, { force: true }); } catch { /* Best effort; the next open retries. */ }
  }
}
