import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiOAuthHooks } from "../src/local/agent/pi-runtime-config.js";
import { ProviderSignIns } from "../src/local/agent/provider-sign-in.js";
import { startLocalApi } from "../src/local/server.js";

const desktopHooks = (): PiOAuthHooks & { opened: string[]; dialogs: number } => {
  const hooks = {
    opened: [] as string[], dialogs: 0,
    openUrl({ url }: { url: string }) { hooks.opened.push(url); },
    showDeviceCode() { hooks.dialogs += 1; },
    async prompt() { hooks.dialogs += 1; return ""; },
    async select() { hooks.dialogs += 1; return undefined; },
  };
  return hooks;
};

test("a pending sign-in takes a pasted link only while its browser prompt waits", async () => {
  const signIns = new ProviderSignIns();
  const inner = desktopHooks();
  const signIn = await signIns.begin(inner);
  assert.equal(signIns.acceptsPaste, false);
  assert.equal(await signIn.hooks.select({ message: "How?", options: [{ id: "device_code", label: "Device" }, { id: "browser", label: "Browser" }] }), "browser");
  assert.equal(inner.dialogs, 0, "browser sign-in is chosen without a dialog");
  assert.equal(await signIn.hooks.select({ message: "Which host?", options: [{ id: "a", label: "A" }] }), undefined);
  assert.equal(inner.dialogs, 1, "other choices still go to the desktop");

  const prompt = new AbortController();
  const pasted = signIn.hooks.manualCodeInput!(prompt.signal, { message: "Paste", placeholder: "http://127.0.0.1:1455/auth/callback" });
  assert.equal(signIns.acceptsPaste, true);
  assert.equal(signIns.paste("http://127.0.0.1:1455/auth/callback?code=c&state=s"), true);
  assert.equal(await pasted, "http://127.0.0.1:1455/auth/callback?code=c&state=s");
  assert.equal(signIns.acceptsPaste, false);
  assert.equal(signIns.paste("again"), false);

  // The browser's own callback won: Pi aborts the prompt, which then takes nothing.
  const waiting = signIn.hooks.manualCodeInput!(prompt.signal);
  assert.equal(signIns.acceptsPaste, true);
  prompt.abort(new Error("callback arrived"));
  await assert.rejects(waiting, /callback arrived/);
  assert.equal(signIns.acceptsPaste, false);
  signIn.finish();
  assert.equal(signIns.cancel(), false, "a finished sign-in has nothing to cancel");
});

test("cancelling, or starting another sign-in, ends the one in progress", async () => {
  const signIns = new ProviderSignIns();
  const first = await signIns.begin(desktopHooks());
  const firstPrompt = first.hooks.manualCodeInput!(first.hooks.signal);
  let secondStarted = false;
  const starting = signIns.begin(desktopHooks()).then((value) => { secondStarted = true; return value; });
  assert.equal(first.cancelled(), true);
  await assert.rejects(firstPrompt, /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondStarted, false, "a new sign-in waits for the cancelled one to let go of the setup lock");
  first.finish();
  const second = await starting;
  assert.equal(second.cancelled(), false, "the earlier sign-in finishing never clears the newer one");
  assert.equal(signIns.cancel(), true);
  assert.equal(second.cancelled(), true);
  assert.equal(second.hooks.signal?.aborted, true);
});

test("the provider setup API cancels a sign-in or finishes it with a pasted link, with no dialog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-provider-sign-in-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = FileCredentialStore.inMemory();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, authPath: join(root, "auth.json") });
  const account = fauxProvider({ provider: "browser-account", models: [{ id: "account-model" }] });
  const methods: string[] = [];
  runtime.registerNativeProvider({ ...account.provider, auth: { oauth: {
    name: "Browser account",
    async login(interaction) {
      const method = await interaction.prompt({ type: "select", message: "How?", options: [{ id: "browser", label: "Browser" }, { id: "device_code", label: "Device code" }] });
      methods.push(String(method));
      interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
      const link = await interaction.prompt({ type: "manual_code", message: "Paste the link", placeholder: "http://127.0.0.1:1455/auth/callback" });
      return { type: "oauth", access: new URL(link).searchParams.get("code")!, refresh: "synthetic-refresh", expires: Date.now() + 3_600_000 };
    },
    refresh: async (credential) => credential,
    toAuth: async (credential) => ({ apiKey: credential.access }),
  } } });
  const hooks = desktopHooks();
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "content"), loadEnv: false,
    piRuntimeProvider: { resolveRuntime: async () => ({ agentDir: root, credentials, modelRuntime: runtime }) }, piOAuthHooks: hooks });
  t.after(() => api.close());
  const post = (path: string, body: object) => fetch(`${api.origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const acceptsPaste = async () => ((await (await fetch(`${api.origin}/api/agent/oauth/pending`)).json()) as { acceptsPaste: boolean }).acceptsPaste;
  const untilPasteable = async () => { for (let tries = 0; tries < 200 && !(await acceptsPaste()); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(await acceptsPaste(), true); };
  const signIn = () => post("/api/agent/oauth", { scope: "agent", provider: "browser-account" });

  // Cancel ends it quietly; nothing is saved.
  const cancelled = signIn();
  await untilPasteable();
  assert.deepEqual(await (await post("/api/agent/oauth/cancel", {})).json(), { cancelled: true });
  const cancelledResponse = await cancelled;
  assert.equal(cancelledResponse.status, 409);
  assert.match(((await cancelledResponse.json()) as { error: string }).error, /Sign-in cancelled/);
  assert.equal(await acceptsPaste(), false);
  assert.equal((await post("/api/agent/oauth/paste", { value: "http://127.0.0.1:1455/auth/callback?code=late" })).status, 409);
  assert.equal(await credentials.read("browser-account"), undefined);

  // Starting again replaces a sign-in left waiting, and the pasted link finishes the new one.
  const abandoned = signIn();
  await untilPasteable();
  const finished = signIn();
  assert.equal((await abandoned).status, 409);
  await untilPasteable();
  assert.equal((await post("/api/agent/oauth/paste", { value: "  " })).status, 400);
  assert.deepEqual(await (await post("/api/agent/oauth/paste", { value: "http://127.0.0.1:1455/auth/callback?code=pasted-access&state=s" })).json(), { accepted: true });
  const finishedResponse = await finished;
  assert.equal(finishedResponse.status, 200, await finishedResponse.clone().text());
  assert.equal((await credentials.read("browser-account"))?.type, "oauth");
  const saved = await credentials.read("browser-account");
  assert.equal(saved?.type === "oauth" && saved.access, "pasted-access");
  assert.deepEqual(methods, ["browser", "browser", "browser"], "browser sign-in is chosen in the app");
  assert.equal(hooks.dialogs, 0, "no step opened a dialog");
  assert.deepEqual(hooks.opened, ["https://example.test/authorize", "https://example.test/authorize", "https://example.test/authorize"]);
});
