import assert from "node:assert/strict";
import { existsSync, fstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { loadConversationContextAttachmentsForTurn, previewConversationContextAttachment } from "../src/local/conversation-context.js";
import { createConnectedFolderCheckpoint, listFileVersions, restoreFileVersion } from "../src/local/history.js";
import { startLocalApi } from "../src/local/server.js";
import { configureAmpleFileStateRoot, connectedFolderConversationDir, connectedFolderManifestFile, connectedFolderStateDir } from "../src/local/state-paths.js";
import { readConnectedFolderIgnoreState, setConnectedFolderIgnoreState } from "../src/local/connected-folder-ignore.js";
import { getConnectedFolderEntryInfo, registerLinkedConnectedFolder, scanConnectedFolderTree } from "../src/local/connected-folder.js";

test("linked Connected Folders keep portable identity in .amplefile while a .work-fold folder and operational state remain external", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-parity-linked-"));
  const root = join(sandbox, "ordinary-folder");
  const state = join(sandbox, "state");
  await mkdir(join(root, "Drafts"), { recursive: true });
  await mkdir(join(root, ".work-fold"), { recursive: true });
  await writeFile(join(root, ".work-fold", "records.json"), "earlier metadata", "utf8");
  await writeFile(join(root, "Drafts", "notes.txt"), "first version\n", "utf8");
  configureAmpleFileStateRoot(state);
  t.after(async () => {
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const connectedFolder = await registerLinkedConnectedFolder(root);
  await setConnectedFolderIgnoreState(root, ["Drafts/notes.txt"], true);
  assert.deepEqual((await readConnectedFolderIgnoreState(root)).patterns, ["Drafts/notes.txt"]);
  assert.equal((await scanConnectedFolderTree(root)).entries[0]?.children?.[0]?.ignored, true);
  const lazyTree = (await scanConnectedFolderTree(root, 0)).entries;
  assert.deepEqual(lazyTree[0]?.children, []);
  assert.equal(lazyTree[0]?.hasChildren, true, "a shallow tree must advertise folders that can be expanded lazily");
  assert.equal((await scanConnectedFolderTree(root, 0, "Drafts")).entries[0]?.path, "Drafts/notes.txt");
  const visibleTree = (await scanConnectedFolderTree(root, 20, "", { includeIgnored: false })).entries;
  assert.equal(visibleTree[0]?.path, "Drafts");
  assert.deepEqual(visibleTree[0]?.children, []);
  assert.equal((await scanConnectedFolderTree(root, 0, "", { includeIgnored: false })).entries[0]?.hasChildren, false);

  const first = await createConnectedFolderCheckpoint(root, { reason: "manual", label: "First" });
  await writeFile(join(root, "Drafts", "notes.txt"), "second version\n", "utf8");
  await createConnectedFolderCheckpoint(root, { reason: "manual", label: "Second" });
  const versions = await listFileVersions(root, "Drafts/notes.txt");
  assert.equal(versions.length, 2);
  const firstVersion = versions.find((version) => version.checkpointId === first.checkpointId);
  assert.ok(firstVersion);
  const restored = await restoreFileVersion(root, "Drafts/notes.txt", firstVersion.hashSha256);
  assert.equal(restored.safetyCheckpointId.startsWith("cp-"), true);
  assert.equal(await readFile(join(root, "Drafts", "notes.txt"), "utf8"), "first version\n");

  const docx = new JSZip();
  docx.file("word/document.xml", [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:body><w:p><w:r><w:t>Quarterly planning notes</w:t></w:r></w:p></w:body>",
    "</w:document>",
  ].join(""));
  await writeFile(join(root, "Plan.docx"), await docx.generateAsync({ type: "nodebuffer" }));
  const preview = await previewConversationContextAttachment(root, { path: "Plan.docx" });
  assert.equal(preview.mode, "full_extracted_text");
  assert.equal(preview.includedInPrompt, true);
  const [attachment] = await loadConversationContextAttachmentsForTurn(root, ["Plan.docx"]);
  assert.match(attachment?.text ?? "", /Quarterly planning notes/);

  const info = await getConnectedFolderEntryInfo(root, "Plan.docx");
  assert.equal(info.officeDocument, true);
  assert.equal(info.hashSha256?.length, 64);
  assert.equal(existsSync(connectedFolderManifestFile(root)), true);
  assert.equal(existsSync(connectedFolderStateDir(root)), true);
  assert.deepEqual((await readdir(root)).sort(), [".amplefile", ".work-fold", "Drafts", "Plan.docx"]);
  assert.deepEqual((await scanConnectedFolderTree(root)).entries.map((entry) => entry.name), ["Drafts", "Plan.docx"]);
  assert.equal(connectedFolder.location.storage, "linked");
});

test("local API exposes path-safe file operations, undo checkpoints, chat rename, attachments, and file events", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-parity-api-"));
  const historyEvents: Array<{ reason: "pre_turn" | "post_turn" }> = [];
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    onHistoryCheckpoint: (event) => historyEvents.push(event),
  });
  t.after(async () => {
    await api.close();
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const created = await json(`${api.origin}/api/connected-folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Operations" }),
  }) as { connectedFolder: { id: string; connectedFolderRoot: string } };
  const { id, connectedFolderRoot } = created.connectedFolder;

  const files = new FormData();
  files.set("targetFolderPath", "");
  files.set("relativePaths", JSON.stringify(["Drafts/note.txt", "Archive/.keep"]));
  files.append("files", new Blob(["before\n"]), "note.txt");
  files.append("files", new Blob(["keep\n"]), ".keep");
  await ok(`${api.origin}/api/connected-folders/${id}/upload-local-files`, { method: "POST", body: files });

  const createdFolder = await json(`${api.origin}/api/connected-folders/${id}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentPath: "", name: "Inbox" }),
  }) as { folder: { path: string } };
  assert.equal(createdFolder.folder.path, "Inbox");
  const createdFile = await json(`${api.origin}/api/connected-folders/${id}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentPath: "Inbox", name: "draft.md", text: "draft\n" }),
  }) as { file: { path: string } };
  assert.equal(createdFile.file.path, "Inbox/draft.md");
  const renamedFile = await json(`${api.origin}/api/connected-folders/${id}/rename-local-entry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Inbox/draft.md", newName: "final.md" }),
  }) as { renamed: { path: string } };
  assert.equal(renamedFile.renamed.path, "Inbox/final.md");

  const info = await json(`${api.origin}/api/connected-folders/${id}/file-info?path=Drafts%2Fnote.txt`) as { kind: string; hashSha256: string };
  assert.equal(info.kind, "file");
  assert.equal(info.hashSha256.length, 64);

  // The file tab's inline preview: bounded text renders with its size, a
  // recognized image extension defers to the raw-file route, and binary
  // content declines with its reason instead of decoding garbage.
  const textPreview = await json(`${api.origin}/api/connected-folders/${id}/file-preview?path=Drafts%2Fnote.txt`) as { preview: { kind: string; content: string; truncated: boolean } };
  assert.equal(textPreview.preview.kind, "text");
  assert.equal(textPreview.preview.content, "before\n");
  assert.equal(textPreview.preview.truncated, false);
  await writeFile(join(connectedFolderRoot, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  const imagePreview = await json(`${api.origin}/api/connected-folders/${id}/file-preview?path=photo.png`) as { preview: { kind: string } };
  assert.equal(imagePreview.preview.kind, "image");
  await writeFile(join(connectedFolderRoot, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 5, 6, 7]));
  const binaryPreview = await json(`${api.origin}/api/connected-folders/${id}/file-preview?path=blob.bin`) as { preview: { kind: string; reason: string } };
  assert.equal(binaryPreview.preview.kind, "none");
  assert.equal(binaryPreview.preview.reason, "binary");
  const previewTraversal = await fetch(`${api.origin}/api/connected-folders/${id}/file-preview?path=..%2Foutside.txt`);
  assert.equal(previewTraversal.ok, false);
  const existing = await json(`${api.origin}/api/connected-folders/${id}/paths-exist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["note.txt", "missing.txt"] }),
  }) as { existing: string[] };
  assert.deepEqual(existing.existing, ["Drafts/note.txt"]);

  const edited = await json(`${api.origin}/api/connected-folders/${id}/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Drafts/note.txt", text: "after\n" }),
  }) as { safetyCheckpointId: string };
  assert.match(edited.safetyCheckpointId, /^cp-/);

  const moved = await json(`${api.origin}/api/connected-folders/${id}/move-local-entry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePath: "Drafts/note.txt", targetFolderPath: "Archive" }),
  }) as { moved: { path: string }; safetyCheckpointId: string };
  assert.equal(moved.moved.path, "Archive/note.txt");
  assert.match(moved.safetyCheckpointId, /^cp-/);

  const deleted = await json(`${api.origin}/api/connected-folders/${id}/local-file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Archive/note.txt" }),
  }) as { deleted: true; safetyCheckpointId: string };
  assert.equal(deleted.deleted, true);
  assert.equal(existsSync(join(connectedFolderRoot, "Archive", "note.txt")), false);
  await ok(`${api.origin}/api/connected-folders/${id}/history/checkpoints/${deleted.safetyCheckpointId}/restore`, { method: "POST" });
  assert.equal(await readFile(join(connectedFolderRoot, "Archive", "note.txt"), "utf8"), "after\n");

  const deletedFolder = await json(`${api.origin}/api/connected-folders/${id}/local-file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Inbox" }),
  }) as { kind: string; safetyCheckpointId: string };
  assert.equal(deletedFolder.kind, "folder");
  assert.equal(existsSync(join(connectedFolderRoot, "Inbox")), false);
  await ok(`${api.origin}/api/connected-folders/${id}/history/checkpoints/${deletedFolder.safetyCheckpointId}/restore`, { method: "POST" });
  assert.equal(await readFile(join(connectedFolderRoot, "Inbox", "final.md"), "utf8"), "draft\n");

  const versions = await json(`${api.origin}/api/connected-folders/${id}/history/file-versions?path=Drafts%2Fnote.txt`) as { versions: unknown[] };
  assert.ok(versions.versions.length >= 1);

  const conversation = await json(`${api.origin}/api/connected-folders/${id}/conversations`, { method: "POST" }) as { conversation: { id: string } };
  const renamed = await json(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Planning notes" }),
  }) as { conversation: { title: string } };
  assert.equal(renamed.conversation.title, "Planning notes");
  assert.equal(existsSync(join(connectedFolderConversationDir(connectedFolderRoot), `${conversation.conversation.id}.jsonl`)), true);

  const archived = await json(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  }) as { conversation: { archivedAt: string | null; snoozedUntil: string | null } };
  assert.ok(archived.conversation.archivedAt);
  assert.equal(archived.conversation.snoozedUntil, null);

  const restored = await json(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  }) as { conversation: { archivedAt: string | null } };
  assert.equal(restored.conversation.archivedAt, null);

  const snoozedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const snoozed = await json(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snoozedUntil }),
  }) as { conversation: { snoozedUntil: string | null } };
  assert.equal(snoozed.conversation.snoozedUntil, snoozedUntil);

  const rejectedSnoozedTurn = await fetch(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Do not continue this deferred Chat yet.", contextPaths: [] }),
  });
  assert.equal(rejectedSnoozedTurn.status, 409);
  assert.match(await rejectedSnoozedTurn.text(), /Resume this Chat/);

  const invalidLifecycleMutation = await fetch(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true, snoozedUntil: null }),
  });
  assert.equal(invalidLifecycleMutation.status, 400);

  await ok(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snoozedUntil: null }),
  });

  const rejectedTurn = await fetch(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "This must not be appended", contextPaths: ["../outside.txt"] }),
  });
  assert.equal(rejectedTurn.status, 400);
  const transcriptAfterRejectedTurn = await json(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}`) as {
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(transcriptAfterRejectedTurn.messages.some((message) => message.content === "This must not be appended"), false);
  const acceptedAfterRejectedTurn = await fetch(`${api.origin}/api/connected-folders/${id}/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // A selected path from an older client is ignored, even one that no longer exists.
    body: JSON.stringify({ content: "/session", selectedPath: "Inbox/deleted-since.md", contextPaths: [] }),
  });
  assert.equal(acceptedAfterRejectedTurn.status, 202, await acceptedAfterRejectedTurn.text());
  await waitFor(() => historyEvents.some((event) => event.reason === "post_turn"));
  assert.deepEqual(historyEvents.map((event) => event.reason), ["pre_turn", "post_turn"]);

  const attachment = await json(`${api.origin}/api/connected-folders/${id}/context-attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Archive/note.txt" }),
  }) as { attachment: { mode: string; includedInPrompt: boolean } };
  assert.deepEqual(attachment.attachment, { ...attachment.attachment, mode: "path_only_reference", includedInPrompt: false });

  const controller = new AbortController();
  const eventsResponse = await fetch(`${api.origin}/api/connected-folders/${id}/file-events`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
  });
  assert.equal(eventsResponse.ok, true);
  assert.ok(eventsResponse.body);
  const events = readConnectedFolderFileEvents(eventsResponse.body);
  try {
    assert.equal((await events.next()).value?.type, "ready");
    // The server's ready frame means fs.watch has returned, not that the
    // platform has delivered a native event. Establish that separately before
    // asserting one post-readiness write. Only this startup probe is repeated;
    // a lost watch-me.txt event must still fail the test. The fetch signal puts
    // a hard bound on both startup and target delivery under shared-runner load.
    const nativeReady = waitForConnectedFolderFileEvent(events, "watch-ready.txt").then(
      () => ({ ready: true as const }),
      (error: unknown) => ({ error }),
    );
    for (let attempt = 0; ; attempt += 1) {
      await writeFile(join(connectedFolderRoot, "watch-ready.txt"), `ready ${attempt}\n`, "utf8");
      const result = await Promise.race([
        nativeReady,
        new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), 100)),
      ]);
      if (!result) continue;
      if ("error" in result) throw result.error;
      break;
    }
    await writeFile(join(connectedFolderRoot, "watch-me.txt"), "watch\n", "utf8");
    await waitForConnectedFolderFileEvent(events, "watch-me.txt");
  } finally {
    controller.abort();
    await events.return();
  }

  const traversal = await fetch(`${api.origin}/api/connected-folders/${id}/file-info?path=..%2Foutside.txt`);
  assert.equal(traversal.ok, false);
  const unsafeRename = await fetch(`${api.origin}/api/connected-folders/${id}/rename-local-entry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Inbox/final.md", newName: "../escape.md" }),
  });
  assert.equal(unsafeRename.ok, false);
  const rootDelete = await fetch(`${api.origin}/api/connected-folders/${id}/local-file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "./" }),
  });
  assert.equal(rootDelete.ok, false);
  assert.equal(existsSync(connectedFolderRoot), true);
});

test("Connected Folder lifecycle renames external metadata and removes linked versus managed roots safely", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-lifecycle-api-"));
  const stateRoot = join(sandbox, "state");
  const contentRoot = join(sandbox, "managed");
  const linkedRoot = join(sandbox, "linked-folder");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, "keep.txt"), "keep", "utf8");
  const api = await startLocalApi({ port: 0, stateBase: stateRoot, connectedFolderBase: contentRoot, loadEnv: false });
  t.after(async () => {
    await api.close();
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const linked = await json(`${api.origin}/api/connected-folders/local-folder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectedFolderRoot: linkedRoot }),
  }) as { connectedFolder: { id: string; connectedFolderRoot: string } };
  const renamedLinked = await json(`${api.origin}/api/connected-folders/${linked.connectedFolder.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Renamed linked Connected Folder" }),
  }) as { connectedFolder: { name: string; connectedFolderRoot: string } };
  assert.equal(renamedLinked.connectedFolder.name, "Renamed linked Connected Folder");
  assert.equal(renamedLinked.connectedFolder.connectedFolderRoot, linkedRoot);
  assert.equal(await readFile(join(linkedRoot, "keep.txt"), "utf8"), "keep");
  assert.equal(existsSync(connectedFolderManifestFile(linkedRoot)), true);
  const removedLinked = await json(`${api.origin}/api/connected-folders/${linked.connectedFolder.id}`, { method: "DELETE" }) as { removed: true; deleted: boolean };
  // Removing a linked registration destroys nothing, so nothing is kept.
  assert.deepEqual(removedLinked, {
    removed: true,
    deleted: false,
    connectedFolderRoot: linkedRoot,
    cleanupPending: false,
    recentlyDeleted: null,
  });
  assert.equal(existsSync(linkedRoot), true);
  assert.equal(existsSync(connectedFolderManifestFile(linkedRoot)), true);
  assert.equal(existsSync(connectedFolderStateDir(linkedRoot)), false);

  const managed = await json(`${api.origin}/api/connected-folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Managed lifecycle" }),
  }) as { connectedFolder: { id: string; connectedFolderRoot: string } };
  await writeFile(join(managed.connectedFolder.connectedFolderRoot, "delete-with-connected-folder.txt"), "managed", "utf8");
  const removedManaged = await json(`${api.origin}/api/connected-folders/${managed.connectedFolder.id}`, { method: "DELETE" }) as {
    removed: true; deleted: boolean; connectedFolderRoot: string; recentlyDeleted: { entryId: string } | null;
  };
  assert.equal(removedManaged.deleted, true);
  assert.equal(removedManaged.connectedFolderRoot, managed.connectedFolder.connectedFolderRoot);
  assert.equal(existsSync(managed.connectedFolder.connectedFolderRoot), false);
  assert.equal(existsSync(connectedFolderStateDir(managed.connectedFolder.connectedFolderRoot)), false);
  // The managed folder moved to Recently deleted with its History state.
  const keptConnectedFolders = (await api.recentlyDeleted.list()).entries.filter((entry) => entry.kind === "connected-folder");
  assert.equal(keptConnectedFolders.length, 1);
  assert.equal(keptConnectedFolders[0]?.originalPath, managed.connectedFolder.connectedFolderRoot);
  assert.equal(removedManaged.recentlyDeleted?.entryId, keptConnectedFolders[0]?.id);
});

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as unknown;
}

interface ConnectedFolderFileEvent {
  type: string;
  path?: string | null;
  message?: string;
}

async function* readConnectedFolderFileEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<ConnectedFolderFileEvent, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as ConnectedFolderFileEvent;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function waitForConnectedFolderFileEvent(events: AsyncGenerator<ConnectedFolderFileEvent, void>, path: string): Promise<void> {
  for (;;) {
    const event = await events.next();
    assert.equal(event.done, false, `File event stream ended before ${path}.`);
    if (!event.value) continue;
    assert.notEqual(event.value.type, "error", event.value.message);
    if (event.value.type === "file_event" && event.value.path === path) return;
  }
}

test("file event assertions preserve split and combined SSE frames", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of [
      'data: {"type":"rea',
      'dy"}\n\n: keepalive\n\ndata: {"type":"file_event","path":"watch-ready.txt"}\n',
      '\ndata: {"type":"file_event","path":"watch-me.txt"}\n\n',
    ]) controller.enqueue(encoder.encode(chunk));
    controller.close();
  } });
  const events = readConnectedFolderFileEvents(stream);
  assert.equal((await events.next()).value?.type, "ready");
  await waitForConnectedFolderFileEvent(events, "watch-ready.txt");
  await waitForConnectedFolderFileEvent(events, "watch-me.txt");
  assert.equal((await events.next()).done, true);
});

test("a native readiness event cannot satisfy the subsequent exact file event assertion", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"file_event","path":"watch-ready.txt"}\n\ndata: {"type":"file_event","path":"watch-ready.txt"}\n\n'));
    controller.close();
  } });
  const events = readConnectedFolderFileEvents(stream);
  await waitForConnectedFolderFileEvent(events, "watch-ready.txt");
  await assert.rejects(waitForConnectedFolderFileEvent(events, "watch-me.txt"), /File event stream ended before watch-me\.txt/);
});

async function ok(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for asynchronous API work.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

test("an abandoned raw-file read closes its file instead of holding it open", { skip: process.platform === "win32" }, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-raw-file-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => {
    await api.close();
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  const created = await json(`${api.origin}/api/connected-folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Previews" }),
  }) as { connectedFolder: { id: string; connectedFolderRoot: string } };
  const { id, connectedFolderRoot } = created.connectedFolder;
  const size = 16 * 1024 * 1024;
  await writeFile(join(connectedFolderRoot, "large.bin"), Buffer.alloc(size, 7));
  await writeFile(join(connectedFolderRoot, "empty.txt"), "");
  const rawFile = (path: string) => `${api.origin}/api/connected-folders/${id}/raw-file?path=${encodeURIComponent(path)}`;

  const whole = await fetch(rawFile("large.bin"));
  assert.equal(whole.headers.get("content-length"), String(size));
  assert.equal((await whole.arrayBuffer()).byteLength, size);
  const empty = await fetch(rawFile("empty.txt"));
  assert.equal(empty.status, 200);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);

  // A preview that changes aborts its fetch mid-body. Each abandoned read must
  // release its file: count this process's descriptors that still name it.
  const { dev, ino } = await stat(join(connectedFolderRoot, "large.bin"));
  const descriptorsOnFile = async () => {
    let count = 0;
    for (const name of await readdir("/dev/fd")) {
      try {
        const info = fstatSync(Number(name));
        if (info.dev === dev && info.ino === ino) count += 1;
      } catch {
        // Closed while the listing was read.
      }
    }
    return count;
  };
  assert.equal(await descriptorsOnFile(), 0);
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolvePromise, reject) => {
      const request = get(rawFile("large.bin"), { agent: false }, (response) => {
        response.once("data", () => {
          request.destroy();
          resolvePromise();
        });
      });
      request.once("error", reject);
    });
  }
  const started = Date.now();
  while (await descriptorsOnFile() > 0) {
    if (Date.now() - started > 2_000) assert.fail(`abandoned raw-file reads left ${await descriptorsOnFile()} descriptors open on the file`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
});
