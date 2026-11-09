import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startLocalApi } from "../src/local/server.js";

/**
 * The file manager's transfer and compress routes over the local API
 * (docs/product-model.md, "The file manager window").
 */

type Api = Awaited<ReturnType<typeof startLocalApi>>;

async function sandboxApi(t: test.TestContext, options: Partial<Parameters<typeof startLocalApi>[0]> = {}): Promise<{ api: Api; sandbox: string }> {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-file-transfer-api-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false, ...options });
  t.after(async () => { await api.close(); await rm(sandbox, { recursive: true, force: true }); });
  return { api, sandbox };
}

function caller(api: Api) {
  return async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${api.origin}${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };
}

test("a move between Connected Folders never erases a nested Connected Folder and keeps what History cannot", async (t) => {
  const { api, sandbox } = await sandboxApi(t);
  const call = caller(api);
  const sourceRoot = join(sandbox, "source");
  await mkdir(join(sourceRoot, "Projects", "Child"), { recursive: true });
  await writeFile(join(sourceRoot, "Projects", "Child", "child.txt"), "child");
  await writeFile(join(sourceRoot, "Projects", "plain.txt"), "plain");
  await writeFile(join(sourceRoot, "big.bin"), "x".repeat(64));
  const source = (await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: sourceRoot } })).body!.connectedFolder;
  const nested = await call(`/api/connected-folders/${source.id}/nested-folders`, { method: "POST", body: { path: "Projects/Child" } });
  assert.equal(nested.status, 201);
  const chatLog = join(sourceRoot, "Projects", "Child", ".amplefile", "conversations", "chat.jsonl");
  await mkdir(join(chatLog, ".."), { recursive: true });
  await writeFile(chatLog, "{\"role\":\"user\"}\n");
  const target = (await call("/api/connected-folders", { method: "POST", body: { name: "Target" } })).body!.connectedFolder;
  const move = (path: string) => call("/api/file-transfer", {
    method: "POST",
    body: { mode: "move", sources: [{ place: { kind: "connected-folder", id: source.id }, path }], target: { place: { kind: "connected-folder", id: target.id }, path: "" } },
  });

  // A folder holding a nested Connected Folder, the nested Connected Folder
  // itself, or anything inside it is refused before anything is copied.
  for (const path of ["Projects", "Projects/Child", "Projects/Child/child.txt"]) {
    const refused = await move(path);
    assert.equal(refused.status, 409, `${path}: ${JSON.stringify(refused.body)}`);
    assert.equal(await readFile(chatLog, "utf8"), "{\"role\":\"user\"}\n", "the nested Chat log stays");
    assert.ok(existsSync(join(sourceRoot, "Projects", "Child", "child.txt")));
    assert.ok(!existsSync(join(target.connectedFolderRoot, "Projects")), "nothing was copied");
    assert.ok(!existsSync(join(target.connectedFolderRoot, "Child")), "nothing was copied");
    assert.ok(!existsSync(join(target.connectedFolderRoot, "child.txt")), "nothing was copied");
  }
  // The Connected Folder itself is never a move's source.
  const root = await move(".");
  assert.equal(root.status, 400, JSON.stringify(root.body));
  assert.ok(existsSync(join(sourceRoot, "big.bin")));
  assert.ok(existsSync(join(sourceRoot, ".amplefile", "connected-folder.json")));

  // An ordinary move: copied in, then the source's delete, with two restore points.
  const plain = await move("Projects/plain.txt");
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.deepEqual(plain.body!.written, ["plain.txt"]);
  assert.equal(plain.body!.mode, "move");
  assert.equal(plain.body!.restorePoints.length, 2);
  assert.equal(plain.body!.recentlyDeleted, undefined, "History kept all of it");
  assert.ok(!existsSync(join(sourceRoot, "Projects", "plain.txt")));
  assert.equal(await readFile(join(target.connectedFolderRoot, "plain.txt"), "utf8"), "plain");

  // A file History cannot keep leaves through Recently Deleted, not an erase.
  const previousCap = process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES;
  process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = "8";
  try {
    const big = await move("big.bin");
    assert.equal(big.status, 200, JSON.stringify(big.body));
    assert.equal(big.body!.recentlyDeleted?.length, 1);
    assert.equal(big.body!.recentlyDeleted[0].path, "big.bin");
    assert.ok(!existsSync(join(sourceRoot, "big.bin")));
    assert.equal((await readFile(join(target.connectedFolderRoot, "big.bin"), "utf8")).length, 64);
    const trash = await api.recentlyDeleted.list();
    assert.ok(trash.entries.some((entry) => entry.id === big.body!.recentlyDeleted[0].entryId && entry.originalPath === "big.bin"));
  } finally {
    if (previousCap === undefined) delete process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES;
    else process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = previousCap;
  }
});

test("a move out of a Connected Folder waits for that Connected Folder's outstanding work, as a delete does", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-file-transfer-busy-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  const released = join(sandbox, "released");
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `import { existsSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("hold", {
    description: "Hold a test turn",
    handler: async () => { while (!existsSync(${JSON.stringify(released)})) await new Promise((resolve) => setTimeout(resolve, 25)); },
  });
}\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
  });
  t.after(async () => {
    await writeFile(released, "").catch(() => undefined);
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const call = caller(api);
  const source = (await api.actFacade.createConnectedFolder({ name: "Busy source" })).connectedFolder;
  const target = (await api.actFacade.createConnectedFolder({ name: "Quiet target" })).connectedFolder;
  await writeFile(join(source.connectedFolderRoot, "notes.md"), "notes");
  const sent = await api.actFacade.sendMessage({ connectedFolder: source.id, newConversation: true, content: "/hold" });
  const running = () => api.actFacade.conversationStatus({ connectedFolder: source.id, conversationId: sent.conversationId });
  await waitFor(async () => (await running()).state === "running");
  const body = { mode: "move", sources: [{ place: { kind: "connected-folder", id: source.id }, path: "notes.md" }], target: { place: { kind: "connected-folder", id: target.id }, path: "" } };

  // While the Worker's turn runs, the move is refused.
  const busy = await call("/api/file-transfer", { method: "POST", body });
  assert.equal(busy.status, 409, JSON.stringify(busy.body));
  assert.match(busy.body!.error, /outstanding work/);

  // The Worker asks a question and its turn ends: its request is waiting on
  // an answer, which is unfinished work, so the move is still refused.
  await api.actFacade.chatAsk({ connectedFolder: source.id, taskId: sent.taskId, question: "Which notes?", respondent: "person" });
  await writeFile(released, "");
  await waitFor(async () => (await running()).state !== "running");
  assert.equal(api.requests.byTaskId(sent.taskId)?.state, "waiting");
  const waiting = await call("/api/file-transfer", { method: "POST", body });
  assert.equal(waiting.status, 409, JSON.stringify(waiting.body));
  assert.match(waiting.body!.error, /outstanding work/);
  assert.ok(existsSync(join(source.connectedFolderRoot, "notes.md")));
  assert.ok(!existsSync(join(target.connectedFolderRoot, "notes.md")), "nothing was copied");

  // A copy out of it takes nothing away, so it goes ahead.
  const copied = await call("/api/file-transfer", { method: "POST", body: { ...body, mode: "copy" } });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.ok(existsSync(join(source.connectedFolderRoot, "notes.md")));
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
