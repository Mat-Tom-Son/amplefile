import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AmpleFileDesktopCliHost } from "../desktop/src/amplefile-cli-host.js";
import type { AmpleFileActFacade } from "../src/local/cli/index.js";
import { desktopCliTest, testCli } from "./support/desktop-cli.js";

/**
 * A stand-in for the AmpleFile executable: it logs each request the shim
 * hands it and answers with that request's own id and argv, or never
 * answers when FAKE_SILENT is set.
 */
const fakeApp = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const id = process.argv[process.argv.indexOf("--amplefile-cli-request") + 1];
const root = path.join(process.env.FAKE_STATE, "cli");
const request = JSON.parse(fs.readFileSync(path.join(root, "requests", id + ".json"), "utf8"));
fs.appendFileSync(path.join(process.env.FAKE_STATE, "requests.log"), JSON.stringify({ launchedWith: id, id: request.id, lane: request.lane ?? null, argv: request.argv }) + "\\n");
if (process.env.FAKE_SILENT) process.exit(0);
const response = { protocolVersion: 1, id, exitCode: 0, stdout: JSON.stringify({ id: request.id, argv: request.argv }) + "\\n", stderr: "" };
const temporary = path.join(root, "responses", id + ".tmp");
fs.writeFileSync(temporary, JSON.stringify(response), { mode: 0o600 });
fs.renameSync(temporary, path.join(root, "responses", id + ".json"));
`;

interface Run { code: number; stdout: string; stderr: string; log: Array<{ launchedWith: string; id: string; lane: string | null; argv: string[] }> }

async function stateFolder(t: TestContext): Promise<string> {
  const state = await mkdtemp(join(tmpdir(), "amplefile-cli-request-id-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, "cli", "requests"), { recursive: true });
  await mkdir(join(state, "cli", "responses"), { recursive: true });
  await writeFile(join(state, "cli", "act-token.json"), JSON.stringify({ version: 1, actToken: "t".repeat(32) }), { mode: 0o600 });
  const app = join(state, "fake-app");
  await writeFile(app, fakeApp, "utf8");
  await chmod(app, 0o755);
  return state;
}

async function runShim(state: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile(testCli!, args, {
      env: { ...process.env, FAKE_STATE: state, AMPLEFILE_CLI_APP: join(state, "fake-app"), AMPLEFILE_CLI_STATE_DIR: state, ...env },
      timeout: 30_000,
    }, (error, out, err) => resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: out, stderr: err }));
  });
  const log = (await readFile(join(state, "requests.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Run["log"][number]);
  return { code, stdout, stderr, log };
}

test("an act's --request-id travels in its arguments, and the try keeps a request file of its own", desktopCliTest, async (t) => {
  const state = await stateFolder(t);
  const id = randomUUID();
  const run = await runShim(state, ["files", "rename", "--connected-folder", "home", "--path", "a.txt", "--name", "b.txt", "--request-id", id.toUpperCase(), "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.log.length, 1);
  const [sent] = run.log;
  assert.equal(sent?.lane, "act");
  assert.equal(sent?.launchedWith, sent?.id);
  assert.notEqual(sent?.id, id, "each try is its own request, so a caller only reads its own answer");
  assert.deepEqual(
    sent?.argv,
    ["files", "rename", "--connected-folder", "home", "--path", "a.txt", "--name", "b.txt", "--request-id", id, "--json"],
    "the act id is lowercased and stays in argv, where the host reads it",
  );
  assert.deepEqual(await readdir(join(state, "cli", "requests")), [], "the shim clears its own request");
  assert.deepEqual(await readdir(join(state, "cli", "responses")), [], "and its own answer");

  const equalsForm = await runShim(state, ["agent", "status", `--request-id=${id}`]);
  assert.equal(equalsForm.code, 0, equalsForm.stderr);
  assert.deepEqual(equalsForm.log.at(-1)?.argv, ["agent", "status", "--request-id", id]);
});

/**
 * A stand-in for the AmpleFile executable that only records each launch, so
 * the test can hand it to a real host after a delay, as Electron's
 * second-instance event hands a launch to the running app.
 */
const relayApp = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const id = process.argv[process.argv.indexOf("--amplefile-cli-request") + 1];
fs.appendFileSync(path.join(process.env.FAKE_STATE, "launches.log"), id + "\\n");
`;

async function withRealHost(t: TestContext, createDelayMs: number) {
  const state = await stateFolder(t);
  const token = "t".repeat(64);
  await writeFile(join(state, "cli", "act-token.json"), JSON.stringify({ version: 1, actToken: token }));
  await writeFile(join(state, "fake-app"), relayApp, "utf8");
  const created: string[] = [];
  const facade = {
    async createConversation(input: { connectedFolder: string }) {
      created.push(input.connectedFolder);
      if (createDelayMs) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, createDelayMs));
      return {
        connectedFolder: { id: input.connectedFolder, name: "CF", connectedFolderRoot: join(state, "cf") },
        conversation: { id: `chat-${created.length}`, title: "New Chat", createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z", archivedAt: null, snoozedUntil: null },
      };
    },
  } as unknown as AmpleFileActFacade;
  const control = { authority: null as { facade: AmpleFileActFacade; token: string } | null };
  const host = new AmpleFileDesktopCliHost({
    stateRoot: state,
    kernel: { getContext: async (actor) => ({ cwd: actor.cwd, connectedFolder: null }), listConnectedFolders: async () => [], listTasks: async () => [], listCapabilities: async () => [] },
    version: "1.0.0",
    getActFacade: () => control.authority,
  });
  await host.initialize();
  let handed = 0;
  let stopped = false;
  const relay = (async () => {
    while (!stopped) {
      const launches = (await readFile(join(state, "launches.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
      for (const launched of launches.slice(handed)) {
        handed += 1;
        setTimeout(() => { void host.processRequest(launched).catch(() => undefined); }, 150);
      }
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 10));
    }
  })();
  t.after(async () => {
    stopped = true;
    await relay;
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 200));
    await host.whenIdle();
  });
  const run = (args: string[]) => runShim(state, args, { AMPLEFILE_CLI_TIMEOUT_MS: "10000" });
  const journal = async () => (await readFile(host.receipts.path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { requestId: string; outcome: string; command: string });
  return { state, host, run, created, control, facade, token, journal };
}

test("through the real CLI and host, every try under an id gets the answer decided for that try", desktopCliTest, async (t) => {
  const { run, created, control, facade, token, journal, state } = await withRealHost(t, 0);

  // A try refused because the act authority is not up never ran, so a retry under its id runs.
  const retried = randomUUID();
  const refused = await run(["chat", "create", "--connected-folder", "cf-1", "--request-id", retried]);
  assert.equal(refused.code, 6, refused.stderr);
  control.authority = { facade, token };
  const retry = await run(["chat", "create", "--connected-folder", "cf-1", "--request-id", retried]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /Created Chat chat-1 in CF \[cf-1\]/);
  assert.deepEqual(created, ["cf-1"]);

  // A usage error never ran either, so the corrected command runs under the same id.
  const corrected = randomUUID();
  const misspelled = await run(["chat", "create", "--connected-folder", "cf-2", "--bogus", "--request-id", corrected]);
  assert.equal(misspelled.code, 2);
  assert.match(misspelled.stderr, /Unknown option: --bogus/);
  const fixed = await run(["chat", "create", "--connected-folder", "cf-2", "--request-id", corrected]);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.match(fixed.stdout, /\[cf-2\]/);
  assert.deepEqual(created, ["cf-1", "cf-2"]);

  // Any command under an id that already ran is refused and told what ran, never handed that run's output.
  for (const argv of [["--connected-folder", "cf-1"], ["--connected-folder", "cf-OTHER"]]) {
    const again = await run(["chat", "create", ...argv, "--request-id", retried]);
    assert.equal(again.code, 5, again.stderr);
    assert.equal(again.stdout, "");
    assert.match(again.stderr, /already executed \(chat create, ok at /);
  }
  assert.deepEqual(created, ["cf-1", "cf-2"], "nothing ran twice");

  const lines = await journal();
  assert.deepEqual(lines.filter((line) => line.requestId === retried).map((line) => line.outcome), ["rejected", "accepted", "ok", "rejected", "rejected"]);
  assert.deepEqual(lines.filter((line) => line.requestId === corrected).map((line) => line.outcome), ["accepted", "ok"]);
  assert.deepEqual(await readdir(join(state, "cli", "responses")), [], "every caller removed its own answer");
});

test("through the real CLI and host, two callers waiting under one id each get an answer at once, and it runs once", desktopCliTest, async (t) => {
  const { run, created, control, facade, token, host } = await withRealHost(t, 1_500);
  control.authority = { facade, token };
  const id = randomUUID();
  const argv = ["chat", "create", "--connected-folder", "cf-1", "--request-id", id];
  const first = run(argv);
  const deadline = Date.now() + 10_000;
  while (!created.length) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the first try to start.");
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 20));
  }
  // The second caller sends the same command while the first is still running it.
  const second = run(argv);
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /Created Chat chat-1/);
  assert.equal(two.code, 5, two.stderr);
  assert.match(two.stderr, /already executed \(chat create, ok at /, "the second hears what the id did");
  assert.deepEqual(created, ["cf-1"], "the act ran once");
  await host.whenIdle();
});

test("a malformed --request-id is refused before anything is sent", desktopCliTest, async (t) => {
  const state = await stateFolder(t);
  const run = await runShim(state, ["agent", "status", "--request-id", "req-1"]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--request-id must be a UUID, such as one uuidgen prints/);
  assert.deepEqual(run.log, [], "the app is never asked");
  const twice = await runShim(state, ["agent", "status", "--request-id", randomUUID(), "--request-id", randomUUID()]);
  assert.equal(twice.code, 2);
  assert.match(twice.stderr, /--request-id may be provided only once/);
});

test("receipts show rides the act lane, and a wait that runs out says how to ask what became of the act", desktopCliTest, async (t) => {
  const state = await stateFolder(t);
  const asked = randomUUID();
  const read = await runShim(state, ["receipts", "show", "--id", asked, "--json"]);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(read.log[0]?.lane, "act");
  assert.deepEqual(read.log[0]?.argv, ["receipts", "show", "--id", asked, "--json"]);

  const id = randomUUID();
  const silent = await runShim(state, ["files", "mkdir", "--connected-folder", "home", "--path", "Inbox", "--request-id", id], { FAKE_SILENT: "1", AMPLEFILE_CLI_TIMEOUT_MS: "300" });
  assert.equal(silent.code, 124);
  assert.match(silent.stderr, new RegExp(`did not answer act ${id} within 300 ms\\. 'amplefile receipts show --id ${id}' tells whether it ran\\.`));
  assert.deepEqual(await readdir(join(state, "cli", "requests")), [], "a try nobody picked up is withdrawn");

  const unnamed = await runShim(state, ["agent", "status"], { FAKE_SILENT: "1", AMPLEFILE_CLI_TIMEOUT_MS: "1000" });
  assert.equal(unnamed.code, 124);
  assert.equal(unnamed.log.length, 3);
  const actId = unnamed.log.at(-1)!.id;
  assert.ok(unnamed.stderr.includes(`did not answer act ${actId} within 1000 ms. 'amplefile receipts show --id ${actId}' tells whether it ran.`));
});
