/**
 * The local API's event streams: the renderer's event connection and the
 * content-free control hints, a Chat's replayable event log and broadcast, and
 * the file-change streams for Connected Folders and Standard Folders. They use
 * the stream sets, Chat event logs, and turn checkpoint writer in
 * `LocalApiState`.
 */

import { boundedLiveTurnPresentation } from "../agent/turn-live-presentation.js";
import {
  createLocalEventSink,
  createLocalEventChannel,
  localEventTarget,
  parseLocalEventSubscriptions,
  type LocalEventSink,
} from "../local-event-stream.js";
import { localEventStreamLimits, type LocalEventEnvelope } from "../../shared/local-event-stream.js";
import { watch } from "node:fs";
import {
  accessError as standardFolderAccessError,
  isShownStandardEntry,
  resolveStandardFolderPath,
  type StandardFolderId,
} from "../standard-folders.js";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { maxDurableTurnTextChars } from "../agent/turn-store.js";
import { readConversationSummary } from "../agent/chat-store.js";
import { ampleFileAgentRoot, ampleFileAgentScopeId } from "../state-paths.js";
import {
  isAlwaysHiddenConnectedFolderEntry,
  isConnectedFolderIgnored,
  readConnectedFolderIgnoreState,
} from "../connected-folder-ignore.js";
import { canonicalConnectedFolderWatchRoot } from "../connected-folder-watch.js";
import { getConnectedFolder, resolveConnectedFolderPath } from "../connected-folder.js";
import { assertAmpleFileAgentReadyForRoutes } from "./amplefile-agent-routes.js";
import { extensionSnapshot } from "./extension-ui.js";
import { badRequest, errorMessage, httpError, notFound, readJsonBody } from "./http.js";
import {
  type ChatEventLog,
  type ChatEventLogEntry,
  type LocalApiRequest,
  type LocalApiState,
  rememberConnectedFolderRoot,
  streamKey,
} from "./state.js";
import { queuedMessageEvent } from "./turn-acceptance.js";

/** The renderer's event connection and the content-free control hints. */
export async function handleEventStreamRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // One renderer connection carries only its explicitly subscribed read streams.
  // The same local session/origin authorization above protects this endpoint.
  if (url.pathname === "/api/events" && method === "POST") {
    if (state.localEventStreams.size >= 64) throw httpError(429, "Too many local event connections.");
    const input = await readJsonBody<unknown>(state, req, localEventStreamLimits.bodyBytes);
    let subscriptions: ReturnType<typeof parseLocalEventSubscriptions>;
    try { subscriptions = parseLocalEventSubscriptions(input); }
    catch (error) { throw badRequest(errorMessage(error)); }
    if (state.localEventStreams.size >= 64) throw httpError(429, "Too many local event connections.");
    const connection = createLocalEventSink(res);
    state.localEventStreams.add(connection);
    const heartbeat = setInterval(() => connection.heartbeat(), 15_000);
    heartbeat.unref();
    connection.onClose(() => { clearInterval(heartbeat); state.localEventStreams.delete(connection); });
    await Promise.all(subscriptions.map(async (subscription) => {
      const channel = createLocalEventChannel(connection, subscription.id);
      try {
        const target = localEventTarget(subscription.path)!;
        if (target.kind === "control") {
          if (state.controlStreams.size >= 64) throw httpError(429, "Too many control event connections.");
          openControlEventStream(state, channel);
        } else if (target.kind === "agent") {
          assertAmpleFileAgentReadyForRoutes(state);
          if (!await readConversationSummary(ampleFileAgentRoot(), target.conversationId)) throw notFound("Conversation not found.");
          if (channel.closed) return;
          openChatStream(state, channel, ampleFileAgentScopeId, target.conversationId, subscription.lastEventId);
        } else {
          const connectedFolder = await getConnectedFolder(target.connectedFolderId);
          if (channel.closed) return;
          if (target.kind === "files") await openConnectedFolderFileStream(state, channel, connectedFolder.connectedFolderRoot, target.connectedFolderId);
          else {
            if (!await readConversationSummary(connectedFolder.connectedFolderRoot, target.conversationId)) throw notFound("Conversation not found.");
            const registered = await getConnectedFolder(target.connectedFolderId);
            if (registered.connectedFolderRoot !== connectedFolder.connectedFolderRoot) throw notFound("Connected Folder changed while opening this Chat.");
            if (channel.closed) return;
            rememberConnectedFolderRoot(state, registered.id, registered.connectedFolderRoot);
            openChatStream(state, channel, target.connectedFolderId, target.conversationId, subscription.lastEventId);
          }
        }
        if (!channel.closed) connection.send({ subscriptionId: subscription.id, ready: true } satisfies LocalEventEnvelope);
      } catch (error) {
        const code = (error as { statusCode?: unknown })?.statusCode;
        const status = typeof code === "number" && code >= 400 && code <= 599 ? code : 500;
        if (!channel.closed) connection.send({ subscriptionId: subscription.id, error: {
          status, message: status < 500 ? errorMessage(error) : "This local event stream is unavailable. Refresh to reconnect.",
        } } satisfies LocalEventEnvelope);
        channel.close();
      }
    }));
    return true;
  }

  // Content-free control hints for the renderer: which registry changed, so
  // the surfaces requery instead of accumulating an event queue.
  if (url.pathname === "/api/amplefile-agent/control-events" && method === "GET") {
    if (state.controlStreams.size >= 64) throw httpError(429, "Too many control event connections.");
    openControlEventStream(state, createLocalEventSink(res));
    return true;
  }
  return false;
}

export function closeConnectedFolderStreams(state: LocalApiState, connectedFolderId: string): void {
  for (const [close, owner] of [...state.fileStreams]) if (owner === connectedFolderId) close();
  const prefix = `${connectedFolderId}:`;
  for (const [key, streams] of [...state.chatStreams]) {
    if (!key.startsWith(prefix)) continue;
    for (const response of streams) response.close();
    state.chatStreams.delete(key);
  }
}

function openControlEventStream(state: LocalApiState, sink: LocalEventSink): void {
  if (sink.closed) return;
  state.controlStreams.add(sink);
  sink.send({ type: "reset" });
  const heartbeat = setInterval(() => sink.heartbeat(), 15_000);
  heartbeat.unref();
  sink.onClose(() => { clearInterval(heartbeat); state.controlStreams.delete(sink); });
}

export function openChatStream(
  state: LocalApiState,
  res: LocalEventSink,
  connectedFolderId: string,
  conversationId: string,
  _lastEventId?: string | string[],
): void {
  if (res.closed) return;
  const key = streamKey(connectedFolderId, conversationId);
  writeSseData(res, { type: "status", conversationId, message: "Connected." });
  const log = chatEventLog(state, key);
  // The conflict reservation precedes persistence. A new subscriber must not
  // mistake that reservation for a readable accepted message/answer.
  const turnId = state.activeTurnIdsByKey.get(key);
  const running = state.runningTurns.has(key) && Boolean(turnId && state.turnStore.get(turnId)?.userMessagePersisted);
  // A reconnect reads current state. Replaying deltas would repeat local
  // timers/rows and an old process's numeric cursor could match a new log.
  // No model or tool execution is restarted by this read-only projection.
  const presentation = (running && turnId ? state.clients.get(key)?.getTurnLivePresentation(turnId) : undefined)
    ?? boundedLiveTurnPresentation({ text: log.assistantText, workTrail: [], truncated: false });
  const snapshotId = log.nextId - 1;
  writeSseData(res, {
    type: "turn_snapshot", conversationId, running,
    turnId: turnId ?? log.turnId ?? null,
    text: presentation.text, presentation,
  }, snapshotId > 0 ? snapshotId : undefined);
  // Older consumers retain their original handshake alongside the richer view.
  writeSseData(res, turnStateEvent(conversationId, running, turnId ?? log.turnId ?? null), snapshotId > 0 ? snapshotId : undefined);
  // Current state, like turn_state: it carries the snapshot's cursor.
  writeSseData(res, queuedMessageEvent(state, connectedFolderId, conversationId), snapshotId > 0 ? snapshotId : undefined);
  const streams = state.chatStreams.get(key) ?? new Set<LocalEventSink>();
  streams.add(res);
  state.chatStreams.set(key, streams);
  const extensionScope = { conversationId, connectedFolderRoot: connectedFolderId === ampleFileAgentScopeId
    ? ampleFileAgentRoot() : [...state.connectedFolderIdsByRoot].find(([, id]) => id === connectedFolderId)?.[0] ?? "" };
  writeSseData(res, { type: "extension_ui_snapshot", conversationId, requests: extensionSnapshot(state, extensionScope) });
  const heartbeat = setInterval(() => {
    try {
      res.heartbeat();
    } catch { /* disconnected */ }
  }, 15_000);
  res.onClose(() => {
    clearInterval(heartbeat);
    streams.delete(res);
    if (!streams.size) state.chatStreams.delete(key);
  });
}

/** How long one file-event stream reuses its read of the ignore rules. */
const fileEventIgnoreStateReuseMs = 1_000;

export async function openConnectedFolderFileStream(
  state: LocalApiState,
  res: LocalEventSink,
  connectedFolderRoot: string,
  connectedFolderId: string,
): Promise<void> {
  let recursive = true;
  let watcher: ReturnType<typeof watch>;
  const sendEvent = (event: unknown) => {
    res.send(event);
  };
  // A build or a Git command can report thousands of changes a second. They
  // share one read of the ignore rules for a moment instead of each reading
  // the rules file again; a failed read is not reused.
  let ignoreRead: { at: number; state: ReturnType<typeof readConnectedFolderIgnoreState> } | null = null;
  const currentIgnoreState = () => {
    const now = Date.now();
    if (!ignoreRead || now - ignoreRead.at > fileEventIgnoreStateReuseMs) {
      const read = { at: now, state: readConnectedFolderIgnoreState(connectedFolderRoot) };
      read.state.catch(() => { if (ignoreRead === read) ignoreRead = null; });
      ignoreRead = read;
    }
    return ignoreRead.state;
  };
  const onChange = (eventType: string, fileName: string | Buffer | null) => {
    const rawName = Buffer.isBuffer(fileName) ? fileName.toString("utf8") : fileName ?? "";
    if (!rawName) {
      sendEvent({ type: "file_event", eventType, path: null });
      return;
    }
    const path = rawName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || isAlwaysHiddenConnectedFolderEntry(basename(path))) return;
    void currentIgnoreState().then((ignoreState) => {
      if (res.closed) return;
      if (isConnectedFolderIgnored(path, ignoreState.patterns)) return;
      try { resolveConnectedFolderPath(connectedFolderRoot, path); } catch { return; }
      sendEvent({ type: "file_event", eventType, path });
    }).catch(() => { if (!res.closed) sendEvent({ type: "error", message: "File monitoring is unavailable. Refresh this Connected Folder to reconnect." }); });
  };
  const watchRoot = await canonicalConnectedFolderWatchRoot(connectedFolderRoot);
  if (res.closed) return;
  const registered = await getConnectedFolder(connectedFolderId);
  if (registered.connectedFolderRoot !== connectedFolderRoot) throw notFound("Connected Folder changed while opening file monitoring.");
  if (res.closed) return;
  try {
    watcher = watch(watchRoot, { recursive: true }, onChange);
  } catch {
    recursive = false;
    watcher = watch(watchRoot, onChange);
  }
  sendEvent({ type: "ready", recursive });
  const heartbeat = setInterval(() => {
    res.heartbeat();
  }, 15_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    watcher.close();
    if (!res.closed) res.close();
    state.fileStreams.delete(close);
  };
  state.fileStreams.set(close, connectedFolderId);
  watcher.on("error", (error) => sendEvent({ type: "error", message: errorMessage(error) }));
  res.onClose(close);
}

/** Live refresh for the one standard folder level on screen; a folder level is not watched recursively. */
export async function openStandardFolderFileStream(state: LocalApiState, res: LocalEventSink, standardFolderId: StandardFolderId, relativePath: string): Promise<void> {
  const directory = resolveStandardFolderPath(standardFolderId, relativePath);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw notFound("That folder isn’t there anymore.");
  if (res.closed) return;
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(directory, (eventType, fileName) => {
      const name = Buffer.isBuffer(fileName) ? fileName.toString("utf8") : fileName ?? "";
      if (name && !isShownStandardEntry(basename(name))) return;
      res.send({ type: "file_event", eventType, path: name ? [relativePath, name].filter(Boolean).join("/") : null });
    });
  } catch (error) {
    throw standardFolderAccessError(error, standardFolderId);
  }
  res.send({ type: "ready", recursive: false });
  const heartbeat = setInterval(() => res.heartbeat(), 15_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    watcher.close();
    if (!res.closed) res.close();
    state.fileStreams.delete(close);
  };
  state.fileStreams.set(close, `standard:${standardFolderId}`);
  watcher.on("error", (error) => res.send({ type: "error", message: errorMessage(error) }));
  res.onClose(close);
}

const maxChatEventEntries = 512;
const maxChatEventBytes = 1024 * 1024;
const maxIdleChatEventLogs = 200;
export const maxChatStreamQueuedBytes = 512 * 1024;

export function resetChatEventTurn(state: LocalApiState, key: string): void {
  const log = chatEventLog(state, key);
  log.events = [];
  log.bytes = 0;
  log.assistantText = "";
  delete log.turnId;
}

export function chatEventLog(state: LocalApiState, key: string): ChatEventLog {
  let log = state.chatEventLogs.get(key);
  if (log) {
    state.chatEventLogs.delete(key);
    state.chatEventLogs.set(key, log);
    return log;
  }
  while (state.chatEventLogs.size >= maxIdleChatEventLogs) {
    const removable = [...state.chatEventLogs.keys()].find((candidate) =>
      !state.runningTurns.has(candidate) && !state.chatStreams.has(candidate));
    if (!removable) break;
    state.chatEventLogs.delete(removable);
  }
  log = { nextId: 1, events: [], bytes: 0, assistantText: "" };
  state.chatEventLogs.set(key, log);
  return log;
}

function appendChatEvent(state: LocalApiState, key: string, data: unknown): ChatEventLogEntry {
  const log = chatEventLog(state, key);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const event = data as { type?: unknown; text?: unknown; turnId?: unknown };
    if (typeof event.turnId === "string" && event.turnId) log.turnId = event.turnId;
    if (event.type === "assistant_delta" && typeof event.text === "string") {
      const remaining = maxDurableTurnTextChars - log.assistantText.length;
      if (remaining > 0) log.assistantText += event.text.slice(0, remaining);
    }
    if (event.type === "assistant_message" && typeof event.text === "string") {
      log.assistantText = event.text.slice(0, maxDurableTurnTextChars);
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(data));
  const entry = { id: log.nextId++, data, bytes };
  log.events.push(entry);
  log.bytes += bytes;
  while (log.events.length > maxChatEventEntries || log.bytes > maxChatEventBytes) {
    const removed = log.events.shift();
    if (!removed) break;
    log.bytes -= removed.bytes;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const type = (data as { type?: unknown }).type;
    if (type === "assistant_delta" || type === "assistant_message") scheduleTurnCheckpoint(state, key);
  }
  return entry;
}

function scheduleTurnCheckpoint(state: LocalApiState, key: string): void {
  state.turnCheckpointWriter.schedule(key);
}

export async function flushTurnCheckpoint(state: LocalApiState, key: string, taskId: string): Promise<void> {
  await state.turnCheckpointWriter.flush(key, taskId);
}

export async function flushAllTurnCheckpoints(state: LocalApiState): Promise<void> {
  await state.turnCheckpointWriter.close();
}

function writeSseEntry(response: LocalEventSink, entry: ChatEventLogEntry): void {
  writeSseData(response, entry.data, entry.id);
}

export function writeSseData(response: LocalEventSink, data: unknown, id?: number): void {
  response.send(data, id);
}

export function broadcast(state: LocalApiState, key: string, event: unknown): void {
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const activeTurnId = state.activeTurnIdsByKey.get(key);
    const supplied = (event as { turnId?: unknown }).turnId;
    // Native callbacks from a draining earlier turn cannot alter a newer view.
    if (typeof supplied === "string" && activeTurnId && supplied !== activeTurnId) return;
    if (supplied === undefined || supplied === null) event = { ...event, turnId: activeTurnId ?? chatEventLog(state, key).turnId ?? null };
  }
  const entry = appendChatEvent(state, key, event);
  const listeners = state.chatEventListeners.get(key);
  if (listeners) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { listeners.delete(listener); }
    }
  }
  const streams = state.chatStreams.get(key);
  if (!streams) return;
  for (const response of [...streams]) {
    try {
      if (response.closed || response.queuedBytes > maxChatStreamQueuedBytes) {
        response.close();
        streams.delete(response);
        continue;
      }
      writeSseEntry(response, entry);
    } catch {
      streams.delete(response);
    }
  }
  if (!streams.size) state.chatStreams.delete(key);
}

/** Content-free hints only. Reconnect always sends reset; no events are replayed. */
export function publishControlHint(state: LocalApiState, type: "connected-folders" | "models" | "activity"): void {
  for (const response of state.controlStreams) {
    if (response.closed) continue;
    // A slow renderer must reconnect and requery instead of accumulating a queue.
    try { if (!response.send({ type })) response.close(); }
    catch { response.close(); }
  }
}

export function turnStateEvent(conversationId: string, running: boolean, turnId?: string | null): { type: "turn_state"; conversationId: string; running: boolean; turnId?: string | null } {
  return { type: "turn_state", conversationId, running, ...(turnId === undefined ? {} : { turnId }) };
}
