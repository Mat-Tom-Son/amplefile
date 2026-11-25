import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shim = join(rootDir, "desktop", "cli", "amplefile");
const onMac = { skip: process.platform !== "darwin" };

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
fs.writeFileSync(temporary, JSON.stringify(response));
fs.renameSync(temporary, path.join(root, "responses", id + ".json"));
`;

interface Run { code: number; stdout: string; stderr: string; log: Array<{ launchedWith: string; id: string; lane: string | null; argv: string[] }> }

async function stateFolder(t: TestContext): Promise<string> {
  const state = await mkdtemp(join(tmpdir(), "amplefile-cli-request-id-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, "cli", "requests"), { recursive: true });
  await mkdir(join(state, "cli", "responses"), { recursive: true });
  await writeFile(join(state, "cli", "act-token.json"), JSON.stringify({ version: 1, actToken: "t".repeat(32) }));
  const app = join(state, "fake-app");
  await writeFile(app, fakeApp, "utf8");
  await chmod(app, 0o755);
  return state;
}

async function runShim(state: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile(shim, args, {
      env: { ...process.env, FAKE_STATE: state, AMPLEFILE_CLI_APP: join(state, "fake-app"), AMPLEFILE_CLI_STATE_DIR: state, ...env },
      timeout: 30_000,
    }, (error, out, err) => resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: out, stderr: err }));
  });
  const log = (await readFile(join(state, "requests.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Run["log"][number]);
  return { code, stdout, stderr, log };
}

test("an act sent with --request-id travels under that id, so the caller holds it before any wait", onMac, async (t) => {
  const state = await stateFolder(t);
  const id = randomUUID();
  const run = await runShim(state, ["files", "rename", "--connected-folder", "home", "--path", "a.txt", "--name", "b.txt", "--request-id", id.toUpperCase(), "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.log, [{
    launchedWith: id,
    id,
    lane: "act",
    argv: ["files", "rename", "--connected-folder", "home", "--path", "a.txt", "--name", "b.txt", "--request-id", id, "--json"],
  }], "the id is lowercased as the broker names files, and stays in argv for the host to check");
  assert.deepEqual(await readdir(join(state, "cli", "requests")), [], "the shim cleans up after its answer");

  const equalsForm = await runShim(state, ["agent", "status", `--request-id=${id}`]);
  assert.equal(equalsForm.code, 0, equalsForm.stderr);
  assert.equal(equalsForm.log.at(-1)?.id, id);
});

test("a retry under the same --request-id joins a first try that is still waiting to be picked up", onMac, async (t) => {
  const state = await stateFolder(t);
  const id = randomUUID();
  const first = { protocolVersion: 3, lane: "act", id, argv: ["files", "delete", "--connected-folder", "home", "--path", "first.txt", "--request-id", id], cwd: "/", createdAt: new Date().toISOString(), actToken: "t".repeat(32) };
  await writeFile(join(state, "cli", "requests", `${id}.json`), JSON.stringify(first));
  const retry = await runShim(state, ["files", "delete", "--connected-folder", "home", "--path", "first.txt", "--request-id", id]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(retry.log.length, 1, "one request, one answer");
  assert.deepEqual(retry.log[0]?.argv, first.argv, "the first try is answered, not overwritten by a second");
  assert.deepEqual(JSON.parse(retry.stdout), { id, argv: first.argv });
});

test("a malformed --request-id is refused before anything is sent", onMac, async (t) => {
  const state = await stateFolder(t);
  const run = await runShim(state, ["agent", "status", "--request-id", "req-1"]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--request-id must be a UUID, such as one uuidgen prints/);
  assert.deepEqual(run.log, [], "the app is never asked");
  const twice = await runShim(state, ["agent", "status", "--request-id", randomUUID(), "--request-id", randomUUID()]);
  assert.equal(twice.code, 2);
  assert.match(twice.stderr, /--request-id may be provided only once/);
});

test("receipts show rides the act lane, and a wait that runs out says how to ask what became of the act", onMac, async (t) => {
  const state = await stateFolder(t);
  const asked = randomUUID();
  const read = await runShim(state, ["receipts", "show", "--id", asked, "--json"]);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(read.log[0]?.lane, "act");
  assert.deepEqual(read.log[0]?.argv, ["receipts", "show", "--id", asked, "--json"]);

  const id = randomUUID();
  const silent = await runShim(state, ["files", "mkdir", "--connected-folder", "home", "--path", "Inbox", "--request-id", id], { FAKE_SILENT: "1", AMPLEFILE_CLI_TIMEOUT_MS: "300" });
  assert.equal(silent.code, 124);
  assert.match(silent.stderr, new RegExp(`did not answer CLI request ${id} within 300 ms\\. 'amplefile receipts show --id ${id}' tells whether it ran\\.`));
});
