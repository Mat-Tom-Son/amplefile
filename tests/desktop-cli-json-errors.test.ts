import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { desktopCliTest, testCli } from "./support/desktop-cli.js";

/**
 * A stand-in for the AmpleFile executable. It reports an Automation run as
 * still running to every status read, or never answers when FAKE_SILENT is set.
 */
const fakeApp = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
if (process.env.FAKE_SILENT) process.exit(0);
const id = process.argv[process.argv.indexOf("--amplefile-cli-request") + 1];
const root = path.join(process.env.FAKE_STATE, "cli");
const stdout = JSON.stringify({ ok: true, data: { automationId: "automation-1", run: { runId: "run-1", state: "running" } } }) + "\\n";
const response = { protocolVersion: 1, id, exitCode: 0, stdout, stderr: "" };
const temporary = path.join(root, "responses", id + ".tmp");
fs.writeFileSync(temporary, JSON.stringify(response), { mode: 0o600 });
fs.renameSync(temporary, path.join(root, "responses", id + ".json"));
`;

async function stateFolder(t: TestContext, options: { actToken: boolean }): Promise<string> {
  const state = await mkdtemp(join(tmpdir(), "amplefile-cli-json-errors-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(join(state, "cli", "requests"), { recursive: true });
  await mkdir(join(state, "cli", "responses"), { recursive: true });
  if (options.actToken) {
    await writeFile(join(state, "cli", "act-token.json"), JSON.stringify({ version: 1, actToken: "t".repeat(32) }), { mode: 0o600 });
  }
  await writeFile(join(state, "fake-app"), fakeApp, "utf8");
  await chmod(join(state, "fake-app"), 0o755);
  return state;
}

function runCli(state: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(testCli!, args, {
      env: { ...process.env, FAKE_STATE: state, AMPLEFILE_CLI_APP: join(state, "fake-app"), AMPLEFILE_CLI_STATE_DIR: state, ...env },
      timeout: 30_000,
    }, (error, stdout, stderr) => resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

function assertJsonFailure(run: { code: number; stdout: string; stderr: string }, exit: number, code: string, message: RegExp): void {
  assert.equal(run.code, exit, run.stderr);
  assert.equal(run.stdout, "");
  assert.ok(run.stderr.endsWith("\n"), "stderr ends with a newline");
  const value = JSON.parse(run.stderr) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(value.ok, false);
  assert.equal(value.error.code, code);
  assert.match(value.error.message, message);
}

test("with --json, the command's own failures are one JSON object on stderr and keep their exit codes", desktopCliTest, async (t) => {
  const state = await stateFolder(t, { actToken: true });
  assertJsonFailure(
    await runCli(state, ["chat", "send", "--connected-folder", "Inbox", "--new", "--message", "hi", "--request-id", "not-a-uuid", "--json"]),
    2, "usage", /must be a UUID/,
  );
  assertJsonFailure(
    await runCli(state, ["automations", "wait", "--automation", "automation-1", "--run", "run-1", "--timeout", "1", "--json"]),
    7, "timeout", /automations wait timed out after 1s/,
  );
  const id = "5a6f0c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
  assertJsonFailure(
    await runCli(state, ["files", "mkdir", "--connected-folder", "Inbox", "--path", "Sorted", "--request-id", id, "--json"], { FAKE_SILENT: "1", AMPLEFILE_CLI_TIMEOUT_MS: "300" }),
    124, "timeout", new RegExp(`receipts show --id ${id}`),
  );
});

test("with --json, a missing app is reported as unavailable", desktopCliTest, async (t) => {
  const state = await stateFolder(t, { actToken: false });
  assertJsonFailure(await runCli(state, ["files", "mkdir", "--connected-folder", "Inbox", "--path", "Sorted", "--json"]), 6, "unavailable", /Open AmpleFile/);
});

test("without --json, the command's own failures stay one plain line", desktopCliTest, async (t) => {
  const state = await stateFolder(t, { actToken: false });
  const run = await runCli(state, ["files", "mkdir", "--connected-folder", "Inbox", "--path", "Sorted"]);
  assert.equal(run.code, 6);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /^AmpleFile: Open AmpleFile/);
  assert.equal(run.stderr.trim().split("\n").length, 1);
});
