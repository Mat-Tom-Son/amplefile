import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import type { FolderSearchNameMatch } from "./folder-search.js";
import { isOfficeLockFileName } from "./office-lock-files.js";
import { listConversations, readConversation } from "./agent/chat-store.js";
import { decodeRetrievalCursor, encodeRetrievalCursor, retrievalError } from "./retrieval-cursor.js";
import { isAlwaysHiddenConnectedFolderEntry, isConnectedFolderIgnored, readConnectedFolderIgnoreState } from "./connected-folder-ignore.js";
import { assertConnectedFolderDoesNotContainState, comparableRelative, ensureSafeConnectedFolderRoot, inspectSymbolicLink, nestedRegisteredConnectedFolderPaths, resolveConnectedFolderPath, type TreeEntryLink } from "./connected-folder.js";

export type ConnectedFolderNameMatch = FolderSearchNameMatch & { link?: TreeEntryLink };
export interface ConnectedFolderFileMatch { path: string; line: number; preview: string; }
export interface ConnectedFolderChatMatch { conversationId: string; title: string; role: "user" | "assistant" | "system"; createdAt: string; preview: string; }
interface NameSearchCoverage { visitedEntries: number; complete: boolean; }

const maxNameEntries = 20_000;

export interface ConnectedFolderSearchCoverage {
  /** Text counters describe this page, including excluded directory roots, not their descendants. */
  ignored: number; internal: number; symbolicLink: number; binary: number; unreadable: number; changed: number; nonRegular: number;
  scannedBytes: number;
  /** Coverage of the first-page name walk. Null when files were out of scope. */
  names: NameSearchCoverage | null;
  /** Whether the requested file text and Chat search has finished with full coverage. */
  textComplete: boolean;
  /** Live observations, not an atomic filesystem snapshot. */
  consistency: "live";
  complete: boolean;
}
export interface ConnectedFolderSearchResult {
  query: string; names: ConnectedFolderNameMatch[]; files: ConnectedFolderFileMatch[]; chats: ConnectedFolderChatMatch[]; truncated: boolean; scannedFiles: number;
  nextCursor: string | null; coverage: ConnectedFolderSearchCoverage;
}
export interface ConnectedFolderSearchOptions {
  includeFiles?: boolean; includeChats?: boolean; maxMatches?: number; maxScannedFiles?: number;
  /** Deprecated spelling, now a resumable page byte budget; never excludes a large file. */
  maxFileBytes?: number;
  maxScannedBytes?: number;
  path?: string; cursor?: string; signal?: AbortSignal;
}
interface DirectoryPosition { path: string; after: string | null; version: string; }
interface FilePosition { path: string; version: string; offset: number; line: number; tail: string; matched: boolean; sampled?: boolean; }
interface SearchCursor { scope: string; nameCoverage: NameSearchCoverage | null; stack: DirectoryPosition[]; current?: FilePosition; filesDone: boolean; chatIndex: number; messageIndex: number; chatVersion?: string; transcriptVersion?: string; incomplete: boolean; }

/** Fixed allocations and resumable page budgets; ordinary text files have no size ceiling. */
export async function searchConnectedFolder(connectedFolderRoot: string, rawQuery: string, options: ConnectedFolderSearchOptions = {}): Promise<ConnectedFolderSearchResult> {
  const query = rawQuery.trim();
  if (!query) throw retrievalError("Enter something to search for.");
  if (query.length > 64 * 1024) throw retrievalError("Search text is too long.");
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  assertConnectedFolderDoesNotContainState(root);
  aborted(options.signal);
  if (options.includeFiles === false && options.path) throw retrievalError("Search path narrows files; use files or all scope.");
  const selected = await selectedSearchPath(root, options.path);
  const ignore = (await readConnectedFolderIgnoreState(root)).patterns;
  const nested = (await nestedRegisteredConnectedFolderPaths(root)).map(comparableRelative);
  const scope = digest(JSON.stringify([root, query, selected, options.includeFiles !== false, options.includeChats !== false, ignore, nested]));
  const cursor = options.cursor ? decodeRetrievalCursor<SearchCursor>(options.cursor) : undefined;
  if (cursor && cursor.scope !== scope) throw retrievalError("Search selection or ignore rules changed. Start the search again.", 409);
  const state: SearchCursor = cursor ?? { scope, nameCoverage: null, stack: [], filesDone: options.includeFiles === false, chatIndex: 0, messageIndex: 0, incomplete: false };
  const needle = query.toLocaleLowerCase();
  let names: ConnectedFolderNameMatch[] = [];
  const files: ConnectedFolderFileMatch[] = [];
  const chats: ConnectedFolderChatMatch[] = [];
  const matchCount = () => files.length + chats.length;
  let resultBytes = 0; let resultBudgetReached = false;
  const admit = (match: ConnectedFolderFileMatch | ConnectedFolderChatMatch): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(match));
    if (resultBytes + bytes > 512 * 1024) { resultBudgetReached = true; return false; }
    resultBytes += bytes; return true;
  };
  const coverage: ConnectedFolderSearchCoverage = { ignored: 0, internal: 0, symbolicLink: 0, binary: 0, unreadable: 0, changed: 0, nonRegular: 0, scannedBytes: 0, names: null, textComplete: false, consistency: "live", complete: false };
  const maxMatches = count(options.maxMatches, 200, 1000);
  const maxFiles = count(options.maxScannedFiles, 5000, 50000);
  const maxBytes = count(options.maxScannedBytes ?? options.maxFileBytes, 8 * 1024 * 1024, 64 * 1024 * 1024);
  let scannedFiles = 0; let visited = 0;
  const directoryEntries = new Map<string, { entries: import("node:fs").Dirent[]; index: number }>();
  const exclusion = (path: string): "internal" | "ignored" | null => {
    if (path.split("/").some((name) => isAlwaysHiddenConnectedFolderEntry(name) || isOfficeLockFileName(name))) return "internal";
    if (nested.length) {
      const key = comparableRelative(path);
      if (nested.some((child) => key === child || key.startsWith(`${child}/`))) return "internal";
    }
    return isConnectedFolderIgnored(path, ignore) ? "ignored" : null;
  };
  const excluded = (path: string): boolean => {
    const reason = exclusion(path);
    if (reason) coverage[reason]++;
    return reason !== null;
  };
  const safe = async (path: string): Promise<BigIntStats> => {
    aborted(options.signal);
    // Recheck ancestors on every open; a continuation cannot follow a replaced symlink.
    const absolute = resolveConnectedFolderPath(root, path);
    const info = await lstat(absolute, { bigint: true });
    if (info.isSymbolicLink()) throw retrievalError("Search source became a symbolic link. Start the search again.", 409);
    return info;
  };
  if (!cursor && !state.filesDone) {
    if (selected && excluded(selected)) {
      state.nameCoverage = { visitedEntries: 0, complete: true };
      state.filesDone = true;
    } else {
      const info = await lstat(resolveConnectedFolderPath(root, selected, { finalLink: true }), { bigint: true });
      const nameSearch = await searchNames(root, selected, info, needle, exclusion, options.signal);
      names = nameSearch.names;
      state.nameCoverage = nameSearch.coverage;
      if (info.isDirectory()) state.stack.push({ path: selected, after: null, version: identity(info) });
      else if (info.isFile()) state.current = filePosition(selected, info);
      else {
        if (info.isSymbolicLink()) coverage.symbolicLink++;
        else coverage.nonRegular++;
        state.filesDone = true;
      }
    }
  }
  for (const frame of state.stack) {
    if (identity(await safe(frame.path).catch(() => { throw retrievalError("A searched directory changed. Start the search again.", 409); })) !== frame.version) throw retrievalError("A searched directory changed. Start the search again.", 409);
  }
  while (!state.filesDone && !resultBudgetReached && matchCount() < maxMatches && scannedFiles < maxFiles && visited < maxFiles && coverage.scannedBytes < maxBytes) {
    aborted(options.signal);
    if (state.current) {
      const current = state.current;
      const initial = await safe(current.path).catch((error) => {
        if (cursor) throw retrievalError("A searched file changed or disappeared. Start the search again.", 409);
        if ((error as { statusCode?: number }).statusCode) throw error;
        coverage.unreadable++; state.incomplete = true; return null;
      });
      if (initial && identity(initial) !== current.version) throw retrievalError("A searched file changed. Start the search again.", 409);
      scannedFiles++;
      if (!initial || await scanFile(root, current, initial, needle, maxMatches, maxBytes, files, coverage, admit, options.signal)) delete state.current;
      if (!state.current && !state.stack.length) state.filesDone = true;
      continue;
    }
    const frame = state.stack.at(-1);
    if (!frame) { state.filesDone = true; break; }
    let listing = directoryEntries.get(frame.path);
    if (!listing) {
      const entries = await readdir(resolveConnectedFolderPath(root, frame.path), { withFileTypes: true }).catch(() => null);
      if (!entries) { coverage.unreadable++; state.incomplete = true; state.stack.pop(); continue; }
      // Sort once per directory/page, then advance by index. A wide directory
      // must not be sorted or searched again for every individual entry.
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      let index = 0;
      if (frame.after !== null) {
        let end = entries.length;
        while (index < end) {
          const middle = Math.floor((index + end) / 2);
          if (entries[middle]!.name <= frame.after) index = middle + 1;
          else end = middle;
        }
      }
      listing = { entries, index }; directoryEntries.set(frame.path, listing);
    }
    const entry = listing.entries[listing.index++];
    if (!entry) { state.stack.pop(); directoryEntries.delete(frame.path); continue; }
    visited++;
    const path = frame.path ? `${frame.path}/${entry.name}` : entry.name;
    if (excluded(path)) { frame.after = entry.name; continue; }
    if (entry.isSymbolicLink()) { frame.after = entry.name; coverage.symbolicLink++; continue; }
    const info = await safe(path).catch(() => null);
    frame.after = entry.name;
    if (!info) { coverage.unreadable++; state.incomplete = true; continue; }
    if (info.isDirectory()) state.stack.push({ path, after: null, version: identity(info) });
    else if (info.isFile()) state.current = filePosition(path, info);
    else coverage.nonRegular++;
  }
  // Exhausted directory frames need no more search, even if the last file met a page limit.
  while (!state.current && state.stack.length) {
    const listing = directoryEntries.get(state.stack.at(-1)!.path);
    if (!listing || listing.index < listing.entries.length) break;
    state.stack.pop();
  }
  if (!state.current && !state.stack.length) state.filesDone = true;
  let chatsDone = options.includeChats === false;
  if (state.filesDone && !chatsDone) {
    const conversations = await listConversations(root);
    const version = digest(JSON.stringify(conversations));
    if (state.chatVersion && state.chatVersion !== version) throw retrievalError("Chats changed. Start the search again.", 409);
    state.chatVersion = version;
    let inspected = 0;
    while (state.chatIndex < conversations.length && !resultBudgetReached && matchCount() < maxMatches && inspected < maxFiles) {
      aborted(options.signal);
      const conversation = conversations[state.chatIndex]!;
      const messages = await readConversation(root, conversation.id);
      const transcriptVersion = digest(JSON.stringify(messages));
      if (state.transcriptVersion && state.transcriptVersion !== transcriptVersion) throw retrievalError("A searched Chat changed. Start the search again.", 409);
      state.transcriptVersion = transcriptVersion; inspected++;
      while (state.messageIndex < messages.length && matchCount() < maxMatches) {
        const message = messages[state.messageIndex++]!;
        if (["conversation_lifecycle", "conversation_title", "assistant_continuation", "context_compaction"].includes(message.kind ?? "")) continue;
        const text = message.content.replace(/\s+/g, " ");
        const at = text.toLocaleLowerCase().indexOf(needle);
        if (at >= 0) {
          const match = { conversationId: conversation.id, title: conversation.title, role: message.role, createdAt: message.createdAt, preview: preview(text, at, query.length) };
          if (!admit(match)) { state.messageIndex--; break; }
          chats.push(match);
        }
      }
      if (state.messageIndex < messages.length) break;
      state.chatIndex++; state.messageIndex = 0; delete state.transcriptVersion;
    }
    chatsDone = state.chatIndex >= conversations.length;
  }
  aborted(options.signal);
  state.incomplete ||= coverage.unreadable > 0 || coverage.changed > 0;
  const more = !state.filesDone || !chatsDone;
  coverage.names = state.nameCoverage;
  coverage.textComplete = !more && !state.incomplete;
  coverage.complete = coverage.textComplete && (coverage.names?.complete ?? true);
  return { query, names, files, chats, scannedFiles, truncated: !coverage.complete, nextCursor: more ? encodeRetrievalCursor(state) : null, coverage };
}

/** Canonicalize a selected link's parent while keeping the link itself as the selection. */
async function selectedSearchPath(root: string, path?: string): Promise<string> {
  if (!path?.trim()) return "";
  const absolute = resolveConnectedFolderPath(root, path, { finalLink: true });
  const info = await lstat(absolute);
  const selected = info.isSymbolicLink()
    ? join(await realpath(dirname(absolute)), basename(absolute))
    : await realpath(absolute);
  return relative(await realpath(root), selected).split(sep).join("/");
}

async function searchNames(
  root: string, selected: string, initial: BigIntStats, needle: string,
  exclusion: (path: string) => "internal" | "ignored" | null, signal?: AbortSignal,
): Promise<{ names: ConnectedFolderNameMatch[]; coverage: NameSearchCoverage }> {
  const names: ConnectedFolderNameMatch[] = [];
  const coverage: NameSearchCoverage = { visitedEntries: 0, complete: true };

  async function addMatch(path: string, name: string, info?: BigIntStats): Promise<void> {
    if (!name.toLocaleLowerCase().includes(needle)) return;
    try {
      const absolute = resolveConnectedFolderPath(root, path, { finalLink: true });
      info ??= await lstat(absolute, { bigint: true });
      if (info.isSymbolicLink()) {
        // Use the listing's target metadata for display. Neither search walk enters it.
        const link = await inspectSymbolicLink(absolute);
        if (link) names.push({
          path, name, kind: link.target === "folder" ? "folder" : "file",
          updatedAt: (link.targetInfo ?? link.linkInfo).mtime.toISOString(),
          ...(link.target === "file" && link.targetInfo ? { sizeBytes: link.targetInfo.size } : {}),
          link: { target: link.target, targetPath: link.targetPath },
        });
      } else if (info.isFile() || info.isDirectory()) {
        names.push({
          path, name, kind: info.isDirectory() ? "folder" : "file", updatedAt: info.mtime.toISOString(),
          ...(info.isFile() ? { sizeBytes: Number(info.size) } : {}),
        });
      }
    } catch {
      coverage.complete = false;
    }
  }

  async function walk(path: string): Promise<boolean> {
    aborted(signal);
    let entries;
    try {
      entries = await readdir(resolveConnectedFolderPath(root, path), { withFileTypes: true });
    } catch {
      coverage.complete = false;
      return true;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      aborted(signal);
      if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (exclusion(child)) continue;
      if (coverage.visitedEntries === maxNameEntries) {
        coverage.complete = false;
        return false;
      }
      coverage.visitedEntries++;
      await addMatch(child, entry.name);
      if (entry.isDirectory() && !await walk(child)) return false;
    }
    return true;
  }

  if (initial.isDirectory()) await walk(selected);
  else if (initial.isFile() || initial.isSymbolicLink()) {
    coverage.visitedEntries++;
    await addMatch(selected, basename(selected), initial);
  }
  return { names, coverage };
}

async function scanFile(root: string, current: FilePosition, initial: BigIntStats, needle: string, maxMatches: number, maxBytes: number, files: ConnectedFolderFileMatch[], coverage: ConnectedFolderSearchCoverage, admit: (match: ConnectedFolderFileMatch) => boolean, signal?: AbortSignal): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const resultStart = files.length;
  try {
    handle = await open(resolveConnectedFolderPath(root, current.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (identity(await handle.stat({ bigint: true })) !== current.version) throw retrievalError("A searched file changed. Start the search again.", 409);
    if (!current.sampled) {
      const sample = Buffer.alloc(Math.min(8192, maxBytes - coverage.scannedBytes));
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      coverage.scannedBytes += bytesRead; current.sampled = true;
      if (looksBinary(sample.subarray(0, bytesRead))) { coverage.binary++; return true; }
    }
    const buffer = Buffer.alloc(64 * 1024 + 4);
    while (current.offset < Number(initial.size) && files.length < maxMatches && coverage.scannedBytes < maxBytes) {
      aborted(signal);
      const size = Math.min(64 * 1024, Math.max(4, maxBytes - coverage.scannedBytes), Number(initial.size) - current.offset);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(size + 3, buffer.length), current.offset);
      if (!bytesRead) break;
      let length = Math.min(size, bytesRead);
      while (length < bytesRead && length > 0 && (buffer[length]! & 0xc0) === 0x80) length--;
      if (!length) length = Math.min(4, bytesRead);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
      catch { files.splice(resultStart); coverage.binary++; return true; }
      const parts = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      for (const part of parts) {
        if (files.length >= maxMatches) break;
        const terminated = part.endsWith("\n");
        const body = terminated ? part.slice(0, -1).replace(/\r$/u, "") : part;
        const joined = current.tail + body;
        const at = current.matched ? -1 : joined.toLocaleLowerCase().indexOf(needle);
        if (at >= 0) {
          const match = { path: current.path, line: current.line, preview: preview(joined, at, needle.length) };
          if (!admit(match)) {
            if (identity(await handle.stat({ bigint: true })) !== current.version) throw retrievalError("A searched file changed. Start the search again.", 409);
            return false;
          }
          files.push(match); current.matched = true;
        }
        const consumed = Buffer.byteLength(part);
        current.offset += consumed; coverage.scannedBytes += consumed;
        current.tail = terminated ? "" : joined.slice(-(needle.length + 80));
        if (terminated) { current.line++; current.matched = false; }
      }
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(resolveConnectedFolderPath(root, current.path), { bigint: true });
    if (identity(after) !== current.version || identity(pathAfter) !== current.version) {
      files.splice(resultStart); coverage.changed++; return true;
    }
    return current.offset >= Number(initial.size);
  } catch (error) {
    if ((error as Error).name === "AbortError" || (error as { statusCode?: number }).statusCode) throw error;
    files.splice(resultStart); coverage.unreadable++; return true;
  } finally { await handle?.close().catch(() => undefined); }
}
function filePosition(path: string, info: BigIntStats): FilePosition { return { path, version: identity(info), offset: 0, line: 1, tail: "", matched: false }; }
function identity(info: BigIntStats): string { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(":"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function preview(line: string, at: number, length: number): string { const start = Math.max(0, at - 80); const value = `${start ? "…" : ""}${line.slice(start, at + length + 80).trim()}`; return value.length > 240 ? `${value.slice(0, 240)}…` : value; }
function looksBinary(bytes: Buffer): boolean { if (bytes.includes(0)) return true; let controls = 0; for (const byte of bytes) if (byte < 9 || byte > 13 && byte < 32) controls++; return bytes.length > 0 && controls / bytes.length > 0.1; }
function count(value: number | undefined, fallback: number, maximum: number): number { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw retrievalError(`Search page budget must be between 1 and ${maximum}.`); return value; }
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw Object.assign(new Error("Search cancelled."), { name: "AbortError" }); }
