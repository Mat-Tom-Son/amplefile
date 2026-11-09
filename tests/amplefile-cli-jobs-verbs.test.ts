import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AmpleFileCliActReceiptV3 } from "../src/local/cli/act-receipts.js";
import { createAmpleFileCliActRequest, executeAmpleFileCliActRequest } from "../src/local/cli/index.js";
import { parseAmpleFileCliActArgv } from "../src/local/cli/act-commands.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * The `amplefile jobs` family end to end (docs/background-jobs.md): argv →
 * executor → the real facade inside startLocalApi, inside a Worker turn held
 * at the prompt gate so `--task` names a turn that is really running.
 */

const token = "b".repeat(64);
type ReceiptEntry = Omit<AmpleFileCliActReceiptV3, "v" | "at">;

interface Harness {
  sandbox: string;
  api: LocalApiHandle;
  records: ReceiptEntry[];
  run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  ok<T>(argv: string[]): Promise<T>;
  heldTurn(connectedFolderId: string, message: string): Promise<{ taskId: string; conversationId: string; release: () => void }>;
  /** Lets a turn the host started itself (a follow-up) past the prompt gate. */
  release(taskId: string): Promise<void>;
}

async function startHarness(t: { after: (fn: () => unknown) => void }): Promise<Harness> {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-jobs-cli-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", { description: "Hold a test turn", handler: async () => await new Promise((resolve) => setTimeout(resolve, 25)) });
  }\n`, "utf8");
  const pending = new Map<string, () => void>();
  let draining = false;
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    beforeAgentPrompt: async (event) => {
      if (draining) return;
      await new Promise<void>((release) => pending.set(event.taskId, release));
    },
  });
  t.after(async () => {
    draining = true;
    for (const release of pending.values()) release();
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const records: ReceiptEntry[] = [];
  const run = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      resolveLineageParent: (taskId) => api.resolveAmpleFileAgentLineageParent(taskId),
      receipts: {
        hasAccepted: async (requestId) => records.some((record) => record.requestId === requestId && record.outcome === "accepted"),
        append: async (record) => { records.push(structuredClone(record)); return true; },
      },
    },
  );
  return {
    sandbox,
    api,
    records,
    run,
    async ok<T>(argv: string[]): Promise<T> {
      const result = await run(argv);
      assert.equal(result.exitCode, 0, `${argv.join(" ")}\n${result.stderr}`);
      return (JSON.parse(result.stdout) as { data: T }).data;
    },
    async release(taskId) {
      await waitFor(() => pending.has(taskId), `turn ${taskId} to reach the prompt gate`);
      pending.get(taskId)?.();
      pending.delete(taskId);
    },
    async heldTurn(connectedFolderId, message) {
      const sent = await api.actFacade.sendMessage({ connectedFolder: connectedFolderId, newConversation: true, content: message });
      await waitFor(() => pending.has(sent.taskId), "the turn to reach the prompt gate");
      return {
        taskId: sent.taskId,
        conversationId: sent.conversationId,
        release: () => { pending.get(sent.taskId)?.(); pending.delete(sent.taskId); },
      };
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function errorOf(stderr: string): { code?: string; message?: string } {
  try {
    return (JSON.parse(stderr) as { error?: { code?: string; message?: string } }).error ?? {};
  } catch {
    return {};
  }
}

interface JobJson {
  jobId: string;
  name: string;
  state: string;
  status: string;
  stoppedBy: string | null;
  conversationId: string;
  taskId: string;
  delivery: { by: string; taskId: string | null } | null;
}

test("jobs verbs parse with explicit selection and refuse what they cannot take", () => {
  const start = parseAmpleFileCliActArgv(["jobs", "start", "--connected-folder", "Site", "--task", "turn-1", "--command", "npm run build", "--name", "Build", "--timeout", "90", "--json"]);
  assert.equal(start.name, "jobs.start");
  assert.equal(start.jobCommand, "npm run build");
  assert.equal(start.timeoutSeconds, 90);
  assert.throws(() => parseAmpleFileCliActArgv(["jobs", "start", "--task", "turn-1", "--command", "true"]), /--connected-folder/);
  assert.throws(() => parseAmpleFileCliActArgv(["jobs", "start", "--connected-folder", "Site", "--command", "true"]), /--task/);
  assert.throws(() => parseAmpleFileCliActArgv(["jobs", "start", "--connected-folder", "Site", "--task", "t", "--command", "true", "--command-file", "c.sh"]), /either --command/);
  assert.throws(() => parseAmpleFileCliActArgv(["jobs", "start", "--connected-folder", "Site", "--task", "t", "--command", "true", "--timeout", "0"]), /--timeout/);
  assert.throws(() => parseAmpleFileCliActArgv(["jobs", "output", "--connected-folder", "Site", "--job", "j", "--wait", "-1"]), /--wait/);
  // One call waits at most ten minutes; a longer wait is a repeat read.
  assert.throws(() => parseAmpleFileCliActArgv(["jobs", "output", "--connected-folder", "Site", "--job", "j", "--wait", "601"]), /--wait is at most 600 seconds/);
  assert.equal(parseAmpleFileCliActArgv(["jobs", "output", "--connected-folder", "Site", "--job", "j", "--wait", "600"]).waitSeconds, 600);
  assert.throws(() => parseAmpleFileCliActArgv(["jobs", "show", "--connected-folder", "Site", "--job", "j", "--parent-task", "x"]), /--parent-task/);
  const output = parseAmpleFileCliActArgv(["jobs", "output", "--connected-folder", "Site", "--job", "j", "--offset", "10", "--limit", "5000", "--until", "ready|listening", "--wait", "30"]);
  assert.deepEqual([output.offset, output.limit, output.until, output.waitSeconds], [10, 5000, "ready|listening", 30]);
});

test("a Worker starts, reads, and stops jobs through the CLI with receipts", async (t) => {
  const h = await startHarness(t);
  const { connectedFolder } = await h.api.actFacade.createConnectedFolder({ name: "Site" });
  const { connectedFolder: other } = await h.api.actFacade.createConnectedFolder({ name: "Elsewhere" });
  const turn = await h.heldTurn(connectedFolder.id, "/hold Build the site.");

  const started = await h.ok<{ job: JobJson }>([
    "jobs", "start", "--connected-folder", connectedFolder.id, "--task", turn.taskId,
    "--command", "echo hello; sleep 0.3; echo done", "--name", "Build", "--json",
  ]);
  assert.equal(started.job.name, "Build");
  assert.equal(started.job.conversationId, turn.conversationId);
  assert.equal(h.records.find((record) => record.command === "jobs.start" && record.outcome === "ok")?.detail?.startsWith(`job ${started.job.jobId}; running`), true);

  const listed = await h.ok<{ jobs: JobJson[] }>(["jobs", "list", "--connected-folder", connectedFolder.id, "--json"]);
  assert.deepEqual(listed.jobs.map((job) => job.jobId), [started.job.jobId]);

  // A read from the starting turn, in the job's own Chat, is its delivery.
  const read = await h.ok<{ job: JobJson; output: { text: string; totalLines: number }; wait: { outcome: string } }>([
    "jobs", "output", "--connected-folder", connectedFolder.id, "--job", started.job.jobId, "--wait", "10", "--task", turn.taskId, "--json",
  ]);
  assert.equal(read.wait.outcome, "ended");
  assert.equal(read.job.state, "exited");
  assert.equal(read.output.text, "hello\ndone");
  assert.equal(read.job.delivery?.by, "read");

  // Another Connected Folder cannot reach it.
  const elsewhere = await h.run(["jobs", "show", "--connected-folder", other.id, "--job", started.job.jobId, "--json"]);
  assert.equal(errorOf(elsewhere.stderr).code, "notFound");

  // A long job, then stop: the whole group ends and the receipt says so.
  await writeFile(join(h.sandbox, "serve.sh"), "echo serving\nsleep 30\n", "utf8");
  const server = await h.ok<{ job: JobJson }>([
    "jobs", "start", "--connected-folder", connectedFolder.id, "--task", turn.taskId, "--command-file", "serve.sh", "--name", "Server", "--json",
  ]);
  const ready = await h.ok<{ wait: { outcome: string; text?: string } }>([
    "jobs", "output", "--connected-folder", connectedFolder.id, "--job", server.job.jobId, "--until", "serv(ing|ed)", "--wait", "10", "--json",
  ]);
  assert.deepEqual([ready.wait.outcome, ready.wait.text], ["matched", "serving"]);
  const stopped = await h.ok<{ job: JobJson }>(["jobs", "stop", "--connected-folder", connectedFolder.id, "--job", server.job.jobId, "--json"]);
  assert.equal(stopped.job.state, "stopped");
  assert.equal(stopped.job.stoppedBy, "cli");

  turn.release();
  // The read delivered the first job; the stopped one, which no turn read,
  // wakes the Chat once, and the request stays working until it has.
  await waitFor(() => (h.api.requests.byTaskId(turn.taskId)?.turns.length ?? 0) >= 2, "one follow-up for the stopped job");
  assert.equal(h.api.requests.byTaskId(turn.taskId)!.state, "working");
  assert.deepEqual(h.api.requests.byTaskId(turn.taskId)!.deliveredJobIds?.sort(), [started.job.jobId, server.job.jobId].sort());
  // This harness has no model, so the follow-up settles without a reply.
  await h.release(h.api.requests.byTaskId(turn.taskId)!.turns[1]!.taskId);
  await waitFor(() => h.api.requests.byTaskId(turn.taskId)?.state !== "working", "the follow-up to settle");
  const record = h.api.requests.byTaskId(turn.taskId)!;
  assert.equal(record.turns.length, 2);
  assert.deepEqual(record.jobs?.map((job) => job.state), ["exited", "stopped"]);
  assert.deepEqual(record.actions.map((action) => action.command).filter((command) => command.startsWith("jobs.")), ["jobs.start", "jobs.start"]);

  // requests show carries the jobs.
  const shown = await h.ok<{ request: { jobs: Array<{ jobId: string }> } }>(["requests", "show", "--request", record.requestId, "--json"]);
  assert.equal(shown.request.jobs.length, 2);
});

test("jobs start needs the caller's own running turn", async (t) => {
  const h = await startHarness(t);
  const { connectedFolder } = await h.api.actFacade.createConnectedFolder({ name: "Site" });
  const turn = await h.heldTurn(connectedFolder.id, "/hold Wait here.");
  turn.release();
  await waitFor(async () => (await h.api.actFacade.turnStatus({ connectedFolder: connectedFolder.id, taskId: turn.taskId })).task.state !== "running", "the turn to end");
  const refused = await h.run([
    "jobs", "start", "--connected-folder", connectedFolder.id, "--task", turn.taskId, "--command", "true", "--json",
  ]);
  assert.equal(errorOf(refused.stderr).code, "conflict");
  assert.match(errorOf(refused.stderr).message ?? "", /already finished|stopping/);
  assert.equal(h.api.jobs.list().length, 0);
});
