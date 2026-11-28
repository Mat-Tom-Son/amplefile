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

/** The name walk's budget for one page: entries visited, and name matches returned. The cursor carries the rest. */
const maxNameEntries = 20_000;
const maxNameMatches = 500;

export interface ConnectedFolderSearchCoverage {
  /** Text counters describe this page, including excluded directory roots, not their descendants. */
  ignored: number; internal: number; symbolicLink: number; binary: number; unreadable: number; changed: number; nonRegular: number;
  scannedBytes: number;
  /** This page's slice of the name walk: entries it visited, and whether the whole walk has finished with nothing unreadable or changed. Null when files were out of scope. */
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
/** A folder a walk has entered: where it is, the last entry finished (by name), and the folder's dev:ino when entered. */
interface DirectoryPosition { path: string; after: string | null; version: string; }
interface FilePosition { path: string; version: string; offset: number; line: number; tail: string; matched: boolean; sampled?: boolean; }
/** The name walk, carried page to page until it has visited the whole selection. */
interface NameWalk { stack: DirectoryPosition[]; done: boolean; incomplete: boolean; }
/** Chats are searched in id order: every Chat up to `after` is finished, and `current` is one partly searched. */
interface ChatPosition { after: string | null; current: { id: string; messageIndex: number } | null; }
interface SearchCursor { scope: string; names: NameWalk | null; stack: DirectoryPosition[]; current?: FilePosition; filesDone: boolean; chats: ChatPosition; incomplete: boolean; }

/**
 * Search one Connected Folder's names, file text, and Chats, a bounded page
 * at a time. Following `nextCursor` until it is null finds every match in the
 * selection: the name walk and the text walk each continue where the last
 * page stopped. Pages are live observations, as the plain-folder search's
 * are: a folder resumes by name after the last entry finished, so items added
 * or removed between pages never end the search; a folder removed, replaced,
 * or turned into a link since, and a file that changed partway through its
 * scan, are skipped, counted as changed, and leave coverage incomplete. A
 * walk never follows a link. A cursor from another query, selection, ignore
 * rules, or set of nested Connected Folders is refused.
 */
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
  const state: SearchCursor = cursor ?? { scope, names: null, stack: [], filesDone: options.includeFiles === false, chats: { after: null, current: null }, incomplete: false };
  const needle = query.toLocaleLowerCase();
  const names: ConnectedFolderNameMatch[] = [];
  let nameVisited = 0;
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
      state.names = { stack: [], done: true, incomplete: false };
      state.filesDone = true;
    } else {
      const info = await lstat(resolveConnectedFolderPath(root, selected, { finalLink: true }), { bigint: true });
      state.names = { stack: [], done: true, incomplete: false };
      if (info.isDirectory()) {
        state.names = { stack: [{ path: selected, after: null, version: folderIdentity(info) }], done: false, incomplete: false };
        state.stack.push({ path: selected, after: null, version: folderIdentity(info) });
      } else {
        // A selected file or link is the whole name walk: its own name, once.
        if (info.isFile() || info.isSymbolicLink()) {
          nameVisited++;
          if (basename(selected).toLocaleLowerCase().includes(needle)) {
            const match = await nameMatch(root, selected, basename(selected), info);
            if (match) names.push(match);
            else state.names.incomplete = true;
          }
        }
        if (info.isFile()) state.current = filePosition(selected, info);
        else {
          if (info.isSymbolicLink()) coverage.symbolicLink++;
          else coverage.nonRegular++;
          state.filesDone = true;
        }
      }
    }
  }
  // This page's slice of the name walk comes first: names arrive ahead of the slower text walk.
  if (state.names && !state.names.done) {
    const slice = await continueNameWalk(root, state.names, needle, exclusion, options.signal);
    names.push(...slice.names);
    nameVisited += slice.visited;
  }
  // A file position carried from an earlier page that is gone or changed is a change, not a failure.
  const carriedFile = cursor ? state.current : undefined;
  while (!state.filesDone && !resultBudgetReached && matchCount() < maxMatches && scannedFiles < maxFiles && visited < maxFiles && coverage.scannedBytes < maxBytes) {
    aborted(options.signal);
    if (state.current) {
      const current = state.current;
      const initial = await safe(current.path).catch((error) => {
        if ((error as Error).name === "AbortError") throw error;
        return null;
      });
      scannedFiles++;
      if (!initial || identity(initial) !== current.version) {
        if (initial || current === carriedFile) coverage.changed++;
        else coverage.unreadable++;
        state.incomplete = true;
        delete state.current;
      } else if (await scanFile(root, current, initial, needle, maxMatches, maxBytes, files, coverage, admit, options.signal)) delete state.current;
      if (!state.current && !state.stack.length) state.filesDone = true;
      continue;
    }
    const frame = state.stack.at(-1);
    if (!frame) { state.filesDone = true; break; }
    let listing = directoryEntries.get(frame.path);
    if (!listing) {
      const entries = await openFolder(root, frame);
      if (entries === "changed") { coverage.changed++; state.incomplete = true; state.stack.pop(); continue; }
      if (!entries) { coverage.unreadable++; state.incomplete = true; state.stack.pop(); continue; }
      listing = { entries, index: resumeIndex(entries, frame.after) }; directoryEntries.set(frame.path, listing);
    }
    const entry = listing.entries[listing.index++];
    if (!entry) { state.stack.pop(); directoryEntries.delete(frame.path); continue; }
    visited++;
    const path = frame.path ? `${frame.path}/${entry.name}` : entry.name;
    if (excluded(path)) { frame.after = entry.name; continue; }
    if (entry.isSymbolicLink()) { frame.after = entry.name; coverage.symbolicLink++; continue; }
    const info = await safe(path).catch((error) => {
      if ((error as Error).name === "AbortError") throw error;
      return null;
    });
    frame.after = entry.name;
    if (!info) { coverage.unreadable++; state.incomplete = true; continue; }
    if (info.isDirectory()) state.stack.push({ path, after: null, version: folderIdentity(info) });
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
    // Chats in id order, resumed after the last one finished: a Chat added or
    // a transcript that grew between pages never ends the search.
    const conversations = (await listConversations(root)).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const position = state.chats;
    if (position.current && !conversations.some((conversation) => conversation.id === position.current!.id)) {
      coverage.changed++; state.incomplete = true;
      position.after = position.current.id; position.current = null;
    }
    let index = position.current
      ? conversations.findIndex((conversation) => conversation.id === position.current!.id)
      : conversations.findIndex((conversation) => position.after === null || conversation.id > position.after);
    if (index < 0) index = conversations.length;
    let inspected = 0;
    while (index < conversations.length && !resultBudgetReached && matchCount() < maxMatches && inspected < maxFiles) {
      aborted(options.signal);
      const conversation = conversations[index]!;
      const messages = await readConversation(root, conversation.id);
      let messageIndex = position.current?.id === conversation.id ? position.current.messageIndex : 0;
      // A transcript is appended to; one that shrank since was rewritten, and the rest of it is skipped.
      if (messageIndex > messages.length) { coverage.changed++; state.incomplete = true; messageIndex = messages.length; }
      const current = { id: conversation.id, messageIndex };
      position.current = current; inspected++;
      while (current.messageIndex < messages.length && matchCount() < maxMatches) {
        const message = messages[current.messageIndex++]!;
        if (["conversation_lifecycle", "conversation_title", "assistant_continuation", "context_compaction"].includes(message.kind ?? "")) continue;
        const text = message.content.replace(/\s+/g, " ");
        const at = text.toLocaleLowerCase().indexOf(needle);
        if (at >= 0) {
          const match = { conversationId: conversation.id, title: conversation.title, role: message.role, createdAt: message.createdAt, preview: preview(text, at, query.length) };
          if (!admit(match)) { current.messageIndex--; break; }
          chats.push(match);
        }
      }
      if (current.messageIndex < messages.length) break;
      position.after = conversation.id; position.current = null; index++;
    }
    chatsDone = index >= conversations.length;
  }
  aborted(options.signal);
  state.incomplete ||= coverage.unreadable > 0 || coverage.changed > 0;
  const namesMore = Boolean(state.names && !state.names.done);
  const textMore = !state.filesDone || !chatsDone;
  coverage.names = state.names ? { visitedEntries: nameVisited, complete: !namesMore && !state.names.incomplete } : null;
  coverage.textComplete = !textMore && !state.incomplete;
  coverage.complete = coverage.textComplete && (coverage.names?.complete ?? true);
  return { query, names, files, chats, scannedFiles, truncated: !coverage.complete, nextCursor: namesMore || textMore ? encodeRetrievalCursor(state) : null, coverage };
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

/**
 * A folder a walk entered, listed again by name, or "changed" when it is no
 * longer that folder: removed, replaced by another (a new dev:ino), or turned
 * into a link anywhere on its path. A changed folder is never entered. Null
 * when it cannot be listed.
 */
async function openFolder(root: string, frame: DirectoryPosition): Promise<import("node:fs").Dirent[] | "changed" | null> {
  let absolute: string;
  try { absolute = resolveConnectedFolderPath(root, frame.path); } catch { return "changed"; }
  const info = await lstat(absolute, { bigint: true }).catch(() => null);
  if (!info?.isDirectory() || folderIdentity(info) !== frame.version) return "changed";
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
  // Sort once per directory/page, then advance by index. A wide directory
  // must not be sorted or searched again for every individual entry.
  return entries?.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ?? null;
}

/** Where a folder's listing resumes: the first entry after the last one finished. */
function resumeIndex(entries: readonly import("node:fs").Dirent[], after: string | null): number {
  if (after === null) return 0;
  let index = 0;
  let end = entries.length;
  while (index < end) {
    const middle = Math.floor((index + end) / 2);
    if (entries[middle]!.name <= after) index = middle + 1;
    else end = middle;
  }
  return index;
}

/**
 * One page of the name walk: depth first, each folder's entries by name, up
 * to `maxNameEntries` visited and `maxNameMatches` matched. The walk stops
 * before an entry the page has no room for, so the next page starts with it
 * and no name is returned twice. Links are matched with their listing detail
 * and never entered.
 */
async function continueNameWalk(
  root: string, walk: NameWalk, needle: string,
  exclusion: (path: string) => "internal" | "ignored" | null, signal?: AbortSignal,
): Promise<{ names: ConnectedFolderNameMatch[]; visited: number }> {
  const names: ConnectedFolderNameMatch[] = [];
  let visited = 0;
  const listings = new Map<DirectoryPosition, { entries: import("node:fs").Dirent[]; index: number }>();
  while (walk.stack.length) {
    aborted(signal);
    const frame = walk.stack.at(-1)!;
    let listing = listings.get(frame);
    if (!listing) {
      const entries = await openFolder(root, frame);
      if (!Array.isArray(entries)) { walk.incomplete = true; walk.stack.pop(); continue; }
      listing = { entries, index: resumeIndex(entries, frame.after) };
      listings.set(frame, listing);
    }
    const entry = listing.entries[listing.index];
    if (!entry) { walk.stack.pop(); continue; }
    const child = frame.path ? `${frame.path}/${entry.name}` : entry.name;
    if ((!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) || exclusion(child)) {
      listing.index++; frame.after = entry.name;
      continue;
    }
    if (visited === maxNameEntries || names.length === maxNameMatches) break;
    listing.index++; frame.after = entry.name; visited++;
    const matches = entry.name.toLocaleLowerCase().includes(needle);
    if (!matches && !entry.isDirectory()) continue;
    const info = await lstat(resolveConnectedFolderPath(root, child, { finalLink: true }), { bigint: true }).catch(() => null);
    if (!info) { walk.incomplete = true; continue; }
    if (matches) {
      const match = await nameMatch(root, child, entry.name, info);
      if (match) names.push(match);
      else walk.incomplete = true;
    }
    if (info.isDirectory()) walk.stack.push({ path: child, after: null, version: folderIdentity(info) });
  }
  walk.done = walk.stack.length === 0;
  return { names, visited };
}

/** A matching name as a result row: a file or folder with its size and date, or a link with its listing detail. Null when it cannot be read. */
async function nameMatch(root: string, path: string, name: string, info: BigIntStats): Promise<ConnectedFolderNameMatch | null> {
  try {
    if (info.isSymbolicLink()) {
      // Use the listing's target metadata for display. Neither search walk enters it.
      const link = await inspectSymbolicLink(resolveConnectedFolderPath(root, path, { finalLink: true }));
      return link ? {
        path, name, kind: link.target === "folder" ? "folder" : "file",
        updatedAt: (link.targetInfo ?? link.linkInfo).mtime.toISOString(),
        ...(link.target === "file" && link.targetInfo ? { sizeBytes: link.targetInfo.size } : {}),
        link: { target: link.target, targetPath: link.targetPath },
      } : null;
    }
    if (info.isFile() || info.isDirectory()) {
      return {
        path, name, kind: info.isDirectory() ? "folder" : "file", updatedAt: info.mtime.toISOString(),
        ...(info.isFile() ? { sizeBytes: Number(info.size) } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function scanFile(root: string, current: FilePosition, initial: BigIntStats, needle: string, maxMatches: number, maxBytes: number, files: ConnectedFolderFileMatch[], coverage: ConnectedFolderSearchCoverage, admit: (match: ConnectedFolderFileMatch) => boolean, signal?: AbortSignal): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const resultStart = files.length;
  try {
    handle = await open(resolveConnectedFolderPath(root, current.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    // A file that changed since its scan began is dropped from here on, counted as changed.
    if (identity(await handle.stat({ bigint: true })) !== current.version) { coverage.changed++; return true; }
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
            if (identity(await handle.stat({ bigint: true })) !== current.version) { files.splice(resultStart); coverage.changed++; return true; }
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
/** A folder's identity across pages: the same folder, whatever was added to or removed from it since. */
function folderIdentity(info: BigIntStats): string { return `${info.dev}:${info.ino}`; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function preview(line: string, at: number, length: number): string { const start = Math.max(0, at - 80); const value = `${start ? "…" : ""}${line.slice(start, at + length + 80).trim()}`; return value.length > 240 ? `${value.slice(0, 240)}…` : value; }
function looksBinary(bytes: Buffer): boolean { if (bytes.includes(0)) return true; let controls = 0; for (const byte of bytes) if (byte < 9 || byte > 13 && byte < 32) controls++; return bytes.length > 0 && controls / bytes.length > 0.1; }
function count(value: number | undefined, fallback: number, maximum: number): number { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw retrievalError(`Search page budget must be between 1 and ${maximum}.`); return value; }
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw Object.assign(new Error("Search cancelled."), { name: "AbortError" }); }
