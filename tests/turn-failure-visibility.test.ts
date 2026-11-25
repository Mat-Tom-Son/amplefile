import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { buildTurnContextMessage, previousTurnPartialTextMaxChars } from "../src/local/agent/pi-client.js";
import { describeProviderFailure, providerHttpStatus } from "../src/local/agent/turn-failure.js";
import { runActOperation } from "../src/local/api/act-support.js";
import { AmpleFileCliError } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";
import { ampleFileAgentScopeId } from "../src/local/state-paths.js";

const privateBody = "acct_private_123 billing.invalid/private sk-live-secret";

/**
 * Why a turn failed reaches the agents that read it in fixed words, never
 * the provider's own text: a Chat's transcript travels with its Connected
 * Folder, and provider errors carry account data.
 */
test("provider failures are sorted into fixed causes that say what helps, without provider text", () => {
  const cases: Array<[string, string, RegExp]> = [
    [`402 {"error":{"message":"needs credits ${privateBody}"}}`, "billing", /credit or billing limit \(HTTP 402\)/],
    [`400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the API. ${privateBody}"}}`, "billing", /credit or billing limit \(HTTP 400\)/],
    [`Summarization failed: 401 Incorrect API key provided ${privateBody}`, "credentials", /did not accept AmpleFile's API key or sign-in \(HTTP 401\)/],
    [`401 {"error":{"message":"bad key ${privateBody}"}}`, "credentials", /did not accept AmpleFile's API key or sign-in \(HTTP 401\)/],
    [`404: {"message":"The model \`x\` does not exist or you do not have access to it. ${privateBody}","code":"model_not_found"}`, "model_access", /says the model "probe-model" does not exist or this account cannot use it \(HTTP 404\)/],
    [`403 status code (no body)`, "model_access", /refused this request for this account \(HTTP 403\)/],
    [`429 {"error":{"message":"Rate limit reached ${privateBody}"}}`, "rate_limit", /limiting requests .* \(HTTP 429\) after 2 automatic retries/],
    [`400 {"error":{"message":"Image input is not supported for this model ${privateBody}"}}`, "image_input", /rejected an image .* choose a model that accepts images/],
    [`400 {"error":{"message":"Unrecognized request argument ${privateBody}"}}`, "invalid_request", /rejected the request as invalid \(HTTP 400\)/],
    [`503 {"error":{"message":"overloaded ${privateBody}"}}`, "provider_unavailable", /failed or could not be reached \(HTTP 503\)/],
    [`Anthropic API error (400): prompt is too long: 250000 tokens > 200000 maximum ${privateBody}`, "context_overflow", /too long for this model's context window/],
    [`something odd ${privateBody}`, "provider_error", /returned an error AmpleFile does not recognize/],
  ];
  for (const [message, cause, text] of cases) {
    const described = describeProviderFailure({ message, provider: "probe-provider", model: "probe-model", retryAttempts: 2 });
    assert.equal(described.cause, cause, message);
    assert.match(described.text, text, message);
    assert.doesNotMatch(described.text, /acct_private|billing\.invalid|sk-live|model_not_found|Unrecognized|overloaded/, "provider text is never echoed");
  }
  assert.equal(describeProviderFailure({ message: "Context overflow recovery failed after one compact-and-retry attempt.", kind: "context_overflow" }).cause, "context_overflow");
  assert.equal(describeProviderFailure({ message: "anything", kind: "length" }).cause, "response_length");
  assert.equal(providerHttpStatus("HTTP/1.1 418 teapot"), 418);
  assert.equal(providerHttpStatus("no status here, 200 tokens"), undefined);
  assert.equal(providerHttpStatus("max_tokens: 500 is above this model's limit"), undefined, "a field name is no wrapper label");
  assert.equal(providerHttpStatus("Summarization failed: 401 Incorrect API key"), 401);
  // A rate limit that points at billing details is still a rate limit.
  assert.equal(describeProviderFailure({ message: "429 Quota exceeded for requests per minute. Please check your plan and billing details." }).cause, "rate_limit");
  assert.equal(describeProviderFailure({ message: `429 {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}` }).cause, "billing");
});

test("a turn is told how this Chat's previous turn ended, bounded", () => {
  const long = "x".repeat(previousTurnPartialTextMaxChars + 50);
  const failed = buildTurnContextMessage({ previousTurn: { outcome: "failed", detail: "The model provider says it is gone.", partialText: long } });
  assert.match(failed, /This Chat's previous turn failed before it finished \(host-owned\): The model provider says it is gone\./);
  assert.match(failed, /Its unfinished reply is not in your context\. It began:/);
  assert.ok(failed.includes(`${"x".repeat(previousTurnPartialTextMaxChars)}…`), "the partial reply is cut at its bound");
  assert.ok(!failed.includes("x".repeat(previousTurnPartialTextMaxChars + 1)));
  assert.match(failed, /Check before redoing work/);
  assert.match(buildTurnContextMessage({ previousTurn: { outcome: "stopped", detail: "Stopped." } }), /previous turn was stopped before it finished/);
  assert.match(buildTurnContextMessage({ previousTurn: { outcome: "interrupted", detail: "Closed." } }), /cut off because AmpleFile closed/);
  assert.doesNotMatch(buildTurnContextMessage({}), /previous turn/);
});

test("a provider that refuses the model says so to agents, and the next turn hears how the last one ended", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-turn-failure-"));
  const bodies: string[] = [];
  let refuse = true;
  const providerServer = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      bodies.push(body);
      if (refuse) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `The model \`probe-model\` does not exist or you do not have access to it. ${privateBody}`, code: "model_not_found" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      response.end(`data: ${JSON.stringify({ id: "ok", object: "chat.completion.chunk", created: 1, model: "probe-model", choices: [{ index: 0, delta: { role: "assistant", content: "Done now." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const port = (providerServer.address() as AddressInfo).port;
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "probe-provider.ts"), `export default function(pi){pi.registerProvider("probe-provider",{api:"openai-completions",baseUrl:"http://127.0.0.1:${port}/v1",apiKey:"test-key",models:[{id:"probe-model",name:"Probe Model",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024}]});}`);
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "probe-provider", defaultModel: "probe-model", defaultThinkingLevel: "off", retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } });
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false, piRuntimeProvider: { async resolveRuntime() { return { agentDir, settingsManager }; } } });
  t.after(async () => {
    await api.close();
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    await rm(sandbox, { recursive: true, force: true });
  });
  const facade = api.actFacade;
  const { connectedFolder } = await facade.createConnectedFolder({ name: "Probe" });
  const settle = async (taskId: string) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const status = await facade.turnStatus({ connectedFolder: connectedFolder.id, taskId });
      if (!["accepted", "running"].includes(status.task.state)) return status;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the turn did not settle");
  };

  const first = await facade.sendMessage({ connectedFolder: connectedFolder.id, newConversation: true, content: "Rename the screenshots." });
  const failed = await settle(first.taskId);
  assert.equal(failed.task.state, "failed");
  assert.match(failed.task.error ?? "", /does not exist or this account cannot use it \(HTTP 404\)\. Choose another model/);
  assert.doesNotMatch(failed.task.error ?? "", /stopped responding|below/);
  await assert.rejects(
    () => facade.turnResult({ connectedFolder: connectedFolder.id, taskId: first.taskId }),
    (error: unknown) => error instanceof AmpleFileCliError && error.code === "failure" && /cannot use it/.test(error.message),
  );
  const transcript = await facade.conversationResult({ connectedFolder: connectedFolder.id, conversationId: first.conversationId });
  assert.doesNotMatch(JSON.stringify(transcript), /acct_private|billing\.invalid|sk-live|model_not_found|do not have access/, "no provider text in the portable transcript");

  refuse = false;
  const second = await facade.sendMessage({ connectedFolder: connectedFolder.id, conversationId: first.conversationId, content: "Try again." });
  assert.equal((await settle(second.taskId)).task.state, "succeeded");
  // The turn's own request, not the Chat title request that may follow it.
  const turnRequest = (message: string) => [...bodies].reverse().find((body) => body.includes(message) && !body.includes("title for this conversation"))!;
  const sent = turnRequest("Try again.");
  assert.match(sent, /This Chat's previous turn failed before it finished \(host-owned\): The model provider says the model \\"probe-model\\" does not exist/,
    "the model itself is told how the last turn ended");
  assert.doesNotMatch(sent, /acct_private|sk-live/);

  const third = await facade.sendMessage({ connectedFolder: connectedFolder.id, conversationId: first.conversationId, content: "And now?" });
  assert.equal((await settle(third.taskId)).task.state, "succeeded");
  assert.doesNotMatch(turnRequest("And now?").split("And now?").at(-1)!, /previous turn failed/, "after a turn that answered, nothing is said");
});

test("a child that reported and then failed hands its report to its parent", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-failed-child-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", { description: "Stand in for a turn", handler: async () => {} });
  }\n`, "utf8");
  let releaseRoot = () => {};
  const rootHeld = new Promise<void>((resolve) => { releaseRoot = resolve; });
  let rootStarted = false;
  let holdRoot = true;
  let api: Awaited<ReturnType<typeof startLocalApi>>;
  api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    async beforeAgentPrompt(event) {
      if (event.connectedFolderId === ampleFileAgentScopeId) {
        if (!holdRoot) return;
        holdRoot = false;
        rootStarted = true;
        await rootHeld;
        return;
      }
      // What a Worker does: it files a report, then its turn fails.
      await api.actFacade.chatReport({ connectedFolder: event.connectedFolderId, taskId: event.taskId, summary: "Renamed 3 of 5 screenshots before stopping.", outcome: "partial", files: [] });
      throw new Error("Synthetic failure after the report");
    },
  });
  t.after(async () => {
    releaseRoot();
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const waitFor = async (condition: () => boolean | Promise<boolean>) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out");
  };
  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Screenshots" });
  const root = await api.actFacade.agentSend({ content: "/hold" });
  await waitFor(() => rootStarted);
  const child = await api.actFacade.sendMessage({ connectedFolder: connectedFolder.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
  await waitFor(async () => (await api.actFacade.turnStatus({ connectedFolder: connectedFolder.id, taskId: child.taskId })).task.state === "failed");

  await assert.rejects(
    () => api.actFacade.turnResult({ connectedFolder: connectedFolder.id, taskId: child.taskId }),
    (error: unknown) => error instanceof AmpleFileCliError
      && /unexpected error/.test(error.message)
      && /filed a report \(partial\): Renamed 3 of 5 screenshots before stopping\./.test(error.message)
      && /requests show --request req-/.test(error.message),
  );

  releaseRoot();
  const requestId = api.requests.byTaskId(root.taskId)!.requestId;
  await waitFor(() => api.requests.get(requestId)!.turns.length === 2);
  assert.match(api.requests.get(requestId)!.content, /failed: .*It reported before it ended \(partial\): Renamed 3 of 5 screenshots before stopping\./);
});

test("file acts refuse a taken name as a conflict and a locked folder in plain words", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-file-act-errors-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false, piRuntimeProvider: { async resolveRuntime() { return {}; } } });
  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Files" });
  const locked = join(connectedFolder.connectedFolderRoot, "Locked");
  t.after(async () => {
    await chmod(locked, 0o755).catch(() => undefined);
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  await writeFile(join(connectedFolder.connectedFolderRoot, "a.txt"), "a");
  await writeFile(join(connectedFolder.connectedFolderRoot, "b.txt"), "b");
  await assert.rejects(
    () => api.actFacade.filesRename({ connectedFolder: connectedFolder.id, path: "a.txt", newName: "b.txt" }),
    (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /already exists there/.test(error.message),
  );
  await mkdir(locked);
  await writeFile(join(locked, "c.txt"), "c");
  await chmod(locked, 0o555);
  await assert.rejects(
    () => api.actFacade.filesRename({ connectedFolder: connectedFolder.id, path: "Locked/c.txt", newName: "d.txt" }),
    (error: unknown) => error instanceof AmpleFileCliError
      && error.code === "permissionDenied"
      && /can’t be changed/.test(error.message)
      && !error.message.includes(sandbox),
  );
});

test("a failed system call at the act boundary names a file refusal plainly and leaves other failures neutral", async () => {
  const failedCall = (code: string, syscall: string, path?: string) =>
    Object.assign(new Error(`${code}: failed, ${syscall}${path ? ` '${path}'` : ""}`), { code, syscall, ...(path ? { path } : {}) });
  const refusal = async (error: unknown) => runActOperation(async () => { throw error; }).then(
    () => assert.fail("expected a refusal"),
    (thrown: unknown) => thrown as AmpleFileCliError,
  );
  const locked = await refusal(failedCall("EACCES", "open", "/Users/someone/Private/report.txt"));
  assert.equal(locked.code, "permissionDenied");
  assert.match(locked.message, /“report\.txt” can’t be changed/);
  assert.doesNotMatch(locked.message, /Users\/someone/);
  for (const [code, syscall] of [["ECONNREFUSED", "connect"], ["ENOTFOUND", "getaddrinfo"], ["ENOENT", "spawn rg"], ["EISDIR", "read"], ["EMFILE", "open"]] as const) {
    const neutral = await refusal(failedCall(code, syscall, syscall.startsWith("spawn") ? "rg" : undefined));
    assert.equal(neutral.code, "failure", `${syscall} ${code} is a plain failure, not a conflict`);
    assert.equal(neutral.message, `The system refused this request (${code}).`);
  }
  // Not a system call (a package manager's own code): its message stands.
  const npm = await refusal(Object.assign(new Error("No matching version found"), { code: "E404" }));
  assert.equal(npm.code, "failure");
  assert.equal(npm.message, "No matching version found");
});
