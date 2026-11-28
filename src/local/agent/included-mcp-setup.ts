import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  addMcpServerConfig, createDefaultTransport, FileCredentialStoreBackend,
  loadMcpConfig, McpOAuthCredentialStore, McpServerConnection, removeMcpServerConfig,
  signInMcpServer, updateMcpServerConfig, validateMcpServerConfig, withFileMutationQueue,
  type LoadedMcpConfig, type McpExtensionOptions, type McpServerConfig, type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { createPersistentPiAuthStorage } from "./auth-storage.js";

export type IncludedMcpScope = "global" | "project";
export interface IncludedMcpPaths { agentDir: string; cwd?: string; mcpCredentialBackend?: NonNullable<ConstructorParameters<typeof McpOAuthCredentialStore>[0]>; }
export interface IncludedMcpSelection { scope: IncludedMcpScope; name: string; expectedRevision?: string; }
export interface IncludedMcpServer extends IncludedMcpSelection {
  path: string;
  transport: "stdio" | "http";
  endpoint: string;
  disabled: boolean;
  auth: "none" | "oauth" | "bearer" | "automatic" | "provider";
  inherited?: boolean;
  credential: "not_checked" | "present" | "expired" | "missing" | "unavailable";
  exposure: "codemode" | "deferred" | "direct" | "hidden";
  revision: string;
  environmentKeys: string[];
  headerKeys: string[];
  /** What the connection's last Check established, while it still holds (see `IncludedMcpCheckStore`). */
  lastCheck?: IncludedMcpLastCheck;
}
export interface IncludedMcpOAuthJob { id: string; state: "running" | "connected" | "cancelled" | "failed"; message?: string; }
/**
 * A connection check's evidence. `signIn` is what the check established about
 * signing in to an HTTP service: it connected with a saved sign-in (`saved`),
 * connected with none, so the service needs none (`not_needed`), or refused
 * until someone signs in (`required`). It is null when the check could not
 * tell (a failure, a cancel, or a service with no sign-in of its own).
 */
export interface IncludedMcpProbe { state: "ready" | "setup_required" | "empty" | "error" | "cancelled"; detail: string; checkedAt: string; tools: number; resources: number; prompts: number; signIn: "saved" | "not_needed" | "required" | null; }
/** What a connection's last Check established, as its row shows it. */
export interface IncludedMcpLastCheck { state: IncludedMcpProbe["state"]; signIn: IncludedMcpProbe["signIn"]; checkedAt: string; }
interface StoredCheck extends IncludedMcpLastCheck {
  /** The definition's revision that was checked. */
  revision: string;
  /** Whether a sign-in was saved when the check connected; null when the check did not read it. */
  credentialPresent: boolean | null;
}
/**
 * Each connection's last Check, kept by the host rather than by the dialog
 * that ran it, so every setup session and every window shows it. Keyed by the
 * definition's file and name. A check stands while the definition's revision
 * is the one checked and, when a listing reads credentials, while a sign-in is
 * saved exactly when one was at the check; every change AmpleFile makes to
 * the definition or its sign-in (save, Turn On or Off, Use Token, Disconnect,
 * a completed Sign In, Remove) forgets it. It lives as long as the app does.
 */
export type IncludedMcpCheckStore = Map<string, StoredCheck>;
const sharedChecks: IncludedMcpCheckStore = new Map();
/** A store of its own, for a test; the app shares one across every setup session. */
export function createIncludedMcpCheckStore(): IncludedMcpCheckStore { return new Map(); }
export interface IncludedMcpSetupOptions extends IncludedMcpPaths {
  /** Where last checks are kept; defaults to the one store the whole app shares. */
  checks?: IncludedMcpCheckStore;
  credentials?: CredentialStore;
  providerToken?: (provider: string) => Promise<string | undefined>;
  openAuthorizationUrl(url: string): void | Promise<void>;
  withMutation?<T>(selection: IncludedMcpSelection, operation: () => Promise<T>): Promise<T>;
}
export function includedMcpConfigPath(paths: IncludedMcpPaths, scope: IncludedMcpScope): string {
  if (scope === "global") return join(resolve(paths.agentDir), "mcp.json");
  if (scope !== "project" || !paths.cwd) throw new Error("Choose a registered Connected Folder for a folder-only connection.");
  return join(resolve(paths.cwd), ".pi", "mcp.json");
}
export async function loadIncludedMcpConfig(paths: IncludedMcpPaths): Promise<LoadedMcpConfig> {
  const config = loadMcpConfig({ agentDir: resolve(paths.agentDir), cwd: paths.cwd ?? paths.agentDir, projectTrusted: Boolean(paths.cwd) });
  return { ...config, errors: config.errors.map(() => "A service configuration could not be loaded. Check its JSON format and native Pi MCP options in Skills & Extensions.") };
}
function credentialId(path: string, name: string, config: McpServerConfig): string {
  return "amplefile-" + createHash("sha256").update(JSON.stringify([resolve(path), name, "url" in config ? config.url : ""])).digest("hex").slice(0, 40);
}
function revision(config: McpServerConfig): string { return createHash("sha256").update(JSON.stringify(config)).digest("hex"); }
function nativeCredentials(paths: IncludedMcpPaths): McpOAuthCredentialStore {
  return new McpOAuthCredentialStore(paths.mcpCredentialBackend ?? new FileCredentialStoreBackend(join(paths.agentDir, "mcp-auth.json")), join(paths.agentDir, "mcp-auth-locks"));
}
/** Pi owns refresh locking and protocol auth; AmpleFile pins credentials to the defining scope. */
class ScopedMcpCredentials extends McpOAuthCredentialStore {
  private closed = false;
  close(): void { this.closed = true; }
  constructor(agentDir: string, private readonly source: (name: string) => McpServerEntry | undefined, backend?: IncludedMcpPaths["mcpCredentialBackend"]) {
    super(backend ?? new FileCredentialStoreBackend(join(agentDir, "mcp-auth.json")), join(agentDir, "mcp-auth-locks"));
  }
  private identity(name: string): string { const entry = this.source(name); return entry ? credentialId(entry.source, name, entry.config) : name; }
  override forServer(name: string, url: string) {
    const store = super.forServer(this.identity(name), url);
    const assertOpen = () => { if (this.closed) throw new Error("This service session has closed."); };
    return { ...store, load: () => { assertOpen(); return store.load(); }, save: (state: Parameters<typeof store.save>[0]) => { assertOpen(); return store.save(state); } };
  }
  override tokens(name: string, url: string) { return super.tokens(this.identity(name), url); }
  override remove(name: string, url: string) { return super.remove(this.identity(name), url); }
}
function transport(credentials: CredentialStore): NonNullable<McpExtensionOptions["createTransport"]> {
  return (entry, cwd, auth) => {
    if (!("url" in entry.config)) return createDefaultTransport(entry, cwd, auth);
    const key = credentialId(entry.source, entry.name, entry.config);
    return createDefaultTransport(entry, cwd, {
      async token() { const saved = await credentials.read(key); return saved?.type === "api_key" ? saved.key : auth?.token(); },
      async onUnauthorized(context) {
        const saved = await credentials.read(key);
        if (saved?.type === "api_key") throw new Error("This service rejected its saved token. Reconnect in Skills & Extensions.");
        await auth?.onUnauthorized?.(context);
      },
    });
  };
}
/** Catalog reads remain cold. Chat sign-in commands never get a secret/setup bridge. */
export async function includedNativeMcpOptions(paths: IncludedMcpPaths, credentials: CredentialStore, mode: "catalog" | "session"): Promise<McpExtensionOptions & { disposeCredentials(): void }> {
  const config = await loadIncludedMcpConfig(paths);
  const scoped = new ScopedMcpCredentials(paths.agentDir, (name) => config.servers.find((entry) => entry.name === name), paths.mcpCredentialBackend);
  return {
    disposeCredentials: () => scoped.close(),
    loadConfig: () => mode === "catalog" ? { servers: [], errors: config.errors } : config,
    credentials: scoped,
    createTransport: transport(credentials),
    logPath: join(paths.agentDir, "mcp.log"),
    openUrl: () => { throw new Error("Sign in through Skills & Extensions → Service Connections."); },
    updateConfig: () => { throw new Error("Change connections through Skills & Extensions → Service Connections."); },
  };
}
function validateName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || name === "constructor" || name === "prototype") throw new Error("Use a service name starting with a letter, containing up to 64 letters, digits, underscores or hyphens.");
}
function validateDefinition(name: string, value: McpServerConfig): McpServerConfig {
  const config = validateMcpServerConfig(name, value);
  if (typeof config === "string") throw new Error("Enter a valid native Pi MCP server definition.");
  if ("url" in config) {
    const url = new URL(config.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) service URL without an embedded username or password.");
  }
  return config;
}
function endpoint(config: McpServerConfig): string {
  if (!("url" in config)) return config.command;
  try { const url = new URL(config.url); url.username = ""; url.password = ""; if (url.search) url.search = "?…"; url.hash = ""; return url.href; } catch { return "Invalid service URL"; }
}

/** Native Pi MCP on the trusted settings surface, with source-pinned, fenced mutations. */
export function createIncludedMcpSetup(options: IncludedMcpSetupOptions) {
  const paths = { agentDir: resolve(options.agentDir), ...(options.cwd ? { cwd: resolve(options.cwd) } : {}), mcpCredentialBackend: options.mcpCredentialBackend };
  const oauth = nativeCredentials(paths);
  const credentials = options.credentials ? Promise.resolve(options.credentials) : createPersistentPiAuthStorage(paths).then((store) => store.credentials);
  const jobs = new Map<string, { public: IncludedMcpOAuthJob; selection: IncludedMcpSelection; controller: AbortController; settled: Promise<void> }>();
  const probes = new Map<AbortController, Promise<void>>();
  const checks = options.checks ?? sharedChecks;
  const checkKey = (selection: Pick<IncludedMcpSelection, "scope" | "name">) => `${includedMcpConfigPath(paths, selection.scope)}\0${selection.name}`;
  const forgetCheck = (selection: Pick<IncludedMcpSelection, "scope" | "name">) => { checks.delete(checkKey(selection)); };
  /** Keeps what a check found; a failed check supersedes an earlier success, and a cancelled one changes nothing. */
  const rememberCheck = (selection: IncludedMcpSelection, checkedRevision: string, probe: IncludedMcpProbe, credentialPresent: boolean | null) => {
    if (probe.state === "cancelled") return;
    if (probe.state === "error") { forgetCheck(selection); return; }
    checks.set(checkKey(selection), { state: probe.state, signIn: probe.signIn, checkedAt: probe.checkedAt, revision: checkedRevision, credentialPresent });
  };
  let disposed = false;
  let oauthStartQueue: Promise<void> = Promise.resolve();
  function assertOpen() { if (disposed) throw new Error("This connection setup has closed."); }
  async function entries(scope: IncludedMcpScope) {
    includedMcpConfigPath(paths, scope);
    const config = loadMcpConfig({ agentDir: paths.agentDir, cwd: scope === "global" ? paths.agentDir : paths.cwd!, projectTrusted: scope === "project" });
    if (config.errors.length) throw new Error("The native MCP configuration could not be read. Check its JSON format and file permissions.");
    return scope === "global" ? config.servers : config.servers.filter(entry => entry.scope === "project" || entry.override);
  }
  async function selected(selection: IncludedMcpSelection) {
    assertOpen(); validateName(selection.name);
    const path = includedMcpConfigPath(paths, selection.scope);
    const entry = (await entries(selection.scope)).find((item) => item.name === selection.name);
    if (!entry) throw new Error("This service definition no longer exists. Refresh connections.");
    if (selection.expectedRevision !== undefined && selection.expectedRevision !== revision(entry.config)) throw new Error("This service changed. Refresh connections before continuing.");
    return { path, entry, definition: entry.config };
  }
  async function cancelFor(selection: IncludedMcpSelection) {
    for (const job of jobs.values()) if (job.selection.scope === selection.scope && job.selection.name === selection.name && job.public.state === "running") {
      job.public.state = "cancelled"; job.controller.abort(); await job.settled;
    }
  }
  /** Whether a sign-in is saved for this definition: a bearer token, or native OAuth tokens. Reads the credential store. */
  async function savedSignIn(source: string, name: string, config: McpServerConfig & { url: string }): Promise<{ present: boolean; bearer: boolean }> {
    const id = credentialId(source, name, config);
    const saved = await (await credentials).read(id);
    const bearer = saved?.type === "api_key";
    return { present: bearer || Boolean(oauth.tokens(id, config.url)), bearer };
  }
  /** The row's last check while it still holds: the same revision, and, when credentials were read, the same saved sign-in. */
  function standingCheck(selection: Pick<IncludedMcpSelection, "scope" | "name">, currentRevision: string, credential: IncludedMcpServer["credential"]): IncludedMcpLastCheck | null {
    const stored = checks.get(checkKey(selection));
    if (!stored) return null;
    const readNow = credential === "present" || credential === "missing";
    if (stored.revision !== currentRevision || (readNow && stored.credentialPresent !== null && (credential === "present") !== stored.credentialPresent)) {
      forgetCheck(selection);
      return null;
    }
    return { state: stored.state, signIn: stored.signIn, checkedAt: stored.checkedAt };
  }
  async function mutate<T>(selection: IncludedMcpSelection, operation: () => Promise<T>): Promise<T> {
    assertOpen(); if (selection.expectedRevision !== undefined) await selected(selection); await cancelFor(selection);
    // Any change AmpleFile makes to a definition or its sign-in ends what its last check established.
    const run = async () => { assertOpen(); const value = await operation(); forgetCheck(selection); return value; };
    return options.withMutation ? options.withMutation(selection, run) : run();
  }
  return {
    async list({ inspectCredentials = false }: { inspectCredentials?: boolean } = {}): Promise<IncludedMcpServer[]> {
      assertOpen(); const results: IncludedMcpServer[] = [];
      for (const scope of ["global", ...(paths.cwd ? ["project"] : [])] as IncludedMcpScope[]) {
        const path = includedMcpConfigPath(paths, scope);
        for (const { name, config, source, override } of await entries(scope)) {
          const http = "url" in config;
          let credential: IncludedMcpServer["credential"] = "not_checked";
          let auth: IncludedMcpServer["auth"] = http ? config.auth?.provider ? "provider" : "automatic" : "none";
          if (inspectCredentials && http) {
            try {
              const saved = await savedSignIn(source, name, config);
              auth = saved.bearer ? "bearer" : config.auth?.provider ? "provider" : "automatic";
              credential = saved.present ? "present" : "missing";
            } catch { credential = "unavailable"; }
          }
          const lastCheck = standingCheck({ scope, name }, revision(config), credential);
          results.push({ scope, name, path, ...(override ? { inherited: true } : {}), transport: http ? "http" : "stdio", endpoint: endpoint(config), disabled: config.enabled === false, auth, credential,
            exposure: config.exposure ?? "codemode", revision: revision(config), environmentKeys: "env" in config ? Object.keys(config.env ?? {}) : [], headerKeys: http ? Object.keys(config.headers ?? {}) : [],
            ...(lastCheck ? { lastCheck } : {}) });
        }
      }
      return results;
    },
    /** The connection's last check as its row shows it, or null when none stands. */
    lastCheck(selection: Pick<IncludedMcpSelection, "scope" | "name">): IncludedMcpLastCheck | null {
      const stored = checks.get(checkKey(selection));
      return stored ? { state: stored.state, signIn: stored.signIn, checkedAt: stored.checkedAt } : null;
    },
    async probe(selection: IncludedMcpSelection, { signal }: { signal?: AbortSignal } = {}): Promise<IncludedMcpProbe> {
      const { entry, definition } = await selected(selection);
      const empty = { checkedAt: new Date().toISOString(), tools: 0, resources: 0, prompts: 0, signIn: null };
      if (definition.enabled === false) return { ...empty, state: "setup_required", detail: "Enable this service to check its connection." };
      const store = await credentials; assertOpen();
      const controller = new AbortController(); const owned = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
      let finished!: () => void; probes.set(controller, new Promise<void>((resolve) => { finished = resolve; }));
      const connection = new McpServerConnection({ entry: { ...entry, config: { ...definition, timeout: 15 } }, cwd: paths.cwd ?? paths.agentDir,
        credentials: new ScopedMcpCredentials(paths.agentDir, () => entry, paths.mcpCredentialBackend), providerToken: options.providerToken, createTransport: transport(store), onTools: () => undefined });
      const abort = () => { void connection.close(); }; owned.addEventListener("abort", abort, { once: true });
      try {
        owned.throwIfAborted(); await connection.getClient(); owned.throwIfAborted();
        const resources = connection.hasResources ? await connection.allResources({ signal: owned }) : [];
        owned.throwIfAborted();
        if (revision((await selected(selection)).definition) !== revision(definition)) return { ...empty, state: "error", detail: "This service changed while it was being checked. Check it again." };
        const counts = { tools: connection.tools.length, resources: resources.length, prompts: 0 };
        const usable = counts.tools + counts.resources > 0;
        // A service AmpleFile signs in to itself (HTTP, no AI Models provider) connected: with a saved sign-in, or with none, so it needs none.
        const present = "url" in definition && !definition.auth?.provider
          ? await savedSignIn(entry.source, selection.name, definition).then((saved) => saved.present, () => null)
          : null;
        const signIn = present === null ? null : present ? "saved" as const : "not_needed" as const;
        const result: IncludedMcpProbe = { ...empty, ...counts, signIn, state: usable ? "ready" : "empty", detail: usable ? "The service initialized successfully and its capabilities are available." : "The service connected but did not advertise tools or resources." };
        rememberCheck(selection, revision(definition), result, present);
        return result;
      } catch {
        const cancelled = controller.signal.aborted || signal?.aborted;
        const needsSignIn = !cancelled && connection.state === "needs-auth";
        const result: IncludedMcpProbe = { ...empty, state: cancelled ? "cancelled" : needsSignIn ? "setup_required" : "error", ...(needsSignIn ? { signIn: "required" as const } : {}), detail: cancelled ? "Connection check cancelled." : needsSignIn ? "The service needs you to sign in before it can be used." : owned.aborted ? "The service did not respond within 15 seconds." : "The service could not complete MCP initialization. Check its command or URL and sign-in settings." };
        rememberCheck(selection, revision(definition), result, null);
        return result;
      } finally { owned.removeEventListener("abort", abort); controller.abort(); await connection.close(); probes.delete(controller); finished(); }
    },
    async saveServer(input: IncludedMcpSelection & { definition: McpServerConfig }): Promise<void> {
      validateName(input.name); const definition = validateDefinition(input.name, input.definition);
      if (input.scope === "project" && "auth" in definition && definition.auth?.provider) throw new Error("Provider credentials can only be connected from an Everywhere MCP definition.");
      await mutate(input, async () => { const path = includedMcpConfigPath(paths, input.scope); await withFileMutationQueue(path, async () => {
        assertOpen(); const existing = (await entries(input.scope)).find((entry) => entry.name === input.name);
        if (existing && input.expectedRevision === undefined) throw new Error("A service with this name already exists in that location. Choose another name.");
        if (input.expectedRevision !== undefined) await selected(input);
        addMcpServerConfig(path, input.name, definition);
      }); });
    },
    async removeServer(selection: IncludedMcpSelection): Promise<void> {
      await mutate(selection, async () => { const { path } = await selected(selection); await withFileMutationQueue(path, async () => { await selected(selection); removeMcpServerConfig(path, selection.name); }); });
    },
    async setEnabled(selection: IncludedMcpSelection, enabled: boolean): Promise<void> {
      await mutate(selection, async () => { const { path } = await selected(selection); await withFileMutationQueue(path, async () => { const { entry } = await selected(selection); updateMcpServerConfig(path, selection.name, { enabled }, { override: Boolean(entry.override) }); }); });
    },
    async saveBearer(input: IncludedMcpSelection & { token: string }): Promise<void> {
      if (typeof input.token !== "string" || !input.token.trim() || input.token.length > 65_536 || /[\r\n]/.test(input.token)) throw new Error("Enter a bearer token on one line.");
      await mutate(input, async () => { const { path } = await selected(input); await withFileMutationQueue(path, async () => { const { definition, entry } = await selected(input);
        if (entry.override) throw new Error("Connect this inherited service from Everywhere.");
        if (!("url" in definition)) throw new Error("Bearer authentication requires an HTTP service.");
        await (await credentials).modify(credentialId(entry.source, input.name, definition), async () => ({ type: "api_key", key: input.token.trim() }));
      }); });
    },
    async disconnect(selection: IncludedMcpSelection): Promise<void> {
      await mutate(selection, async () => { const { path } = await selected(selection); await withFileMutationQueue(path, async () => { const { definition, entry } = await selected(selection); if (entry.override) throw new Error("Disconnect this inherited service from Everywhere."); const id = credentialId(entry.source, selection.name, definition);
        await (await credentials).delete(id); if ("url" in definition) oauth.remove(id, definition.url);
      }); });
    },
    startOAuth(selection: IncludedMcpSelection): Promise<IncludedMcpOAuthJob> {
      const start = oauthStartQueue.then(async () => {
      await cancelFor(selection); const { path, entry, definition } = await selected(selection);
      if (entry.override) throw new Error("Sign in to this inherited service from Everywhere.");
      if ("url" in definition && definition.auth?.provider) throw new Error("Sign in to this service provider in Settings → AI Models.");
      if (!("url" in definition) || definition.enabled === false) throw new Error("Enable an HTTP service before connecting it.");
      const pin = revision(definition); const controller = new AbortController();
      const job = { public: { id: randomUUID(), state: "running" } as IncludedMcpOAuthJob, selection, controller, settled: Promise.resolve() }; jobs.set(job.public.id, job);
      job.settled = (async () => {
        const store = oauth.forServer(credentialId(entry.source, selection.name, definition), definition.url);
        let staged: Awaited<ReturnType<typeof store.load>>;
        const connection = new McpServerConnection({ entry, cwd: paths.cwd ?? paths.agentDir, credentials: oauth, createTransport: createDefaultTransport, onTools: () => undefined });
        try {
          staged = await store.load();
          if (staged) {
            // Explicit setup stages new credentials. Refresh could rotate the live token before
            // the definition is rechecked or while the person can still cancel.
            const { tokens: _tokens, tokensExpireAt: _expiry, ...clientState } = staged;
            staged = clientState;
          }
          await signInMcpServer({ serverUrl: definition.url, settings: connection.oauthSettings(), signal: controller.signal,
            store: {
              load: () => structuredClone(staged),
              save: (state) => { controller.signal.throwIfAborted(); staged = structuredClone(state); },
              withRefreshLock: store.withRefreshLock,
            },
            prompt: {
              showAuthorizationUrl(url) {
                void (async () => {
                  controller.signal.throwIfAborted();
                  if (revision((await selected(selection)).definition) !== pin) throw new Error("Service configuration changed.");
                  await options.openAuthorizationUrl(url.href);
                })().catch(() => controller.abort());
              },
              promptForRedirectUrl(signal) {
                return new Promise((_, reject) => {
                  const abort = () => reject(new Error("Service sign-in cancelled."));
                  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
                });
              },
            },
          });
          const commit = async () => { await withFileMutationQueue(path, async () => { controller.signal.throwIfAborted(); if (revision((await selected(selection)).definition) !== pin) throw new Error("Service configuration changed.");
            if (!staged?.tokens) throw new Error("Service sign-in did not return credentials.");
            await (await credentials).delete(credentialId(entry.source, selection.name, definition)); controller.signal.throwIfAborted(); await store.save(staged);
          }); };
          if (options.withMutation) await options.withMutation(selection, commit); else await commit();
          forgetCheck(selection);
          job.public = { id: job.public.id, state: "connected" };
        } catch { job.public = { id: job.public.id, state: controller.signal.aborted ? "cancelled" : "failed", ...(controller.signal.aborted ? {} : { message: "The service could not complete authorization. Check its URL and OAuth configuration, then try again." }) }; }
        finally { await connection.close(); }
      })();
      return { ...job.public };
      });
      oauthStartQueue = start.then(() => undefined, () => undefined);
      return start;
    },
    oauthStatus(id: string): IncludedMcpOAuthJob { const job = jobs.get(id); if (!job) throw new Error("This connection attempt no longer exists."); return { ...job.public }; },
    async cancelOAuth(id: string): Promise<void> { const job = jobs.get(id); if (!job || job.public.state !== "running") return; job.public.state = "cancelled"; job.controller.abort(); await job.settled; },
    async dispose(): Promise<void> { disposed = true; for (const probe of probes.keys()) probe.abort(); for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...probes.values(), ...[...jobs.values()].map((job) => job.settled)]); jobs.clear(); },
  };
}
