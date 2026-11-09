import { ExtensionQuestions } from "../components/chat/ExtensionQuestions";
import { WorkRequest } from "../components/chat/WorkRequest";
import { useApplicationAppearance } from "../hooks/useApplicationAppearance";
import { useWorkRequest } from "../hooks/useWorkRequest";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Chat16Regular } from "@fluentui/react-icons";
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, File, Folder, History, Link2, MoreHorizontal, Search, Square, SquarePen, X } from "../components/chrome/icons";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ApiError, api, createEventSource, errorText } from "../lib/api";
import { groupChatsByRecency } from "../lib/chat-recency";
import { rehypeSingleLineBreaks } from "../lib/markdown-line-breaks";
import { subscribeControlEvents } from "../lib/control-events";
import { activeFolderMention, addressedFolderIds, insertFolderMention, matchingMentionFolders, mentionNames } from "../lib/folder-mentions";
import { folderTreeRows } from "../lib/folder-nesting";
import { FolderMentionMenu, type MentionFolderOption } from "../components/chat/FolderMentionMenu";
import { AmpleFileLockup } from "../components/brand/AmpleFileBrand";
import { RuntimeContextPreview } from "../components/chat/activity";
import { SafeMarkdownAnchor } from "../components/chat/SafeMarkdownAnchor";
import { TurnAnnouncer, type TurnStatus } from "../components/chat/TurnAnnouncer";
import { savedWorkTrailPreviews } from "../lib/chat-work-trail";
import type { ChatMessage, ComposerState, ConversationRuntime, ChatStreamEvent, ExtensionUiRequest, RuntimePreviewEntry } from "../types";

/** Mirrors the server's AmpleFileActManagementRequest projection. */
interface AmpleFileAgentRequestView {
  taskId: string;
  conversationId: string;
  phase: "working" | "needs_you" | "handed_off" | "done" | "failed" | "stopped";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  content: string;
  attachments: Array<{ kind: "file" | "folder" | "url"; target: string; name: string }>;
  dispositions: Array<{
    attachment: { kind: "file" | "folder" | "url"; target: string; name: string };
    status: "placed" | "registered" | "unrecorded";
    connectedFolderName?: string;
    copied?: string[];
    checkpointId?: string | null;
  }>;
  actions: Array<{
    command: "files.add" | "connected-folders.create" | "connected-folders.register" | "chat.send";
    at: string;
    connectedFolderId: string;
    connectedFolderName: string;
    copied?: string[];
    checkpointId?: string | null;
    rootPath?: string;
    conversationId?: string;
    taskId?: string;
  }>;
  children: Array<{
    taskId: string;
    connectedFolderId: string;
    connectedFolderName: string;
    conversationId: string;
    state: "running" | "succeeded" | "failed" | "aborted" | "unknown";
    error: string | null;
  }>;
  reply: { messageId: string; content: string } | null;
}

function ampleFileAgentTurnIdentity(prefix: "request" | "message"): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

interface AmpleFileAgentSummary {
  available: boolean;
  reason?: string;
  conversation: { id: string; title: string } | null;
  state: "idle" | "running" | "compacting";
  latestRequest: AmpleFileAgentRequestView | null;
}

interface AmpleFileAgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  kind?: string;
  source?: string;
  /** The steps the agent took for this reply, folded above it. */
  workTrail?: ChatMessage["workTrail"];
  interruption?: ChatMessage["interruption"];
}

interface StagedItem {
  value: string;
  label: string;
  isLink: boolean;
}

interface AmpleFileAgentChat {
  id: string;
  title: string;
  updatedAt: string;
  archivedAt?: string | null;
  snoozedUntil?: string | null;
  requestState: string | null;
  needsAnswer?: boolean;
}

// The preview's sample chats, dated relative to now so they group the way real ones do.
const fixtureHoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const fixtureChats: AmpleFileAgentChat[] = [
  { id: "fixture-agent", title: "What did my folders get done today?", updatedAt: fixtureHoursAgo(0.2), requestState: "done" },
  { id: "fixture-plan", title: "Gather the tax documents", updatedAt: fixtureHoursAgo(3), requestState: "waiting", needsAnswer: true },
  { id: "fixture-notes", title: "File the Downloads screenshots", updatedAt: fixtureHoursAgo(30), requestState: "done" },
  { id: "fixture-quotes", title: "Compare the contractor quotes", updatedAt: fixtureHoursAgo(75), requestState: "done" },
];

const activePhases = new Set(["working", "handed_off"]);
/** How a request's phase is announced: a turn that asked or handed work on did not reply. */
const popoverTurnStatus: Record<AmpleFileAgentRequestView["phase"], TurnStatus> = {
  working: "working", needs_you: "question", handed_off: "handed_off", done: "replied", failed: "failed", stopped: "stopped",
};
const pollIntervalMs = 1_500;
const idlePollIntervalMs = 5_000;
const popoverFixtureRequested = new URLSearchParams(window.location.search).get("fixture") === "agent";
const extensionFixtureRequested = popoverFixtureRequested && new URLSearchParams(window.location.search).get("extensions") === "1";

const popoverFixtureMessages: AmpleFileAgentMessage[] = [
  {
    id: "fixture-user-1",
    role: "user",
    content: "What did my folders get done today?",
    createdAt: fixtureHoursAgo(0.25),
  },
  {
    id: "fixture-assistant-1",
    role: "assistant",
    content: [
      "Three Connected Folders moved forward today:",
      "",
      "- **Downloads**: Organize New Files filed 6 new files into their folders.",
      "- **Home Renovation**: the Worker compared three quotes and wrote Quote Comparison.docx.",
      "- **Taxes 2026**: the Worker renamed two statements and has a question for you about a missing 1099-DIV.",
      "",
      "Want me to open Taxes 2026?",
    ].join("\n"),
    createdAt: fixtureHoursAgo(0.2),
  },
];

const popoverFixtureComposer: ComposerState = {
  model: { provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Claude Sonnet" },
  thinkingLevel: "medium",
  thinkingLevels: ["low", "medium", "high"],
};

/** The menu-bar popover: its own window, so it owns the appearance preferences. */
export function PopoverApp() {
  useApplicationAppearance({ fixtureMode: popoverFixtureRequested });
  return <AmpleFileAgentChat host="popover" fixtureMode={popoverFixtureRequested} />;
}

export interface AmpleFileAgentChatProps {
  /** The menu-bar popover window, or the panel beside the main window's work area. */
  host: "popover" | "panel";
  fixtureMode?: boolean;
  /** Panel only: the window's top strip, where the chat's controls render. */
  controlsTarget?: HTMLElement | null;
  /** Panel only: the panel is showing (it stays mounted while closed). */
  visible?: boolean;
  /** Panel only: opens Settings → AI Models for the AmpleFile Agent. */
  onOpenModelSettings?: () => void;
  /** Panel only: text another surface handed over, added to the message box like a tray drop. */
  draftRequest?: { id: number; text: string } | null;
}

/**
 * The AmpleFile Agent's chat. The menu-bar popover and the main window's
 * panel render this same component, so both show one conversation the same
 * way, including each turn's thinking and tool steps as they happen.
 */
export function AmpleFileAgentChat({ host, fixtureMode = false, controlsTarget = null, visible = true, onOpenModelSettings, draftRequest = null }: AmpleFileAgentChatProps) {
  const popoverFixtureRequested = fixtureMode;
  const extensionFixture = fixtureMode && extensionFixtureRequested;
  const bridge = window.ampleFileDesktop;
  const [available, setAvailable] = useState<boolean | null>(popoverFixtureRequested ? true : null);
  const [unavailableReason, setUnavailableReason] = useState<string>("");
  const [request, setRequest] = useState<AmpleFileAgentRequestView | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(popoverFixtureRequested ? "fixture-agent" : null);
  const [messages, setMessages] = useState<AmpleFileAgentMessage[]>(popoverFixtureRequested ? popoverFixtureMessages : []);
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [text, setText] = useState("");
  // Connected Folder Workers the AmpleFile Agent can be told to involve with @,
  // in the same nested order as the Connected Folder switcher.
  const [mentionFolders, setMentionFolders] = useState<MentionFolderOption[]>([]);
  const [composerCaret, setComposerCaret] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [startingNewChat, setStartingNewChat] = useState(false);
  const [chats, setChats] = useState<AmpleFileAgentChat[]>(popoverFixtureRequested ? fixtureChats : []);
  const [chatTitle, setChatTitle] = useState(popoverFixtureRequested ? fixtureChats[0].title : "New Chat");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [chatAction, setChatAction] = useState<{ id: string; mode: "menu" | "rename"; title: string } | null>(null);
  const [savingChat, setSavingChat] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const workState = useWorkRequest(!popoverFixtureRequested && conversationId && !startingNewChat ? `/api/amplefile-agent/conversations/${encodeURIComponent(conversationId)}/work` : null);
  const [stopping, setStopping] = useState(false);
  const [banner, setBanner] = useState<string>("");
  const [dropActive, setDropActive] = useState(false);
  const [activity, setActivity] = useState<string>("");
  const [streamingAssistant, setStreamingAssistant] = useState("");
  // The current turn's steps, as the main window's Chat shows them.
  const [liveSteps, setLiveSteps] = useState<RuntimePreviewEntry[]>([]);
  const activeThinkingIdRef = useRef<string | null>(null);
  const stepCounterRef = useRef(0);
  const [ampleFileAgentComposer, setAmpleFileAgentComposer] = useState<ComposerState | null>(popoverFixtureRequested ? popoverFixtureComposer : null);
  const [conversationRuntime, setConversationRuntime] = useState<ConversationRuntime | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectionRef = useRef<string | null>(popoverFixtureRequested ? "fixture-agent" : null);
  const refreshGeneration = useRef(0);
  const runtimeUpdateRevision = useRef(0);
  const [extensionSnapshot, setExtensionSnapshot] = useState<{ conversationId: string; requests: ExtensionUiRequest[] } | null>(extensionFixture ? {
    conversationId: "fixture-agent", requests: [
      { id: "fixture-extension", method: "select", title: "Which account should I use for the report?", options: ["Work account", "Personal account"] },
    ],
  } : null);
  const draftsRef = useRef(new Map<string, { text: string; staged: StagedItem[] }>());
  const transcriptRef = useRef<HTMLElement | null>(null);
  // The transcript mounts only after the first availability read (and again
  // if the agent becomes available later), so its observers follow the
  // element rather than the first render.
  const [transcriptElement, setTranscriptElement] = useState<HTMLElement | null>(null);
  const attachTranscript = useCallback((node: HTMLElement | null) => {
    transcriptRef.current = node;
    setTranscriptElement(node);
  }, []);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const transcriptPinnedRef = useRef(true);
  const [transcriptPinned, setTranscriptPinnedState] = useState(true);
  const dragDepthRef = useRef(0);
  const streamingDeltaRef = useRef("");
  const streamingFrameRef = useRef<number | null>(null);
  const requestRef = useRef<AmpleFileAgentRequestView | null>(null);
  const pendingSendIdentityRef = useRef<{
    signature: string;
    requestId: string;
    userMessageId: string;
  } | null>(null);
  const startingNewChatRef = useRef(false);
  requestRef.current = request;
  const refreshAmpleFileAgentComposer = useCallback(async () => {
    if (popoverFixtureRequested) return;
    try {
      const result = await api<{ composer: ComposerState }>("/api/agent/composer?scope=agent");
      setAmpleFileAgentComposer(result.composer);
    } catch {
      // Model setup is a convenience affordance, not popover availability.
      // Keep the last known composer state if this optional read is unavailable.
    }
  }, []);

  const refreshConversationRuntime = useCallback(async (id: string) => {
    if (popoverFixtureRequested) return;
    const revision = runtimeUpdateRevision.current;
    try {
      const result = await api<{ runtime: ConversationRuntime }>(`/api/amplefile-agent/conversations/${encodeURIComponent(id)}/runtime`);
      if (selectionRef.current === id && revision === runtimeUpdateRevision.current) setConversationRuntime(result.runtime);
    } catch {
      if (selectionRef.current === id && revision === runtimeUpdateRevision.current) setConversationRuntime(null);
    }
  }, []);

  const flushStreamingAssistant = useCallback(() => {
    if (streamingFrameRef.current !== null) {
      window.cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
    const delta = streamingDeltaRef.current;
    streamingDeltaRef.current = "";
    if (delta) setStreamingAssistant((current) => current + delta);
  }, []);

  const queueStreamingAssistant = useCallback((delta: string) => {
    streamingDeltaRef.current += delta;
    if (streamingFrameRef.current !== null) return;
    streamingFrameRef.current = window.requestAnimationFrame(flushStreamingAssistant);
  }, [flushStreamingAssistant]);

  const replaceStreamingAssistant = useCallback((text: string) => {
    if (streamingFrameRef.current !== null) window.cancelAnimationFrame(streamingFrameRef.current);
    streamingFrameRef.current = null;
    streamingDeltaRef.current = "";
    setStreamingAssistant(text);
  }, []);

  useEffect(() => () => {
    if (streamingFrameRef.current !== null) window.cancelAnimationFrame(streamingFrameRef.current);
  }, []);

  const refreshConversation = useCallback(async () => {
    if (popoverFixtureRequested) return;
    const generation = ++refreshGeneration.current;
    const selectedId = selectionRef.current;
    try {
      const [summary, history] = await Promise.all([
        api<AmpleFileAgentSummary>(selectedId ? `/api/amplefile-agent/summary?conversationId=${encodeURIComponent(selectedId)}` : "/api/amplefile-agent/summary"),
        api<{ conversations: AmpleFileAgentChat[] }>("/api/amplefile-agent/conversations").then(
          (result) => ({ chats: result.conversations, error: "" }),
          (error) => ({ chats: null, error: errorText(error) }),
        ),
      ]);
      if (generation !== refreshGeneration.current) return;
      if (history.chats) setChats(history.chats);
      setHistoryError(history.error);
      setAvailable(summary.available);
      setUnavailableReason(summary.available ? "" : summary.reason ?? "");
      if (startingNewChatRef.current) return;
      const nextConversationId = summary.conversation?.id ?? null;
      if (!nextConversationId) {
        // An empty desktop is a new-chat draft too. Another surface creating
        // a conversation later must not silently become this draft's target.
        startingNewChatRef.current = true;
        setStartingNewChat(true);
        setRequest(null);
        setMessages([]);
        replaceStreamingAssistant("");
        return;
      }
      const transcript = await api<{ messages: AmpleFileAgentMessage[] }>(`/api/amplefile-agent/conversations/${encodeURIComponent(nextConversationId)}`);
      if (generation !== refreshGeneration.current) return;
      selectionRef.current = nextConversationId;
      setConversationId(nextConversationId);
      setChatTitle(summary.conversation?.title || "Untitled chat");
      setRequest(summary.latestRequest);
      const next = transcript.messages.filter((message) =>
        message.kind === "context_compaction" || (message.role === "user" || message.role === "assistant") && (!message.kind || message.kind === "assistant_continuation"));
      // Polling refetches the same transcript most ticks; keeping the old
      // array identity for identical content spares re-renders and the
      // follow-scroll effect.
      setMessages((current) => {
        const ids = new Set(next.map(message => message.id));
        const merged = [...next, ...current.filter(message => message.kind === "context_compaction" && !ids.has(message.id))];
        return sameTranscript(current, merged) ? current : merged;
      });
      if (!summary.latestRequest || !activePhases.has(summary.latestRequest.phase)) {
        replaceStreamingAssistant("");
        activeThinkingIdRef.current = null;
        setLiveSteps([]);
      }
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      if (error instanceof ApiError && error.status === 404) {
        setRequest(null);
        setMessages([]);
        replaceStreamingAssistant("");
        setAvailable(true);
        setBanner("This chat is no longer available. Choose another chat or start a new one.");
        return;
      }
      const message = errorText(error);
      setAvailable(false);
      setUnavailableReason(message);
    } finally {
      if (generation === refreshGeneration.current) setLoadingChat(false);
    }
  }, [replaceStreamingAssistant]);

  useEffect(() => {
    void refreshConversation();
    void refreshAmpleFileAgentComposer();
  }, [refreshConversation, refreshAmpleFileAgentComposer]);

  // Staged material handed over by the tray (macOS icon drops).
  useEffect(() => {
    if (popoverFixtureRequested) return;
    const unsubscribe = bridge?.ampleFileAgent?.onStaged((items) => {
      for (const item of items) {
        if (item.kind === "path") addStagedValue(item.value, setStaged);
        else if (looksLikeLink(item.value)) addStagedValue(item.value.trim(), setStaged);
        else setText((current) => (current ? `${current}\n${item.value}` : item.value));
      }
    });
    return () => unsubscribe?.();
  }, [bridge]);

  const clearLiveSteps = useCallback(() => {
    activeThinkingIdRef.current = null;
    setLiveSteps([]);
  }, []);

  const upsertLiveStep = useCallback((step: RuntimePreviewEntry) => {
    setLiveSteps((current) => {
      const index = current.findIndex((item) => item.id === step.id);
      if (index < 0) return [...current, step];
      const next = [...current];
      next[index] = { ...next[index], ...step };
      return next;
    });
  }, []);

  const startLiveThought = useCallback((event?: ChatStreamEvent) => {
    const id = event?.workTrailId ?? `thinking-${++stepCounterRef.current}`;
    activeThinkingIdRef.current = id;
    upsertLiveStep({ id, kind: "thinking", text: "", phase: "streaming", startedAt: event?.startedAt ?? Date.now(), ...(event?.order !== undefined ? { order: event.order } : {}) });
  }, [upsertLiveStep]);

  const appendLiveThought = useCallback((text: string, event?: ChatStreamEvent) => {
    let id = event?.workTrailId ?? activeThinkingIdRef.current;
    if (!id) { startLiveThought(event); id = activeThinkingIdRef.current; }
    if (!id) return;
    setLiveSteps((current) => current.map((entry) => entry.id === id ? { ...entry, text: `${entry.text}${text}`, phase: "streaming" } : entry));
  }, [startLiveThought]);

  const finishLiveThought = useCallback((event?: ChatStreamEvent) => {
    const id = event?.workTrailId ?? activeThinkingIdRef.current;
    if (!id) return;
    activeThinkingIdRef.current = null;
    const endedAt = Date.now();
    setLiveSteps((current) => current.map((entry) => entry.id === id
      ? { ...entry, phase: "complete", ...(event?.durationMs !== undefined ? { durationMs: event.durationMs } : entry.startedAt ? { durationMs: Math.max(0, endedAt - entry.startedAt) } : {}) }
      : entry));
  }, []);

  // A draft handed in through `draftRequest` lands in the message box.
  useEffect(() => {
    if (!draftRequest) return;
    setHistoryOpen(false);
    setText((current) => (current ? `${current}\n${draftRequest.text}` : draftRequest.text));
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [draftRequest?.id]);

  // Live turn events for the active request's conversation.
  useEffect(() => {
    if (!conversationId || popoverFixtureRequested) return;
    const stream = createEventSource(`/api/amplefile-agent/conversations/${encodeURIComponent(conversationId)}/events`);
    let observedRunning = false;
    stream.onmessage = (raw) => {
      if (selectionRef.current !== conversationId) return;
      let event: ChatStreamEvent;
      try {
        event = JSON.parse(raw.data) as ChatStreamEvent;
      } catch {
        return;
      }
      if (event.type === "extension_ui_snapshot") setExtensionSnapshot({ conversationId, requests: event.requests ?? [] });
      if (event.type === "runtime" && event.runtime) {
        runtimeUpdateRevision.current++;
        setConversationRuntime(event.runtime);
      }
      if (event.type === "context_compacted" && event.chatMessage?.kind === "context_compaction") {
        const notice = event.chatMessage;
        setMessages((current) => current.some((message) => message.id === notice.id) ? current : [...current, notice]);
      }
      if (event.type === "extension_ui_request" && event.request?.method === "notify") setActivity(event.request.message ?? "");
      if (event.type === "editor" && typeof event.text === "string") setText((current) => event.editorMode === "replace" ? event.text! : current + event.text);
      if (event.type === "status" || event.type === "tool") {
        const message = typeof event.message === "string" && event.message !== "Connected." ? event.message.trim() : "";
        const tool = event.type === "tool" && typeof event.toolName === "string" ? event.toolName.trim() : "";
        if (message || tool) setActivity(message || tool);
      }
      if (event.type === "turn_state" || event.type === "turn_snapshot") {
        if (event.running === true && !observedRunning) {
          replaceStreamingAssistant("");
          clearLiveSteps();
        }
        observedRunning = event.running === true;
      }
      if (event.type === "turn_snapshot" && typeof event.text === "string" && event.running === true) {
        replaceStreamingAssistant(event.presentation?.text ?? event.text);
        // A snapshot replaces the steps at its cursor, so a reconnect never duplicates rows.
        if (event.presentation) {
          setLiveSteps(event.presentation.workTrail);
          activeThinkingIdRef.current = [...event.presentation.workTrail].reverse()
            .find((entry) => entry.kind === "thinking" && ["running", "streaming"].includes(entry.phase ?? ""))?.id ?? null;
        }
      }
      if (event.type === "tool") {
        upsertLiveStep({
          id: event.workTrailId ?? (event.toolCallId?.trim() ? `tool-${event.toolCallId.trim()}` : `tool-${++stepCounterRef.current}`),
          kind: "tool",
          text: event.message?.trim() || event.toolName?.trim() || "Tool",
          ...(event.detail?.trim() ? { detail: event.detail.trim() } : {}),
          ...(event.toolName?.trim() ? { toolName: event.toolName.trim() } : {}),
          ...(event.toolTitle?.trim() ? { toolTitle: event.toolTitle.trim() } : {}),
          ...(event.order !== undefined ? { order: event.order } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.edit ? { edit: event.edit } : {}),
          phase: event.phase ?? "running",
        });
      }
      if (event.type === "assistant_thinking") {
        if (event.thinkingPhase === "start") startLiveThought(event);
        if (event.text) appendLiveThought(event.text, event);
        if (event.thinkingPhase === "end") finishLiveThought(event);
      }
      if (event.type === "assistant_delta" && typeof event.text === "string") {
        queueStreamingAssistant(event.text);
      }
      if (event.type === "assistant_message" && typeof event.text === "string") {
        replaceStreamingAssistant(event.text);
      }
      if (event.type === "turn_state" || event.type === "done" || event.type === "error") {
        if (event.type === "done" || event.type === "error" || event.running === false) { flushStreamingAssistant(); finishLiveThought(); }
        if (event.type === "done" || event.type === "error" || event.running === false) void refreshConversationRuntime(conversationId);
        void refreshConversation();
      }
    };
    return () => stream.close();
  }, [conversationId, refreshConversation, refreshConversationRuntime, flushStreamingAssistant, queueStreamingAssistant, replaceStreamingAssistant, clearLiveSteps, upsertLiveStep, startLiveThought, appendLiveThought, finishLiveThought]);

  useEffect(() => {
    if (popoverFixtureRequested) return;
    replaceStreamingAssistant("");
    if (conversationId) void refreshConversationRuntime(conversationId);
    else setConversationRuntime(null);
  }, [conversationId, refreshConversationRuntime, replaceStreamingAssistant]);

  // Refresh saved Chats without replacing the person's selected conversation.
  const phase = request?.phase ?? null;
  useEffect(() => {
    if (popoverFixtureRequested) return;
    const timer = window.setInterval(() => {
      void refreshConversation();
      setNow(Date.now());
    }, request && phase && activePhases.has(phase) ? pollIntervalMs : idlePollIntervalMs);
    return () => window.clearInterval(timer);
  }, [request?.taskId, phase, refreshConversation]);

  // Electron keeps this renderer mounted while the popover is hidden. A turn
  // can settle while Chromium has throttled its timer and event stream, so a
  // newly shown/focused popover must reconcile the persisted request before it
  // renders the old Working state again.
  useEffect(() => {
    if (popoverFixtureRequested) return;
    let lastMentionRefresh = 0;
    const refreshMentionFolders = (force = false) => {
      // Focus and visibility often fire together on one show; read once.
      if (!force && Date.now() - lastMentionRefresh < 1000) return;
      lastMentionRefresh = Date.now();
      void api<{ connectedFolders: Array<{ id: string; name: string; connectedFolderRoot: string }> }>("/api/connected-folders/outline")
        .then(({ connectedFolders }) => { const names = mentionNames(connectedFolders); setMentionFolders(folderTreeRows(connectedFolders).map(({ connectedFolder, depth }) => ({
          id: connectedFolder.id,
          name: names.get(connectedFolder.id) ?? connectedFolder.name,
          icon: <Folder aria-hidden="true" />,
          style: { paddingLeft: `${8 + depth * 16}px` },
        }))); })
        .catch(() => {});
    };
    refreshMentionFolders(true);
    const unsubscribeControl = subscribeControlEvents((hint) => { if (hint === "connected-folders" || hint === "reset") refreshMentionFolders(true); });
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") {
        void refreshConversation();
        void refreshAmpleFileAgentComposer();
        refreshMentionFolders();
      }
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      unsubscribeControl();
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshConversation, refreshAmpleFileAgentComposer]);

  const setTranscriptPinned = useCallback((pinned: boolean) => {
    transcriptPinnedRef.current = pinned;
    setTranscriptPinnedState(pinned);
  }, []);

  // Sending, opening a chat, and Latest all return to the newest entry.
  const followLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    setTranscriptPinned(true);
    window.requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTo({ top: transcript.scrollHeight, behavior });
    });
  }, [setTranscriptPinned]);

  useEffect(() => {
    setTranscriptPinned(true);
  }, [conversationId, setTranscriptPinned]);

  // The transcript follows every streamed frame and compact status change only
  // while the person is at (or near) the bottom. A frame runs after layout so
  // a growing Markdown reply and the shrinking/growing live tail are measured
  // at their final height before the scroll is applied. Showing the panel or
  // coming back from Chats counts too: a hidden transcript loses its place.
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !transcriptPinnedRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (transcriptPinnedRef.current) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, phase, streamingAssistant, activity, liveSteps, conversationId, visible, historyOpen]);

  // Size changes that come from outside the chat state follow too: a resized
  // panel or window, a growing composer, a loaded image, or an opened step.
  useEffect(() => {
    const transcript = transcriptElement;
    if (!transcript) return;
    let frame: number | null = null;
    const stick = () => {
      if (!transcriptPinnedRef.current || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (transcriptPinnedRef.current) transcript.scrollTop = transcript.scrollHeight;
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(stick);
    observer?.observe(transcript);
    transcript.addEventListener("load", stick, true);
    transcript.addEventListener("toggle", stick, true);
    return () => {
      observer?.disconnect();
      transcript.removeEventListener("load", stick, true);
      transcript.removeEventListener("toggle", stick, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [transcriptElement]);

  // The door comes first: whenever the shown popover has nothing that outranks
  // it — no running work hiding the composer — and focus has not landed
  // anywhere yet, the composer takes it.
  useEffect(() => {
    if (host !== "panel" || !visible || available !== true) return;
    const current = requestRef.current;
    if (current && activePhases.has(current.phase)) return;
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [host, visible, available]);

  useEffect(() => {
    if (host !== "popover" || available !== true) return;
    // `phase` is a dependency so the composer regains focus the moment a
    // settled request brings it back, not only on the next window focus.
    const focusComposerFirst = () => {
      if (document.visibilityState === "hidden") return;
      const current = requestRef.current;
      if (current && activePhases.has(current.phase)) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      composerRef.current?.focus();
    };
    focusComposerFirst();
    window.addEventListener("focus", focusComposerFirst);
    document.addEventListener("visibilitychange", focusComposerFirst);
    return () => {
      window.removeEventListener("focus", focusComposerFirst);
      document.removeEventListener("visibilitychange", focusComposerFirst);
    };
  }, [host, available, phase]);

  // Hiding the popover releases focus parked on a button or strip: Chromium
  // keeps DOM focus across hide/show, and a stale button would otherwise
  // swallow both the reopen keystrokes and the composer's first-focus claim.
  // Text entry (the composer) keeps its focus across reopens.
  useEffect(() => {
    if (host !== "popover") return;
    const releaseStaleFocus = () => {
      if (document.visibilityState !== "hidden") return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) return;
      if (active.matches("textarea, input, [contenteditable]")) return;
      active.blur();
    };
    document.addEventListener("visibilitychange", releaseStaleFocus);
    return () => document.removeEventListener("visibilitychange", releaseStaleFocus);
  }, [host]);

  const send = useCallback(async () => {
    const content = text.trim();
    const currentRequest = requestRef.current;
    if (!content || sending || loadingChat || stopping || (currentRequest && activePhases.has(currentRequest.phase))) return;
    setSending(true);
    setBanner("");
    setActivity("");
    replaceStreamingAssistant("");
    clearLiveSteps();
    followLatest();
    try {
      const current = requestRef.current;
      const addressedConnectedFolderIds = addressedFolderIds(content, mentionFolders);
      // Match the host's request digest: a registry change may remove or
      // rename an addressed Worker between retries of the same message.
      const signature = JSON.stringify({
        content,
        attachments: staged.map((item) => item.value),
        newConversation: startingNewChatRef.current,
        conversationId: selectionRef.current,
        continuationTaskId: current?.phase === "needs_you" ? current.taskId : null,
      });
      const identity = pendingSendIdentityRef.current?.signature === signature
        ? pendingSendIdentityRef.current
        : {
            signature,
            requestId: ampleFileAgentTurnIdentity("request"),
            userMessageId: ampleFileAgentTurnIdentity("message"),
          };
      pendingSendIdentityRef.current = identity;
      const body: Record<string, unknown> = {
        content,
        requestId: identity.requestId,
        userMessageId: identity.userMessageId,
      };
      if (staged.length) body.attachments = staged.map((item) => item.value);
      if (addressedConnectedFolderIds.length) body.addressedConnectedFolderIds = addressedConnectedFolderIds;
      if (startingNewChatRef.current) {
        body.newConversation = true;
      } else if (selectionRef.current) {
        body.conversationId = selectionRef.current;
        if (current?.phase === "needs_you") body.continuationTaskId = current.taskId;
      }
      const result = await api<{ taskId: string; conversationId: string }>(
        "/api/amplefile-agent/messages",
        { method: "POST", body, idempotent: true },
      );
      startingNewChatRef.current = false;
      pendingSendIdentityRef.current = null;
      setStartingNewChat(false);
      // Clear only what was submitted; keystrokes that landed while the send
      // was in flight stay in the box.
      setText((current) => (current === text ? "" : current));
      setStaged([]);
      draftsRef.current.delete(selectionRef.current ?? "new");
      selectionRef.current = result.conversationId;
      setConversationId(result.conversationId);
      await refreshConversation();
    } catch (error) {
      setBanner(errorText(error));
    } finally {
      setSending(false);
    }
  }, [text, staged, sending, loadingChat, stopping, refreshConversation, replaceStreamingAssistant, clearLiveSteps, mentionFolders, followLatest]);

  // Enter while the AmpleFile Agent is working reaches its running turn after
  // its current step, the way a Connected Folder Chat steers.
  const steer = useCallback(async () => {
    const content = text.trim();
    const conversation = selectionRef.current;
    if (!content || sending || !conversation) return;
    if (staged.length) {
      setBanner("Attachments go with your next message, after this work finishes.");
      return;
    }
    setSending(true);
    setBanner("");
    try {
      await api("/api/amplefile-agent/messages", {
        method: "POST",
        idempotent: true,
        body: { content, delivery: "steer", conversationId: conversation, requestId: ampleFileAgentTurnIdentity("request"), userMessageId: ampleFileAgentTurnIdentity("message") },
      });
      setText((current) => (current === text ? "" : current));
      await refreshConversation();
    } catch (error) {
      setBanner(errorText(error));
    } finally {
      setSending(false);
    }
  }, [text, staged, sending, refreshConversation]);

  const activeMention = useMemo(() => mentionFolders.length ? activeFolderMention(text, composerCaret) : null, [composerCaret, mentionFolders.length, text]);
  const mentionSuggestions = useMemo(() => activeMention ? matchingMentionFolders(mentionFolders, activeMention.query) : [], [activeMention, mentionFolders]);
  const mentionKey = activeMention ? `${activeMention.start}:${text}` : null;
  const mentionMenuOpen = mentionSuggestions.length > 0 && mentionKey !== dismissedMentionKey;
  useEffect(() => { setActiveMentionIndex(0); }, [activeMention?.start, activeMention?.query]);
  const chooseMentionFolder = (folder: MentionFolderOption) => {
    if (!activeMention) return;
    const next = insertFolderMention(text, activeMention, folder);
    setText(next.value);
    setComposerCaret(next.caret);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const selectChat = useCallback((id: string | null) => {
    if (sending || stopping || workState.busy || savingChat) return;
    setHistoryOpen(false);
    setHistoryQuery("");
    if (id === selectionRef.current && (id || startingNewChatRef.current)) {
      window.setTimeout(() => composerRef.current?.focus(), 0);
      return;
    }
    draftsRef.current.set(selectionRef.current ?? "new", { text, staged });
    const draft = draftsRef.current.get(id ?? "new");
    setText(draft?.text ?? "");
    setStaged(draft?.staged ?? []);
    refreshGeneration.current++;
    selectionRef.current = id;
    startingNewChatRef.current = id === null;
    pendingSendIdentityRef.current = null;
    setStartingNewChat(id === null);
    setLoadingChat(Boolean(id) && !popoverFixtureRequested);
    setChatTitle(id ? chats.find((chat) => chat.id === id)?.title || "Untitled chat" : "New Chat");
    setRequest(null);
    requestRef.current = null;
    setConversationId(id);
    setConversationRuntime(null);
    setMessages(popoverFixtureRequested && id ? popoverFixtureMessages : []);
    setActivity("");
    replaceStreamingAssistant("");
    clearLiveSteps();
    setBanner("");
    void refreshConversation();
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [sending, stopping, workState.busy, savingChat, text, staged, chats, refreshConversation, replaceStreamingAssistant, clearLiveSteps]);
  async function changeChat(action: "rename" | "delete") {
    if (!chatAction || savingChat) return;
    const { id } = chatAction;
    const title = chatAction.title.replace(/\s+/g, " ").trim();
    if (action === "rename" && !title) return;
    setSavingChat(true);
    setHistoryError("");
    // Invalidate reads started before this mutation so they cannot restore an old title/list.
    refreshGeneration.current++;
    try {
      if (!popoverFixtureRequested) await api(`/api/amplefile-agent/conversations/${encodeURIComponent(id)}${action === "rename" ? "/title" : ""}`, {
        method: action === "rename" ? "POST" : "DELETE",
        ...(action === "rename" ? { body: { title } } : {}),
      });
      if (action === "rename") {
        setChats((current) => current.map((chat) => chat.id === id ? { ...chat, title } : chat));
        if (selectionRef.current === id) setChatTitle(title);
      } else {
        setChats((current) => current.filter((chat) => chat.id !== id));
        draftsRef.current.delete(id);
        if (selectionRef.current === id) {
          selectionRef.current = null;
          startingNewChatRef.current = true;
          setStartingNewChat(true);
          setConversationId(null);
          setChatTitle("New Chat");
          setMessages([]);
          setRequest(null);
          requestRef.current = null;
          setConversationRuntime(null);
          setText(draftsRef.current.get("new")?.text ?? "");
          setStaged(draftsRef.current.get("new")?.staged ?? []);
          replaceStreamingAssistant("");
        }
      }
      setChatAction(null);
      await refreshConversation();
      window.requestAnimationFrame(() => {
        if (action === "delete") searchRef.current?.focus();
        else [...document.querySelectorAll<HTMLButtonElement>("[data-chat-actions]")].find((button) => button.dataset.chatActions === id)?.focus();
      });
    } catch (error) { setHistoryError(errorText(error)); }
    finally { setSavingChat(false); }
  }
  const startNewChat = useCallback(() => selectChat(null), [selectChat]);

  useEffect(() => {
    if (historyOpen) searchRef.current?.focus();
  }, [historyOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Cancelling an IME composition must not dismiss the surface.
      if (event.isComposing) return;
      if (host === "panel") {
        const target = event.target instanceof Node ? event.target : null;
        const inside = Boolean(target && (rootRef.current?.contains(target) || controlsTarget?.contains(target)));
        if (!inside || event.key !== "Escape") return;
        if (chatAction) { if (!savingChat) setChatAction(null); }
        else if (historyOpen) { setHistoryOpen(false); window.setTimeout(() => composerRef.current?.focus(), 0); }
        return;
      }
      if (event.key === "Escape") {
        if (chatAction) { if (!savingChat) setChatAction(null); }
        else if (historyOpen) { setHistoryOpen(false); window.setTimeout(() => composerRef.current?.focus(), 0); }
        else bridge?.ampleFileAgent?.hide();
      }
      // ⌘N/Ctrl+N mirrors the direct header action.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bridge, host, controlsTarget, startNewChat, historyOpen, chatAction, savingChat]);

  const stop = useCallback(async () => {
    const current = requestRef.current;
    if (!current || stopping) return;
    setStopping(true);
    try {
      const result = await api<{
        stopped: { ampleFileAgentAborted: boolean; children: Array<{ aborted: boolean }> };
      }>(`/api/amplefile-agent/requests/${encodeURIComponent(current.taskId)}/stop`, { method: "POST", body: {} });
      if (!result.stopped.ampleFileAgentAborted && !result.stopped.children.some((child) => child.aborted)) {
        setBanner("No running work was stopped. It may have finished just before the request arrived.");
      }
      await refreshConversation();
    } catch (error) {
      setBanner(errorText(error));
    } finally {
      setStopping(false);
    }
  }, [stopping, refreshConversation]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    const transfer = event.dataTransfer;
    let added = false;
    for (const file of Array.from(transfer.files)) {
      const path = (bridge?.ampleFileAgent?.getPathForFile ?? bridge?.agent?.getPathForFile)?.(file) ?? "";
      if (path) {
        addStagedValue(path, setStaged);
        added = true;
      }
    }
    if (!added) {
      const uriList = transfer.getData("text/uri-list") || transfer.getData("text/plain");
      for (const line of uriList.split("\n")) {
        const value = line.trim();
        if (value && looksLikeLink(value)) {
          addStagedValue(value, setStaged);
          added = true;
        }
      }
    }
    if (!added && transfer.files.length) {
      setBanner("Dropped files need the AmpleFile desktop app; links and paths still work here.");
    }
    // A staged chip waits for its instruction — put the cursor where the
    // instruction goes.
    if (added) composerRef.current?.focus();
  }, [bridge]);

  const onDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  }, []);

  // Pasting a lone link into an empty composer stages it as a reference chip,
  // the same treatment a dropped or tray-staged link gets. Pasting into or
  // around existing text stays plain text.
  const onComposerPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData("text/plain").trim();
    if (!pasted || !looksLikeLink(pasted) || /\s/.test(pasted)) return;
    if (event.currentTarget.value.trim()) return;
    event.preventDefault();
    addStagedValue(pasted, setStaged);
  }, []);

  const removeStaged = useCallback((value: string) => {
    setStaged((current) => current.filter((item) => item.value !== value));
  }, []);

  const elapsedLabel = useMemo(() => {
    if (!request || request.phase !== "working") return "";
    const startedAt = Date.parse(request.startedAt);
    if (!Number.isFinite(startedAt)) return "";
    const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }, [request, now]);

  if (available === null) {
    return <div className="popover popover-loading"><AmpleFileLockup className="popover-loading-brand" animated /><p className="muted">Connecting…</p></div>;
  }
  if (available === false && !conversationId) {
    return (
      <div className="popover">
        <header className="popover-header">
          <h1 className="popover-chat-title">AmpleFile Agent</h1>
        </header>
        <div className="card">
          <p>The AmpleFile Agent is unavailable.</p>
          {unavailableReason ? <p className="muted small">{unavailableReason}</p> : null}
        </div>
      </div>
    );
  }

  const requestRunning = request !== null && activePhases.has(request.phase);
  const canSteer = request?.phase === "working" && Boolean(conversationId) && !startingNewChat;
  const composerPlaceholder = canSteer
    ? "Steer (Enter)"
    : requestRunning
    ? "Draft a follow-up"
    : request?.phase === "needs_you"
      ? "Reply to AmpleFile"
      : "Tell AmpleFile what to do";
  const composerThinking = conversationRuntime && !startingNewChat ? conversationRuntime : ampleFileAgentComposer;
  const thinkingLevels = composerThinking?.thinkingLevels ?? [];
  const ampleFileAgentModelLabel = composerThinking?.model?.name || composerThinking?.model?.id || "Choose Model";
  const visibleBanner = banner || (available === false ? unavailableReason : "");
  const backgroundChats = chats.filter((chat) => chat.id !== conversationId && (chat.requestState === "working" || chat.requestState === "handed_off"));
  const filteredChats = chats.filter((chat) => chat.title.toLocaleLowerCase().includes(historyQuery.trim().toLocaleLowerCase()));
  const chatsByRecency = groupChatsByRecency(filteredChats);
  const navigationBusy = sending || stopping || workState.busy || savingChat;

  const closeHistory = () => {
    setHistoryOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const changeThinkingLevel = async (level: string) => {
    if (requestRunning || loadingChat || level === composerThinking?.thinkingLevel) return;
    const selectedId = selectionRef.current;
    try {
      if (conversationId && conversationRuntime && !startingNewChat) {
        const result = await api<{ runtime: ConversationRuntime }>(`/api/amplefile-agent/conversations/${encodeURIComponent(conversationId)}/thinking`, {
          method: "POST",
          body: { level },
        });
        if (selectionRef.current === selectedId) setConversationRuntime(result.runtime);
      } else {
        const result = await api<{ composer: ComposerState }>("/api/agent/thinking", {
          method: "POST",
          body: { scope: "agent", level },
        });
        setAmpleFileAgentComposer(result.composer);
      }
    } catch (error) {
      if (selectionRef.current === selectedId) setBanner(errorText(error));
    }
  };

  return (
    <div
      ref={rootRef}
      className={`popover${host === "panel" ? " agent-panel-chat" : ""}${dropActive ? " drop-active" : ""}${popoverFixtureRequested && host === "popover" ? " popover-fixture" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={(event) => { event.preventDefault(); }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {host === "panel" ? (controlsTarget ? createPortal(
        // The panel's chat controls live in the window's top strip, icon only.
        <>
          <button className="window-chrome-button" type="button" aria-label={historyOpen ? "Back to Chat" : "Chats"} title={historyOpen ? "Back to Chat" : `Chats · ${chatTitle}`} aria-pressed={historyOpen} aria-controls="agent-chat-history"
            onClick={() => { setHistoryOpen((open) => !open); void refreshConversation(); }}>
            <History aria-hidden="true" size={16} />
          </button>
          <button className="window-chrome-button" type="button" aria-label="New Chat" title="New Chat" onClick={startNewChat} disabled={navigationBusy}>
            <SquarePen aria-hidden="true" size={16} />
          </button>
        </>,
        controlsTarget,
      ) : null) : <header className="popover-header">
        {/* As a Chat in the file manager's panel: a back button and the title, icon buttons at the end. */}
        {historyOpen ? <button type="button" className="popover-capbtn" aria-label="Back to Chat" title="Back" onClick={closeHistory}><ChevronLeft aria-hidden="true" /></button> : null}
        <h1 className="popover-chat-title" title={historyOpen ? undefined : chatTitle}>{historyOpen ? "Chats" : chatTitle}</h1>
        <div className="popover-header-actions">
          {historyOpen ? null : <button className="popover-capbtn" type="button" aria-label="Chats" title="Chats" aria-expanded={historyOpen} aria-controls="agent-chat-history"
            onClick={() => { setHistoryOpen(true); void refreshConversation(); }}>
            <History aria-hidden="true" />
          </button>}
          <button
            className="popover-capbtn popover-new-chat"
            type="button"
            aria-label="New Chat"
            title="New Chat"
            onClick={startNewChat}
            disabled={navigationBusy}
          >
            <SquarePen aria-hidden="true" />
          </button>
        </div>
      </header>}

      {visibleBanner ? (
        <div className="agent-banner" role="alert">
          <span className="agent-banner-text">{visibleBanner}</span>
          <button className="agent-banner-dismiss" type="button" aria-label="Dismiss" onClick={() => setBanner("")}><X aria-hidden="true" size={13} /></button>
        </div>
      ) : null}

      {historyOpen ? (
        <section className="agent-chat-history" id="agent-chat-history" aria-label="Saved AmpleFile Agent chats">
          {host === "panel" ? <div className="agent-history-heading">
            <button type="button" className="agent-back" aria-label="Back to Chat" onClick={closeHistory}><ArrowLeft aria-hidden="true" /></button>
            <h1>Chats</h1>
          </div> : null}
          <label className="agent-chat-search"><Search aria-hidden="true" size={14} /><input ref={searchRef} type="search" aria-label="Search chats" placeholder="Search Chats" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} /></label>
          {historyError ? <p className="error-line" role="alert">{historyError} <button type="button" onClick={() => void refreshConversation()}>Try Again</button></p> : null}
          <div className="agent-chat-list">
            {draftsRef.current.get("new")?.text || draftsRef.current.get("new")?.staged.length ? <div className="agent-chat-card">
              <div className="agent-chat-item">
                <button className="agent-chat-row" type="button" disabled={navigationBusy} onClick={startNewChat}>
                  <span className="agent-chat-glyph" aria-hidden="true"><Chat16Regular /></span>
                  <span className="agent-chat-text"><span>New Chat</span><small>Draft</small></span>
                </button>
              </div>
            </div> : null}
            {chatsByRecency.map(([label, groupedChats]) => <section className="agent-chat-group" key={label} aria-label={label}>
              <h2>{label}</h2>
              <div className="agent-chat-card">
              {groupedChats.map((chat) => {
                const working = chat.requestState === "working" || chat.requestState === "handed_off";
                const status = chat.needsAnswer ? "Needs Your Answer" : working ? "Working" : chat.archivedAt ? "Archived" : chat.snoozedUntil && Date.parse(chat.snoozedUntil) > now ? "Snoozed" : draftsRef.current.get(chat.id)?.text || draftsRef.current.get(chat.id)?.staged.length ? "Draft" : null;
                return (
                <div key={chat.id} className="agent-chat-item">
                <button className="agent-chat-row" type="button" aria-current={chat.id === conversationId ? "page" : undefined} disabled={navigationBusy} onClick={() => selectChat(chat.id)}>
                  <span className="agent-chat-glyph" aria-hidden="true"><Chat16Regular /></span>
                  <span className="agent-chat-text">
                    <span title={chat.title || "Untitled chat"}>{chat.title || "Untitled chat"}</span>
                    <small><time dateTime={chat.updatedAt}>{chatDateLabel(chat.updatedAt)}</time>{status ? <em>{` · ${status}`}</em> : null}</small>
                  </span>
                  {/* The file manager's activity dots: pulsing while it works, green when it needs you. */}
                  {working ? <span className="popover-dot is-run" aria-hidden="true" /> : chat.needsAnswer ? <span className="popover-dot is-done" aria-hidden="true" /> : null}
                </button>
                <button className="agent-chat-options" data-chat-actions={chat.id} type="button" aria-label={`Actions for ${chat.title}`} aria-expanded={chatAction?.id === chat.id} disabled={navigationBusy || working} onClick={() => setChatAction(chatAction?.id === chat.id ? null : { id: chat.id, mode: "menu", title: chat.title })}><MoreHorizontal aria-hidden="true" /></button>
                {chatAction?.id === chat.id ? <div className="agent-chat-actions">
                  {chatAction.mode === "rename" ? <form onSubmit={(event) => { event.preventDefault(); void changeChat("rename"); }}>
                    <input aria-label="Chat Title" autoFocus maxLength={80} value={chatAction.title} disabled={savingChat} onChange={(event) => setChatAction({ ...chatAction, title: event.target.value })} />
                    <button type="submit" className="is-primary" disabled={savingChat || !chatAction.title.trim()}>Save</button>
                    <button type="button" disabled={savingChat} onClick={() => setChatAction(null)}>Cancel</button>
                  </form> : <><button type="button" onClick={() => setChatAction({ ...chatAction, mode: "rename" })}>Rename</button><button type="button" onClick={() => void changeChat("delete")}>Delete</button></>}
                </div> : null}
                </div>
                );
              })}
              </div>
            </section>)}
            {!filteredChats.length ? <p className="agent-history-empty">{historyQuery ? "No chats match your search." : "Your chats will appear here after you send a message."}</p> : null}
          </div>
        </section>
      ) : null}

      {backgroundChats.length ? <button type="button" className="agent-background-work" onClick={() => selectChat(backgroundChats[0].id)} disabled={navigationBusy}><span className="popover-dot is-run" aria-hidden="true" /><span>{backgroundChats.length === 1 ? backgroundChats[0].title : `${backgroundChats.length} chats`} · Working</span><ChevronRight aria-hidden="true" size={14} /></button> : null}

      <div className="popover-chat" hidden={historyOpen}>
      <section className="agent-section agent-section-conversation">
        <section
          className="popover-transcript"
          id="popover-conversation"
          ref={attachTranscript}
          aria-label="AmpleFile Agent chat"
          tabIndex={-1}
          onScroll={(event) => {
            const target = event.currentTarget;
            // A hidden transcript reports no height; keep its place for when it shows.
            if (!target.clientHeight) return;
            const pinned = target.scrollHeight - target.scrollTop - target.clientHeight < 120;
            if (pinned !== transcriptPinnedRef.current) setTranscriptPinned(pinned);
          }}
        >
          {loadingChat ? <p className="agent-chat-loading" role="status">Loading chat…</p> : !messages.length && !streamingAssistant && !request ? <div className="agent-chat-empty"><p>What would you like to work on?</p><span>Pick up a saved chat, or start here.</span></div> : null}
          {messages.map((message) => <SavedPopoverMessage message={message} key={message.id} />)}
          {request?.phase === "working" || liveSteps.length ? (
            <RuntimeContextPreview entries={liveSteps} running={request?.phase === "working"} replyStarted={Boolean(streamingAssistant)} renderText={renderStepText} />
          ) : null}
          {streamingAssistant ? (
            <article className="popover-message assistant streaming" aria-label="amplefile is replying">
              <div className="popover-message-body">
                <PopoverMarkdown text={streamingAssistant} />
              </div>
            </article>
          ) : null}
          {request && request.phase === "handed_off" && !workState.work ? (
            <article className="popover-entry">
              <ul className="trail">
                {request.children.map((child) => (
                  <li key={child.taskId}>
                    {child.state === "running" ? <span className="popover-dot is-run" aria-hidden="true" /> : <Tick state={child.state} />}
                    <span>{child.connectedFolderName}: {childStateLabel(child.state)}</span>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
          {request && !activePhases.has(request.phase) ? (
            <ResultEntry request={request} showState={!workState.work} />
          ) : null}
          {conversationId && extensionSnapshot?.conversationId === conversationId ? <ExtensionQuestions requests={extensionSnapshot.requests} scope={`agent/${conversationId}`} respond={async (question, value, cancelled = false) => {
            const selectedId = conversationId;
            if (!popoverFixtureRequested) await api(`/api/amplefile-agent/conversations/${encodeURIComponent(selectedId)}/extension-ui/${encodeURIComponent(question.id)}`, { method: "POST", body: { value, cancelled } });
            setExtensionSnapshot((current) => current?.conversationId === selectedId ? { ...current, requests: current.requests.filter((item) => item.id !== question.id) } : current);
          }} /> : null}
          <WorkRequest {...workState} showProgress={request?.phase !== "working"} showStop={request?.phase === "needs_you"} />
          {!transcriptPinned ? (
            <button className="agent-jump-latest" type="button" onClick={() => followLatest("smooth")}><ArrowDown aria-hidden="true" size={13} />Latest</button>
          ) : null}
        </section>
          <TurnAnnouncer conversationKey={conversationId} status={request && !loadingChat ? popoverTurnStatus[request.phase] : null} who="The AmpleFile Agent" />
          {request && activePhases.has(request.phase) ? (
            <div className="agent-tail">
              {request.phase === "working" ? (
                // The steps above show what is happening; this line keeps the time.
                elapsedLabel ? <p className="working-line" aria-live="off"><span className="working-elapsed">{elapsedLabel}</span></p> : null
              ) : !workState.work ? (
                <p className="working-line" role="status" aria-live="polite"><span className="popover-dot is-run" aria-hidden="true" /><span className="working-copy">Working in {request.children.filter((child) => child.state === "running").length === 1 ? "a Connected Folder" : "Connected Folders"}…</span></p>
              ) : null}
            </div>
          ) : null}
      </section>

      {staged.length ? (
        // Staged material renders even while a turn hides the composer, so a
        // mid-turn drop is confirmed on screen instead of surfacing later.
        <ul className="chips">
          {staged.map((item) => (
            <li key={item.value} className="chip" title={item.value}>
              <span className="chip-kind" aria-hidden="true">{item.isLink ? <Link2 size={13} /> : <File size={13} />}</span>
              <span className="chip-label">{item.label}</span>
              <button className="chip-remove" aria-label={`Remove ${item.label}`} onClick={() => removeStaged(item.value)}><X size={10} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <section className="agent-composer">
        <div className="composer-field">
          <div className="composer-input">
            {mentionMenuOpen ? (
              <FolderMentionMenu id="popover-mentions" className="popover-mention-menu" folders={mentionSuggestions} activeIndex={activeMentionIndex} onHover={setActiveMentionIndex} onChoose={chooseMentionFolder} />
            ) : null}
            <textarea
              ref={composerRef}
              rows={1}
              aria-label={composerPlaceholder}
              placeholder={composerPlaceholder}
              value={text}
              onChange={(event) => { setText(event.target.value); setComposerCaret(event.target.selectionStart ?? event.target.value.length); }}
              onSelect={(event) => setComposerCaret(event.currentTarget.selectionStart ?? 0)}
              onPaste={onComposerPaste}
              aria-autocomplete="list"
              aria-expanded={mentionMenuOpen}
              aria-controls={mentionMenuOpen ? "popover-mentions" : undefined}
              aria-activedescendant={mentionMenuOpen ? `popover-mentions-${activeMentionIndex}` : undefined}
              onKeyDown={(event) => {
                // An IME composition owns Enter, arrows, and Escape until it commits.
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                const plainKey = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
                if (mentionMenuOpen && plainKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setActiveMentionIndex((current) => (current + step + mentionSuggestions.length) % mentionSuggestions.length);
                  return;
                }
                if (mentionMenuOpen && plainKey && (event.key === "Enter" || event.key === "Tab")) {
                  event.preventDefault();
                  const folder = mentionSuggestions[activeMentionIndex];
                  if (folder) chooseMentionFolder(folder);
                  return;
                }
                if (mentionMenuOpen && event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setDismissedMentionKey(mentionKey);
                  return;
                }
                // Enter sends when idle and steers while the agent works; while
                // only delegated work runs, the composer is a safe draft area
                // and the action stays Stop.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (!requestRunning || canSteer)) {
                  event.preventDefault();
                  void (requestRunning ? steer() : send());
                }
              }}
            />
          </div>
          {/* Send sits inside the field, as in the file manager's message box; it becomes Stop while the agent works. */}
          <button
            className={`composer-action${requestRunning ? " composer-stop" : text.trim() ? " primary is-ready" : " primary"}`}
            type="button"
            onClick={() => { if (requestRunning) void stop(); else void send(); }}
            disabled={requestRunning ? stopping : sending || loadingChat || available === false || !text.trim()}
            aria-label={requestRunning ? (stopping ? "Stopping" : "Stop") : (sending ? "Sending" : "Send Message")}
          >
            {requestRunning ? <Square aria-hidden="true" size={10} /> : <ArrowUp aria-hidden="true" size={14} />}
          </button>
        </div>
        {/* The small row under the field: the model, then its reasoning level as a quiet second word. */}
        <div className="composer-controls">
          <button
            className="composer-model"
            type="button"
            onClick={() => { if (host === "panel") onOpenModelSettings?.(); else void bridge?.ampleFileAgent?.openAiModelsSettings(); }}
            title="Change the AmpleFile Agent's model in AI Models"
            aria-label={`Change the model used by the AmpleFile Agent. Current model: ${ampleFileAgentModelLabel}`}
          >
            <span>{ampleFileAgentModelLabel}</span>
          </button>
          {thinkingLevels.length >= 2 && composerThinking ? (
            <span className="composer-thinking-control">
              <select
                className="composer-thinking"
                value={composerThinking.thinkingLevel}
                disabled={requestRunning}
                onChange={(event) => { void changeThinkingLevel(event.target.value); }}
                aria-label={`Reasoning level for this AmpleFile Agent chat: ${composerThinking.thinkingLevel}`}
              >
                {thinkingLevels.map((level) => <option key={level} value={level}>{formatThinkingLevel(level)}</option>)}
              </select>
              <ChevronDown aria-hidden="true" size={12} />
            </span>
          ) : null}
        </div>
      </section>
      </div>
      {dropActive ? (
        <div className="drop-overlay" role="status" aria-live="polite">
          <File aria-hidden="true" />
          <strong>Drop to Add</strong>
          <span>Files, folders, or links</span>
        </div>
      ) : null}
    </div>
  );
}

const popoverRemarkPlugins = [remarkGfm];
const popoverRehypePlugins = [rehypeSingleLineBreaks];
// A link opens in the default browser when it is safe and is plain text
// otherwise: a relative link such as notes.md would replace the popover.
const popoverMarkdownComponents: Components = {
  a: ({ href, children }) => <SafeMarkdownAnchor href={href}>{children}</SafeMarkdownAnchor>,
};

/** Replies and progress notes; memoised so unchanged text is not re-parsed. */
const PopoverMarkdown = memo(function PopoverMarkdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={popoverRemarkPlugins} rehypePlugins={popoverRehypePlugins} components={popoverMarkdownComponents}>{text}</ReactMarkdown>;
});

/**
 * One saved message. Memoised: a streamed frame or a keystroke in the
 * composer re-renders the popover, but never re-parses a saved reply.
 */
const SavedPopoverMessage = memo(function SavedPopoverMessage({ message }: { message: AmpleFileAgentMessage }) {
  const steps = useMemo(() => message.role === "assistant" && message.kind !== "assistant_continuation" ? savedWorkTrailPreviews(message as ChatMessage) : null, [message]);
  return (
    <article
      className={message.kind === "assistant_continuation" || message.kind === "context_compaction" ? "work-continuation" : `popover-message ${message.role}`}
      title={timestampTitle(message.createdAt)}
    >
      {steps ? <RuntimeContextPreview entries={steps} renderText={renderStepText} /> : null}
      <div className="popover-message-body">
        {message.kind === "assistant_continuation" ? "Continuing with the results from delegated work." : message.role === "assistant"
          ? <PopoverMarkdown text={message.content} />
          : message.content}
      </div>
    </article>
  );
});

/** Progress notes inside the steps render with the same Markdown as replies. */
function renderStepText(text: string) {
  return <PopoverMarkdown text={text} />;
}

/** Today's and yesterday's chats show their time, since the group already names the day; older ones their date. */
function chatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const dayStart = (when: Date) => new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
  const daysAgo = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (daysAgo === 0 || daysAgo === 1) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/**
 * The settled request's inline conversation entry: its host-recorded outcome,
 * told inside the one narrator.
 */
function ResultEntry({ request, showState = true }: { request: AmpleFileAgentRequestView; showState?: boolean }) {
  const showOutcome = request.phase === "failed"
    || request.phase === "stopped"
    || request.dispositions.length > 0
    || request.actions.some((action) => action.command !== "files.add");
  if (!showOutcome) return null;
  return (
    <article className="popover-entry">
      {showState && request.phase === "failed" ? (
        <p className="error-line">Couldn't finish{request.error ? `: ${request.error}` : "."}</p>
      ) : null}
      {showState && request.phase === "stopped" ? <p>Stopped before it finished.</p> : null}
      <DispositionTrail request={showState ? request : { ...request, actions: request.actions.filter((action) => action.command !== "chat.send") }} />
    </article>
  );
}

/**
 * Host-recorded trail: dispositions come from explicitly attributed act-lane
 * actions, not the agent's prose. An attachment with no recorded action is shown
 * as exactly that — nothing silently disappears from the story.
 */
function DispositionTrail({ request }: { request: AmpleFileAgentRequestView }) {
  const extraActions = request.actions.filter((action) =>
    action.command === "connected-folders.create" || action.command === "connected-folders.register" || action.command === "chat.send");
  if (!request.dispositions.length && !extraActions.length) return null;
  return (
    <ul className="trail">
      {request.dispositions.map((disposition) => (
        <li key={`${disposition.attachment.kind}:${disposition.attachment.target}`}>
          {disposition.status === "unrecorded" ? <span className="dot" aria-hidden="true" /> : <Tick state="succeeded" />}
          <span>
            {disposition.status === "placed"
              ? <>Copied {disposition.attachment.name} to {disposition.connectedFolderName}{disposition.checkpointId ? <span className="muted small"> · restore point {shortId(disposition.checkpointId)}</span> : null}</>
              : disposition.status === "registered"
                ? <>Registered {disposition.attachment.name} as the folder {disposition.connectedFolderName}</>
                : <>{disposition.attachment.name}: no recorded placement — see the reply below</>}
          </span>
        </li>
      ))}
      {extraActions.map((action, index) => {
        const child = action.command === "chat.send"
          ? request.children.find((candidate) => candidate.taskId === action.taskId)
          : undefined;
        const state = child?.state ?? "succeeded";
        return (
          <li key={`${action.command}:${action.taskId ?? action.rootPath ?? index}`}>
            {state === "running" ? <span className="popover-dot is-run" aria-hidden="true" /> : <Tick state={state} />}
            <span>
              {action.command === "chat.send"
                ? <>Work in {action.connectedFolderName}: {childStateLabel(state)}</>
                : action.command === "connected-folders.create"
                  ? <>Created the folder {action.connectedFolderName}</>
                  : <>Registered the folder {action.connectedFolderName}</>}
              {child?.error ? <span className="muted small"> · {child.error}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Tick({ state }: { state: "running" | "succeeded" | "failed" | "aborted" | "unknown" }) {
  if (state === "succeeded") return <span className="tick" aria-hidden="true">✓</span>;
  if (state === "failed") return <span className="cross" aria-hidden="true">✕</span>;
  return <span className="dot" aria-hidden="true" />;
}

function childStateLabel(state: "running" | "succeeded" | "failed" | "aborted" | "unknown"): string {
  switch (state) {
    case "running": return "still working";
    case "succeeded": return "finished";
    case "failed": return "failed";
    case "aborted": return "stopped";
    default: return "state unknown";
  }
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function timestampTitle(value: string): string | undefined {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : undefined;
}

function sameTranscript(current: AmpleFileAgentMessage[], next: AmpleFileAgentMessage[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((message, index) => {
    const candidate = next[index];
    return candidate !== undefined && message.id === candidate.id && message.content === candidate.content;
  });
}

function formatThinkingLevel(level: string): string {
  return level ? `${level[0]?.toLocaleUpperCase() ?? ""}${level.slice(1)}` : "Reasoning";
}

function looksLikeLink(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function addStagedValue(value: string, setStaged: React.Dispatch<React.SetStateAction<StagedItem[]>>): void {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4_096) return;
  const isLink = looksLikeLink(trimmed);
  const label = isLink
    ? trimmed.replace(/^https?:\/\//i, "").slice(0, 60)
    : trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed;
  setStaged((current) => {
    if (current.some((item) => item.value === trimmed)) return current;
    if (current.length >= 1_000) return current;
    return [...current, { value: trimmed, label, isLink }];
  });
}
