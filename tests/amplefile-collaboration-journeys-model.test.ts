import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  ampleFileConnectedFolderOperationsGuide,
  ampleFileConnectedFolderOperationsGuideHeading,
} from "../src/local/agent/connected-folder-operations-guide.js";
import type { AmpleFileCliActReceiptV3 } from "../src/local/cli/act-receipts.js";
import { createAmpleFileCliActRequest, executeAmpleFileCliActRequest } from "../src/local/cli/index.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { ampleFileAgentScopeId } from "../src/local/state-paths.js";

/**
 * The two acceptance journeys of docs/collaboration-contract.md that only a
 * real model turn can prove, driven through the installed act lane against a
 * scripted provider that records the exact bytes each turn sent:
 *
 * - **Discover.** What a fresh Worker actually receives:
 *   the operations guide in its system prompt beside the person's Connected Folder
 *   instructions, a hidden context naming this turn's own ids, and none of the
 *   AmpleFile agent's conversation, the Connected Folder registry, or any other
 *   Connected Folder.
 *
 * The journeys that need no model (delegate and clarify, request help from a
 * Connected Folder) live in tests/amplefile-collaboration-journeys.test.ts.
 *
 * A turn is held by holding its provider request open, which is the only way
 * to act inside a genuinely running model turn; `/hold`-style extension
 * commands cannot be used here because a registered extension command skips
 * the turn-context message entirely (src/local/agent/pi-client.ts).
 */

const token = "m".repeat(64);

type ReceiptEntry = Omit<AmpleFileCliActReceiptV3, "v" | "at">;

type ScriptedReply =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; arguments: unknown }
  | { kind: "hold" };

interface ScriptedProvider {
  /** Every provider request body, in order, exactly as the model received it. */
  bodies: string[];
  baseUrl: string;
  /** Resolves once at least `count` requests are being held open. */
  waitForHolds(count: number): Promise<void>;
  /** Finish every held request with one plain answer. */
  release(text: string): void;
  close(): Promise<void>;
}

interface ProviderBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function?: { name?: string }; name?: string }>;
}

async function startScriptedProvider(script: (body: string, index: number) => ScriptedReply): Promise<ScriptedProvider> {
  const bodies: string[] = [];
  const holds: ServerResponse[] = [];
  const watchers: Array<{ count: number; resolve: () => void }> = [];
  const finish = (res: ServerResponse, reply: Exclude<ScriptedReply, { kind: "hold" }>, id: number): void => {
    const chunk = (delta: unknown, finishReason: string | null = null): void => {
      res.write(`data: ${JSON.stringify({
        id: `completion-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "journey-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
    };
    if (reply.kind === "tool") {
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: `call-${id}`, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.arguments) } }],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: reply.text });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(body);
      const index = bodies.length;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const reply = script(body, index);
      if (reply.kind !== "hold") {
        finish(res, reply, index);
        return;
      }
      res.write(": waiting\n\n");
      holds.push(res);
      for (const watcher of watchers.splice(0).filter((entry) => {
        if (holds.length < entry.count) return true;
        entry.resolve();
        return false;
      })) watchers.push(watcher);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    bodies,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    waitForHolds: (count) => holds.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => { watchers.push({ count, resolve }); }),
    release: (text) => {
      for (const [offset, res] of holds.splice(0).entries()) finish(res, { kind: "text", text }, 1_000 + offset);
    },
    close: async () => {
      for (const res of holds.splice(0)) res.end("data: [DONE]\n\n");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ModelJourney {
  sandbox: string;
  api: LocalApiHandle;
  provider: ScriptedProvider;
  records: ReceiptEntry[];
  prompts: Array<{ connectedFolderId: string; conversationId: string; taskId: string }>;
  run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  ok<T>(argv: string[]): Promise<T>;
  lastOk(): ReceiptEntry;
  close(): Promise<void>;
}

async function startModelJourney(prefix: string, options: {
  script: (body: string, index: number) => ScriptedReply;
  workerInstructions?: string;
}): Promise<ModelJourney> {
  const sandbox = await mkdtemp(join(tmpdir(), `amplefile-journey-${prefix}-`));
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const provider = await startScriptedProvider(options.script);
  await writeFile(join(agentDir, "extensions", "journey-provider.ts"), `export default function(pi) { pi.registerProvider("journey-provider", { api: "openai-completions", baseUrl: ${JSON.stringify(provider.baseUrl)}, apiKey: "synthetic", models: [{ id: "journey-model", name: "Journey Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] }); }\n`, "utf8");
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "journey-provider", defaultModel: "journey-model", defaultThinkingLevel: "off" });
  const prompts: Array<{ connectedFolderId: string; conversationId: string; taskId: string }> = [];
  const records: ReceiptEntry[] = [];
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return {
          agentDir,
          settingsManager,
          ...(options.workerInstructions ? { workerInstructions: options.workerInstructions } : {}),
        };
      },
    },
    beforeAgentPrompt: async (event) => {
      prompts.push({ connectedFolderId: event.connectedFolderId, conversationId: event.conversationId, taskId: event.taskId });
    },
  });
  const run = (argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      resolveLineageParent: (taskId) => api.resolveAmpleFileAgentLineageParent(taskId),
      receipts: {
        hasAccepted: async (requestId) => records.some((record) => record.requestId === requestId && record.outcome === "accepted"),
        append: async (record) => {
          records.push(structuredClone(record));
          return true;
        },
      },
    },
  );
  return {
    sandbox,
    api,
    provider,
    records,
    prompts,
    run,
    async ok<T>(argv: string[]): Promise<T> {
      const result = await run(argv);
      assert.equal(result.exitCode, 0, `${argv.join(" ")}\n${result.stderr}`);
      return (JSON.parse(result.stdout) as { data: T }).data;
    },
    lastOk: () => records.filter((record) => record.outcome === "ok").at(-1)!,
    close: async () => {
      provider.release("Done.");
      await api.close();
      await provider.close();
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface ResultEnvelope {
  summary: string;
  data?: unknown;
  files?: Array<{ path: string; sha256: string; sizeBytes: number }>;
  outcome: "succeeded" | "partial" | "failed";
}

/** One result shape for everyone (docs/collaboration-contract.md): wherever an envelope came from, it is checked the same way. */
function assertResultEnvelope(envelope: ResultEnvelope, expected: {
  summary: string;
  outcome: "succeeded" | "partial" | "failed";
  data?: unknown;
  files?: Array<{ path: string; bytes: string }>;
}): void {
  assert.deepEqual(
    Object.keys(envelope).sort(),
    ["data", "files", "outcome", "summary"].filter((key) => key in envelope).sort(),
    "an envelope carries summary, outcome, and the optional data and files — nothing undeclared",
  );
  assert.equal(envelope.summary, expected.summary);
  assert.equal(envelope.outcome, expected.outcome);
  if (expected.data === undefined) {
    assert.equal("data" in envelope, false, "no declared data means the key is absent, never null");
  } else {
    assert.deepEqual(envelope.data, expected.data);
  }
  const files = envelope.files ?? [];
  assert.equal(files.length, expected.files?.length ?? 0);
  for (const [index, file] of files.entries()) {
    const want = expected.files![index]!;
    assert.equal(file.path, want.path);
    assert.equal(file.path.startsWith("/"), false, "a deliverable path is Connected Folder–relative");
    assert.equal(file.sha256, createHash("sha256").update(want.bytes).digest("hex"), "the digest is the bytes on disk");
    assert.equal(file.sizeBytes, Buffer.byteLength(want.bytes, "utf8"));
  }
}

function parseBody(raw: string): ProviderBody {
  return JSON.parse(raw) as ProviderBody;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part as { text?: string }).text ?? "").join("\n");
}

function messagesOf(raw: string, role: string): string[] {
  return parseBody(raw).messages.filter((message) => message.role === role).map((message) => textOf(message.content));
}

/** The host's hidden identity block, wherever the session put it among the turn's messages. */
const turnContextMarker = "This turn's AmpleFile identity (host-owned; use these exact ids):";

function turnContextOf(raw: string): string {
  const blocks = messagesOf(raw, "user").filter((text) => text.includes(turnContextMarker));
  assert.equal(blocks.length, 1, "exactly one hidden identity block per turn");
  return blocks[0]!;
}

test("journey: a fresh Connected Folder turn receives the operations guide, its own ids, and nothing from the AmpleFile agent or the Connected Folder registry", { timeout: 60_000 }, async () => {
  const j = await startModelJourney("discover", {
    workerInstructions: "Prefer short answers.",
    script: () => ({ kind: "text", text: "I can work on files in this Connected Folder." }),
  });
  try {
    const workshop = (await j.api.actFacade.createConnectedFolder({ name: "Workshop" })).connectedFolder;
    // A second Connected Folder exists before the turn, so "the registry never enters a
    // Connected Folder turn" is a claim with something to leak.
    const elsewhere = (await j.api.actFacade.createConnectedFolder({ name: "Elsewhere" })).connectedFolder;

    const sent = await j.ok<{ conversationId: string; taskId: string }>([
      "chat", "send", "--connected-folder", workshop.id, "--new", "--message", "What can you do here?", "--json",
    ]);
    await waitFor(() => j.provider.bodies.length > 0, "the Connected Folder turn to reach the model");
    const raw = j.provider.bodies[0]!;
    const requestId = j.api.requests.byTaskId(sent.taskId)!.requestId;

    // The guide rides the system prompt the way Connected Folder instructions do: both
    // blocks, in that order, sourced from the one exported constant.
    const system = messagesOf(raw, "system").join("\n");
    assert.ok(system.includes("## Worker instructions\n\nPrefer short answers."), "the person's instructions are still there");
    assert.ok(system.includes(ampleFileConnectedFolderOperationsGuide()), "the guide is the exported constant, not a retyped copy");
    assert.ok(
      system.indexOf("## Worker instructions") < system.indexOf(ampleFileConnectedFolderOperationsGuideHeading),
      "the guide follows the person's instructions",
    );
    for (const verb of ["chat report", "chat ask", "chat answer", "chat handoff", "chat wait"]) {
      assert.ok(system.includes(verb), `the guide names ${verb}`);
    }
    assert.match(system, /Read and change this Connected Folder's folder only/);
    assert.match(system, /Never write cross-connected-folder context into this Chat: it travels with the folder\./);
    // Neither Checks nor Connected Folder apps are taught, and no
    // app-authoring tool is offered.
    assert.doesNotMatch(system, /checks (status|run)|apps (list|invoke)/);
    const tools = (parseBody(raw).tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    assert.ok(!tools.includes("propose_connected_folder_app") && !tools.includes("start_connected_folder_app"), "no app-authoring tool is offered");

    // The hidden context names this turn and this request, and nothing above.
    const users = messagesOf(raw, "user");
    assert.ok(users.includes("What can you do here?"), "the person's own message went as itself");
    const context = turnContextOf(raw);
    assert.ok(context.includes(sent.taskId), "the turn's own task id");
    assert.ok(context.includes(requestId), "the durable request id");
    assert.ok(context.includes(workshop.id));
    assert.doesNotMatch(context, /Another request delegated this work/, "nothing delegated this turn");
    assert.doesNotMatch(context, /Your assignment/);

    // Nothing from above reached it, by name.
    for (const [label, marker] of [
      ["the Connected Folder registry snapshot", "Current AmpleFile profile snapshot"],
      ["another Connected Folder's id", elsewhere.id],
      ["another Connected Folder's name", "Elsewhere"],
      ["another Connected Folder's folder", elsewhere.connectedFolderRoot],
      ["the AmpleFile agent scope", ampleFileAgentScopeId],
    ] as const) {
      assert.equal(raw.includes(marker), false, `a Connected Folder turn must not carry ${label}`);
    }
  } finally {
    await j.close();
  }
});

test("journey: a delegated Connected Folder turn sees an opaque handle and its assignment, never the AmpleFile agent's task id or conversation", { timeout: 60_000 }, async () => {
  const j = await startModelJourney("delegated", {
    // The AmpleFile agent's own turn is held open so the delegation happens inside it.
    script: (body) => (/AmpleFile profile snapshot/.test(body) ? { kind: "hold" } : { kind: "text", text: "Comparing." }),
  });
  try {
    const quotes = (await j.api.actFacade.createConnectedFolder({ name: "Quotes" })).connectedFolder;
    const root = await j.ok<{ conversationId: string; taskId: string }>([
      "agent", "send", "--new", "--message", "Have Quotes compare the vendor quotes.", "--json",
    ]);
    await j.provider.waitForHolds(1);
    const ampleFileAgentBody = j.provider.bodies[0]!;
    assert.ok(ampleFileAgentBody.includes("Current AmpleFile profile snapshot"), "the AmpleFile agent's own turn is the one that sees the registry");

    const assignment = "Compare the North and South quotes and report the winner.";
    const child = await j.ok<{ conversationId: string; taskId: string }>([
      "chat", "send", "--connected-folder", quotes.id, "--new", "--message", assignment, "--parent-task", root.taskId, "--json",
    ]);
    await waitFor(() => j.provider.bodies.length > 1, "the delegated turn to reach the model");
    const raw = j.provider.bodies[1]!;
    const context = turnContextOf(raw);
    assert.ok(context.includes(child.taskId));
    assert.ok(context.includes(j.api.requests.byTaskId(child.taskId)!.requestId));
    assert.match(context, /Another request delegated this work\. Refer to it as parent-[0-9a-f]{16}/);
    assert.match(context, /Your assignment is the message in this turn\./);
    assert.ok(messagesOf(raw, "user").includes(assignment), "the assignment is the message it was sent");
    for (const [label, marker] of [
      ["the parent's real task id", root.taskId],
      ["the AmpleFile agent's conversation", root.conversationId],
      ["the AmpleFile agent's own prompt", "Have Quotes compare the vendor quotes"],
      ["the Connected Folder registry snapshot", "Current AmpleFile profile snapshot"],
    ] as const) {
      assert.equal(raw.includes(marker), false, `a delegated Connected Folder turn must not carry ${label}`);
    }
  } finally {
    await j.close();
  }
});
