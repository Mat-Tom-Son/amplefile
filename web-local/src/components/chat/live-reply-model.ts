import type { AssistantPresentation } from "../../../../src/shared/chat-presentation";
import type { ChatStreamEvent, RuntimePreviewEntry } from "../../types";

/**
 * A turn's live reply: what a Worker or the AmpleFile Agent has written,
 * thought, and done so far, built from the Chat's stream events. Both Chat
 * surfaces (the file manager's panel Chat and the menu-bar popover) read it
 * through `useLiveReply`; each keeps its own presentation, turn bookkeeping,
 * and side effects. Pure, so the rules are tested without a window.
 */
export interface LiveReply {
  /** The reply text on screen. */
  text: string;
  /** Streamed text waiting for the next `flush`, which appends it to `text`. */
  pendingText: string;
  /** Where the latest streamed text sits among the steps; cleared by authoritative text. */
  pendingOrder?: number;
  /** The last authoritative text, from a whole message or a snapshot, and its segments. */
  canonical: { text: string; metadata?: AssistantPresentation };
  /** Thinking and tool steps, in arrival order. */
  steps: RuntimePreviewEntry[];
  /** A snapshot said it left out earlier activity. */
  truncated: boolean;
  /** The thinking step that thinking text without its own id goes to. */
  activeThinkingId: string | null;
  /** How many steps arrived without an id; numbers the ids made for them. */
  unnamedSteps: number;
}

export type LiveReplyAction =
  /** One stream event, seen at `now` (epoch milliseconds). */
  | { type: "event"; event: ChatStreamEvent; now: number }
  /** Shows the streamed text that is waiting. */
  | { type: "flush" }
  /** Clears the reply text and the steps. */
  | { type: "clear" }
  /** Clears the reply text; the steps stay. */
  | { type: "clearText" }
  /** Clears the steps and what places text among them; the reply text stays. */
  | { type: "clearSteps" }
  /** Puts a known reply and steps on screen, as a sample Chat does. */
  | { type: "show"; text?: string; steps?: RuntimePreviewEntry[] };

export const emptyLiveReply: LiveReply = {
  text: "",
  pendingText: "",
  canonical: { text: "" },
  steps: [],
  truncated: false,
  activeThinkingId: null,
  unnamedSteps: 0,
};

/** The next live reply. Returns `reply` itself when nothing changes. */
export function liveReplyReducer(reply: LiveReply, action: LiveReplyAction): LiveReply {
  switch (action.type) {
    case "flush":
      return reply.pendingText ? { ...reply, text: `${reply.text}${reply.pendingText}`, pendingText: "" } : reply;
    case "clear":
      return { ...emptyLiveReply, unnamedSteps: reply.unnamedSteps };
    case "clearText":
      return reply.text || reply.pendingText ? { ...reply, text: "", pendingText: "" } : reply;
    case "clearSteps":
      return { ...reply, steps: [], activeThinkingId: null, canonical: { text: "" }, pendingOrder: undefined, truncated: false };
    case "show":
      return {
        ...reply,
        ...(action.text !== undefined ? { text: action.text, pendingText: "" } : {}),
        ...(action.steps !== undefined ? { steps: action.steps } : {}),
      };
    case "event":
      return applyEvent(reply, action.event, action.now);
  }
}

function applyEvent(reply: LiveReply, event: ChatStreamEvent, now: number): LiveReply {
  switch (event.type) {
    case "tool":
      return applyTool(reply, event);
    case "assistant_thinking": {
      let next = reply;
      if (event.thinkingPhase === "start") next = startThinking(next, event, now);
      if (event.text) next = appendThinking(next, event.text, event, now);
      if (event.thinkingPhase === "end") next = finishThinking(next, event, now);
      return next;
    }
    case "assistant_delta":
      return event.text ? { ...reply, pendingText: `${reply.pendingText}${event.text}`, pendingOrder: event.order } : reply;
    case "assistant_message":
      return typeof event.text === "string" ? authoritativeText(reply, event.text, event.assistantPresentation) : reply;
    case "turn_state":
    case "turn_snapshot":
      if (event.running === false) return endReply(reply, now);
      if (event.type === "turn_snapshot" && event.running === true && typeof event.text === "string") return applySnapshot(reply, event);
      return reply;
    case "done":
    case "error":
      return endReply(reply, now);
    default:
      return reply;
  }
}

/** A tool step appears once and each later event for it updates that row. */
function applyTool(reply: LiveReply, event: ChatStreamEvent): LiveReply {
  const toolCallId = event.toolCallId?.trim();
  let unnamedSteps = reply.unnamedSteps;
  const id = event.workTrailId ?? (toolCallId ? `tool-${toolCallId}` : `tool-${++unnamedSteps}`);
  const step: RuntimePreviewEntry = {
    id,
    kind: "tool",
    text: event.message?.trim() || event.toolName?.trim() || "Tool",
    ...(event.detail?.trim() ? { detail: event.detail.trim() } : {}),
    ...(event.toolName?.trim() ? { toolName: event.toolName.trim() } : {}),
    ...(event.toolTitle?.trim() ? { toolTitle: event.toolTitle.trim() } : {}),
    ...(event.order !== undefined ? { order: event.order } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.edit ? { edit: event.edit } : {}),
    phase: event.phase ?? "running",
  };
  return { ...reply, steps: upsertStep(reply.steps, step), unnamedSteps };
}

function upsertStep(steps: RuntimePreviewEntry[], step: RuntimePreviewEntry): RuntimePreviewEntry[] {
  const index = steps.findIndex((item) => item.id === step.id);
  if (index < 0) return [...steps, step];
  const next = [...steps];
  next[index] = { ...next[index], ...step };
  return next;
}

function startThinking(reply: LiveReply, event: ChatStreamEvent, now: number): LiveReply {
  let unnamedSteps = reply.unnamedSteps;
  const id = event.workTrailId ?? `thinking-${++unnamedSteps}`;
  const step: RuntimePreviewEntry = {
    id,
    kind: "thinking",
    text: "",
    phase: "streaming",
    startedAt: event.startedAt ?? now,
    ...(event.order !== undefined ? { order: event.order } : {}),
  };
  return { ...reply, steps: upsertStep(reply.steps, step), activeThinkingId: id, unnamedSteps };
}

/** Thinking text without a start begins its own step. */
function appendThinking(reply: LiveReply, text: string, event: ChatStreamEvent, now: number): LiveReply {
  let next = reply;
  let id = event.workTrailId ?? next.activeThinkingId;
  if (!id) {
    next = startThinking(next, event, now);
    id = next.activeThinkingId;
  }
  return {
    ...next,
    steps: next.steps.map((entry) => entry.id === id ? { ...entry, text: `${entry.text}${text}`, phase: "streaming" } : entry),
  };
}

/** Marks a thinking step complete with the event's duration, else the time since it started. */
function finishThinking(reply: LiveReply, event: ChatStreamEvent | undefined, now: number): LiveReply {
  const id = event?.workTrailId ?? reply.activeThinkingId;
  if (!id) return reply;
  return {
    ...reply,
    activeThinkingId: null,
    steps: reply.steps.map((entry) => entry.id === id
      ? {
        ...entry,
        phase: "complete",
        ...(event?.durationMs !== undefined
          ? { durationMs: event.durationMs }
          : entry.startedAt ? { durationMs: Math.max(0, now - entry.startedAt) } : {}),
      }
      : entry),
  };
}

/** The turn ended: show the streamed text that is waiting and close the open thinking step. */
function endReply(reply: LiveReply, now: number): LiveReply {
  return finishThinking(liveReplyReducer(reply, { type: "flush" }), undefined, now);
}

function authoritativeText(reply: LiveReply, text: string, metadata: AssistantPresentation | undefined): LiveReply {
  return { ...reply, text, pendingText: "", canonical: { text, metadata }, pendingOrder: undefined };
}

/**
 * A snapshot replaces the reply at its cursor, so replaying one never repeats
 * a step or restarts a thinking timer.
 */
function applySnapshot(reply: LiveReply, event: ChatStreamEvent): LiveReply {
  const snapshot = event.presentation;
  const text = snapshot?.text ?? event.text ?? "";
  const next = { ...authoritativeText(reply, text, snapshot?.assistantPresentation), truncated: snapshot?.truncated === true };
  if (!snapshot) return next;
  return {
    ...next,
    steps: snapshot.workTrail,
    activeThinkingId: [...snapshot.workTrail].reverse()
      .find((entry) => entry.kind === "thinking" && ["running", "streaming"].includes(entry.phase ?? ""))?.id ?? null,
  };
}
