import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AMPLEFILE_CLI_ACT_SURFACES, AmpleFileCliActReceipts, AmpleFileCliError } from "../src/local/cli/index.js";

const bellCharacter = String.fromCharCode(7);
const replacementCharacter = String.fromCharCode(0xfffd);

test("act receipts append ordered JSON lines and rotate only aged entries", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-receipts-test-"));
  try {
    const startTime = Date.parse("2026-07-31T12:00:00.000Z");
    let currentTime = startTime;
    const receipts = new AmpleFileCliActReceipts({ stateRoot: sandbox, maxBytes: 512, now: () => new Date(currentTime) });
    const requestId = randomUUID();
    assert.equal(await receipts.append({
      requestId,
      command: "chat.send",
      connectedFolderId: "connected-folder-1",
      conversationId: "chat-1",
      outcome: "ok",
      taskId: "task-1",
      detail: `accepted${bellCharacter}`,
      surface: "popover",
      undoRef: { kind: "title", value: `Old title${bellCharacter}` },
    }), true);
    assert.equal(await receipts.append({ requestId: randomUUID(), command: "files.add", outcome: "error", errorCode: "conflict" }), true);

    const lines = (await readFile(receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
      v: 3,
      at: new Date(startTime).toISOString(),
      requestId,
      command: "chat.send",
      connectedFolderId: "connected-folder-1",
      conversationId: "chat-1",
      outcome: "ok",
      taskId: "task-1",
      detail: `accepted${replacementCharacter}`,
      surface: "popover",
      undoRef: { kind: "title", value: `Old title${replacementCharacter}` },
    });
    assert.equal(lines[1]?.errorCode, "conflict");

    // Size pressure alone must not rotate while entries are inside the broker
    // freshness window; once they age out, rotation resumes.
    for (let index = 0; index < 8; index += 1) {
      await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok", detail: "x".repeat(96) });
    }
    assert.equal(existsSync(receipts.rotatedPath), false, "fresh journal entries must hold rotation");
    currentTime = startTime + 6 * 60 * 1000;
    await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok" });
    assert.ok(existsSync(receipts.rotatedPath), "aged entries must rotate once the live file exceeds maxBytes");
    const liveLines = (await readFile(receipts.path, "utf8")).trim().split("\n");
    assert.ok(liveLines.length < 10, "rotation must move older lines aside");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("accepted records gate duplicate request ids across the broker freshness window", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-receipts-test-"));
  try {
    const startTime = Date.parse("2026-07-31T12:00:00.000Z");
    let currentTime = startTime;
    const receipts = new AmpleFileCliActReceipts({ stateRoot: sandbox, maxBytes: 256, now: () => new Date(currentTime) });
    const acceptedId = randomUUID();
    assert.equal(await receipts.hasAccepted(acceptedId), false, "an empty journal has no accepted records");
    await receipts.append({ requestId: acceptedId, command: "files.add", outcome: "accepted" });
    assert.equal(await receipts.hasAccepted(acceptedId), true);
    assert.equal(await receipts.hasAccepted(randomUUID()), false);

    // A terminal or rejected record alone must not read as executed.
    const rejectedId = randomUUID();
    await receipts.append({ requestId: rejectedId, command: "files.add", outcome: "rejected", errorCode: "unavailable" });
    assert.equal(await receipts.hasAccepted(rejectedId), false);

    // While the accepted record is inside the freshness window, size pressure
    // must not rotate it out of reach.
    for (let index = 0; index < 6; index += 1) {
      await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok", detail: "y".repeat(64) });
    }
    assert.equal(existsSync(receipts.rotatedPath), false, "fresh ledger entries must hold rotation");
    assert.equal(await receipts.hasAccepted(acceptedId), true);

    // After the window passes, a single rotation still keeps it findable in
    // the rotated file. Longer retention is unnecessary because the broker
    // refuses requests older than the freshness window anyway.
    currentTime = startTime + 6 * 60 * 1000;
    await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok" });
    assert.ok(existsSync(receipts.rotatedPath), "aged entries must rotate");
    assert.equal(await receipts.hasAccepted(acceptedId), true, "one rotation keeps the accepted record findable");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("receipt append failures report false instead of throwing", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-receipts-test-"));
  try {
    const receipts = new AmpleFileCliActReceipts({ stateRoot: sandbox });
    // Occupy the receipts directory path with a regular file so mkdir fails.
    await rm(join(sandbox, "cli"), { recursive: true, force: true });
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(sandbox, "cli"), { recursive: true });
    await writeFile(join(sandbox, "cli", "receipts"), "not a directory", "utf8");
    assert.equal(await receipts.append({ requestId: randomUUID(), command: "chat.send", outcome: "ok" }), false);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the recorded surface vocabulary is the closed three-value set", () => {
  assert.deepEqual([...AMPLEFILE_CLI_ACT_SURFACES], ["cli", "popover", "main-window"]);
});

test("a damaged receipt ledger fails closed instead of permitting a replay", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-receipts-damaged-test-"));
  try {
    const receipts = new AmpleFileCliActReceipts({ stateRoot: sandbox });
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(receipts.path), { recursive: true });
    await writeFile(receipts.path, "{damaged journal line\n", "utf8");
    await assert.rejects(
      () => receipts.hasAccepted(randomUUID()),
      (error: unknown) => error instanceof AmpleFileCliError
        && error.code === "failure"
        && /verify the act receipt journal/.test(error.message),
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function receiptsSandbox(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-receipts-ledger-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return sandbox;
}

function receiptLine(at: string, requestId: string, outcome: string, command = "files.add"): string {
  return `${JSON.stringify({ v: 3, at, requestId, command, outcome })}\n`;
}

test("a torn final append is cut at startup instead of failing every later act", async (t) => {
  const sandbox = await receiptsSandbox(t);
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  const receipts = new AmpleFileCliActReceipts({ stateRoot: sandbox, now: () => new Date(now) });
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(receipts.path), { recursive: true });
  const acceptedId = randomUUID();
  const whole = receiptLine(new Date(now).toISOString(), acceptedId, "accepted");
  await writeFile(receipts.path, `${whole}{"v":3,"at":"2026-07-31T12:00:00.000Z","requestId":"${randomUUID()}","comm`, "utf8");

  assert.equal(await receipts.hasAccepted(acceptedId), true);
  assert.equal(await readFile(receipts.path, "utf8"), whole, "the unfinished line is cut back to the last complete one");
  const nextId = randomUUID();
  assert.equal(await receipts.append({ requestId: nextId, command: "files.add", outcome: "accepted" }), true);
  const reopened = new AmpleFileCliActReceipts({ stateRoot: sandbox, now: () => new Date(now) });
  assert.equal(await reopened.hasAccepted(nextId), true, "the next append lands on its own line");
  for (const line of (await readFile(receipts.path, "utf8")).trim().split("\n")) JSON.parse(line);
});

test("a damaged line fails closed only while it could still hide a replayable request", async (t) => {
  const sandbox = await receiptsSandbox(t);
  const start = Date.parse("2026-07-31T12:00:00.000Z");
  let current = start;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const probe = new AmpleFileCliActReceipts({ stateRoot: sandbox });
  await mkdir(dirname(probe.path), { recursive: true });
  // The shape an older build left behind: a torn append, the next append run
  // into it, and every later act refused with a rejected line.
  const acceptedId = randomUUID();
  const at = (offsetMs: number) => new Date(start + offsetMs).toISOString();
  await writeFile(probe.path, [
    receiptLine(at(0), acceptedId, "accepted").trimEnd(),
    `{"v":3,"at":"${at(1_000)}","requ${receiptLine(at(2_000), randomUUID(), "accepted").trimEnd()}`,
    receiptLine(at(3_000), randomUUID(), "rejected").trimEnd(),
    "",
  ].join("\n"), "utf8");
  const receipts = new AmpleFileCliActReceipts({ stateRoot: sandbox, now: () => new Date(current) });
  await assert.rejects(() => receipts.hasAccepted(randomUUID()), /verify the act receipt journal/);
  // Five minutes of freshness plus a minute of clock skew after the line
  // written next, no request the damaged line could name can be replayed.
  current = start + 3_000 + 6 * 60 * 1000 - 1;
  await assert.rejects(() => receipts.hasAccepted(randomUUID()), /verify the act receipt journal/);
  current = start + 3_000 + 6 * 60 * 1000;
  assert.equal(await receipts.hasAccepted(randomUUID()), false);
  assert.equal(await receipts.hasAccepted(acceptedId), true, "readable accepted records still gate replays");
});

test("the ledger answers from memory, sees another writer's lines, and never accepts an id twice", async (t) => {
  const sandbox = await receiptsSandbox(t);
  const now = () => new Date("2026-07-31T12:00:00.000Z");
  const first = new AmpleFileCliActReceipts({ stateRoot: sandbox, now });
  const second = new AmpleFileCliActReceipts({ stateRoot: sandbox, now });
  const id = randomUUID();
  assert.equal(await second.hasAccepted(id), false);
  assert.equal(await first.append({ requestId: id, command: "files.add", outcome: "accepted" }), true);
  assert.equal(await second.hasAccepted(id), true, "lines another writer appended are read from where this one left off");
  assert.equal(await first.append({ requestId: id, command: "files.add", outcome: "accepted" }), false, "an id is accepted at most once");
  assert.equal(await second.append({ requestId: id, command: "files.add", outcome: "accepted" }), false);
  assert.equal(await first.append({ requestId: id, command: "files.add", outcome: "ok" }), true);
  const lines = (await readFile(first.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { outcome: string });
  assert.deepEqual(lines.map((line) => line.outcome), ["accepted", "ok"]);
});

test("status polls journal beside the acts, so they never push real receipts out", async (t) => {
  const sandbox = await receiptsSandbox(t);
  const start = Date.parse("2026-07-31T12:00:00.000Z");
  let current = start;
  const receipts = new AmpleFileCliActReceipts({ stateRoot: sandbox, maxBytes: 512, now: () => new Date(current) });
  const actId = randomUUID();
  await receipts.append({ requestId: actId, command: "chat.send", outcome: "accepted" });
  await receipts.append({ requestId: actId, command: "chat.send", outcome: "ok" });
  const pollIds: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    current += 2_000;
    const pollId = randomUUID();
    pollIds.push(pollId);
    await receipts.append({ requestId: pollId, command: "chat.status", outcome: "accepted" });
    await receipts.append({ requestId: pollId, command: "chat.status", outcome: "ok" });
  }
  current = start + 60 * 60 * 1000;
  for (let index = 0; index < 20; index += 1) {
    await receipts.append({ requestId: randomUUID(), command: "agent.status", outcome: "accepted" });
  }
  const acts = (await readFile(receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { requestId: string; command: string });
  assert.deepEqual(acts.map((line) => line.command), ["chat.send", "chat.send"], "the act journal holds only the act");
  assert.equal(existsSync(receipts.rotatedPath), false);
  assert.ok(existsSync(receipts.readsRotatedPath), "the reads journal rotates on its own");
  assert.equal(await receipts.hasAccepted(actId), true);
  assert.equal(await receipts.hasAccepted(pollIds.at(-1)!), true, "a read's id is still accepted at most once");
});

test("every read-journal verb is a real act verb", async () => {
  const { AMPLEFILE_CLI_ACT_READ_COMMANDS, parseAmpleFileCliActArgv } = await import("../src/local/cli/index.js");
  for (const name of AMPLEFILE_CLI_ACT_READ_COMMANDS) {
    const argv = name === "connected-folders.worker.show" ? ["connected-folders", "worker", "show"] : name.split(".");
    try {
      const parsed = parseAmpleFileCliActArgv(argv);
      assert.equal(parsed.name, name);
    } catch (error) {
      assert.doesNotMatch(String(error), /Unknown command/, name);
    }
  }
});

test("a partial first append to a fresh journal is cut back, and a failed stat after a durable append still succeeds", async (t) => {
  const sandbox = await receiptsSandbox(t);
  const { appendFile, stat } = await import("node:fs/promises");
  const now = () => new Date("2026-07-31T12:00:00.000Z");
  let tearNext = false;
  let failStat = false;
  const receipts = new AmpleFileCliActReceipts({
    stateRoot: sandbox,
    now,
    io: {
      appendFile: (async (path: Parameters<typeof appendFile>[0], data: string, options?: Parameters<typeof appendFile>[2]) => {
        if (tearNext) {
          tearNext = false;
          await appendFile(path, data.slice(0, 20), options);
          throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
        }
        await appendFile(path, data, options);
      }) as typeof appendFile,
      stat: (async (...args: Parameters<typeof stat>) => {
        if (failStat) {
          failStat = false;
          throw Object.assign(new Error("interrupted"), { code: "EINTR" });
        }
        return await stat(...args);
      }) as typeof stat,
    },
  });

  // The journal does not exist yet; the torn first line is the whole file.
  tearNext = true;
  assert.equal(await receipts.append({ requestId: randomUUID(), command: "files.add", outcome: "accepted" }), false);
  assert.equal(await readFile(receipts.path, "utf8"), "", "the fragment is cut back to an empty journal");
  const next = randomUUID();
  assert.equal(await receipts.append({ requestId: next, command: "files.add", outcome: "accepted" }), true);
  assert.equal(await receipts.hasAccepted(randomUUID()), false, "no damage: the next line stands on its own");
  assert.equal(await receipts.hasAccepted(next), true);

  // A stat failure after the line is durable is not an append failure.
  const durable = randomUUID();
  failStat = true;
  assert.equal(await receipts.append({ requestId: durable, command: "files.add", outcome: "accepted" }), true);
  assert.equal(await receipts.hasAccepted(durable), true);
  assert.equal(await receipts.append({ requestId: durable, command: "files.add", outcome: "ok" }), true);
  const lines = (await readFile(receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { requestId: string; outcome: string });
  assert.deepEqual(lines.map((line) => line.outcome), ["accepted", "accepted", "ok"]);
});
