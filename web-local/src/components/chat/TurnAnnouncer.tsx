import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { ChatMessage } from "../../types";
import type { WorkRequestState } from "../../../../src/shared/request-presentation";

const visuallyHidden: CSSProperties = { position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 };

/** Where a Chat's turn stands, as a screen reader hears it. */
export type TurnStatus = "working" | "replied" | "partial" | "question" | "handed_off" | "failed" | "stopped";

export function turnAnnouncement(status: TurnStatus, who: string): string {
  switch (status) {
    case "working": return `${who} is working.`;
    case "replied": return `${who} replied.`;
    case "partial": return `${who} finished part of the work.`;
    case "question": return `${who} has a question for you.`;
    case "handed_off": return `${who} handed work to Connected Folders and is waiting on it.`;
    case "failed": return `${who} could not finish.`;
    case "stopped": return `${who} stopped.`;
  }
}

/**
 * A Worker Chat's turn status: the durable request's state when it is known,
 * otherwise the last reply (an interrupted one did not simply reply).
 */
export function chatTurnStatus(busy: boolean, workState: WorkRequestState | null | undefined, lastMessage: ChatMessage | undefined): TurnStatus {
  if (busy) return "working";
  switch (workState) {
    case "working": return "working";
    case "waiting": return "question";
    case "handed_off": return "handed_off";
    case "partial": return "partial";
    case "failed": return "failed";
    case "stopped": case "expired": return "stopped";
    case "done": return "replied";
    default: break;
  }
  const interruption = lastMessage?.role === "assistant" ? lastMessage.interruption : undefined;
  if (interruption) return interruption.reason === "cancelled" ? "stopped" : "failed";
  return "replied";
}

/**
 * A polite live region for a Chat transcript. It speaks only when the turn's
 * status changes within one conversation, never per streamed frame or timer
 * tick, and says how the turn ended. What a conversation shows when it opens
 * is not news: after a key change the first known status is a silent
 * baseline (callers pass null while they are still loading), and an ending
 * is spoken only when it follows work (working or handed off).
 */
export function TurnAnnouncer({ conversationKey, status, who }: {
  /** The conversation shown; a change resets without speaking. */
  conversationKey: string | null;
  /** Null while unknown (loading, or no turn yet). */
  status: TurnStatus | null;
  /** "The Worker", "The AmpleFile Agent". */
  who: string;
}) {
  const [text, setText] = useState("");
  const seen = useRef<{ conversationKey: string | null; status: TurnStatus | null }>({ conversationKey, status: null });
  useEffect(() => {
    const previous = seen.current;
    if (previous.conversationKey !== conversationKey) {
      seen.current = { conversationKey, status };
      setText("");
      return;
    }
    if (status === null || status === previous.status) return;
    seen.current = { conversationKey, status };
    if (previous.status === null) return;
    if (status !== "working" && previous.status !== "working" && previous.status !== "handed_off") return;
    setText(turnAnnouncement(status, who));
  }, [conversationKey, status, who]);
  return <div className="turn-announcer" role="status" aria-live="polite" aria-atomic="true" style={visuallyHidden}>{text}</div>;
}
