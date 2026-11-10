import assert from "node:assert/strict";
import test from "node:test";
import type { ConfirmDialogOptions } from "../web-local/src/ui/feedback.js";
import type { DesktopUpdateStatus } from "../web-local/src/types.js";
import { readRunningWork, runDesktopUpdateAction, updateRestartConfirm, type RunningWork } from "../web-local/src/lib/update-restart.js";

const status = (phase: DesktopUpdateStatus["phase"], changes: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus => ({
  supported: true, phase, currentVersion: "0.1.4", availableVersion: "0.1.5", progressPercent: null, checkedAt: null, message: "", error: null, ...changes,
});
const connectedFolders = [{ id: "home", name: "Home projects" }, { id: "trip", name: "Japan trip" }];
const idle: RunningWork = { chats: [], ampleFileAgentWorking: false };

/** One click through the shared action, with the updater, the dialog, and the running-work read recorded. */
async function click(value: DesktopUpdateStatus | null, { answer = true, work = idle as RunningWork | null } = {}) {
  const calls: string[] = [];
  const asked: ConfirmDialogOptions[] = [];
  let reads = 0;
  const reply = (name: string) => async () => { calls.push(name); return status("downloading"); };
  const result = await runDesktopUpdateAction({
    status: value,
    updates: { check: reply("check"), updateNow: reply("updateNow"), install: reply("install") },
    confirm: async (options) => { asked.push(options); return answer; },
    readWork: async () => { reads += 1; return work; },
    connectedFolders,
  });
  return { calls, asked, reads, result };
}

test("available reaches updateNow and ready reaches install, each only after the person confirms", async () => {
  const available = await click(status("available"));
  assert.deepEqual(available.calls, ["updateNow"], "exactly one updater call");
  assert.equal(available.asked.length, 1);
  assert.equal(available.asked[0]!.title, "Restart AmpleFile to Update?");
  assert.equal(available.asked[0]!.confirmLabel, "Update and Restart");
  assert.match(available.asked[0]!.body!, /^AmpleFile downloads AmpleFile 0\.1\.5, then quits and opens again on its own/);
  assert.equal(available.result?.phase, "downloading");

  const ready = await click(status("ready"));
  assert.deepEqual(ready.calls, ["install"]);
  assert.match(ready.asked[0]!.body!, /^AmpleFile quits and opens again on its own to install AmpleFile 0\.1\.5\./);

  const failedDownload = await click(status("error"));
  assert.deepEqual(failedDownload.calls, ["updateNow"], "retrying a failed download asks too");
  assert.equal(failedDownload.asked.length, 1);
});

test("Cancel calls nothing", async () => {
  for (const phase of ["available", "ready", "error"] as const) {
    const cancelled = await click(status(phase), { answer: false });
    assert.equal(cancelled.asked.length, 1, `${phase} asks`);
    assert.deepEqual(cancelled.calls, [], `${phase} calls no updater after Cancel`);
    assert.equal(cancelled.result, null);
  }
});

test("a check asks nothing, and busy phases call nothing", async () => {
  for (const value of [null, status("idle"), status("not_available"), status("unsupported"), status("error", { availableVersion: null })]) {
    const checked = await click(value);
    assert.deepEqual(checked.calls, ["check"]);
    assert.equal(checked.asked.length, 0, "checking never restarts, so it never asks");
    assert.equal(checked.reads, 0);
  }
  for (const phase of ["checking", "downloading", "installing"] as const) {
    const busy = await click(status(phase));
    assert.deepEqual(busy.calls, [], `${phase} calls nothing`);
    assert.equal(busy.asked.length, 0);
    assert.equal(busy.result, null);
  }
});

test("the question names the running Worker Chats and the AmpleFile Agent and says what restarting does to them", async () => {
  const work: RunningWork = {
    chats: [{ connectedFolderId: "home", conversationId: "a" }, { connectedFolderId: "trip", conversationId: "b" }, { connectedFolderId: "home", conversationId: "c" }],
    ampleFileAgentWorking: true,
  };
  const { asked, calls } = await click(status("available"), { work });
  const body = asked[0]!.body!;
  assert.match(body, /3 Worker Chats are working \(Home projects, Japan trip\), and the AmpleFile Agent is working\./);
  assert.match(body, /Restarting stops this work, and it is not run again\. Queued messages are dropped\./);
  assert.equal(asked[0]!.tone, "danger");
  assert.deepEqual(calls, ["updateNow"]);

  const one = updateRestartConfirm("install", status("ready"), { chats: [{ connectedFolderId: "trip", conversationId: "x" }], ampleFileAgentWorking: false }, connectedFolders);
  assert.match(one.body!, /1 Worker Chat is working \(Japan trip\)\./);
  const agentOnly = updateRestartConfirm("install", status("ready"), { chats: [], ampleFileAgentWorking: true }, connectedFolders);
  assert.match(agentOnly.body!, / The AmpleFile Agent is working\. Restarting stops this work/);
  const unknownFolder = updateRestartConfirm("install", status("ready"), { chats: [{ connectedFolderId: "gone", conversationId: "x" }], ampleFileAgentWorking: false }, connectedFolders);
  assert.match(unknownFolder.body!, /1 Worker Chat is working\. Restarting/);

  const quiet = updateRestartConfirm("updateNow", status("available"), idle, connectedFolders);
  assert.equal(quiet.tone, "default");
  assert.match(quiet.body!, /Anything still running when it restarts is stopped and not run again\./, "work started during the download is warned about too");
  assert.doesNotMatch(updateRestartConfirm("install", status("ready"), idle, connectedFolders).body!, /running/);
});

test("when what is running cannot be read, it still asks and warns", async () => {
  const { asked, calls } = await click(status("ready"), { work: null });
  assert.match(asked[0]!.body!, /could not check what is running\. Any Worker Chat or AmpleFile Agent turn still running when it restarts is stopped and not run again, and queued messages are dropped\./);
  assert.equal(asked[0]!.tone, "danger");
  assert.deepEqual(calls, ["install"]);
});

test("running work is read from the activity and AmpleFile Agent endpoints", async () => {
  const paths: string[] = [];
  const answers: Record<string, unknown> = {
    "/api/connected-folders/activity": { running: [{ connectedFolderId: "home", conversationId: "a" }] },
    "/api/amplefile-agent/summary": { available: true, conversation: null, state: "compacting", latestRequest: null },
  };
  const read = async <T>(path: string) => { paths.push(path); return answers[path] as T; };
  assert.deepEqual(await readRunningWork(read), { chats: [{ connectedFolderId: "home", conversationId: "a" }], ampleFileAgentWorking: true });
  assert.deepEqual(paths.sort(), ["/api/amplefile-agent/summary", "/api/connected-folders/activity"]);
  answers["/api/amplefile-agent/summary"] = { state: "idle" };
  assert.equal((await readRunningWork(read))!.ampleFileAgentWorking, false);
  assert.equal(await readRunningWork(async (path) => { if (path.includes("amplefile-agent")) throw new Error("offline"); return { running: [] } as never; }), null);
});
