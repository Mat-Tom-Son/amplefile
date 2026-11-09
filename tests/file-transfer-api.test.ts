import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ampleFileCliBrokerPaths } from "../src/local/cli/broker.js";
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

test("a move between Connected Folders never erases a nested Connected Folder and parks nothing the copy carried", async (t) => {
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
  // The item leaving the source is that Connected Folder's delete, with its receipt.
  const receipts = (await readFile(join(ampleFileCliBrokerPaths(join(sandbox, "state")).root, "receipts", "act.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as { requestId: string; command: string; outcome: string; detail?: string });
  const removal = receipts.find((receipt) => receipt.command === "files.delete" && receipt.outcome === "ok" && receipt.detail?.includes(`moved to ${target.id}`));
  assert.ok(removal, JSON.stringify(receipts));
  assert.ok(receipts.some((receipt) => receipt.requestId === removal.requestId && receipt.outcome === "accepted"), "journaled before the effect");

  // A project folder whose parts History does not keep (a `.git`, installed
  // packages, an ignored build folder, a link, a file over History's limit)
  // moves whole: the copy carried all of it, so nothing is parked in Recently Deleted.
  const project = join(sourceRoot, "App");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(project, "build"), { recursive: true });
  await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(project, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  await writeFile(join(project, "build", "out.js"), "built\n");
  await writeFile(join(project, ".gitignore"), "build/\n");
  await writeFile(join(project, "index.js"), "console.log(1);\n");
  await symlink("index.js", join(project, "entry.js"));
  await rename(join(sourceRoot, "big.bin"), join(project, "big.bin"));
  const previousCap = process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES;
  process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = "32";
  try {
    const app = await move("App");
    assert.equal(app.status, 200, JSON.stringify(app.body));
    assert.equal(app.body!.recentlyDeleted, undefined, "the copy carried everything History does not keep");
    assert.equal(app.body!.failed, undefined);
    assert.ok(!existsSync(project), "the source is gone");
    const moved = join(target.connectedFolderRoot, "App");
    assert.equal(await readFile(join(moved, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
    assert.equal(await readFile(join(moved, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1;\n");
    assert.equal(await readFile(join(moved, "build", "out.js"), "utf8"), "built\n");
    assert.equal((await readFile(join(moved, "big.bin"), "utf8")).length, 64);
    assert.ok((await lstat(join(moved, "entry.js"))).isSymbolicLink());
    assert.deepEqual((await api.recentlyDeleted.list()).entries, [], "nothing was parked in Recently Deleted");
  } finally {
    if (previousCap === undefined) delete process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES;
    else process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = previousCap;
  }
});

test("a disconnected Connected Folder keeps its identity and Chats when moved, and a copy leaves them behind", async (t) => {
  const { api } = await sandboxApi(t);
  const call = caller(api);
  const source = (await call("/api/connected-folders", { method: "POST", body: { name: "Source" } })).body!.connectedFolder;
  const target = (await call("/api/connected-folders", { method: "POST", body: { name: "Target" } })).body!.connectedFolder;
  const identity = (root: string) => ({
    manifest: join(root, ".amplefile", "connected-folder.json"),
    chat: join(root, ".amplefile", "conversations", "chat.jsonl"),
  });
  const plant = async (root: string) => {
    const { manifest, chat } = identity(root);
    await mkdir(join(chat, ".."), { recursive: true });
    await writeFile(manifest, "{\"id\":\"space-0123456789abcdef\"}");
    await writeFile(chat, "{\"role\":\"user\"}\n");
    await writeFile(join(root, "plan.md"), "plan");
  };
  await plant(join(source.connectedFolderRoot, "Old Trip"));
  const transfer = (mode: string, path: string) => call("/api/file-transfer", {
    method: "POST",
    body: { mode, sources: [{ place: { kind: "connected-folder", id: source.id }, path }], target: { place: { kind: "connected-folder", id: target.id }, path: "" } },
  });

  const copied = await transfer("copy", "Old Trip");
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.ok(!existsSync(join(target.connectedFolderRoot, "Old Trip", ".amplefile")), "a copy is not the same Connected Folder");
  await rm(join(target.connectedFolderRoot, "Old Trip"), { recursive: true });

  const moved = await transfer("move", "Old Trip");
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const landed = identity(join(target.connectedFolderRoot, "Old Trip"));
  assert.equal(await readFile(landed.manifest, "utf8"), "{\"id\":\"space-0123456789abcdef\"}");
  assert.equal(await readFile(landed.chat, "utf8"), "{\"role\":\"user\"}\n");
  assert.ok(!existsSync(join(source.connectedFolderRoot, "Old Trip")));
});

test("a moved item that cannot leave its Connected Folder stays there, and its copy carries no identity", { skip: process.getuid?.() === 0 ? "root ignores folder permissions" : false }, async (t) => {
  const { api } = await sandboxApi(t);
  const call = caller(api);
  const source = (await call("/api/connected-folders", { method: "POST", body: { name: "Source" } })).body!.connectedFolder;
  const target = (await call("/api/connected-folders", { method: "POST", body: { name: "Target" } })).body!.connectedFolder;
  const locked = join(source.connectedFolderRoot, "Locked");
  await mkdir(join(locked, "Old Trip", ".amplefile"), { recursive: true });
  await writeFile(join(locked, "Old Trip", ".amplefile", "connected-folder.json"), "{}");
  await writeFile(join(locked, "Old Trip", "plan.md"), "plan");
  await chmod(locked, 0o555);
  let moved: Awaited<ReturnType<typeof call>>;
  try {
    moved = await call("/api/file-transfer", {
      method: "POST",
      body: { mode: "move", sources: [{ place: { kind: "connected-folder", id: source.id }, path: "Locked/Old Trip" }], target: { place: { kind: "connected-folder", id: target.id }, path: "" } },
    });
  } finally {
    await chmod(locked, 0o755);
  }
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body!.written, ["Old Trip"]);
  assert.equal(moved.body!.failed?.path, "Locked/Old Trip");
  assert.equal(typeof moved.body!.failed?.error, "string");
  assert.deepEqual(moved.body!.notRemoved, ["Locked/Old Trip"]);
  assert.ok(existsSync(join(locked, "Old Trip", ".amplefile", "connected-folder.json")), "the original keeps its identity");
  assert.equal(await readFile(join(target.connectedFolderRoot, "Old Trip", "plan.md"), "utf8"), "plan");
  assert.ok(!existsSync(join(target.connectedFolderRoot, "Old Trip", ".amplefile")), "the copy is an ordinary copy");
});

test("a disconnected Connected Folder's Chats survive a move whose source cannot be removed in one go", { skip: process.getuid?.() === 0 ? "root ignores folder permissions" : false }, async (t) => {
  const { api, sandbox } = await sandboxApi(t);
  const call = caller(api);
  const source = (await call("/api/connected-folders", { method: "POST", body: { name: "Source" } })).body!.connectedFolder;
  const target = (await call("/api/connected-folders", { method: "POST", body: { name: "Target" } })).body!.connectedFolder;
  const old = join(source.connectedFolderRoot, "Old");
  await mkdir(join(old, ".amplefile", "conversations"), { recursive: true });
  await writeFile(join(old, ".amplefile", "connected-folder.json"), "{\"id\":\"space-0123456789abcdef\"}");
  await writeFile(join(old, ".amplefile", "conversations", "chat.jsonl"), "{\"role\":\"user\"}\n");
  await mkdir(join(old, "locked"));
  await writeFile(join(old, "locked", "f.txt"), "f");
  // A plain delete of Old would stop partway at locked/f.txt.
  await chmod(join(old, "locked"), 0o555);
  try {
    const moved = await call("/api/file-transfer", {
      method: "POST",
      body: { mode: "move", sources: [{ place: { kind: "connected-folder", id: source.id }, path: "Old" }], target: { place: { kind: "connected-folder", id: target.id }, path: "" } },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const chats = await findFiles(sandbox, "chat.jsonl");
    const inSource = chats.filter((path) => path.startsWith(source.connectedFolderRoot));
    const inTarget = chats.filter((path) => path.startsWith(target.connectedFolderRoot));
    const inTrash = chats.filter((path) => !path.startsWith(source.connectedFolderRoot) && !path.startsWith(target.connectedFolderRoot));
    assert.ok(chats.length, "the Chat log is somewhere it can be recovered from");
    if (moved.body!.failed) {
      assert.ok(inSource.length, "an item that could not leave keeps its Chats in the source");
    } else {
      // The identity leaves the source whole, through Recently Deleted, never a plain delete.
      assert.equal(moved.body!.recentlyDeleted?.length, 1, JSON.stringify(moved.body));
      assert.ok(!existsSync(old));
      assert.equal(inTarget.length, 1, "the moved folder keeps its Chats");
      assert.equal(inTrash.length, 1, "and Recently Deleted keeps the original whole");
      assert.equal(await readFile(inTarget[0]!, "utf8"), "{\"role\":\"user\"}\n");
    }
  } finally {
    await makeWritable(sandbox);
  }
});

async function findFiles(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

async function makeWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory()) return;
  await chmod(root, 0o755);
  for (const entry of await readdir(root)) await makeWritable(join(root, entry));
}

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
