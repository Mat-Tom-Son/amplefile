import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { desktopCliTest, testCli } from "./support/desktop-cli.js";

/**
 * `chat wait` runs inside the installed command: it polls `chat status` and
 * ends with that status (waiting on an answer) or with `chat result`. A wait
 * run by a parent's own turn names that turn with `--parent-task`, and every
 * read the wait makes must carry it, because the host records a child turn
 * as received by its parent only for a read attributed to the parent's turn
 * (docs/collaboration-contract.md).
 *
 * The stand-in app logs each request's argv and answers a status read with
 * the task FAKE_TASK_STATE describes (waiting on an answer, or finished),
 * and a result read with a reply.
 */
const fakeApp = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const id = process.argv[process.argv.indexOf("--amplefile-cli-request") + 1];
const root = path.join(process.env.FAKE_STATE, "cli");
const request = JSON.parse(fs.readFileSync(path.join(root, "requests", id + ".json"), "utf8"));
fs.appendFileSync(path.join(process.env.FAKE_STATE, "requests.log"), JSON.stringify(request.argv) + "\\n");
const waiting = process.env.FAKE_TASK_STATE === "waiting";
const data = request.argv[1] === "status"
  ? { task: { state: waiting ? "running" : "succeeded" }, waiting: waiting ? { questionId: "q-1", question: "Deduct refunds?" } : null, request: { state: waiting ? "waiting" : "done" } }
  : { task: { state: "succeeded" }, message: { content: "Done." } };
const response = { protocolVersion: 1, id, exitCode: 0, stdout: JSON.stringify({ ok: true, data }) + "\\n", stderr: "" };
const temporary = path.join(root, "responses", id + ".tmp");
fs.writeFileSync(temporary, JSON.stringify(response), { mode: 0o600 });
fs.renameSync(temporary, path.join(root, "responses", id + ".json"));
`;

async function stateFolder(t: TestContext): Promise<string> {
  const state = await mkdtemp(join(tmpdir(), "amplefile-cli-chat-wait-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, "cli", "requests"), { recursive: true });
  await mkdir(join(state, "cli", "responses"), { recursive: true });
  await writeFile(join(state, "cli", "act-token.json"), JSON.stringify({ version: 1, actToken: "t".repeat(32) }), { mode: 0o600 });
  const app = join(state, "fake-app");
  await writeFile(app, fakeApp, "utf8");
  await chmod(app, 0o755);
  return state;
}

async function runWait(state: string, args: string[], taskState: "waiting" | "finished"): Promise<{ code: number; stderr: string; reads: string[][] }> {
  const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolveRun) => {
    execFile(testCli!, args, {
      env: { ...process.env, FAKE_STATE: state, FAKE_TASK_STATE: taskState, AMPLEFILE_CLI_APP: join(state, "fake-app"), AMPLEFILE_CLI_STATE_DIR: state },
      timeout: 30_000,
    }, (error, _out, err) => resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stderr: err }));
  });
  const reads = (await readFile(join(state, "requests.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  await rm(join(state, "requests.log"), { force: true });
  return { code, stderr, reads };
}

test("a parent's chat wait names its own turn on every read it makes", desktopCliTest, async (t) => {
  const state = await stateFolder(t);
  const wait = ["chat", "wait", "--connected-folder", "space-0000000000000002", "--task", "task-child", "--parent-task", "task-root", "--json"];

  // Waiting on an answer: the wait ends with the status that shows the question.
  const waiting = await runWait(state, wait, "waiting");
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.deepEqual(waiting.reads, [["chat", "status", "--connected-folder", "space-0000000000000002", "--parent-task", "task-root", "--task", "task-child", "--json"]]);

  // Finished: the wait ends with the result, which names the parent's turn too.
  const finished = await runWait(state, wait, "finished");
  assert.equal(finished.code, 0, finished.stderr);
  assert.deepEqual(finished.reads.map((argv) => argv.slice(0, 2)), [["chat", "status"], ["chat", "result"]]);
  for (const argv of finished.reads) assert.equal(argv[argv.indexOf("--parent-task") + 1], "task-root", `${argv.slice(0, 2).join(" ")} names the parent's turn`);
});

test("a wait that names no turn reads without one, as a person's would", desktopCliTest, async (t) => {
  const state = await stateFolder(t);
  const run = await runWait(state, ["agent", "wait", "--task", "task-child", "--json"], "finished");
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.reads.length >= 2);
  for (const argv of run.reads) assert.ok(!argv.includes("--parent-task"), `${argv.slice(0, 2).join(" ")} carries no turn`);
});
