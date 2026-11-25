import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shim = join(rootDir, "desktop", "cli", "amplefile");

/**
 * A stand-in for the AmpleFile executable: it answers each CLI request the
 * shim hands it, reporting the run as running on the first status read and
 * settled with FAKE_OUTCOME afterwards, and logs every argv it was asked.
 */
const fakeApp = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const id = process.argv[process.argv.indexOf("--amplefile-cli-request") + 1];
const state = process.env.FAKE_STATE;
const root = path.join(state, "cli");
const request = JSON.parse(fs.readFileSync(path.join(root, "requests", id + ".json"), "utf8"));
const counter = path.join(state, "reads");
const reads = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(reads));
fs.appendFileSync(path.join(state, "argv.log"), JSON.stringify(request.argv) + "\\n");
const run = reads >= 2
  ? { runId: "run-1", state: "settled", outcome: process.env.FAKE_OUTCOME, startedAt: "s", finishedAt: "f" }
  : { runId: "run-1", state: "running" };
const stdout = request.argv.includes("--json")
  ? JSON.stringify({ ok: true, data: { automationId: "automation-1", title: "Tidy", run } }) + "\\n"
  : "Run run-1 is " + run.state + ".\\n";
const response = { protocolVersion: 1, id, exitCode: 0, stdout, stderr: "" };
const temporary = path.join(root, "responses", id + ".tmp");
fs.writeFileSync(temporary, JSON.stringify(response));
fs.renameSync(temporary, path.join(root, "responses", id + ".json"));
`;

async function waitWith(outcome: string, extra: string[]): Promise<{ code: number; stdout: string; argv: string[][] }> {
  const state = await mkdtemp(join(tmpdir(), "amplefile-cli-automation-wait-"));
  try {
    await mkdir(join(state, "cli"), { recursive: true });
    await writeFile(join(state, "cli", "act-token.json"), JSON.stringify({ version: 1, actToken: "t".repeat(32) }));
    const app = join(state, "fake-app");
    await writeFile(app, fakeApp, "utf8");
    await chmod(app, 0o755);
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolveRun) => {
      execFile(shim, ["automations", "wait", "--automation", "automation-1", "--run", "run-1", ...extra], {
        env: { ...process.env, FAKE_STATE: state, FAKE_OUTCOME: outcome, AMPLEFILE_CLI_APP: app, AMPLEFILE_CLI_STATE_DIR: state },
        timeout: 30_000,
      }, (error, out) => resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: out }));
    });
    const argv = (await readFile(join(state, "argv.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    return { code, stdout, argv };
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

test("automations wait polls the status read until the run settles, and says how it ended", { skip: process.platform !== "darwin" }, async () => {
  const status = ["automations", "status", "--automation", "automation-1", "--run", "run-1", "--json"];

  const succeeded = await waitWith("success", ["--json"]);
  assert.equal(succeeded.code, 0);
  assert.deepEqual(succeeded.argv, [status, status], "each poll is one quick status read; nothing holds the app");
  assert.equal((JSON.parse(succeeded.stdout) as { data: { run: { state: string } } }).data.run.state, "settled");

  const failed = await waitWith("failure", ["--json"]);
  assert.equal(failed.code, 1, "a run that did not succeed exits 1");

  const human = await waitWith("success", []);
  assert.equal(human.code, 0);
  assert.deepEqual(human.argv.at(-1), status.slice(0, -1), "a person sees the settled status in words");
  assert.match(human.stdout, /is settled/);
});
