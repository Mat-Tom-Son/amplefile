import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { AMPLEFILE_CLI_ACT_MAX_PAYLOAD_BYTES } from "../src/local/cli/act-protocol.js";
import { secureStorageAvailable } from "../desktop/src/secure-storage.js";
import { prepareLinuxDevelopmentCli } from "../desktop/src/linux-development-cli.js";

const run = promisify(execFile);
const cli = resolve("out/included-tools/linux-cli/amplefile-cli");
const native = process.platform === "linux" && existsSync(cli);

test("Linux development CLI fails at setup when the native transport has not been prepared", async t => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-dev-cli-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => prepareLinuxDevelopmentCli({ repoRoot: root, stateDirectory: join(root, "state"), electronPath: process.execPath }), /desktop:linux-native-hosts/);
});

test("Linux development Worker shells find the native CLI and preserve profile, repository, and argv", { skip: !native }, async t => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-dev-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, "repo's $data `literal`");
  const stateDirectory = join(root, "profile's data");
  const electronPath = join(root, "fake electron's launcher");
  await mkdir(join(repoRoot, "out/included-tools/linux-cli"), { recursive: true });
  await copyFile(cli, join(repoRoot, "out/included-tools/linux-cli/amplefile-cli"));
  await writeFile(electronPath, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const id = process.argv[4], root = path.join(process.env.AMPLEFILE_CLI_STATE_DIR, 'cli');
const request = JSON.parse(fs.readFileSync(path.join(root, 'requests', id + '.json')));
const data = { request, launchArguments: process.argv.slice(2) };
fs.writeFileSync(path.join(root, 'responses', id + '.json'), JSON.stringify({protocolVersion:1,id,exitCode:0,stdout:JSON.stringify(data),stderr:''}), {mode:0o600});
`);
  await chmod(electronPath, 0o700);
  const launch = prepareLinuxDevelopmentCli({ repoRoot, stateDirectory, electronPath });
  const env = { ...process.env, PATH: `${launch.binDirectory}:${process.env.PATH}`, AMPLEFILE_CLI_APP: launch.appPath,
    AMPLEFILE_CLI_STATE_DIR: stateDirectory, AMPLEFILE_CLI_TIMEOUT_MS: "3000" };
  const reply = JSON.parse((await run("/bin/bash", ["-c", "amplefile context --json"], { env, cwd: repoRoot })).stdout);
  assert.equal(reply.launchArguments[0], repoRoot);
  assert.equal(reply.launchArguments[1], "--amplefile-cli-request");
  assert.equal(reply.request.cwd, repoRoot);
  assert.equal(reply.request.protocolVersion, 1);
  await writeFile(join(stateDirectory, "cli/act-token.json"), JSON.stringify({ version: 1, actToken: "d".repeat(64) }), { mode: 0o600 });
  const act = JSON.parse((await run("/bin/bash", ["-c", 'amplefile files list --connected-folder "Test Folder" --json'], { env, cwd: repoRoot })).stdout);
  assert.equal(act.request.protocolVersion, 3);
  assert.equal(act.request.lane, "act");
  assert.deepEqual(act.request.argv, ["files", "list", "--connected-folder", "Test Folder", "--json"]);
});

test("Linux credentials require an actual keyring and retain other platform behavior", () => {
  for (const backend of ["basic_text", "unknown", ""]) assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend }, "linux"), false);
  for (const backend of ["gnome_libsecret", "kwallet5", "kwallet6"]) assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend }, "linux"), true);
  assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "gnome_libsecret" }, "linux"), false);
  assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => { throw new Error("Linux only"); } }, "darwin"), true);
});

test("native Linux CLI preserves read/act lanes, payloads, waiting, and response identity", { skip: !native }, async t => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-linux-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "profile"); const app = join(root, "fake-app");
  await mkdir(join(state, "cli"), { recursive: true });
  await writeFile(app, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const id = process.argv[3], root = path.join(process.env.AMPLEFILE_CLI_STATE_DIR, 'cli');
const request = JSON.parse(fs.readFileSync(path.join(root, 'requests', id + '.json')));
fs.writeFileSync(path.join(root, 'last.json'), JSON.stringify(request));
const data = request.argv.includes('status') && ['chat', 'agent'].includes(request.argv[0]) ? {task:{state:'running'},requestGraph:{state:'waiting'},waiting:{questionId:'q'}} : request;
const response = {protocolVersion:1,id:process.env.WRONG_ID ? 'wrong' : id,exitCode:0,stdout:JSON.stringify({data}),stderr:''};
fs.writeFileSync(path.join(root,'responses',id+'.json'),JSON.stringify(response),{mode:0o600});
`); await chmod(app, 0o755);
  const env = { ...process.env, AMPLEFILE_CLI_STATE_DIR: state, AMPLEFILE_CLI_APP: app, AMPLEFILE_CLI_TIMEOUT_MS: "2000" };
  const bin = join(root, "package/bin"), system = join(root, "system-bin");
  await mkdir(bin, { recursive: true }); await mkdir(system);
  await copyFile("desktop/cli/amplefile", join(bin, "amplefile"));
  await copyFile(cli, join(bin, "amplefile-cli"));
  await chmod(join(bin, "amplefile"), 0o755); await chmod(join(bin, "amplefile-cli"), 0o755);
  await symlink(join(bin, "amplefile"), join(system, "amplefile"));
  assert.equal(JSON.parse((await run(join(system, "amplefile"), ["context", "--json"], { env })).stdout).data.protocolVersion, 1, "installed CLI resolves its native sibling through the system symlink");
  let reply = JSON.parse((await run(cli, ["context", "--json"], { env })).stdout).data;
  assert.equal(reply.protocolVersion, 1); assert.equal(reply.actToken, undefined);
  for (const args of [["agent", "--help"], ["connected-folders", "list"], ["automations", "-h"], ["jobs", "--help"], ["worktrees", "-h"]]) {
    const help = JSON.parse((await run(cli, [...args, "--json"], { env })).stdout).data;
    assert.equal(help.protocolVersion, 1, "content-free commands need no launch token");
  }
  await assert.rejects(run(cli, ["files", "list", "--connected-folder", "Test"], { env }), (error: any) => error.code === 6);
  for (const group of ["jobs", "worktrees"]) {
    await assert.rejects(run(cli, [group, "list", "--json"], { env }), (error: any) => error.code === 6);
  }
  await writeFile(join(state, "cli/act-token.json"), JSON.stringify({ version: 1, actToken: "a".repeat(64) }), { mode: 0o600 });
  for (const args of [["agent", "chats"], ["connected-folders", "create"], ["automations", "list"], ["recently-deleted", "list"], ["jobs", "list"], ["worktrees", "manage"]]) {
    const act = JSON.parse((await run(cli, [...args, "--json"], { env })).stdout).data;
    assert.equal(act.protocolVersion, 3); assert.equal(act.actToken, "a".repeat(64));
  }
  const message = join(root, "message.txt"); await writeFile(message, "A real\nUTF-8 message: café");
  reply = JSON.parse((await run(cli, ["chat", "send", "--connected-folder", "Test", "--message-file", message, "--json"], { env })).stdout).data;
  assert.equal(reply.protocolVersion, 3); assert.equal(reply.lane, "act"); assert.equal(reply.payload.messageFile, "A real\nUTF-8 message: café"); assert.ok(reply.argv.includes("--message-from-payload"));
  reply = JSON.parse((await run(cli, ["agent", "wait", "--task", "t", "--json"], { env })).stdout).data;
  assert.equal(reply.requestGraph.state, "waiting");
  const last = JSON.parse(await readFile(join(state, "cli/last.json"), "utf8")); assert.equal(last.argv[1], "status");
  await assert.rejects(run(cli, ["context"], { env: { ...env, WRONG_ID: "1" } }), /Invalid CLI response identity/);
  const largeMessage = "x".repeat(3 * 1024 * 1024);
  await writeFile(message, largeMessage);
  reply = JSON.parse((await run(cli, ["chat", "send", "--connected-folder", "Test", "--message-file", message, "--json"], { env, maxBuffer: 8 * 1024 * 1024 })).stdout).data;
  assert.equal(reply.payload.messageFile, largeMessage, "current payload and response bounds permit normal large messages");
  await writeFile(message, "x".repeat(AMPLEFILE_CLI_ACT_MAX_PAYLOAD_BYTES + 1));
  await assert.rejects(run(cli, ["chat", "send", "--message-file", message], { env }), (error: any) => error.code === 2);
});
