import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "../chrome/icons";

import { api, errorText } from "../../lib/api";

/**
 * Shown while a provider sign-in waits on the browser, in the place that
 * started it: Cancel, and Paste Link for the rare browser that cannot hand the
 * sign-in back to this Mac. Paste Link appears only while the sign-in would take
 * a link (a device-code sign-in finishes in the browser alone). Nothing here
 * opens a dialog.
 */
export function ProviderSignInWaiting({ providerName, fixtureMode = false, onCancelRequested }: {
  providerName: string;
  fixtureMode?: boolean;
  /** Called before the cancel request, so the caller can treat the sign-in's ending as no error. */
  onCancelRequested: () => void;
}) {
  const [acceptsPaste, setAcceptsPaste] = useState(fixtureMode);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [link, setLink] = useState("");
  const [state, setState] = useState<"waiting" | "pasting" | "finishing" | "cancelling">("waiting");
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fixtureMode) return;
    const controller = new AbortController();
    const read = () => api<{ acceptsPaste: boolean }>("/api/agent/oauth/pending", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setAcceptsPaste(result.acceptsPaste); })
      .catch(() => undefined);
    void read();
    const timer = window.setInterval(() => void read(), 1000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [fixtureMode]);

  useEffect(() => { if (pasteOpen) field.current?.focus(); }, [pasteOpen]);

  async function cancel() {
    setState("cancelling");
    setError(null);
    onCancelRequested();
    if (fixtureMode) return;
    try { await api("/api/agent/oauth/cancel", { method: "POST", body: {} }); }
    catch (caught) { setState("waiting"); setError(errorText(caught)); }
  }

  async function paste(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!link.trim() || state !== "waiting") return;
    setState("pasting");
    setError(null);
    try {
      if (!fixtureMode) await api("/api/agent/oauth/paste", { method: "POST", body: { value: link.trim() } });
      setState("finishing");
      setPasteOpen(false);
      setLink("");
    } catch (caught) {
      setState("waiting");
      setError(errorText(caught));
    }
  }

  const busy = state !== "waiting";
  const text = state === "cancelling" ? "Cancelling…" : state === "finishing" ? "Finishing sign-in…" : `Finish signing in to ${providerName} in your browser`;
  return <div className="provider-sign-in">
    <div className="provider-sign-in-row">
      <Loader2 className="spin" size={14} aria-hidden="true" />
      <span className="provider-sign-in-text" role="status">{text}</span>
      {acceptsPaste && !pasteOpen && state === "waiting" ? <button type="button" className="ui-control" onClick={() => setPasteOpen(true)}>Paste Link</button> : null}
      {state !== "cancelling" ? <button type="button" className="ui-control" disabled={state === "pasting"} onClick={() => void cancel()}>Cancel</button> : null}
    </div>
    {pasteOpen ? <form className="provider-sign-in-paste" onSubmit={(event) => void paste(event)}>
      <p className="connect-ai-hint">If your browser didn’t come back here by itself, copy the link from its address bar and paste it here.</p>
      <div className="provider-sign-in-paste-row">
        <input ref={field} type="text" value={link} aria-label="Link from your browser" placeholder="Paste the link from your browser" autoComplete="off" spellCheck={false}
          disabled={busy} onChange={(event) => { setLink(event.target.value); setError(null); }} />
        <button type="submit" className="ui-control ui-control--primary" disabled={busy || !link.trim()}>{state === "pasting" ? "Checking…" : "Continue"}</button>
      </div>
    </form> : null}
    {error ? <p className="connect-ai-error" role="alert">{error}</p> : null}
  </div>;
}
