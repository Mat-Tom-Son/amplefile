import { useEffect, useRef, useState } from "react";
import type { IncludedMcpServer, IncludedMcpOAuthJob, IncludedMcpProbe, IncludedMcpLastCheck } from "../../../../src/local/agent/included-mcp-setup";
import { api, errorText } from "../../lib/api";

/**
 * A connection's status on its row. Its last check, which the host keeps with
 * the connection until its definition or sign-in changes, says what it
 * established (connected, and whether a sign-in was used or is needed);
 * otherwise the row says what is configured and saved. A sign-in is never
 * called required until a check found the service refusing without one.
 */
export function serviceConnectionStatus(server: IncludedMcpServer, check: Pick<IncludedMcpLastCheck, "state" | "signIn"> | null = server.lastCheck ?? null): string {
  if (server.disabled) return "Turned Off";
  if (server.auth === "provider") return "Uses AI Models Connection";
  if (server.inherited) return "Uses Everywhere Connection";
  const connected = check?.state === "ready" || check?.state === "empty";
  if (server.auth === "none") return connected ? "Connected · No Sign-In Required" : "No Sign-In Required";
  if (check?.signIn === "required") return "Needs Sign-In";
  if (connected) return check.signIn === "saved" ? "Connected · Signed In" : check.signIn === "not_needed" ? "Connected · No Sign-In Needed" : "Connected";
  if (server.credential === "present") return "Signed In";
  if (server.credential === "not_checked") return "Sign-In Unknown Until Checked";
  if (server.credential === "unavailable") return "Secure Storage Unavailable";
  return server.auth === "automatic" ? "No Saved Sign-In" : "Not Signed In";
}

export function IncludedMcpSetup({ connectedFolderId, enabled }: { connectedFolderId: string; enabled: boolean }) {
  const [opened, setOpened] = useState(false);
  const [servers, setServers] = useState<IncludedMcpServer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [transport, setTransport] = useState<"url" | "command">("url");
  const [endpoint, setEndpoint] = useState("");
  const [args, setArgs] = useState("[]");
  const [extra, setExtra] = useState("{}");
  const [tokenFor, setTokenFor] = useState<IncludedMcpServer | null>(null);
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState<{ state: string; detail: string; name?: string } | null>(null);
  const [job, setJob] = useState<IncludedMcpOAuthJob | null>(null);
  const session = useRef<string | null>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    alive.current = true; setOpened(false);
    let ownedId: string | null = null;
    let cancelled = false;
    void api<{ sessionId: string; servers: IncludedMcpServer[] }>("/api/agent/mcp-setup", { method: "POST", body: { connectedFolderId, operation: "open" } }).then((result) => {
      ownedId = result.sessionId;
      if (cancelled) { void close(ownedId); return; }
      session.current = ownedId; setServers(result.servers); setOpened(true);
    }).catch((caught) => { if (!cancelled) setError(errorText(caught)); });
    const close = (sessionId: string) => api("/api/agent/mcp-setup", { method: "POST", body: { connectedFolderId, sessionId, operation: "close" } }).catch(() => undefined);
    return () => { cancelled = true; alive.current = false; session.current = null; if (ownedId) void close(ownedId); };
  }, [connectedFolderId]);

  async function operation(action: string, fields: Record<string, unknown> = {}) {
    if (!session.current) throw new Error("Wait for connection setup to open, then try again.");
    return api<{ servers?: IncludedMcpServer[]; job?: IncludedMcpOAuthJob; probe?: IncludedMcpProbe; lastCheck?: IncludedMcpLastCheck | null }>("/api/agent/mcp-setup", { method: "POST", body: { ...fields, connectedFolderId, sessionId: session.current, operation: action } });
  }
  async function act(action: string, fields: Record<string, unknown> = {}) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const result = await operation(action, fields);
      if (!alive.current) return;
      if (result.servers) setServers(result.servers);
      if (result.job) setJob(result.job);
      setProbe(result.probe ? { ...result.probe, ...(typeof fields.name === "string" ? { name: fields.name } : {}) } : null);
      // A check's answer carries what the host now keeps for that connection; its row shows it.
      if (action === "check" && result.probe) {
        const checked = result.lastCheck ?? null;
        setServers((current) => current.map((row) => row.scope !== fields.scope || row.name !== fields.name ? row
          : checked ? { ...row, lastCheck: checked } : (({ lastCheck: _dropped, ...rest }) => rest)(row)));
      }
      if (action === "save") { setAdding(false); setName(""); setEndpoint(""); setExtra("{}"); }
      if (action === "bearer") { setTokenFor(null); setToken(""); }
      if (action === "oauth-cancel") setJob(null);
    } catch (caught) { if (alive.current) setError(errorText(caught)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    if (job?.state !== "running") return;
    const timer = window.setTimeout(() => {
      void operation("oauth-status", { jobId: job.id }).then(async ({ job: next }) => {
        if (!alive.current || !next) return;
        setJob(next);
        if (next.state === "connected") await act("list");
      }).catch((caught) => { if (alive.current) { setError(errorText(caught)); setJob(null); } });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [job]);
  const selection = (server: IncludedMcpServer) => ({ scope: server.scope, name: server.name, expectedRevision: server.revision });
  function save() {
    try {
      const additional = JSON.parse(extra);
      if (!additional || typeof additional !== "object" || Array.isArray(additional)) throw new Error("Advanced settings must be a JSON object.");
      void act("save", { name, scope, definition: { ...additional, [transport]: endpoint, ...(transport === "command" ? { args: JSON.parse(args) } : {}) } });
    } catch (caught) { setError(errorText(caught)); }
  }
  return <div className="included-mcp-setup">
    <div className="included-tool-actions"><button type="button" className="ui-control ui-control--primary" disabled={!enabled || busy || !opened} onClick={() => setAdding(true)}>Add Connection</button><button type="button" className="ui-control" disabled={busy || !opened} onClick={() => void act("list")}>Refresh</button></div>
    {error ? <p className="included-tool-error" role="alert">{error}</p> : null}
    {probe ? <p role="status">{probe.name ? `${probe.name}: ` : ""}{probe.state === "ready" ? "Connected" : probe.detail}</p> : null}
    {job ? <div className="included-mcp-auth" role="status"><p>{job.state === "running" ? "Complete sign-in in your browser." : job.state === "connected" ? "Signed in." : job.message ?? `Sign-in ${job.state}.`}</p>{job.state === "running" ? <button type="button" className="ui-control" onClick={() => void act("oauth-cancel", { jobId: job.id })}>Cancel Sign-In</button> : null}</div> : null}
    {!opened && !error ? <p role="status">Loading connections…</p> : opened && !servers.length && !adding ? <p>No Connections</p> : null}
    {opened && servers.length ? <p>Connections are checked when used. Check a connection below to verify it now.</p> : null}
    <ul className="included-mcp-list">{servers.map((server) => { const check = server.lastCheck ?? null; return <li key={`${server.scope}:${server.name}`}><div><strong>{server.name}</strong><small>{server.scope === "global" ? "Everywhere" : "This Connected Folder only"} · {serviceConnectionStatus(server, check)}</small></div><div className="included-tool-actions">
      <button type="button" className="ui-control" disabled={busy || !enabled || server.disabled} onClick={() => void act("check", selection(server))}>Check</button>
      <button type="button" className="ui-control" disabled={busy || !enabled} onClick={() => void act("enabled", { ...selection(server), enabled: server.disabled })}>{server.disabled ? "Turn On" : "Turn Off"}</button>
      {server.transport === "http" && server.auth !== "none" && server.auth !== "provider" && !server.inherited && check?.signIn !== "not_needed" ? <><button type="button" className="ui-control" disabled={busy || !enabled || server.disabled || job?.state === "running"} onClick={() => void act("oauth", selection(server))}>Sign In</button></> : null}
      </div><details className="included-tool-optional"><summary>Connection Settings</summary><code>{server.endpoint}</code><small>Tool Access: {server.exposure}</small><div className="included-tool-actions">{server.transport === "http" && server.auth !== "provider" && !server.inherited ? <><button type="button" className="ui-control" disabled={busy || !enabled} onClick={() => { setTokenFor(server); setToken(""); }}>Use Token</button><button type="button" className="ui-control" disabled={busy} onClick={() => void act("disconnect", selection(server))}>Disconnect</button></> : null}
      <button type="button" className="ui-control" disabled={busy} onClick={() => void act("remove", selection(server))}>Remove</button>
    </div></details></li>; })}</ul>
    {tokenFor ? <form className="included-mcp-form" onSubmit={(event) => { event.preventDefault(); void act("bearer", { ...selection(tokenFor), token }); }}><label>Token for {tokenFor.name}<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label><div className="included-tool-actions"><button type="submit" className="ui-control ui-control--primary" disabled={busy || !token.trim()}>Connect</button><button type="button" className="ui-control" onClick={() => { setTokenFor(null); setToken(""); }}>Cancel</button></div></form> : null}
    {adding ? <form className="included-mcp-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <h3>Add Connection</h3><label>Name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="my-service" /></label>
      <label>Availability<select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}><option value="global">Everywhere</option><option value="project">This Connected Folder only</option></select></label>
      <label>Connection<select value={transport} onChange={(event) => setTransport(event.target.value as "url" | "command")}><option value="url">Service URL</option><option value="command">Local Server Command</option></select></label>
      <label>{transport === "url" ? "MCP Service URL" : "Executable"}<input required type={transport === "url" ? "url" : "text"} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={transport === "url" ? "https://example.com/mcp" : "/path/to/server"} /></label>
      {transport === "command" ? <><p>Install the command and its runtime first.</p><label>Arguments (JSON Array)<input value={args} onChange={(event) => setArgs(event.target.value)} /></label></> : null}
      <details><summary>Advanced Settings</summary><p>Native Pi MCP options include exposure: codemode, deferred, direct, or hidden; toolExposure sets individual tools.</p><textarea aria-label="Advanced MCP Settings" value={extra} onChange={(event) => setExtra(event.target.value)} rows={5} spellCheck={false} /></details>
      <div className="included-tool-actions"><button type="submit" className="ui-control ui-control--primary" disabled={busy}>Add Connection</button><button type="button" className="ui-control" disabled={busy} onClick={() => setAdding(false)}>Cancel</button></div>
    </form> : null}
  </div>;
}
