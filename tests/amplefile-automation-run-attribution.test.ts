import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { watchAutomationFileToolWrites } from "../src/local/api/automation-hops.js";

// An automation step's own files (docs/automations.md): Pi's built-in write
// and edit tools report each file they finished touching, and the step
// records its device and inode at once, so the run's own output never starts
// a follow-up run.

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

test("a step records the files Pi's own write and edit tools touched, and nothing else", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-run-attribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Inbox"), { recursive: true });
  const client = new PiConversationClient("attribution", root);
  fakeRuntime(client, [{ name: "write", source: "builtin" }, { name: "edit", source: "builtin" }, { name: "read", source: "builtin" }]);
  const placed = watchAutomationFileToolWrites(client);

  // A write relative to the Connected Folder, and an edit by absolute path.
  native(client, { type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "Inbox/summary.md", content: "summary" } });
  await writeFile(join(root, "Inbox/summary.md"), "summary");
  native(client, { type: "tool_execution_end", toolCallId: "write-1", toolName: "write", isError: false, result: {} });
  await writeFile(join(root, "Inbox/notes.md"), "notes");
  native(client, { type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: join(root, "Inbox/notes.md") } });
  native(client, { type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", isError: false, result: {} });
  // A failed write, and a read, place nothing.
  await writeFile(join(root, "Inbox/refused.md"), "kept");
  native(client, { type: "tool_execution_start", toolCallId: "write-2", toolName: "write", args: { path: "Inbox/refused.md" } });
  native(client, { type: "tool_execution_end", toolCallId: "write-2", toolName: "write", isError: true, result: {} });
  native(client, { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "Inbox/refused.md" } });
  native(client, { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false, result: {} });

  const ids = await placed.settle();
  placed.stop();
  assert.deepEqual(ids.sort(), [await fileId(join(root, "Inbox/summary.md")), await fileId(join(root, "Inbox/notes.md"))].sort());
});

test("a write tool an Extension provides is not taken for Pi's own", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-run-attribution-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new PiConversationClient("attribution-extension", root);
  fakeRuntime(client, [{ name: "write", source: "extension" }]);
  const placed = watchAutomationFileToolWrites(client);
  await writeFile(join(root, "made.md"), "made");
  native(client, { type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "made.md" } });
  native(client, { type: "tool_execution_end", toolCallId: "write-1", toolName: "write", isError: false, result: {} });
  assert.deepEqual(await placed.settle(), []);
  placed.stop();
});
