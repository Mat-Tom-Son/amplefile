import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendMessage } from "../src/local/agent/chat-store.js";
import { AmpleFileCliError } from "../src/local/cli/index.js";
import {
  normalizeAmpleFileAutomationDeclaration,
  ampleFileAutomationDigest,
} from "../src/local/automations/automation-declarations.js";
import { startLocalApi } from "../src/local/server.js";
import { setConnectedFolderIgnoreState } from "../src/local/connected-folder-ignore.js";

test("the act facade drives Connected Folder, conversation, and file-addition lifecycles with CLI semantics", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-facade-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;
    const createdConnectedFolder = await facade.createConnectedFolder({ name: "Act Connected Folder" });
    assert.ok(createdConnectedFolder.connectedFolder.id);
    assert.equal(createdConnectedFolder.connectedFolder.name, "Act Connected Folder");
    await assert.rejects(() => facade.createConnectedFolder({ name: "  " }), /Connected Folder name is required/);

    // Connected Folder selection follows the CLI id-or-exact-name semantics.
    const byName = await facade.listConversations({ connectedFolder: "Act Connected Folder" });
    assert.deepEqual(byName.conversations, []);
    await assert.rejects(
      () => facade.listConversations({ connectedFolder: "Missing Connected Folder" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );

    const registeredRoot = join(sandbox, "external-folder");
    await mkdir(registeredRoot, { recursive: true });
    const registered = await facade.registerConnectedFolder({ connectedFolderRoot: registeredRoot });
    assert.equal(registered.connectedFolder.connectedFolderRoot, registeredRoot);
    await assert.rejects(() => facade.registerConnectedFolder({ connectedFolderRoot: "relative/path" }), /absolute folder path/);

    const conversation = await facade.createConversation({ connectedFolder: createdConnectedFolder.connectedFolder.id });
    await assert.rejects(
      () => facade.sendMessage({ connectedFolder: createdConnectedFolder.connectedFolder.id, content: "hello" }),
      /--conversation <id> or --new/,
    );
    const send = await facade.sendMessage({
      connectedFolder: createdConnectedFolder.connectedFolder.id,
      conversationId: conversation.conversation.id,
      content: "/hold",
    });
    assert.equal(send.conversationId, conversation.conversation.id);
    assert.ok(send.taskId);
    const runningTasks = await api.kernel.getTasks({ kind: "system" });
    const turnTask = runningTasks.tasks.find((task) => task.id === send.taskId);
    assert.equal(turnTask?.actor.kind, "cli", "act-lane turns must record a cli actor in the kernel");

    await assert.rejects(
      () => facade.sendMessage({ connectedFolder: createdConnectedFolder.connectedFolder.id, conversationId: conversation.conversation.id, content: "again" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict",
    );

    // Waiting is task-scoped: follow the exact accepted turn to a terminal
    // outcome instead of polling the conversation for idleness.
    await waitForAsync(async () =>
      (await facade.turnStatus({ connectedFolder: createdConnectedFolder.connectedFolder.id, taskId: send.taskId })).task.state !== "running");
    const settled = await facade.turnStatus({ connectedFolder: createdConnectedFolder.connectedFolder.id, taskId: send.taskId });
    assert.equal(settled.task.state, "succeeded");
    assert.equal(settled.task.conversationId, conversation.conversation.id);
    assert.ok(settled.task.messageId, "a succeeded turn must record its response message id");
    const turnResult = await facade.turnResult({ connectedFolder: createdConnectedFolder.connectedFolder.id, taskId: send.taskId });
    assert.equal(turnResult.message.content, "Command completed.");
    assert.equal(turnResult.message.id, settled.task.messageId);
    assert.equal(turnResult.task.state, "succeeded");

    const unknownTask = await facade.turnStatus({ connectedFolder: createdConnectedFolder.connectedFolder.id, taskId: "task-unknown" });
    assert.equal(unknownTask.task.state, "unknown");
    await assert.rejects(
      () => facade.turnResult({ connectedFolder: createdConnectedFolder.connectedFolder.id, taskId: "task-unknown" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );

    const result = await facade.conversationResult({
      connectedFolder: createdConnectedFolder.connectedFolder.id,
      conversationId: conversation.conversation.id,
      messages: 5,
    });
    assert.equal(result.lastAssistant, "Command completed.");
    assert.equal(result.messages.at(-1)?.role, "assistant");
    assert.equal(result.messages.some((message) => message.content === "/hold"), true);
    assert.equal(result.state, "idle");

    // A failing turn (no provider is configured, so a plain prompt fails)
    // settles as failed for its own task and saves a sanitized agent
    // result instead of leaving an older success looking current.
    const failing = await facade.sendMessage({
      connectedFolder: createdConnectedFolder.connectedFolder.id,
      conversationId: conversation.conversation.id,
      content: "summarize this Connected Folder",
    });
    await waitForAsync(async () =>
      (await facade.turnStatus({ connectedFolder: createdConnectedFolder.connectedFolder.id, taskId: failing.taskId })).task.state !== "running");
    const failedStatus = await facade.turnStatus({ connectedFolder: createdConnectedFolder.connectedFolder.id, taskId: failing.taskId });
    assert.equal(failedStatus.task.state, "failed");
    assert.ok(failedStatus.task.error, "a failed turn must record its error");
    assert.ok(failedStatus.task.messageId, "a non-cancelled failure must record its durable result message");
    await assert.rejects(
      () => facade.turnResult({ connectedFolder: createdConnectedFolder.connectedFolder.id, taskId: failing.taskId }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "failure",
    );
    const failedTail = await facade.conversationResult({ connectedFolder: createdConnectedFolder.connectedFolder.id, conversationId: conversation.conversation.id });
    assert.match(failedTail.lastAssistant ?? "", /Settings → AI Models/);
    assert.equal(failedTail.messages.at(-1)?.interrupted, true);
    assert.doesNotMatch(JSON.stringify(failedTail), /No API key|node_modules|providers\.md/);
    await assert.rejects(
      () => facade.conversationResult({ connectedFolder: createdConnectedFolder.connectedFolder.id, conversationId: "chat-missing" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );

    const aborted = await facade.abortTurn({ connectedFolder: createdConnectedFolder.connectedFolder.id, conversationId: conversation.conversation.id });
    assert.equal(aborted.aborted, false, "aborting an idle Chat must report false");

    // files add copies external material and records an additive restore point.
    const sourceDir = join(sandbox, "incoming");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "report.txt"), "external", "utf8");
    await writeFile(join(sandbox, "notes.md"), "note", "utf8");
    const added = await facade.addFiles({
      connectedFolder: createdConnectedFolder.connectedFolder.id,
      fromPaths: [join(sourceDir, "report.txt"), "notes.md"],
      toDir: "Inbox",
      cwd: sandbox,
    });
    assert.deepEqual(added.copied, ["Inbox/report.txt", "Inbox/notes.md"]);
    assert.ok(added.checkpointId, "files add must record a restore point");
    assert.equal(existsSync(join(createdConnectedFolder.connectedFolder.connectedFolderRoot, "Inbox", "report.txt")), true);

    if (process.platform !== "win32") {
      await symlink(join(sourceDir, "report.txt"), join(sandbox, "linked.txt"));
      await assert.rejects(
        () => facade.addFiles({ connectedFolder: createdConnectedFolder.connectedFolder.id, fromPaths: [join(sandbox, "linked.txt")], cwd: sandbox }),
        /Symbolic-link/,
      );
    }
    await assert.rejects(
      () => facade.addFiles({ connectedFolder: createdConnectedFolder.connectedFolder.id, fromPaths: [join(sandbox, "content")], cwd: sandbox }),
      /contains this Connected Folder/,
    );
    await assert.rejects(
      () => facade.addFiles({
        connectedFolder: createdConnectedFolder.connectedFolder.id,
        fromPaths: [join(createdConnectedFolder.connectedFolder.connectedFolderRoot, "Inbox", "report.txt")],
        cwd: sandbox,
      }),
      /already inside this Connected Folder/,
    );
    await assert.rejects(
      () => facade.addFiles({ connectedFolder: createdConnectedFolder.connectedFolder.id, fromPaths: [join(sandbox, "missing.bin")], cwd: sandbox }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );

    // A folder copy that fails partway must leave no partial destination.
    if (process.platform !== "win32") {
      const partialSource = join(sandbox, "partial-source");
      await mkdir(partialSource, { recursive: true });
      await writeFile(join(partialSource, "readable.txt"), "ok", "utf8");
      await writeFile(join(partialSource, "unreadable.txt"), "secret", "utf8");
      await chmod(join(partialSource, "unreadable.txt"), 0o000);
      try {
        await assert.rejects(() =>
          facade.addFiles({ connectedFolder: createdConnectedFolder.connectedFolder.id, fromPaths: [partialSource], cwd: sandbox }));
        assert.equal(
          existsSync(join(createdConnectedFolder.connectedFolder.connectedFolderRoot, "partial-source")),
          false,
          "a failed folder copy must leave no partial destination",
        );
      } finally {
        await chmod(join(partialSource, "unreadable.txt"), 0o600);
      }
    }
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the act facade drives Chat lifecycle and History families with ledger conflict rules", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-fold-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 400)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;
    const { connectedFolder } = await facade.createConnectedFolder({ name: "Fold Connected Folder" });
    const conversation = (await facade.createConversation({ connectedFolder: connectedFolder.id })).conversation;

    // Rename appends a manual title record and reports the prior title for
    // the receipt's undo reference.
    const renamed = await facade.chatRename({ connectedFolder: connectedFolder.id, conversationId: conversation.id, title: "Weekly plan" });
    assert.equal(renamed.conversation.title, "Weekly plan");
    assert.equal(renamed.priorTitle, "New Chat");
    await assert.rejects(
      () => facade.chatRename({ connectedFolder: connectedFolder.id, conversationId: "chat-missing", title: "x" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );
    await assert.rejects(
      () => facade.chatRename({ connectedFolder: connectedFolder.id, conversationId: conversation.id, title: "   " }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "usage",
    );

    // Snooze requires a future time and records the prior lifecycle state.
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const snoozed = await facade.chatSnooze({ connectedFolder: connectedFolder.id, conversationId: conversation.id, until });
    assert.equal(snoozed.conversation.snoozedUntil, until);
    assert.deepEqual(snoozed.priorLifecycle, { archivedAt: null, snoozedUntil: null });
    await assert.rejects(
      () => facade.chatSnooze({
        connectedFolder: connectedFolder.id,
        conversationId: conversation.id,
        until: new Date(Date.now() - 1000).toISOString(),
      }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "usage" && /future snooze time/.test(error.message),
    );

    // Sending into a future-snoozed Chat is refused until an explicit resume.
    await assert.rejects(
      () => facade.sendMessage({ connectedFolder: connectedFolder.id, conversationId: conversation.id, content: "hello" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict",
    );
    const resumedFromSnooze = await facade.chatResume({ connectedFolder: connectedFolder.id, conversationId: conversation.id });
    assert.equal(resumedFromSnooze.conversation.snoozedUntil, null);
    assert.equal(resumedFromSnooze.priorLifecycle.snoozedUntil, until);
    await assert.rejects(
      () => facade.chatResume({ connectedFolder: connectedFolder.id, conversationId: conversation.id }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /already active/.test(error.message),
    );

    // Archive wins over snooze rules: one lifecycle change per act, and the
    // inverse verb is resume.
    const archived = await facade.chatArchive({ connectedFolder: connectedFolder.id, conversationId: conversation.id });
    assert.ok(archived.conversation.archivedAt);
    assert.deepEqual(archived.priorLifecycle, { archivedAt: null, snoozedUntil: null });
    await assert.rejects(
      () => facade.chatArchive({ connectedFolder: connectedFolder.id, conversationId: conversation.id }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /already archived/.test(error.message),
    );
    await assert.rejects(
      () => facade.chatSnooze({ connectedFolder: connectedFolder.id, conversationId: conversation.id, until }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /Unarchive this Chat/.test(error.message),
    );
    await assert.rejects(
      () => facade.sendMessage({ connectedFolder: connectedFolder.id, conversationId: conversation.id, content: "hello" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /Restore this Chat/.test(error.message),
    );
    const resumedFromArchive = await facade.chatResume({ connectedFolder: connectedFolder.id, conversationId: conversation.id });
    assert.equal(resumedFromArchive.conversation.archivedAt, null);
    assert.ok(resumedFromArchive.priorLifecycle.archivedAt);

    // Lifecycle changes are append-only records in the Chat's portable log.
    const transcript = await readFile(
      join(connectedFolder.connectedFolderRoot, ".amplefile", "conversations", `${conversation.id}.jsonl`),
      "utf8",
    );
    assert.equal(transcript.split("\n").filter((line) => line.includes("\"conversation_lifecycle\"")).length, 4);

    // History: saving is additive and honestly reports an unchanged Connected Folder.
    await writeFile(join(connectedFolder.connectedFolderRoot, "notes.md"), "first draft", "utf8");
    const firstSave = await facade.historySave({ connectedFolder: connectedFolder.id, label: "draft one" });
    assert.equal(firstSave.created, true);
    assert.equal(firstSave.checkpoint.label, "draft one");
    assert.ok(firstSave.checkpoint.fileCount >= 1);
    const unchangedSave = await facade.historySave({ connectedFolder: connectedFolder.id });
    assert.equal(unchangedSave.created, false);
    assert.equal(unchangedSave.checkpoint.checkpointId, firstSave.checkpoint.checkpointId);

    await writeFile(join(connectedFolder.connectedFolderRoot, "notes.md"), "second draft", "utf8");
    const secondSave = await facade.historySave({ connectedFolder: connectedFolder.id });
    assert.equal(secondSave.created, true);
    assert.notEqual(secondSave.checkpoint.checkpointId, firstSave.checkpoint.checkpointId);
    const listed = await facade.historyList({ connectedFolder: connectedFolder.id });
    assert.deepEqual(
      listed.checkpoints.slice(0, 2).map((checkpoint) => checkpoint.checkpointId),
      [secondSave.checkpoint.checkpointId, firstSave.checkpoint.checkpointId],
    );

    // File versions are content-addressed and restorable one file at a time,
    // with the safety restore point History itself records.
    const versions = await facade.historyVersions({ connectedFolder: connectedFolder.id, path: "notes.md" });
    assert.equal(versions.versions.length, 2);
    const firstVersion = versions.versions.find((version) => version.checkpointId === firstSave.checkpoint.checkpointId);
    assert.ok(firstVersion);
    const fileRestore = await facade.historyRestoreFile({
      connectedFolder: connectedFolder.id,
      path: "notes.md",
      version: firstVersion.hashSha256,
    });
    assert.equal(fileRestore.restored, true);
    assert.ok(fileRestore.safetyCheckpointId);
    assert.ok(fileRestore.previousHashSha256);
    assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "notes.md"), "utf8"), "first draft");
    await assert.rejects(
      () => facade.historyRestoreFile({ connectedFolder: connectedFolder.id, path: "notes.md", version: "not-a-hash" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "usage",
    );
    await assert.rejects(
      () => facade.historyRestoreFile({ connectedFolder: connectedFolder.id, path: "notes.md", version: "0".repeat(64) }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );
    await mkdir(join(connectedFolder.connectedFolderRoot, "docs"), { recursive: true });
    await assert.rejects(
      () => facade.historyRestoreFile({ connectedFolder: connectedFolder.id, path: "docs", version: firstVersion.hashSha256 }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /currently a folder/.test(error.message),
    );

    // Whole–Connected Folder restore returns to the restore point and records its own
    // pre-restore safety restore point.
    await writeFile(join(connectedFolder.connectedFolderRoot, "notes.md"), "unsaved third draft", "utf8");
    const restored = await facade.historyRestore({ connectedFolder: connectedFolder.id, checkpointId: secondSave.checkpoint.checkpointId });
    assert.equal(restored.restored, true);
    assert.equal(restored.checkpointId, secondSave.checkpoint.checkpointId);
    assert.ok(restored.safetyCheckpointId);
    assert.ok(restored.restoredFileCount >= 1);
    assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "notes.md"), "utf8"), "second draft");
    await assert.rejects(
      () => facade.historyRestore({ connectedFolder: connectedFolder.id, checkpointId: "cp-00000000000000-missing" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );

    // Ledger conflict rules: lifecycle verbs, compaction, and whole–Connected Folder
    // restore are refused while a turn runs in that Chat / Connected Folder.
    const holdConversation = (await facade.createConversation({ connectedFolder: connectedFolder.id })).conversation;
    const running = await facade.sendMessage({ connectedFolder: connectedFolder.id, conversationId: holdConversation.id, content: "/hold" });
    await assert.rejects(
      () => facade.chatRename({ connectedFolder: connectedFolder.id, conversationId: holdConversation.id, title: "Busy" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /turn to finish/.test(error.message),
    );
    await assert.rejects(
      () => facade.chatCompact({ connectedFolder: connectedFolder.id, conversationId: holdConversation.id }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /turn to finish/.test(error.message),
    );
    await assert.rejects(
      () => facade.historyRestore({ connectedFolder: connectedFolder.id, checkpointId: secondSave.checkpoint.checkpointId }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /running turn in this Connected Folder/.test(error.message),
    );
    const desktopRestore = await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}/history/checkpoints/${secondSave.checkpoint.checkpointId}/restore`, { method: "POST" });
    assert.equal(desktopRestore.status, 409, "desktop checkpoint restore uses the same running-work fence");
    const desktopFileRestore = await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}/history/file-versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes.md", hashSha256: firstVersion.hashSha256 }),
    });
    assert.equal(desktopFileRestore.status, 409, "desktop file restore cannot bypass the Connected Folder fence");
    await waitForAsync(async () =>
      (await facade.turnStatus({ connectedFolder: connectedFolder.id, taskId: running.taskId })).task.state !== "running");

    // chat compact reuses the renderer's compaction internals with the
    // kernel-task discipline. No provider is configured here, so the
    // compaction fails through the same runtime path as the renderer — and
    // the kernel compaction task is finished on that failure, never leaked.
    await assert.rejects(
      () => facade.chatCompact({ connectedFolder: connectedFolder.id, conversationId: "chat-missing" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );
    await assert.rejects(
      () => facade.chatCompact({ connectedFolder: connectedFolder.id, conversationId: holdConversation.id }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "failure",
    );
    assert.deepEqual(
      (await api.kernel.getTasks({ kind: "system" })).tasks,
      [],
      "a failed compaction finishes its kernel task instead of leaving a ghost",
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the act facade drives file and search families with ledger safety rules", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-files-test-"));
  await mkdir(join(sandbox, "agent"), { recursive: true });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;
    const { connectedFolder } = await facade.createConnectedFolder({ name: "Files Connected Folder" });

    // Creation runs the desktop create internals: additive, name-collision
    // refused, and undone by files delete rather than a restore point.
    const folder = await facade.filesMkdir({ connectedFolder: connectedFolder.id, path: "notes" });
    assert.equal(folder.path, "notes");
    assert.equal(folder.kind, "folder");
    assert.ok(folder.safetyCheckpointId);
    assert.equal(existsSync(join(connectedFolder.connectedFolderRoot, "notes")), true);
    await assert.rejects(() => facade.filesMkdir({ connectedFolder: connectedFolder.id, path: "notes" }), /already exists/);

    const created = await facade.filesCreate({ connectedFolder: connectedFolder.id, path: "notes/todo.md" });
    assert.equal(created.path, "notes/todo.md");
    assert.equal(created.kind, "file");
    assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "notes", "todo.md"), "utf8"), "");
    await assert.rejects(() => facade.filesCreate({ connectedFolder: connectedFolder.id, path: "notes/todo.md" }), /already exists/);

    // Reserved metadata is never a valid endpoint, exactly as in the renderer.
    await assert.rejects(() => facade.filesCreate({ connectedFolder: connectedFolder.id, path: ".pi/hack.md" }), /reserved/);
    await assert.rejects(() => facade.filesMkdir({ connectedFolder: connectedFolder.id, path: ".amplefile/extra" }), /reserved/);
    await assert.rejects(
      () => facade.filesMkdir({ connectedFolder: connectedFolder.id, path: "   ", parentTaskId: undefined }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "usage",
    );

    // Move records the same pre-move safety restore point as the desktop
    // route, and restoring it is the undo.
    await mkdir(join(connectedFolder.connectedFolderRoot, "docs"), { recursive: true });
    await writeFile(join(connectedFolder.connectedFolderRoot, "docs", "plan.md"), "plan", "utf8");
    const moved = await facade.filesMove({ connectedFolder: connectedFolder.id, fromPath: "docs/plan.md", toDir: "notes" });
    assert.equal(moved.fromPath, "docs/plan.md");
    assert.equal(moved.path, "notes/plan.md");
    assert.equal(moved.kind, "file");
    assert.equal(existsSync(join(connectedFolder.connectedFolderRoot, "notes", "plan.md")), true);
    assert.equal(existsSync(join(connectedFolder.connectedFolderRoot, "docs", "plan.md")), false);
    const movedBack = await facade.historyRestore({ connectedFolder: connectedFolder.id, checkpointId: moved.safetyCheckpointId });
    assert.equal(movedBack.movedEntryCount, 1);
    assert.equal(existsSync(join(connectedFolder.connectedFolderRoot, "docs", "plan.md")), true);
    assert.equal(existsSync(join(connectedFolder.connectedFolderRoot, "notes", "plan.md")), false);
    await assert.rejects(
      () => facade.filesMove({ connectedFolder: connectedFolder.id, fromPath: "notes", toDir: "notes/sub" }),
      /into themselves/,
    );

    // Rename reports the prior name for the receipt's undo reference.
    const renamed = await facade.filesRename({ connectedFolder: connectedFolder.id, path: "notes/todo.md", newName: "done.md" });
    assert.equal(renamed.priorName, "todo.md");
    assert.equal(renamed.fromPath, "notes/todo.md");
    assert.equal(renamed.path, "notes/done.md");
    assert.ok(renamed.safetyCheckpointId);
    await assert.rejects(
      () => facade.filesRename({ connectedFolder: connectedFolder.id, path: "notes/done.md", newName: "done.md" }),
      /already has this name/,
    );

    // Delete's safety restore point is the durable form of the Undo toast.
    await writeFile(join(connectedFolder.connectedFolderRoot, "notes", "done.md"), "keep me", "utf8");
    const deletedEntry = await facade.filesDelete({ connectedFolder: connectedFolder.id, path: "notes/done.md" });
    assert.equal(deletedEntry.deleted, true);
    assert.equal(deletedEntry.kind, "file");
    assert.equal(existsSync(join(connectedFolder.connectedFolderRoot, "notes", "done.md")), false);
    await facade.historyRestore({ connectedFolder: connectedFolder.id, checkpointId: deletedEntry.safetyCheckpointId });
    assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "notes", "done.md"), "utf8"), "keep me");

    // Destruction stays reversible (docs/act-ledger.md): a delete whose restore
    // point cannot cover every matched file never refuses. The whole selected
    // entry moves to Recently Deleted, the
    // receipt's undo reference is that entry, and restoring it puts the
    // entry back byte for byte — links included.
    await mkdir(join(connectedFolder.connectedFolderRoot, "bulk"), { recursive: true });
    await writeFile(join(connectedFolder.connectedFolderRoot, "bulk", "big.bin"), "0123456789", "utf8");
    if (process.platform !== "win32") {
      await symlink(join(connectedFolder.connectedFolderRoot, "notes", "done.md"), join(connectedFolder.connectedFolderRoot, "bulk", "link.md"));
    }
    const checkpointsBefore = (await facade.historyList({ connectedFolder: connectedFolder.id })).checkpoints.length;
    process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = "4";
    let uncoverable;
    try {
      uncoverable = await facade.filesDelete({ connectedFolder: connectedFolder.id, path: "bulk" });
    } finally {
      delete process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES;
    }
    assert.equal(uncoverable.deleted, true);
    assert.equal(uncoverable.kind, "folder");
    assert.equal(existsSync(join(connectedFolder.connectedFolderRoot, "bulk")), false, "the entry moves out of the Connected Folder");
    assert.equal(uncoverable.recovery.kind, "recently-deleted");
    assert.equal(
      (await facade.historyList({ connectedFolder: connectedFolder.id })).checkpoints.length,
      checkpointsBefore + 1,
      "the delete still records its restore point for what History could cover",
    );
    const uncoveredReasons = uncoverable.recovery.kind === "recently-deleted"
      ? uncoverable.recovery.uncovered.map((file) => `${file.path}:${file.reason}`).sort()
      : [];
    assert.ok(uncoveredReasons.includes("bulk/big.bin:too_large"), uncoveredReasons.join(","));
    if (process.platform !== "win32") {
      assert.ok(uncoveredReasons.includes("bulk/link.md:symbolic_link"), uncoveredReasons.join(","));
    }
    const kept = (await api.recentlyDeleted.list()).entries;
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.kind, "folder");
    assert.equal(kept[0]?.originalPath, "bulk");
    assert.equal(kept[0]?.connectedFolderId, connectedFolder.id);
    const restored = await facade.recentlyDeletedRestore({ entry: kept[0]!.id });
    assert.equal(restored.restored.kind, "folder");
    assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "bulk", "big.bin"), "utf8"), "0123456789");
    if (process.platform !== "win32") {
      assert.equal((await lstat(join(connectedFolder.connectedFolderRoot, "bulk", "link.md"))).isSymbolicLink(), true);
      await rm(join(connectedFolder.connectedFolderRoot, "bulk", "link.md"));
    }
    assert.deepEqual((await api.recentlyDeleted.list()).entries, [], "a restored item leaves Recently deleted");

    // Search reuses the Connected Folder search service: ignore rules hold, scopes
    // narrow, and malformed queries map to usage errors.
    await mkdir(join(connectedFolder.connectedFolderRoot, "vendor"), { recursive: true });
    await writeFile(join(connectedFolder.connectedFolderRoot, "vendor", "bundle.js"), "quarterly budget in a dependency", "utf8");
    await writeFile(join(connectedFolder.connectedFolderRoot, "notes", "report.md"), "the quarterly budget is due", "utf8");
    await appendMessage(connectedFolder.connectedFolderRoot, "chat-1", {
      id: "m1",
      role: "user",
      content: "check the quarterly budget",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await setConnectedFolderIgnoreState(connectedFolder.connectedFolderRoot, ["vendor"], true);
    const found = await facade.search({ connectedFolder: connectedFolder.id, query: "quarterly budget" });
    assert.equal(found.scope, "all");
    assert.equal(found.query, "quarterly budget");
    assert.deepEqual(found.files.map((match) => match.path), ["notes/report.md"]);
    assert.equal(found.files[0]?.line, 1);
    assert.equal(found.chats.length, 1);
    assert.equal(found.chats[0]?.conversationId, "chat-1");
    assert.equal(found.truncated, false);
    const filesOnly = await facade.search({ connectedFolder: connectedFolder.id, query: "quarterly budget", scope: "files" });
    assert.equal(filesOnly.chats.length, 0);
    assert.equal(filesOnly.files.length, 1);
    await assert.rejects(
      () => facade.search({ connectedFolder: connectedFolder.id, query: "   " }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "usage",
    );
    await assert.rejects(
      () => facade.search({ connectedFolder: connectedFolder.id, query: "x".repeat(64 * 1024 + 1) }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "usage",
    );

    // Mutation verbs refuse a named AmpleFile agent parent that is not active.
    await assert.rejects(
      () => facade.filesMkdir({ connectedFolder: connectedFolder.id, path: "orphan", parentTaskId: "task-gone" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict",
    );
    assert.equal(existsSync(join(connectedFolder.connectedFolderRoot, "orphan")), false);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the act facade drives Connected Folder rename, appearance, and tools families with ledger rules", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-studio-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;
    const { connectedFolder } = await facade.createConnectedFolder({ name: "Fold One" });
    await facade.createConnectedFolder({ name: "Fold Two" });

    // Renaming refuses a case-insensitive duplicate — the CLI selector folds
    // names the same way, so a duplicate would make --connected-folder ambiguous — but a
    // Connected Folder may still change its own casing.
    await assert.rejects(
      () => facade.connectedFoldersRename({ connectedFolder: connectedFolder.id, name: "fold two" }),
      (error: unknown) => error instanceof AmpleFileCliError
        && error.code === "conflict"
        && /already named Fold Two/.test(error.message),
    );
    const renamed = await facade.connectedFoldersRename({ connectedFolder: connectedFolder.id, name: "Fold Prime" });
    assert.equal(renamed.priorName, "Fold One");
    assert.equal(renamed.connectedFolder.name, "Fold Prime");
    const recased = await facade.connectedFoldersRename({ connectedFolder: "Fold Prime", name: "FOLD PRIME" });
    assert.equal(recased.priorName, "Fold Prime");
    assert.equal(recased.connectedFolder.name, "FOLD PRIME");

    // Appearance undo is refused with a typed error while no receipted
    // appearance act has recorded a prior customization for the Connected Folder.
    await assert.rejects(
      () => facade.connectedFoldersAppearanceUndo({ connectedFolder: connectedFolder.id }),
      (error: unknown) => error instanceof AmpleFileCliError
        && error.code === "conflict"
        && /No receipted appearance act/.test(error.message),
    );

    // Only the typed proposal file is accepted, and an explicit target for a
    // different Connected Folder is a refusal, not a silent restyle.
    const proposalPath = join(sandbox, "calm.amplefile-appearance.json");
    await writeFile(proposalPath, JSON.stringify({
      kind: "amplefile.connected-folder-appearance",
      version: 1,
      name: "Calm blue",
      customization: { color: "#3366aa" },
      createdBy: "human",
    }), "utf8");
    const mismatchPath = join(sandbox, "elsewhere.amplefile-appearance.json");
    await writeFile(mismatchPath, JSON.stringify({
      kind: "amplefile.connected-folder-appearance",
      version: 1,
      name: "Elsewhere",
      target: { connectedFolderId: "connected-folder-elsewhere" },
      customization: { color: "#3366aa" },
    }), "utf8");
    await assert.rejects(
      () => facade.connectedFoldersAppearanceApply({ connectedFolder: connectedFolder.id, proposalPath: mismatchPath, cwd: sandbox }),
      (error: unknown) => error instanceof AmpleFileCliError
        && error.code === "conflict"
        && /targets a different Connected Folder \(connected-folder-elsewhere\)/.test(error.message),
    );
    const notProposalPath = join(sandbox, "not-a-proposal.json");
    await writeFile(notProposalPath, JSON.stringify({ hello: "world" }), "utf8");
    await assert.rejects(
      () => facade.connectedFoldersAppearanceApply({ connectedFolder: connectedFolder.id, proposalPath: notProposalPath, cwd: sandbox }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "usage",
    );
    await assert.rejects(
      () => facade.connectedFoldersAppearanceApply({ connectedFolder: connectedFolder.id, proposalPath: "missing.json", cwd: sandbox }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );

    const applied = await facade.connectedFoldersAppearanceApply({ connectedFolder: connectedFolder.id, proposalPath, cwd: sandbox });
    assert.equal(applied.proposalName, "Calm blue");
    assert.match(applied.appearanceRef ?? "", /^sha256:[0-9a-f]{16}$/);
    assert.equal(applied.priorAppearanceRef, null);

    // Undo is one act and its own inverse: default -> applied -> default.
    const undone = await facade.connectedFoldersAppearanceUndo({ connectedFolder: connectedFolder.id });
    assert.equal(undone.restoredAppearanceRef, null);
    assert.equal(undone.displacedAppearanceRef, applied.appearanceRef);
    const redone = await facade.connectedFoldersAppearanceUndo({ connectedFolder: connectedFolder.id });
    assert.equal(redone.restoredAppearanceRef, applied.appearanceRef);
    assert.equal(redone.displacedAppearanceRef, null);

    const reset = await facade.connectedFoldersAppearanceReset({ connectedFolder: connectedFolder.id });
    assert.equal(reset.changed, true);
    assert.equal(reset.priorAppearanceRef, applied.appearanceRef);
    const resetAgain = await facade.connectedFoldersAppearanceReset({ connectedFolder: connectedFolder.id });
    assert.equal(resetAgain.changed, false);
    assert.equal(resetAgain.priorAppearanceRef, null);

    // A desktop-side appearance change makes the recorded prior state stale,
    // so undo refuses instead of restoring a state its receipt never named.
    const desktopEdit = await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}/appearance`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customization: { color: "#aa3366" } }),
    });
    assert.equal(desktopEdit.ok, true);
    await assert.rejects(
      () => facade.connectedFoldersAppearanceUndo({ connectedFolder: connectedFolder.id }),
      (error: unknown) => error instanceof AmpleFileCliError
        && error.code === "conflict"
        && /changed outside the act lane/.test(error.message),
    );

    // Tools removal reuses the desktop capability fencing unchanged: personal
    // scope is fenced against any running agent work, Connected Folder scope against
    // that Connected Folder's work.
    const conversation = await facade.createConversation({ connectedFolder: connectedFolder.id });
    const holding = await facade.sendMessage({
      connectedFolder: connectedFolder.id,
      conversationId: conversation.conversation.id,
      content: "/hold",
    });
    await assert.rejects(
      () => facade.toolsRemove({ scope: "everywhere", source: "./missing-tool-pkg" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict",
    );
    await assert.rejects(
      () => facade.toolsRemove({ scope: "connected-folder", connectedFolder: connectedFolder.id, source: "./missing-tool-pkg" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict",
    );
    await waitForAsync(async () =>
      (await facade.turnStatus({ connectedFolder: connectedFolder.id, taskId: holding.taskId })).task.state !== "running");
    const everywhereRemoval = await facade.toolsRemove({ scope: "everywhere", source: "./missing-tool-pkg" });
    assert.deepEqual(everywhereRemoval, { scope: "everywhere", source: "./missing-tool-pkg", removed: false });
    const connectedFolderRemoval = await facade.toolsRemove({ scope: "connected-folder", connectedFolder: connectedFolder.id, source: "./missing-tool-pkg" });
    assert.equal(connectedFolderRemoval.removed, false);
    assert.equal(connectedFolderRemoval.connectedFolder?.id, connectedFolder.id);

    // Unregistering removes the registration while the folder and its
    // portable identity remain; re-registering restores the same Connected Folder id.
    const linkedRoot = join(sandbox, "linked-fold");
    await mkdir(linkedRoot, { recursive: true });
    await writeFile(join(linkedRoot, "keep.md"), "still here", "utf8");
    const linked = await facade.registerConnectedFolder({ connectedFolderRoot: linkedRoot });
    const unregistered = await facade.connectedFoldersUnregister({ connectedFolder: linked.connectedFolder.id });
    assert.equal(unregistered.storage, "linked");
    assert.equal(unregistered.removed, true);
    assert.equal(await readFile(join(linkedRoot, "keep.md"), "utf8"), "still here");
    assert.equal(existsSync(join(linkedRoot, ".amplefile", "connected-folder.json")), true, "the portable identity persists");
    await assert.rejects(
      () => facade.listConversations({ connectedFolder: linked.connectedFolder.id }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );
    const reRegistered = await facade.registerConnectedFolder({ connectedFolderRoot: linkedRoot });
    assert.equal(reRegistered.connectedFolder.id, linked.connectedFolder.id, "re-registration restores the persisted identity");

    // A managed Connected Folder unregisters the same way: the registration and
    // runtime authorization go, while the managed folder and its portable
    // identity provably survive — deleting the folder is `connected-folders delete`.
    const managedKeep = await facade.createConnectedFolder({ name: "Managed Keep" });
    await writeFile(join(managedKeep.connectedFolder.connectedFolderRoot, "keep.md"), "still managed", "utf8");
    const managedRemoval = await facade.connectedFoldersUnregister({ connectedFolder: managedKeep.connectedFolder.id });
    assert.equal(managedRemoval.storage, "managed");
    assert.equal(managedRemoval.removed, true);
    assert.equal(await readFile(join(managedKeep.connectedFolder.connectedFolderRoot, "keep.md"), "utf8"), "still managed");
    assert.equal(
      existsSync(join(managedKeep.connectedFolder.connectedFolderRoot, ".amplefile", "connected-folder.json")),
      true,
      "the managed folder keeps its portable identity",
    );
    await assert.rejects(
      () => facade.listConversations({ connectedFolder: managedKeep.connectedFolder.id }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );

  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the direct act path executes formerly gated verbs behind fences, receipts, and honest refusals", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-direct-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 500)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;
    const doomed = await facade.createConnectedFolder({ name: "Doomed" });

    // `connected-folders delete` runs the shared removal orchestration on the first
    // call: the folder is gone, the registration is gone, the result is the
    // effect, and no decision identity exists anywhere
    // (docs/act-ledger.md).
    const deleted = await facade.connectedFoldersDelete({ connectedFolder: doomed.connectedFolder.id, requestId: "req-delete-1" });
    assert.equal(deleted.removed, true);
    assert.equal(deleted.storage, "managed");
    assert.equal("staged" in deleted, false);
    assert.equal("decisionId" in deleted, false);
    assert.equal(existsSync(doomed.connectedFolder.connectedFolderRoot), false, "the managed folder is deleted on the first call");
    await assert.rejects(
      () => facade.listConversations({ connectedFolder: doomed.connectedFolder.id }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );
    // No ghost kernel task survives an execution.
    assert.deepEqual((await api.kernel.getTasks({ kind: "system" })).tasks, []);

    // The fence refuses while agent work runs in the affected Connected Folder,
    // and a refused act changes nothing; a second attempt is a fresh call.
    const held = await facade.createConnectedFolder({ name: "Busy" });
    const heldChat = await facade.createConversation({ connectedFolder: held.connectedFolder.id });
    const heldTurn = await facade.sendMessage({
      connectedFolder: held.connectedFolder.id,
      conversationId: heldChat.conversation.id,
      content: "/hold",
    });
    await assert.rejects(
      () => facade.connectedFoldersDelete({ connectedFolder: held.connectedFolder.id, requestId: "req-delete-busy" }),
      (error: unknown) => error instanceof AmpleFileCliError
        && error.code === "conflict"
        && /Wait for affected/.test(error.message),
    );
    assert.equal(existsSync(held.connectedFolder.connectedFolderRoot), true, "a refused act changes nothing");
    await waitForAsync(async () =>
      (await facade.turnStatus({ connectedFolder: held.connectedFolder.id, taskId: heldTurn.taskId })).task.state !== "running");
    assert.deepEqual((await api.kernel.getTasks({ kind: "system" })).tasks, []);

    // A skill import runs at once at Personal scope and reports where the
    // bundle landed; the result is the effect, not a pending record.
    await writeFile(join(sandbox, "SKILL.md"), "---\nname: notes\n---\n# Notes\n", "utf8");
    const imported = await facade.toolsImportSkill({ scope: "everywhere", from: "SKILL.md", cwd: sandbox, requestId: "req-import-1" });
    assert.deepEqual(imported.skillNames, ["notes"]);
    assert.equal(imported.scope, "everywhere");
    assert.ok(imported.bundlePath, "the effect names the imported bundle");
    assert.equal(existsSync(imported.bundlePath), true);
    assert.equal("staged" in imported, false);

    // Needs you means questions: the overview carries no decision items.
    const overview = await facade.agentOverview();
    assert.equal(overview.kind, "amplefile.overview.experimental");
    assert.ok(overview.needsYou.every((item) => (item.kind as string) !== "pending-decision"));
    assert.ok(overview.changes.every((item) => (item.kind as string) !== "decision-recorded"));
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Connected Folder unregister suspends automation authority", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-unregister-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  try {
    const facade = api.actFacade;
    const root = join(sandbox, "shared-folder");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "report.md"), "# Weekly\n\nAll clear.\n", "utf8");
    const registered = await facade.registerConnectedFolder({ connectedFolderRoot: root });

    const automationId = "automation-weekly-glue";
    const declaration = {
      kind: "amplefile.automation",
      version: 1,
      id: automationId,
      title: "Weekly glue",
      createdBy: "human",
      createdAt: "2026-08-01T00:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [{ id: "review", kind: "chat", connectedFolder: registered.connectedFolder.id, message: "Review the report." }],
    };
    const enabled = await api.automations.enable({
      declaration,
      expectedDigest: ampleFileAutomationDigest(normalizeAmpleFileAutomationDeclaration(declaration)),
      grant: { requestId: "request-automation-1", surface: "main-window" },
    });
    assert.equal(enabled.health, "enabled");

    const removal = await facade.connectedFoldersUnregister({ connectedFolder: registered.connectedFolder.id });
    assert.equal(removal.removed, true);
    assert.equal(existsSync(root), true, "a linked registration removal leaves the folder");
    const suspended = await api.automations.getAutomation(automationId);
    assert.equal(suspended?.health, "suspended");
    assert.deepEqual(suspended?.suspension?.missingConnectedFolderIds, [registered.connectedFolder.id]);

    // Re-registration is noted in copy only; the automation stays suspended.
    const reRegistered = await facade.registerConnectedFolder({ connectedFolderRoot: root });
    assert.equal(reRegistered.connectedFolder.id, registered.connectedFolder.id, "portable identity survives re-registration");
    const noted = await api.automations.getAutomation(automationId);
    assert.equal(noted?.health, "suspended", "registration never silently re-arms standing behavior");
    assert.deepEqual(noted?.suspension?.reRegisteredConnectedFolderIds, [registered.connectedFolder.id]);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("automation runs drive live chat hops with receipts, stop honestly, and refuse after shutdown", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-automation-run-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 4000)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  let closed = false;
  try {
    const facade = api.actFacade;
    const connectedFolder = await facade.createConnectedFolder({ name: "Glue target" });
    const handoffTarget = await facade.createConnectedFolder({ name: "Handoff target" });
    const bystander = await facade.createConnectedFolder({ name: "Bystander" });
    await writeFile(join(connectedFolder.connectedFolder.connectedFolderRoot, "notes.md"), "handoff", "utf8");
    const automationId = "automation-hold-review";
    const declaration = {
      kind: "amplefile.automation",
      version: 1,
      id: automationId,
      title: "Hold review",
      createdBy: "human",
      createdAt: "2026-08-01T00:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [
        { id: "review", kind: "chat", connectedFolder: connectedFolder.connectedFolder.id, message: "/hold" },
        {
          id: "handoff",
          kind: "files",
          fromConnectedFolder: connectedFolder.connectedFolder.id,
          from: { kind: "paths", paths: ["notes.md"] },
          toConnectedFolder: handoffTarget.connectedFolder.id,
          to: "Inbox",
        },
      ],
    };
    await api.automations.enable({
      declaration,
      expectedDigest: ampleFileAutomationDigest(normalizeAmpleFileAutomationDeclaration(declaration)),
      grant: { requestId: "request-automation-run", surface: "main-window" },
    });

    const run = api.automations.runNow(automationId, { requestId: "req-run-now" });
    // The hop dispatches a real turn into a fresh Chat in the target Connected Folder.
    await waitForAsync(async () => {
      const conversations = await facade.listConversations({ connectedFolder: connectedFolder.connectedFolder.id });
      if (!conversations.conversations.length) return false;
      const status = await facade.conversationStatus({
        connectedFolder: connectedFolder.connectedFolder.id,
        conversationId: conversations.conversations[0]!.id,
      });
      return status.state === "running";
    }, 60_000);

    // The ledger's History-restore fence (conflict rule 7): while this run is
    // active, a whole–Connected Folder restore of the files hop's target Connected Folder refuses
    // through the kernel-checked rule — and a Connected Folder the run never writes into
    // restores past the fence (here to its own honest not-found).
    await assert.rejects(
      () => facade.historyRestore({ connectedFolder: handoffTarget.connectedFolder.id, checkpointId: "cp-00000000000000-missing" }),
      (error: unknown) => error instanceof AmpleFileCliError
        && error.code === "conflict"
        && /automation run .*automation-hold-review/.test(error.message)
        && /files hop into this Connected Folder/.test(error.message),
    );
    await assert.rejects(
      () => facade.historyRestore({ connectedFolder: bystander.connectedFolder.id, checkpointId: "cp-00000000000000-missing" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );
    const stopped = api.automations.stopRun(automationId);
    assert.ok(stopped?.runId, "an active run is stoppable by automation id");
    const result = await run;
    assert.equal(result.outcome, "failure", "a stopped run never reads as success in the scheduler history");

    const receiptsText = await readFile(join(sandbox, "state", "automations", "receipts.jsonl"), "utf8");
    const receipts = receiptsText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const runReceipts = receipts.filter((entry) => entry.runId === stopped!.runId && entry.scope === "run");
    assert.deepEqual(
      runReceipts.map((entry) => entry.outcome),
      ["accepted", "stopped"],
      "the run journals acceptance before hop 1 and settles stopped",
    );
    const hopReceipts = receipts.filter((entry) => entry.runId === stopped!.runId && entry.scope === "hop");
    assert.equal(hopReceipts[0]?.outcome, "accepted");
    const stoppedChatHop = hopReceipts.find((entry) => entry.hopId === "review" && entry.outcome === "stopped");
    assert.ok(stoppedChatHop?.taskId, "the stopped chat hop names the aborted turn task");
    assert.equal(
      hopReceipts.find((entry) => entry.hopId === "handoff")?.outcome,
      "skipped",
      "the files hop after the stop is recorded skipped, never silently dropped",
    );
    assert.deepEqual((await api.kernel.getTasks({ kind: "system" })).tasks, [], "no ghost tasks survive a stopped run");
    await assert.rejects(
      () => facade.historyRestore({ connectedFolder: handoffTarget.connectedFolder.id, checkpointId: "cp-00000000000000-missing" }),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
      "a settled run releases the restore fence",
    );

    // The overview renders the settled run from the receipts journal.
    const overview = await facade.agentOverview();
    assert.ok(
      overview.changes.some((item) => item.kind === "automation-run-settled" && item.ref?.runId === stopped!.runId),
      "a settled automation run is a change item",
    );

    closed = true;
    await api.close();
    await assert.rejects(
      () => api.automations.runNow(automationId),
      (error: unknown) => (error as { code?: string }).code === "SERVICE_DAMAGED"
        && /closed/.test((error as Error).message),
      "the executor refuses new runs after shutdown",
    );
  } finally {
    if (!closed) await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("automation enablement executes on one call with one request identity", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-enable-test-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  try {
    const facade = api.actFacade;
    const connectedFolder = await facade.createConnectedFolder({ name: "Glue Connected Folder" });

    const tooSoonPath = join(sandbox, "too-soon.amplefile-automation.json");
    await writeFile(tooSoonPath, JSON.stringify({
      kind: "amplefile.automation-proposal",
      version: 2,
      name: "Too soon",
      createdBy: "assistant",
      createdAt: new Date().toISOString(),
      automation: {
        title: "Too soon",
        trigger: { kind: "at", at: new Date(Date.now() - 30_000).toISOString(), ifMissed: "run" },
        steps: [{ id: "review", kind: "chat", connectedFolder: connectedFolder.connectedFolder.id, message: "Review the report." }],
      },
    }, null, 2), "utf8");
    await assert.rejects(
      () => facade.automationsEnable({ proposalPath: tooSoonPath, cwd: sandbox, requestId: "req-automation-too-soon" }),
      /in the future, and at most ten years ahead/,
      "an unusable one-time automation is refused before anything is enabled",
    );

    // Automation enablement: `automations enable` normalizes the inert typed
    // proposal and executes the automation service's enablement at once, with
    // the act's request id as the grant identity (docs/act-ledger.md).
    // No holding area is ever written.
    const proposalPath = join(sandbox, "weekly.amplefile-automation.json");
    const oneTimeAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await writeFile(proposalPath, JSON.stringify({
      kind: "amplefile.automation-proposal",
      version: 2,
      name: "Weekly glue",
      createdBy: "assistant",
      createdAt: "2026-08-01T00:00:00.000Z",
      automation: {
        title: "Weekly glue",
        trigger: { kind: "at", at: oneTimeAt, ifMissed: "run" },
        steps: [{ id: "review", kind: "chat", connectedFolder: connectedFolder.connectedFolder.id, message: "Review the report." }],
      },
    }, null, 2), "utf8");
    const enabled = await facade.automationsEnable({ proposalPath, cwd: sandbox, requestId: "req-automation-enable" });
    assert.equal(enabled.health, "enabled");
    assert.equal(enabled.title, "Weekly glue");
    assert.deepEqual(enabled.referencedConnectedFolderIds, [connectedFolder.connectedFolder.id]);
    assert.match(enabled.automationId, /^automation-[a-f0-9]{16}$/, "a proposal gains a deterministic content-derived id");
    assert.equal("staged" in enabled, false);
    assert.equal(existsSync(join(sandbox, "state", "fold", "staged-routings")), false, "no holding area is ever written");
    const automation = await api.automations.getAutomation(enabled.automationId);
    assert.equal(automation?.health, "enabled");
    assert.equal(automation?.digest, enabled.declarationDigest);
    assert.deepEqual(automation?.declaration.trigger, { kind: "at", at: oneTimeAt, ifMissed: "run" });
    assert.equal(automation?.grants.at(-1)?.requestId, "req-automation-enable", "the enablement receipt carries the act's request id");
    assert.equal(automation?.grants.at(-1)?.surface, "cli");
    assert.equal(enabled.alreadyEnabled, false);
    assert.equal(enabled.stoppedRunId, null);

    // Enabling the identical declaration again is a no-op: the same automation,
    // no fresh receipt, and nothing in flight disturbed.
    const twice = await facade.automationsEnable({ proposalPath, cwd: sandbox, requestId: "req-automation-enable-again" });
    assert.equal(twice.alreadyEnabled, true);
    assert.equal(twice.automationId, enabled.automationId);
    assert.equal((await api.automations.getAutomation(enabled.automationId))?.grants.length, 1);

    // A proposal naming a Connected Folder this machine does not have never arms.
    const strangerPath = join(sandbox, "stranger.amplefile-automation.json");
    await writeFile(strangerPath, JSON.stringify({
      kind: "amplefile.automation-proposal",
      version: 2,
      name: "Stranger",
      createdBy: "assistant",
      createdAt: "2026-08-01T00:00:00.000Z",
      automation: {
        title: "Stranger",
        trigger: { kind: "manual" },
        steps: [{ id: "review", kind: "chat", connectedFolder: "space-0123456789abcdef", message: "Review the report." }],
      },
    }, null, 2), "utf8");
    await assert.rejects(
      () => facade.automationsEnable({ proposalPath: strangerPath, cwd: sandbox, requestId: "req-automation-stranger" }),
      /not registered on this machine/,
    );

    // An unknown placeholder is a declaration error, refused when enabling.
    const unknownPlaceholderPath = join(sandbox, "unknown-placeholder.amplefile-automation.json");
    await writeFile(unknownPlaceholderPath, JSON.stringify({
      kind: "amplefile.automation-proposal",
      version: 4,
      name: "Unknown placeholder",
      createdBy: "assistant",
      createdAt: "2026-08-01T00:00:00.000Z",
      automation: {
        title: "Unknown placeholder",
        trigger: { kind: "manual" },
        steps: [{ id: "review", kind: "chat", connectedFolder: connectedFolder.connectedFolder.id, message: "Review {{nope}}." }],
      },
    }, null, 2), "utf8");
    await assert.rejects(
      () => facade.automationsEnable({ proposalPath: unknownPlaceholderPath, cwd: sandbox, requestId: "req-automation-unknown" }),
      /unknown placeholder \{\{nope\}\}/,
    );
    assert.equal((await api.automations.listAutomations()).length, 1, "a refused declaration arms nothing");
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

test("the act facade's status documents say what a task is waiting on, and a stale task id is refused by name", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-facade-waiting-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 50)),
    });
  }\n`, "utf8");
  const gates: Array<{ taskId: string; release: () => void }> = [];
  const held = new Set<string>();
  let draining = false;
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    beforeAgentPrompt: async (event) => {
      if (draining || !held.has(event.connectedFolderId)) return;
      await new Promise<void>((release) => gates.push({ taskId: event.taskId, release }));
    },
  });
  const release = async (taskId: string): Promise<void> => {
    await waitForAsync(async () => gates.some((gate) => gate.taskId === taskId));
    gates.splice(gates.findIndex((gate) => gate.taskId === taskId), 1)[0]!.release();
  };
  try {
    const facade = api.actFacade;
    const connectedFolder = await facade.createConnectedFolder({ name: "Waiting Connected Folder" });
    held.add(connectedFolder.connectedFolder.id);

    // Before any question: the status carries the request ref and no waiting.
    const own = await facade.sendMessage({ connectedFolder: connectedFolder.connectedFolder.id, newConversation: true, content: "/hold" });
    const before = await facade.turnStatus({ connectedFolder: connectedFolder.connectedFolder.id, taskId: own.taskId });
    assert.equal(before.task.state, "running");
    assert.equal(before.waiting, null);
    assert.equal(before.request?.kind, "cli");
    assert.equal(before.request?.state, "working");
    assert.equal(before.request?.depth, 0);

    // A question from the running turn: waiting is set while the turn runs,
    // and still set once it ends. The management status of an unrelated
    // task carries the same two fields.
    const asked = await facade.chatAsk({ connectedFolder: connectedFolder.connectedFolder.id, taskId: own.taskId, question: "Ship it?", respondent: "person" });
    const during = await facade.turnStatus({ connectedFolder: connectedFolder.connectedFolder.id, taskId: own.taskId });
    assert.equal(during.task.state, "running");
    assert.deepEqual(during.waiting, {
      questionId: asked.question.questionId,
      requestId: asked.request.id,
      respondent: "person",
      question: "Ship it?",
      askedAt: asked.question.askedAt,
      expiresAt: asked.question.expiresAt,
    });
    assert.equal(during.request?.state, "waiting");
    assert.equal(during.request?.openQuestions, 1);
    await release(own.taskId);
    await waitForAsync(async () => (await facade.turnStatus({ connectedFolder: connectedFolder.connectedFolder.id, taskId: own.taskId })).task.state !== "running");
    const after = await facade.turnStatus({ connectedFolder: connectedFolder.connectedFolder.id, taskId: own.taskId });
    assert.equal(after.task.state, "succeeded");
    assert.equal(after.waiting?.questionId, asked.question.questionId);

    // A task id whose turn has ended is not "the caller's own running turn":
    // report, ask, and handoff refuse it by name, exactly as --parent-task
    // would be refused, and record nothing.
    for (const attempt of [
      () => facade.chatReport({ connectedFolder: connectedFolder.connectedFolder.id, taskId: own.taskId, summary: "Late.", files: [], outcome: "succeeded" }),
      () => facade.chatAsk({ connectedFolder: connectedFolder.connectedFolder.id, taskId: own.taskId, question: "Late?", respondent: "person" }),
      () => facade.chatHandoff({ connectedFolder: connectedFolder.connectedFolder.id, taskId: own.taskId, toConnectedFolder: connectedFolder.connectedFolder.id, message: "/hold", files: [] }),
    ]) {
      await assert.rejects(attempt, (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /stopping or has already finished/.test(error.message));
    }
    assert.equal(api.requests.get(asked.request.id)!.results.length, 0);
    assert.equal(api.requests.get(asked.request.id)!.questionIds.length, 1);
    assert.equal(api.requests.get(asked.request.id)!.childRequestIds.length, 0);

    // The management status names the durable request graph beside its shipped projection.
    held.delete(connectedFolder.connectedFolder.id);
    const agent = await facade.agentSend({ content: "/hold" });
    const managed = await facade.agentTurnStatus({ taskId: agent.taskId });
    assert.equal(managed.waiting, null);
    assert.equal(managed.requestGraph?.kind, "agent");
    assert.equal(managed.requestGraph?.id, managed.request?.requestId);
    await waitForAsync(async () => (await facade.agentTurnStatus({ taskId: agent.taskId })).task.state !== "running");
  } finally {
    draining = true;
    for (const gate of gates.splice(0)) gate.release();
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
