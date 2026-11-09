import { useState } from "react";
import { errorText } from "../../lib/api";

/** An explicit fallback; the normal browser callback needs no popup or paste. */
export function OAuthCallbackFallback({ active, onError }: { active: boolean; onError(message: string): void }) {
  const [busy, setBusy] = useState(false);
  const oauth = window.ampleFileDesktop?.oauth;
  if (!active || !oauth) return null;
  return <p className="connect-ai-hint">Waiting for your browser. <button className="ui-control" type="button" disabled={busy} onClick={() => {
    setBusy(true);
    void oauth.pasteCallback().catch(error => onError(errorText(error))).finally(() => setBusy(false));
  }}>Paste Callback URL…</button></p>;
}
