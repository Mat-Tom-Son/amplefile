import { useEffect, useRef, useState, type CSSProperties } from "react";

const visuallyHidden: CSSProperties = { position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 };

/**
 * A polite live region for a Chat transcript. It speaks only when a turn
 * starts and when it ends, never per streamed frame or timer tick, so a
 * screen reader hears that the reply is ready and can read it in place.
 */
export function TurnAnnouncer({ running, who }: { running: boolean; /** "The Worker", "The AmpleFile Agent". */ who: string }) {
  const [text, setText] = useState("");
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running === wasRunning.current) return;
    wasRunning.current = running;
    setText(running ? `${who} is working.` : `${who} replied.`);
  }, [running, who]);
  return <div className="turn-announcer" role="status" aria-live="polite" aria-atomic="true" style={visuallyHidden}>{text}</div>;
}
