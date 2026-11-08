import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAmpleFileCliActRequest,
  executeAmpleFileCliActRequest,
} from "../src/local/cli/index.js";
import type { AmpleFileCliActReceiptV3 } from "../src/local/cli/act-receipts.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

const token = "a".repeat(64);

type ReceiptEntry = Omit<AmpleFileCliActReceiptV3, "v" | "at">;

/**
 * End-to-end coverage of the verbs that install code, widen a power, or
 * destroy data, through the installed act
 * lane: argv → executor → the real facade inside startLocalApi → the
 * prepared-act path — with the executor's own receipts capture proving every
 * verb executes on the first call, journals `accepted` before the effect and
 * a terminal line after, and stamps no decision id anywhere
 * (docs/act-ledger.md).
 */
interface HeldTurn {
  taskId: string;
  connectedFolderId: string;
  release: () => void;
}

async function directVerbHarness(prefix: string): Promise<{
  sandbox: string;
  api: LocalApiHandle;
  records: ReceiptEntry[];
  execute: (argv: string[]) => ReturnType<typeof executeAmpleFileCliActRequest>;
  lastOk: () => ReceiptEntry;
  /** Connected Folder ids (the AmpleFile agent scope id included) whose turns wait at the prompt gate until released. */
  held: Set<string>;
  release: (taskId: string) => Promise<void>;
  close: () => Promise<void>;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), `amplefile-direct-verbs-${prefix}-`));
  // A `/hold` extension command lets a test run a turn that needs no model,
  // and the prompt gate lets it act inside "its own running turn".
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 50)),
    });
  }\n`, "utf8");
  const held = new Set<string>();
  const pending: HeldTurn[] = [];
  // Once teardown starts no turn is held: a turn accepted a moment ago may
  // reach the gate after the last release, and a held turn would keep
  // `close()` waiting forever.
  let draining = false;
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    beforeAgentPrompt: async (event) => {
      if (draining || !held.has(event.connectedFolderId)) return;
      await new Promise<void>((release) => pending.push({ taskId: event.taskId, connectedFolderId: event.connectedFolderId, release }));
    },
  });
  const records: ReceiptEntry[] = [];
  const execute = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      resolveLineageParent: (taskId) => api.resolveAmpleFileAgentLineageParent(taskId),
      receipts: {
        hasAccepted: async () => false,
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
    records,
    execute,
    lastOk: () => records.filter((record) => record.outcome === "ok").at(-1)!,
    held,
    release: async (taskId) => {
      const deadline = Date.now() + 15_000;
      while (!pending.some((turn) => turn.taskId === taskId)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for turn ${taskId} to reach the prompt gate.`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      pending.splice(pending.findIndex((turn) => turn.taskId === taskId), 1)[0]!.release();
    },
    close: async () => {
      draining = true;
      for (const turn of pending.splice(0)) turn.release();
      await api.close();
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

async function settledTask(api: LocalApiHandle, connectedFolderId: string, taskId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await api.actFacade.turnStatus({ connectedFolder: connectedFolderId, taskId });
    if (status.task.state !== "running") return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for turn ${taskId} to settle.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function errorCodeOf(stderr: string): string | undefined {
  try {
    return (JSON.parse(stderr) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

test("retired verbs are unknown commands that leave no receipt", async () => {
  const h = await directVerbHarness("retired");
  try {
    // The pending-decision family, permanent deletion, the holding
    // spellings, desktop-served sharing verbs, and the pages and apps
    // families: none exists.
    for (const argv of [
      ["staged", "list"], ["staged", "show"], ["files", "destroy"],
      ["automations", "stage"], ["pages", "stage"],
      ["pages", "share"], ["pages", "share-app"], ["pages", "status"],
      ["pages", "revoke"], ["pages", "narrow"], ["pages", "widen"], ["pages", "snapshot-off"],
      ["pages", "validate"],
      ["apps", "list"], ["apps", "invoke"], ["apps", "install-preview"], ["apps", "grant"],
      ["apps", "release", "prepare"], ["apps", "uninstall"],
    ]) {
      h.records.length = 0;
      const unknown = await h.execute(argv);
      assert.equal(unknown.exitCode, 2, `'${argv.join(" ")}' must be a usage error`);
      assert.match(unknown.stderr, /Unknown command/);
      assert.deepEqual(h.records, [], "an unknown command leaves no receipt");
    }
  } finally {
    await h.close();
  }
});

test("connected-folders delete deletes a managed folder on the first call, refuses a linked registration, and executes nothing for an inactive parent", async () => {
  const h = await directVerbHarness("connected-folders");
  try {
    const managed = await h.api.actFacade.createConnectedFolder({ name: "Managed" });
    await writeFile(join(managed.connectedFolder.connectedFolderRoot, "note.md"), "gone soon", "utf8");
    const deleted = await h.execute(["connected-folders", "delete", "--connected-folder", managed.connectedFolder.id, "--json"]);
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    const deletedJson = JSON.parse(deleted.stdout) as { data: { removed: boolean; storage: string; cleanupPending: boolean; staged?: unknown } };
    assert.equal(deletedJson.data.removed, true);
    assert.equal(deletedJson.data.storage, "managed");
    assert.equal(deletedJson.data.staged, undefined);
    assert.equal(existsSync(managed.connectedFolder.connectedFolderRoot), false, "the managed folder is deleted on the first call");
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    // The folder is moved, not erased: the receipt names the Recently deleted
    // item that puts it back (docs/act-ledger.md).
    const keptConnectedFolder = (await h.api.recentlyDeleted.list()).entries;
    assert.equal(keptConnectedFolder.length, 1);
    assert.equal(keptConnectedFolder[0]?.kind, "connected-folder");
    assert.equal(h.lastOk().detail, `connected-folder.delete-folder; recently-deleted ${keptConnectedFolder[0]!.id}`);
    assert.deepEqual(h.lastOk().undoRef, { kind: "recently-deleted-entry", value: keptConnectedFolder[0]!.id });
    assert.equal(h.lastOk().connectedFolderId, managed.connectedFolder.id);

    // A linked registration is never deletable through this verb.
    const linkedRoot = join(h.sandbox, "linked-folder");
    await mkdir(linkedRoot, { recursive: true });
    const linked = await h.api.actFacade.registerConnectedFolder({ connectedFolderRoot: linkedRoot });
    h.records.length = 0;
    const refused = await h.execute(["connected-folders", "delete", "--connected-folder", linked.connectedFolder.id, "--json"]);
    assert.notEqual(refused.exitCode, 0);
    assert.equal(errorCodeOf(refused.stderr), "conflict");
    assert.match(refused.stderr, /Only a managed Connected Folder's folder can be deleted/);
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "error"]);
    assert.equal(existsSync(linkedRoot), true);

    // An inactive AmpleFile agent parent is refused before anything is accepted,
    // and nothing executes.
    const other = await h.api.actFacade.createConnectedFolder({ name: "Other" });
    h.records.length = 0;
    const orphan = await h.execute(["connected-folders", "delete", "--connected-folder", other.connectedFolder.id, "--parent-task", "task-inactive", "--json"]);
    assert.notEqual(orphan.exitCode, 0);
    assert.equal(errorCodeOf(orphan.stderr), "conflict");
    assert.match(orphan.stderr, /no longer active/);
    assert.deepEqual(h.records.map((record) => record.outcome), ["rejected"]);
    assert.equal(existsSync(other.connectedFolder.connectedFolderRoot), true, "a refused act changes nothing");
  } finally {
    await h.close();
  }
});

test("chat report, ask, answer, and handoff run through the act lane with content-free receipts, and requests show reads them back", async () => {
  const h = await directVerbHarness("collaboration");
  try {
    const drafts = await h.api.actFacade.createConnectedFolder({ name: "Drafts" });
    const reviews = await h.api.actFacade.createConnectedFolder({ name: "Reviews" });
    await writeFile(join(drafts.connectedFolder.connectedFolderRoot, "draft.md"), "# Draft\n", "utf8");
    await writeFile(join(h.sandbox, "details.json"), JSON.stringify({ pages: 3, sections: ["intro"] }), "utf8");
    h.held.add(drafts.connectedFolder.id);

    // A Connected Folder turn that is its own root, held open at the prompt gate so the
    // verbs below run inside "its own running turn".
    const own = await h.api.actFacade.sendMessage({ connectedFolder: drafts.connectedFolder.id, newConversation: true, content: "/hold" });
    const rootId = h.api.requests.byTaskId(own.taskId)!.requestId;

    // Report: the envelope comes back whole; the receipt records the outcome
    // and file count and never the summary or data.
    const reported = await h.execute([
      "chat", "report", "--connected-folder", drafts.connectedFolder.id, "--task", own.taskId,
      "--summary", "Drafted draft.md from the brief.", "--data", "@details.json", "--file", "draft.md", "--outcome", "partial", "--json",
    ]);
    assert.equal(reported.exitCode, 0, reported.stderr);
    const reportedJson = JSON.parse(reported.stdout) as {
      ok: boolean;
      data: { taskId: string; result: { summary: string; data: unknown; files: Array<{ path: string; sha256: string; sizeBytes: number }>; outcome: string }; request: { id: string; state: string } };
    };
    assert.equal(reportedJson.ok, true);
    assert.equal(reportedJson.data.result.outcome, "partial");
    assert.deepEqual(reportedJson.data.result.data, { pages: 3, sections: ["intro"] }, "--data @<path> is read against the directory the command ran in");
    assert.equal(reportedJson.data.result.files[0]!.path, "draft.md");
    assert.equal(reportedJson.data.result.files[0]!.sizeBytes, 8);
    assert.match(reportedJson.data.result.files[0]!.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().detail, "report partial; 1 file");
    assert.equal(h.lastOk().taskId, own.taskId);
    assert.equal(h.lastOk().connectedFolderId, drafts.connectedFolder.id);
    assert.equal(h.lastOk().undoRef, undefined, "a report is a record, not a mutation");
    assert.doesNotMatch(JSON.stringify(h.records), /Drafted|pages/, "receipts never carry the summary or the data");

    // A file outside the Connected Folder, a reserved folder, and a missing file are
    // each refused before anything is recorded.
    for (const [file, code] of [["../outside.md", "usage"], [".amplefile/connected-folder.json", "usage"], ["ghost.md", "notFound"]] as const) {
      const refused = await h.execute(["chat", "report", "--connected-folder", drafts.connectedFolder.id, "--task", own.taskId, "--summary", "Nope.", "--file", file, "--json"]);
      assert.equal(errorCodeOf(refused.stderr), code, `${file} → ${code}: ${refused.stderr}`);
    }
    assert.equal(h.api.requests.get(rootId)!.results.length, 1);

    // Ask: the task is waiting while its turn still runs, and the status
    // document says so; the receipt names the question, never its text.
    h.records.length = 0;
    const asked = await h.execute(["chat", "ask", "--connected-folder", drafts.connectedFolder.id, "--task", own.taskId, "--question", "Which quarter?", "--json"]);
    assert.equal(asked.exitCode, 0, asked.stderr);
    const askedJson = JSON.parse(asked.stdout) as { data: { question: { questionId: string; respondent: string }; redirectedToPerson: boolean; request: { state: string } } };
    assert.equal(askedJson.data.question.respondent, "person");
    assert.equal(askedJson.data.request.state, "waiting");
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().detail, `question ${askedJson.data.question.questionId} to person`);
    assert.doesNotMatch(JSON.stringify(h.records), /quarter/i);
    const status = await h.execute(["chat", "status", "--connected-folder", drafts.connectedFolder.id, "--task", own.taskId, "--json"]);
    const statusJson = JSON.parse(status.stdout) as { data: { task: { state: string }; waiting: { questionId: string; question: string } | null; request: { state: string } } };
    assert.equal(statusJson.data.task.state, "running");
    assert.equal(statusJson.data.waiting?.questionId, askedJson.data.question.questionId);
    assert.equal(statusJson.data.waiting?.question, "Which quarter?");
    const humanStatus = await h.execute(["chat", "status", "--connected-folder", drafts.connectedFolder.id, "--task", own.taskId]);
    assert.match(humanStatus.stdout, /^Task [^ ]+ — waiting on you since /, humanStatus.stderr);
    assert.match(humanStatus.stdout, /Question q-[^:]+: Which quarter\?/);
    assert.match(humanStatus.stdout, new RegExp(`Answer it with: amplefile chat answer --connected-folder ${drafts.connectedFolder.id} --question ${askedJson.data.question.questionId}`));

    // Handoff: copies with a restore point in the destination, a new Chat
    // there under this request, and the receipt names the destination.
    h.records.length = 0;
    const handed = await h.execute([
      "chat", "handoff", "--connected-folder", drafts.connectedFolder.id, "--task", own.taskId, "--to-connected-folder", reviews.connectedFolder.id,
      "--message", "/hold", "--file", "draft.md", "--json",
    ]);
    assert.equal(handed.exitCode, 0, handed.stderr);
    const handedJson = JSON.parse(handed.stdout) as { data: { taskId: string; conversationId: string; copied: string[]; checkpointId: string; request: { rootId: string; depth: number } } };
    assert.deepEqual(handedJson.data.copied, ["draft.md"]);
    assert.ok(handedJson.data.checkpointId);
    // The child really is under this root, but a Connected Folder–scoped verb hands back
    // an opaque handle instead of the root's id: `requests show` reads a
    // request by id, and the graph above a Connected Folder is not a Connected Folder's to read.
    assert.equal(h.api.requests.byTaskId(handedJson.data.taskId)!.rootId, rootId);
    assert.match(handedJson.data.request.rootId, /^parent-[0-9a-f]{16}$/);
    assert.equal(handedJson.data.request.depth, 1);
    assert.equal(existsSync(join(reviews.connectedFolder.connectedFolderRoot, "draft.md")), true);
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().detail, `handoff to ${reviews.connectedFolder.id}; 1 file`);
    assert.equal(h.lastOk().connectedFolderId, reviews.connectedFolder.id, "the receipt names the Connected Folder the effect landed in");
    assert.equal(h.lastOk().checkpointId, handedJson.data.checkpointId);
    assert.deepEqual(h.lastOk().undoRef, { kind: "checkpoint", value: handedJson.data.checkpointId });
    assert.equal(h.lastOk().taskId, handedJson.data.taskId);
    await settledTask(h.api, reviews.connectedFolder.id, handedJson.data.taskId);

    // The asking turn ends; the question stays open; an answer from the
    // wrong Connected Folder is refused by name, and the right one continues exactly
    // once — the second call executes nothing.
    await h.release(own.taskId);
    await settledTask(h.api, drafts.connectedFolder.id, own.taskId);
    h.records.length = 0;
    const wrong = await h.execute(["chat", "answer", "--connected-folder", reviews.connectedFolder.id, "--question", askedJson.data.question.questionId, "--answer", "Q3", "--json"]);
    assert.equal(wrong.exitCode, 5);
    assert.equal(errorCodeOf(wrong.stderr), "conflict");
    assert.match(wrong.stderr, /belongs to Drafts/);
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "error"]);
    h.records.length = 0;
    const answered = await h.execute(["chat", "answer", "--connected-folder", drafts.connectedFolder.id, "--question", askedJson.data.question.questionId, "--answer", "/hold", "--json"]);
    assert.equal(answered.exitCode, 0, answered.stderr);
    const answeredJson = JSON.parse(answered.stdout) as { data: { question: { state: string; continuationTaskId: string }; continuation: { taskId: string; conversationId: string } } };
    assert.equal(answeredJson.data.question.state, "answered");
    assert.equal(answeredJson.data.continuation.conversationId, own.conversationId);
    assert.equal(answeredJson.data.question.continuationTaskId, answeredJson.data.continuation.taskId);
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().detail, `answered ${askedJson.data.question.questionId}; continuation ${answeredJson.data.continuation.taskId}`);
    assert.equal(h.lastOk().taskId, answeredJson.data.continuation.taskId);
    assert.doesNotMatch(JSON.stringify(h.records), /hold/, "receipts never carry the answer text");
    await h.release(answeredJson.data.continuation.taskId);
    await settledTask(h.api, drafts.connectedFolder.id, answeredJson.data.continuation.taskId);
    h.records.length = 0;
    const again = await h.execute(["chat", "answer", "--connected-folder", drafts.connectedFolder.id, "--question", askedJson.data.question.questionId, "--answer", "/hold", "--json"]);
    assert.equal(again.exitCode, 5);
    assert.match(again.stderr, /already has an answer/);
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "error"]);
    assert.equal(h.api.requests.get(rootId)!.turns.length, 2, "exactly one continuation turn");

    // requests list|show read the record above Connected Folders; the human form clamps,
    // the JSON form carries the envelope whole.
    const listed = await h.execute(["requests", "list", "--json"]);
    assert.equal(listed.exitCode, 0, listed.stderr);
    const listedJson = JSON.parse(listed.stdout) as { data: { requests: Array<{ id: string; children: number }>; truncated: boolean } };
    assert.ok(listedJson.data.requests.some((request) => request.id === rootId && request.children === 1));
    const shown = await h.execute(["requests", "show", "--request", rootId, "--json"]);
    assert.equal(shown.exitCode, 0, shown.stderr);
    const shownJson = JSON.parse(shown.stdout) as {
      data: { request: { state: string; questions: Array<{ text: string; answer: string | null }>; resultRecords: Array<{ envelope: { summary: string; data: unknown } }>; childRequests: Array<{ connectedFolderName: string }> } };
    };
    assert.equal(shownJson.data.request.questions[0]!.text, "Which quarter?");
    assert.equal(shownJson.data.request.questions[0]!.answer, "/hold");
    assert.equal(shownJson.data.request.resultRecords[0]!.envelope.summary, "Drafted draft.md from the brief.");
    assert.deepEqual(shownJson.data.request.resultRecords[0]!.envelope.data, { pages: 3, sections: ["intro"] });
    assert.equal(shownJson.data.request.childRequests[0]!.connectedFolderName, "Reviews");
    const shownHuman = await h.execute(["requests", "show", "--request", rootId]);
    assert.match(shownHuman.stdout, /^Request req-[^ ]+ — cli, done — Drafts \[/);
    assert.match(shownHuman.stdout, /question q-[^ ]+ to you — answered: Which quarter\?/);
    assert.match(shownHuman.stdout, /result res-[^ ]+ from task [^ ]+ — partial, 1 file: Drafted draft\.md from the brief\./);
    assert.match(shownHuman.stdout, /\n  Request req-[^ ]+ — connected-folder, done — Reviews \[/, "children are indented beneath the root");
    const missing = await h.execute(["requests", "show", "--request", "req-00000000000000-00000000", "--json"]);
    assert.equal(errorCodeOf(missing.stderr), "notFound");
  } finally {
    await h.close();
  }
});


test("management questions use the act lane and content-free receipts", async () => {
  const h = await directVerbHarness("agent-questions");
  const scope = "amplefile-agent"; h.held.add(scope);
  try {
    const sent = await h.api.actFacade.agentSend({ content: "/hold" });
    const ask = await h.execute(["agent", "ask", "--task", sent.taskId, "--question", "Which private quarter?", "--json"]);
    assert.equal(ask.exitCode, 0, ask.stderr);
    const question = JSON.parse(ask.stdout).data.question;
    assert.doesNotMatch(JSON.stringify(h.records), /private quarter/);
    await h.release(sent.taskId);
    for (let n = 0; n < 100 && (await h.api.actFacade.agentTurnStatus({ taskId: sent.taskId })).task.state === "running"; n++) await new Promise(r => setTimeout(r, 25));
    const answer = await h.execute(["agent", "answer", "--question", question.questionId, "--answer", "/hold Q3", "--json"]);
    assert.equal(answer.exitCode, 0, answer.stderr);
    assert.equal(JSON.parse(answer.stdout).data.question.state, "answered");
    assert.doesNotMatch(JSON.stringify(h.records), /Q3/);
    const invalid = await h.execute(["agent", "ask", "--connected-folder", "anything", "--task", sent.taskId, "--question", "No", "--json"]);
    assert.notEqual(invalid.exitCode, 0);
  } finally { await h.close(); }
});
