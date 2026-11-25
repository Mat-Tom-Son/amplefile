import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatStreamEvent, RuntimePreviewEntry } from "../../types";
import { emptyLiveReply, liveReplyReducer, type LiveReply, type LiveReplyAction } from "./live-reply-model";

export interface LiveReplyHandle {
  /** The reply as it is on screen. */
  reply: LiveReply;
  /** Applies one stream event. Streamed text shows on the next animation frame, so a burst renders once. */
  apply: (event: ChatStreamEvent) => void;
  clear: () => void;
  clearText: () => void;
  clearSteps: () => void;
  show: (next: { text?: string; steps?: RuntimePreviewEntry[] }) => void;
}

/** A Chat surface's live reply (live-reply-model.ts), with streamed text batched to animation frames. */
export function useLiveReply(): LiveReplyHandle {
  const [reply, setReply] = useState<LiveReply>(emptyLiveReply);
  const replyRef = useRef<LiveReply>(emptyLiveReply);
  const frameRef = useRef<number | null>(null);

  const actions = useMemo(() => {
    const dispatch = (action: LiveReplyAction) => {
      const next = liveReplyReducer(replyRef.current, action);
      if (next === replyRef.current) return;
      replyRef.current = next;
      if (action.type === "event" && action.event.type === "assistant_delta") {
        if (frameRef.current === null) {
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = null;
            dispatch({ type: "flush" });
          });
        }
        return;
      }
      setReply(next);
    };
    return {
      apply: (event: ChatStreamEvent) => dispatch({ type: "event", event, now: Date.now() }),
      clear: () => dispatch({ type: "clear" }),
      clearText: () => dispatch({ type: "clearText" }),
      clearSteps: () => dispatch({ type: "clearSteps" }),
      show: (next: { text?: string; steps?: RuntimePreviewEntry[] }) => dispatch({ type: "show", ...next }),
    };
  }, []);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  return useMemo(() => ({ reply, ...actions }), [reply, actions]);
}
