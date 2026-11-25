import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { outsideAgentSkill } from "../src/shared/outside-agent-skill.js";
import {
  AMPLEFILE_CLI_ACT_READ_COMMANDS,
  AmpleFileCliActReceipts,
  ampleFileCliHelp,
  ampleFileCliActRunsOutsideQueue,
  createAmpleFileCliActRequest,
  executeAmpleFileCliActRequest,
  parseAmpleFileCliActArgv,
  type AmpleFileActFacade,
  type AmpleFileCliActExecutorOptions,
} from "../src/local/cli/index.js";

/**
 * Every act can be traced after its caller stops waiting: the caller may
 * send it under its own --request-id, and `receipts show --id` reports what
 * became of that id from the receipt journals and what the host still holds.
 */

const cwd = resolve(tmpdir());
const token = "b".repeat(64);

test("every act verb takes --request-id, normalized like a broker request id", () => {
  const id = randomUUID();
  const upper = id.toUpperCase();
  const verbs = [
    ["files", "rename", "--connected-folder", "home", "--path", "a.txt", "--name", "b.txt"],
    ["chat", "send", "--connected-folder", "home", "--new", "--message", "hello"],
    ["agent", "status"],
    ["automations", "run", "--automation", "automation-1"],
    ["recently-deleted", "list"],
    ["requests", "show", "--request", "req-1"],
  ];
  for (const argv of verbs) {
    assert.equal(parseAmpleFileCliActArgv([...argv, "--request-id", upper]).requestId, id, argv.join(" "));
    assert.equal(parseAmpleFileCliActArgv([...argv, `--request-id=${id}`]).requestId, id, argv.join(" "));
    assert.equal(parseAmpleFileCliActArgv(argv).requestId, undefined, "no flag, no caller id");
  }
  assert.throws(() => parseAmpleFileCliActArgv(["agent", "status", "--request-id", "req-1"]), /--request-id must be a UUID/);
  assert.throws(() => parseAmpleFileCliActArgv(["agent", "status", "--request-id"]), /--request-id requires a value/);
  assert.throws(
    () => parseAmpleFileCliActArgv(["agent", "status", "--request-id", id, "--request-id", randomUUID()]),
    /--request-id may be provided only once/,
  );
});

test("receipts show parses strictly, reads beside the queue, and journals with the reads", () => {
  const id = randomUUID();
  const parsed = parseAmpleFileCliActArgv(["receipts", "show", "--id", id.toUpperCase(), "--json"]);
  assert.equal(parsed.name, "receipts.show");
  assert.equal(parsed.receiptRequestId, id);
  assert.equal(parsed.output, "json");
  assert.throws(() => parseAmpleFileCliActArgv(["receipts", "show"]), /Provide --id <request-id>/);
  assert.throws(() => parseAmpleFileCliActArgv(["receipts", "show", "--id", "nope"]), /--id must be a UUID/);
  assert.throws(() => parseAmpleFileCliActArgv(["receipts", "show", "--id", id, "--connected-folder", "home"]), /cannot be used/);
  assert.throws(() => parseAmpleFileCliActArgv(["receipts", "show", "--id", id, "--parent-task", "task-1"]), /cannot be used/);
  assert.throws(
    () => parseAmpleFileCliActArgv(["receipts", "show", "--id", id, "--request-id", id]),
    /cannot also be this read's own --request-id/,
  );
  assert.equal(parseAmpleFileCliActArgv(["receipts", "show", "--id", id, "--request-id", randomUUID()]).name, "receipts.show");
  assert.equal(ampleFileCliActRunsOutsideQueue(["receipts", "show", "--id", id]), true, "it must answer while the act it asks about waits in line");
  assert.equal(AMPLEFILE_CLI_ACT_READ_COMMANDS.has("receipts.show"), true);
});

test("an act sent under any id but its own --request-id is refused before anything runs", async (t) => {
  const receipts = await journal(t);
  const created: string[] = [];
  const facade = {
    async createConversation(input: { connectedFolder: string }) {
      created.push(input.connectedFolder);
      return {
        connectedFolder: { id: "connected-folder-1", name: "Home", connectedFolderRoot: "/tmp/home" },
        conversation: { id: "chat-1", title: "New Chat", createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z", archivedAt: null, snoozedUntil: null },
      };
    },
  } as unknown as AmpleFileActFacade;
  const callerId = randomUUID();
  const mismatched = await executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv: ["chat", "create", "--connected-folder", "home", "--request-id", callerId], cwd, actToken: token }),
    options(receipts, facade),
  );
  assert.equal(mismatched.exitCode, 8);
  assert.match(mismatched.stderr, /did not send the request under its --request-id/);
  assert.deepEqual(created, []);
  assert.deepEqual(await journalLines(receipts.path), [], "a refused envelope journals nothing");

  const matched = await executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: callerId, argv: ["chat", "create", "--connected-folder", "home", "--request-id", callerId.toUpperCase()], cwd, actToken: token }),
    options(receipts, facade),
  );
  assert.equal(matched.exitCode, 0, matched.stderr);
  assert.deepEqual(created, ["home"]);
  assert.deepEqual((await journalLines(receipts.path)).map((line) => [line.requestId, line.outcome]), [[callerId, "accepted"], [callerId, "ok"]]);

  // Sent again under the same id after its answer was cleaned up: refused,
  // and the refusal says what the id already did.
  const replay = await executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: callerId, argv: ["chat", "create", "--connected-folder", "home", "--request-id", callerId], cwd, actToken: token }),
    options(receipts, facade),
  );
  assert.equal(replay.exitCode, 5);
  assert.match(replay.stderr, /already executed \(chat create, ok at [^)]+\), so it was not run again/);
  assert.match(replay.stderr, new RegExp(`receipts show --id ${callerId}`));
  assert.deepEqual(created, ["home"], "the replay never reaches the facade");
});

test("receipts show reports every state an act request id can be in", async (t) => {
  const receipts = await journal(t);
  const facade = {} as AmpleFileActFacade;
  const pending = new Map<string, { processing: boolean; decideBy: string }>();
  const show = async (id: string) => {
    const response = await executeAmpleFileCliActRequest(
      createAmpleFileCliActRequest({ id: randomUUID(), argv: ["receipts", "show", "--id", id, "--json"], cwd, actToken: token }),
      options(receipts, facade, async (requestId) => pending.get(requestId) ?? null),
    );
    assert.equal(response.exitCode, 0, response.stderr);
    return (JSON.parse(response.stdout) as { command: string; data: Record<string, unknown> & { receipt: Record<string, unknown> | null } }).data;
  };

  const unknown = randomUUID();
  assert.deepEqual(
    { state: (await show(unknown)).state, receipt: (await show(unknown)).receipt },
    { state: "not_found", receipt: null },
  );
  assert.match(String((await show(unknown)).summary), /it never ran/);

  const queued = randomUUID();
  pending.set(queued, { processing: true, decideBy: "2026-07-31T12:05:00.000Z" });
  const queuedView = await show(queued);
  assert.equal(queuedView.state, "queued");
  assert.equal(queuedView.decideBy, "2026-07-31T12:05:00.000Z");
  assert.match(String(queuedView.summary), /has not started it/);

  const running = randomUUID();
  await receipts.append({ requestId: running, command: "files.rename", outcome: "accepted", surface: "cli", detail: "Connected Folder home" });
  pending.set(running, { processing: true, decideBy: "2026-07-31T12:05:00.000Z" });
  const runningView = await show(running);
  assert.deepEqual([runningView.state, runningView.running, runningView.command], ["accepted", true, "files.rename"]);
  pending.delete(running);
  const interrupted = await show(running);
  assert.deepEqual([interrupted.state, interrupted.running], ["accepted", false]);
  assert.match(String(interrupted.summary), /interrupted/);

  const fromWindow = randomUUID();
  await receipts.append({ requestId: fromWindow, command: "files.delete", outcome: "accepted", surface: "main-window" });
  const windowView = await show(fromWindow);
  assert.deepEqual([windowView.state, windowView.running], ["accepted", null], "only the CLI host's own requests are judged from what it holds");

  const succeeded = randomUUID();
  await receipts.append({ requestId: succeeded, command: "files.rename", outcome: "accepted", surface: "cli" });
  await receipts.append({
    requestId: succeeded, command: "files.rename", outcome: "ok", surface: "cli",
    connectedFolderId: "connected-folder-1", checkpointId: "checkpoint-1", undoRef: { kind: "entry-name", value: "old.txt" },
  });
  const okView = await show(succeeded);
  assert.equal(okView.state, "ok");
  assert.equal(okView.receipt?.checkpointId, "checkpoint-1");
  assert.equal(okView.receipt?.v, undefined, "the journal version stays in the journal");
  assert.match(String(okView.summary), /files rename ran and succeeded/);

  const failed = randomUUID();
  await receipts.append({ requestId: failed, command: "files.move", outcome: "accepted", surface: "cli" });
  await receipts.append({ requestId: failed, command: "files.move", outcome: "error", errorCode: "conflict", surface: "cli" });
  const errorView = await show(failed);
  assert.deepEqual([errorView.state, errorView.receipt?.errorCode], ["error", "conflict"]);

  const refused = randomUUID();
  await receipts.append({ requestId: refused, command: "files.rename", outcome: "rejected", errorCode: "timeout", surface: "cli", detail: "waited too long behind other commands" });
  const rejectedView = await show(refused);
  assert.equal(rejectedView.state, "rejected");
  assert.match(String(rejectedView.summary), /without running it \(waited too long behind other commands\)\. Nothing changed\./);
  // The same id sent again and waiting in line is queued, not rejected.
  pending.set(refused, { processing: false, decideBy: "2026-07-31T12:05:00.000Z" });
  assert.equal((await show(refused)).state, "queued");

  // The read journals itself beside the other reads, naming what it found.
  const reads = await journalLines(receipts.readsPath);
  assert.ok(reads.some((line) => line.command === "receipts.show" && line.outcome === "ok" && line.detail === `request ${succeeded}; ok`));
  assert.ok((await journalLines(receipts.path)).every((line) => line.command !== "receipts.show"));
});

test("receipts show reads the journals again when the host let go of the request between two looks", async (t) => {
  const receipts = await journal(t);
  const id = randomUUID();
  await receipts.append({ requestId: id, command: "files.rename", outcome: "accepted", surface: "cli" });
  // The host still held it at the first look; by the time it is asked, the
  // act has finished and written its outcome.
  const response = await executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv: ["receipts", "show", "--id", id], cwd, actToken: token }),
    options(receipts, {} as AmpleFileActFacade, async () => {
      await receipts.append({ requestId: id, command: "files.rename", outcome: "ok", surface: "cli" });
      return null;
    }),
  );
  assert.equal(response.exitCode, 0, response.stderr);
  assert.match(response.stdout, new RegExp(`^Request ${id} — ok\\nfiles rename ran and succeeded at `));
});

test("receipts show renders a person's view with the receipt's identifiers", async (t) => {
  const receipts = await journal(t);
  const id = randomUUID();
  await receipts.append({ requestId: id, command: "files.delete", outcome: "accepted", surface: "cli" });
  await receipts.append({
    requestId: id, command: "files.delete", outcome: "ok", surface: "cli",
    connectedFolderId: "connected-folder-1", checkpointId: "checkpoint-9",
    undoRef: { kind: "recently-deleted-entry", value: "entry-1" }, detail: "recently-deleted entry-1",
  });
  const response = await executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv: ["receipts", "show", "--id", id], cwd, actToken: token }),
    options(receipts, {} as AmpleFileActFacade),
  );
  assert.equal(response.exitCode, 0, response.stderr);
  const [heading, summary, facts] = response.stdout.split("\n");
  assert.equal(heading, `Request ${id} — ok`);
  assert.match(summary ?? "", /^files delete ran and succeeded at /);
  assert.equal(facts, "Connected Folder connected-folder-1; restore point checkpoint-9; undo: recently-deleted-entry entry-1; recently-deleted entry-1");
});

test("a caller's own id is refused again only as far back as the journal holds it, and the lookup says how far", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-receipts-bound-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const start = Date.parse("2026-07-31T12:00:00.000Z");
  let current = start;
  const receipts = new AmpleFileCliActReceipts({ stateRoot: sandbox, maxBytes: 256, now: () => new Date(current) });
  const id = randomUUID();
  await receipts.append({ requestId: id, command: "files.rename", outcome: "accepted", surface: "cli" });
  await receipts.append({ requestId: id, command: "files.rename", outcome: "ok", surface: "cli" });
  assert.equal(await receipts.hasAccepted(id), true);
  // Two rotations, each once the live file's oldest entry is past the
  // freshness window, drop the generation that held the id.
  for (const step of [10, 20]) {
    current = start + step * 60 * 1000;
    for (let index = 0; index < 4; index += 1) {
      await receipts.append({ requestId: randomUUID(), command: "files.add", outcome: "ok", detail: "x".repeat(64) });
    }
  }
  assert.equal(await receipts.hasAccepted(id), false, "a retry under this id would run again");
  const found = await receipts.lookup(id);
  assert.equal(found.accepted, null);
  assert.ok(found.journalSince && Date.parse(found.journalSince) > start, "the lookup says the journal no longer reaches the id");
});

test("every promise that a retry never runs twice says how far back it holds", async () => {
  const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(outsideAgentSkill(), /never runs twice while the receipt journal still holds that id/);
  const instructions = await source("src/local/amplefile-agent-instructions.ts");
  assert.match(instructions, /it never runs twice while the receipt journal still holds that id/);
  assert.match(instructions, /it is safe while the journal still holds that id/);
  assert.match(ampleFileCliHelp("AmpleFile", "receipts"), /That holds as far back as the\nreceipt journal still holds the id/);
  assert.match(await source("SECURITY.md"), /it is refused only while the journals still hold that id's `accepted` line/);
  assert.match(await source("docs/act-ledger.md"), /it is refused only while the\n   journals still hold the id's `accepted` line/);
  const guide = await source("docs/amplefile-agent-and-cli.md");
  assert.match(guide, /A retry under an id older than that runs again\./);
  assert.match(guide, /never run twice, for\n  as long as the journals still hold the id's `accepted` line/);
});

function options(
  receipts: AmpleFileCliActReceipts,
  facade: AmpleFileActFacade,
  pendingRequest?: AmpleFileCliActExecutorOptions["pendingRequest"],
): AmpleFileCliActExecutorOptions {
  return {
    version: "test",
    getActFacade: () => ({ facade, token }),
    receipts,
    ...(pendingRequest ? { pendingRequest } : {}),
  };
}

async function journal(t: TestContext): Promise<AmpleFileCliActReceipts> {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-receipts-show-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return new AmpleFileCliActReceipts({ stateRoot: sandbox });
}

async function journalLines(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}
