import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { PiConversationClient, type PiFileToolWrite } from "../src/local/agent/pi-client.js";
import { connectedFolderFileIds, noteAutomationRunFiles, notePiFileToolWrite } from "../src/local/api/automation-attribution.js";
import type { LocalApiState } from "../src/local/api/state.js";

// An automation run's own files (docs/automations.md): Pi's built-in write
// and edit tools report each file they finished touching, with the turn
// whose tool it was, at the path Pi itself resolved; AmpleFile records its
// device and inode when that turn is a running step's work. Attribution is
// bookkeeping: it never fails an act.

function fakeRuntime(client: PiConversationClient, tools: Array<{ name: string; source: string }>): void {
  (client as unknown as { runtimeHost: unknown }).runtimeHost = {
    session: { getAllTools: () => tools.map((tool) => ({ name: tool.name, sourceInfo: { source: tool.source } })) },
  };
}

function native(client: PiConversationClient, event: unknown): void {
  (client as unknown as { handleSessionEvent(event: unknown): void }).handleSessionEvent(event);
}

async function fileId(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

async function reports(client: PiConversationClient, count: number, act: () => Promise<void> | void): Promise<PiFileToolWrite[]> {
  const seen: PiFileToolWrite[] = [];
  client.on("file-tool-wrote", (event: PiFileToolWrite) => seen.push(event));
  await act();
  for (let attempt = 0; attempt < 200 && seen.length < count; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  return seen;
}

test("Pi's own write and edit report the file at the path Pi resolved, with their turn, and nothing else does", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-run-attribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Inbox"), { recursive: true });
  const client = new PiConversationClient("attribution", root);
  fakeRuntime(client, [{ name: "write", source: "builtin" }, { name: "edit", source: "builtin" }, { name: "read", source: "builtin" }]);
  (client as unknown as { presentationTaskId: string }).presentationTaskId = "turn-1";

  // A macOS screenshot name carries a narrow no-break space before PM; Pi's
  // own write tool turns it into a plain space.
  const screenshotName = "Inbox/Screenshot 2026-11-25 at 1.00.00 PM notes.md";
  await createWriteToolDefinition(root).execute("pi-write", { path: screenshotName, content: "notes" }, undefined, undefined, undefined as never);
  const written = (await readdir(join(root, "Inbox"))).find((name) => name.startsWith("Screenshot"))!;
  assert.equal(written, "Screenshot 2026-11-25 at 1.00.00 PM notes.md");
  await writeFile(join(root, "Inbox/notes.md"), "notes");
  await writeFile(join(root, "Inbox/refused.md"), "kept");

  const seen = await reports(client, 2, () => {
    native(client, { type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: screenshotName, content: "notes" } });
    native(client, { type: "tool_execution_end", toolCallId: "write-1", toolName: "write", isError: false, result: {} });
    native(client, { type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: join(root, "Inbox/notes.md") } });
    native(client, { type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", isError: false, result: {} });
    // A failed write and a read report nothing.
    native(client, { type: "tool_execution_start", toolCallId: "write-2", toolName: "write", args: { path: "Inbox/refused.md" } });
    native(client, { type: "tool_execution_end", toolCallId: "write-2", toolName: "write", isError: true, result: {} });
    native(client, { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "Inbox/refused.md" } });
    native(client, { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false, result: {} });
  });
  assert.deepEqual(seen.map((event) => event.path).sort(), [join(root, "Inbox", written), join(root, "Inbox/notes.md")].sort());
  assert.ok(seen.every((event) => event.taskId === "turn-1"));
});

test("a write tool an Extension provides is not taken for Pi's own", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-run-attribution-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new PiConversationClient("attribution-extension", root);
  fakeRuntime(client, [{ name: "write", source: "extension" }]);
  await writeFile(join(root, "made.md"), "made");
  const seen = await reports(client, 0, () => {
    native(client, { type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "made.md" } });
    native(client, { type: "tool_execution_end", toolCallId: "write-1", toolName: "write", isError: false, result: {} });
  });
  assert.deepEqual(seen, []);
});

function fakeState(counts: (act: { connectedFolderId?: string; taskId?: string }) => boolean) {
  const asked: Array<{ connectedFolderId?: string; taskId?: string }> = [];
  const noted: Array<{ connectedFolderId?: string; taskId?: string; fileIds: string[]; vacatedFileIds?: string[] }> = [];
  const state = {
    automations: {
      countsAsRunWork: (act: { connectedFolderId?: string; taskId?: string }) => { asked.push(act); return counts(act); },
      notePlacedFiles: (act: { connectedFolderId?: string; taskId?: string; fileIds: readonly string[]; vacatedFileIds?: readonly string[] }) => {
        noted.push({ ...act, fileIds: [...act.fileIds], ...(act.vacatedFileIds ? { vacatedFileIds: [...act.vacatedFileIds] } : {}) });
      },
    },
  } as unknown as LocalApiState;
  return { state, asked, noted };
}

test("a Pi write in a turn that is a running step's work is noted by device and inode; any other is not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-run-attribution-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "summary.md"), "summary");
  const { state, asked, noted } = fakeState((act) => act.taskId === "step-turn");
  await notePiFileToolWrite(state, { path: join(root, "summary.md"), taskId: "step-turn" });
  await notePiFileToolWrite(state, { path: join(root, "summary.md"), taskId: "a person's turn" });
  await notePiFileToolWrite(state, { path: join(root, "summary.md"), taskId: null });
  assert.deepEqual(asked, [{ taskId: "step-turn" }, { taskId: "a person's turn" }]);
  assert.deepEqual(noted, [{ taskId: "step-turn", fileIds: [await fileId(join(root, "summary.md"))] }]);
});

test("attribution never fails an act: reserved paths are skipped and a throw is swallowed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-run-attribution-safe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".amplefile", "conversations"), { recursive: true });
  await writeFile(join(root, ".amplefile", "conversations", "chat.jsonl"), "{}\n");
  await writeFile(join(root, "kept.md"), "kept");
  assert.deepEqual(await connectedFolderFileIds(root, [".amplefile/conversations/chat.jsonl", "../outside.md", "kept.md"]), [await fileId(join(root, "kept.md"))]);

  const { state, noted } = fakeState(() => true);
  await noteAutomationRunFiles(state, { connectedFolderId: "space-aaaaaaaaaaaaaaaa" }, { root, placed: [".amplefile/conversations/chat.jsonl"] });
  assert.deepEqual(noted, [{ connectedFolderId: "space-aaaaaaaaaaaaaaaa", fileIds: [], vacatedFileIds: [] }]);
  const throwing = { automations: { countsAsRunWork: () => true, notePlacedFiles: () => { throw new Error("bookkeeping broke"); } } } as unknown as LocalApiState;
  await noteAutomationRunFiles(throwing, { connectedFolderId: "space-aaaaaaaaaaaaaaaa" }, { root, placed: ["kept.md"] });
  await notePiFileToolWrite(throwing, { path: join(root, "kept.md"), taskId: "step-turn" });
});
