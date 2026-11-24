import { useEffect, useState, type ReactNode } from "react";
import { Open16Regular } from "@fluentui/react-icons";
import type { ProviderAccountDetails as AccountDetails, ProviderUsageWindow } from "../../../../src/shared/provider-account";
import { api } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";

/** Account metadata stays in Settings and is never part of the model catalog or a Chat. */
export function ProviderAccountDetails({ provider, scope, connectedFolderId, revision, active, fixtureMode, onSelectCodex, onReconnect, busy = false, actions }: {
  provider: string; scope: "connected-folder" | "agent"; connectedFolderId?: string; revision: unknown; active: boolean; fixtureMode: boolean;
  onSelectCodex?: () => void; onReconnect?: () => void; busy?: boolean; actions?: ReactNode;
}) {
  const [account, setAccount] = useState<AccountDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || fixtureMode || provider !== "openai-codex") return;
    const refresh = () => { if (!document.hidden) setAttempt(value => value + 1); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [active, fixtureMode, provider]);
  useEffect(() => {
    if (!active || fixtureMode) return;
    // Credential changes must refresh identity even while the parent keeps
    // unsaved instruction drafts instead of applying new settings.
    return subscribeControlEvents(hint => {
      if (hint === "models" || hint === "reset") setAttempt(value => value + 1);
    });
  }, [active, fixtureMode]);
  useEffect(() => {
    const controller = new AbortController();
    setAccount(null);
    setError(null);
    if (!active || fixtureMode) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    const params = new URLSearchParams({ provider, scope });
    if (scope === "connected-folder" && connectedFolderId) params.set("connectedFolderId", connectedFolderId);
    void api<{ account: AccountDetails }>(`/api/agent/provider-account?${params}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setAccount(result.account);
        setError(result.account.error);
      }, () => {
        if (!controller.signal.aborted) setError("Account details are unavailable.");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [provider, scope, connectedFolderId, revision, active, fixtureMode, attempt]);

  const workspace = account?.workspaceName ?? account?.workspaceId ?? null;
  const plan = account?.plan ? account.plan.replace(/_/g, " ") : null;
  const hasFacts = Boolean(account?.email || workspace || plan);

  return <div className="ai-models-account-details" aria-label="OpenAI account details">
    {loading ? <p className="ai-models-quiet-note" role="status">Loading account…</p> : <>
      {hasFacts ? <dl>
        {account?.email ? <div><dt>Email</dt><dd>{account.email}</dd></div> : null}
        {workspace ? <div><dt>Workspace</dt><dd>{workspace}</dd></div> : null}
        {plan ? <div><dt>Plan</dt><dd className="ai-models-plan-value">{plan}</dd></div> : null}
      </dl> : null}
      {account?.identityNeedsReconnect ? <div className="ai-models-inline-banner">
        <span>Reconnect once to load your email.</span>
        {onReconnect ? <button className="ui-control" type="button" disabled={busy} onClick={onReconnect}>Reconnect to Load Email</button> : null}
      </div> : null}
      {account?.limits?.length ? <div className="ai-models-account-usage" role="region" aria-label="Codex subscription usage">
        <div className="ai-models-usage-header">
          <h4>Codex Usage</h4>
          {account.checkedAt ? <span className="ai-models-quiet-note">Updated {new Date(account.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span> : null}
        </div>
        {account.limits.map(limit => <div className="ai-models-account-limit" key={limit.id}>
          {account.limits!.length > 1 ? <strong>{limit.name}</strong> : null}
          {[limit.primary, limit.secondary].map((window, index) => window ? <UsageWindow key={index} window={window} /> : null)}
        </div>)}
        {account.applicableResets != null ? <p className="ai-models-quiet-note">Resets: {account.applicableResets}{account.availableResets != null ? ` (${account.availableResets} on account)` : ""}</p>
          : account.availableResets != null ? <p className="ai-models-quiet-note">Resets on account: {account.availableResets}</p> : null}
      </div> : null}
      {account?.connected === false ? <p className="ai-models-quiet-note" role="status">No signed-in OpenAI account.</p> : null}
      {error ? <p className="ai-models-quiet-note" role="status">{error}</p> : null}
      {provider === "openai-codex" && account?.limitsAvailability !== "available" && !error ? <p className="ai-models-quiet-note">Usage limits unavailable.</p> : null}
    </>}
    <div className="ai-models-drawer-bar">
      <div className="ai-models-drawer-links">
        <a className="ai-models-text-link" href={provider === "openai-codex" ? "https://chatgpt.com/codex/settings/usage" : "https://chatgpt.com/settings/usage"} target="_blank" rel="noreferrer">Usage<Open16Regular aria-hidden="true" /></a>
        {provider === "openai" && onSelectCodex ? <button className="ai-models-text-action" type="button" disabled={busy} onClick={onSelectCodex}>Codex Connection</button> : null}
        <button className="ai-models-text-action" type="button" disabled={loading || busy || !active || fixtureMode} onClick={() => setAttempt(value => value + 1)}>Refresh</button>
      </div>
      {actions ? <div className="ai-models-drawer-actions">{actions}</div> : null}
    </div>
  </div>;
}

function UsageWindow({ window }: { window: ProviderUsageWindow }) {
  const minutes = window.windowDurationMins;
  const duration = !minutes ? "Usage window" : minutes % 1440 === 0 ? `${minutes / 1440}-day window`
    : minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window`;
  return <div className="ai-models-account-window">
    <div><span>{duration}</span><span className="ai-models-usage-percent">{window.usedPercent}% used</span></div>
    <progress max={100} value={Math.min(100, window.usedPercent)} aria-label={`${duration} usage`} />
    {window.resetsAt ? <p className="ai-models-quiet-note">Resets <time dateTime={new Date(window.resetsAt * 1000).toISOString()}>{new Date(window.resetsAt * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</time></p> : null}
  </div>;
}
