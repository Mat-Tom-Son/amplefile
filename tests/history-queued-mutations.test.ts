import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ampleFileAutomationDigest, normalizeAmpleFileAutomationDeclaration } from "../src/local/automations/automation-declarations.js";
import { withConnectedFolderHistoryOperation } from "../src/local/connected-folder.js";
import { startLocalApi } from "../src/local/server.js";

/**
 * Deletes, a move between Connected Folders, and an Automation's files hop
 * queue for History before they reserve a Connected Folder: while one waits,
 * the folder keeps accepting turns, and it checks for unsettled work once it
 * holds History.
 */

type Api = Awaited<ReturnType<typeof startLocalApi>>;

async function sandboxApi(t: TestContext): Promise<{ api: Api; release: () => void; hold: (root: string) => Promise<void> }> {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-history-queued-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", { description: "A test turn", handler: async () => "held" });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
  });
  const releases: Array<() => void> = [];
  const held: Promise<void>[] = [];
  const release = () => { for (const done of releases.splice(0)) done(); };
  t.after(async () => { release(); await Promise.all(held); await api.close(); await rm(sandbox, { recursive: true, force: true }); });
  // Something else holds this folder's History until released.
  const hold = (root: string) => {
    const operation = withConnectedFolderHistoryOperation(root, () => new Promise<void>((resolve) => { releases.push(resolve); }));
    held.push(operation);
    return operation;
  };
  return { api, release, hold };
}

/** Starts a turn; it is accepted (not refused as a capability change) and its id returned. */
async function turnAccepted(api: Api, connectedFolderId: string): Promise<{ connectedFolderId: string; taskId: string }> {
  const turn = await api.actFacade.sendMessage({ connectedFolder: connectedFolderId, newConversation: true, content: "/hold" });
  return { connectedFolderId, taskId: turn.taskId };
}

/** The turn's own "Before turn" checkpoint queues for History too, so it finishes after the release. */
async function finished(api: Api, ...turns: Array<{ connectedFolderId: string; taskId: string }>): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (const turn of turns) {
    while ((await api.actFacade.turnStatus({ connectedFolder: turn.connectedFolderId, taskId: turn.taskId })).task.state === "running") {
      if (Date.now() > deadline) throw new Error("The turn did not finish.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const json = (api: Api, path: string, method: string, body: unknown) =>
  fetch(new URL(path, api.origin), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a delete waiting for History does not hold the Connected Folder's turns off", async (t) => {
  const { api, release, hold } = await sandboxApi(t);
  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Deletes" });
  const root = connectedFolder.connectedFolderRoot;
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, name), name);

  const held = hold(root);
  const batch = json(api, `/api/connected-folders/${connectedFolder.id}/local-files`, "DELETE", { paths: ["a.txt", "b.txt"] });
  const single = api.actFacade.filesDelete({ connectedFolder: connectedFolder.id, path: "c.txt" }).then(() => null, (error: unknown) => error);
  await pause();
  // Both deletes wait; a turn in the folder is accepted meanwhile.
  const turn = await turnAccepted(api, connectedFolder.id);
  release(); await held;
  // They check for running work once they hold History: the turn accepted
  // while they waited refuses them then, before anything is deleted.
  const refused = await batch;
  assert.equal(refused.status, 409);
  assert.match((await refused.json() as { error: string }).error, /agent work/);
  assert.match(String(await single), /agent work/);
  for (const name of ["a.txt", "b.txt", "c.txt"]) assert.equal(existsSync(join(root, name)), true);
  await finished(api, turn);
  assert.equal((await json(api, `/api/connected-folders/${connectedFolder.id}/local-files`, "DELETE", { paths: ["a.txt", "b.txt"] })).status, 200);
  await api.actFacade.filesDelete({ connectedFolder: connectedFolder.id, path: "c.txt" });
  for (const name of ["a.txt", "b.txt", "c.txt"]) assert.equal(existsSync(join(root, name)), false);
});

function mover(api: Api) {
  return (from: { id: string }, to: { id: string }, path: string) => json(api, "/api/file-transfer", "POST", {
    mode: "move",
    sources: [{ place: { kind: "connected-folder", id: from.id }, path }],
    target: { place: { kind: "connected-folder", id: to.id }, path: "" },
  });
}

test("a move between Connected Folders waiting for History holds no turns off in either folder", async (t) => {
  const { api, release, hold } = await sandboxApi(t);
  const move = mover(api);
  const a = (await api.actFacade.createConnectedFolder({ name: "Alpha" })).connectedFolder;
  const b = (await api.actFacade.createConnectedFolder({ name: "Beta" })).connectedFolder;
  await writeFile(join(a.connectedFolderRoot, "from-a.txt"), "a");

  const held = hold(b.connectedFolderRoot);
  const moving = move(a, b, "from-a.txt");
  await pause();
  const turns = [await turnAccepted(api, a.id), await turnAccepted(api, b.id)];
  release(); await held;
  const refused = await moving;
  assert.equal(refused.status, 409, await refused.clone().text());
  assert.equal(existsSync(join(a.connectedFolderRoot, "from-a.txt")), true, "nothing moved");
  assert.equal(existsSync(join(b.connectedFolderRoot, "from-a.txt")), false, "nothing copied");
  await finished(api, ...turns);
  assert.equal((await move(a, b, "from-a.txt")).status, 200);
  assert.equal(await readFile(join(b.connectedFolderRoot, "from-a.txt"), "utf8"), "a");
});

test("two opposite moves between the same Connected Folders both finish", async (t) => {
  const { api, release, hold } = await sandboxApi(t);
  const move = mover(api);
  const a = (await api.actFacade.createConnectedFolder({ name: "Alpha" })).connectedFolder;
  const b = (await api.actFacade.createConnectedFolder({ name: "Beta" })).connectedFolder;
  await writeFile(join(a.connectedFolderRoot, "from-a.txt"), "a");
  await writeFile(join(b.connectedFolderRoot, "from-b.txt"), "b");

  // Both moves queue behind History on one side; neither may hold the other up.
  const held = hold(a.connectedFolderRoot);
  const forward = move(a, b, "from-a.txt");
  const backward = move(b, a, "from-b.txt");
  await pause();
  release(); await held;
  const [there, back] = await Promise.all([forward, backward]);
  assert.equal(there.status, 200, await there.clone().text());
  assert.equal(back.status, 200, await back.clone().text());
  assert.equal(await readFile(join(b.connectedFolderRoot, "from-a.txt"), "utf8"), "a");
  assert.equal(await readFile(join(a.connectedFolderRoot, "from-b.txt"), "utf8"), "b");
  assert.equal(existsSync(join(a.connectedFolderRoot, "from-a.txt")), false);
  assert.equal(existsSync(join(b.connectedFolderRoot, "from-b.txt")), false);
});

test("an Automation's files hop waiting for History holds no turns off in either folder", async (t) => {
  const { api, release, hold } = await sandboxApi(t);
  const source = (await api.actFacade.createConnectedFolder({ name: "Hop source" })).connectedFolder;
  const target = (await api.actFacade.createConnectedFolder({ name: "Hop target" })).connectedFolder;
  await writeFile(join(source.connectedFolderRoot, "notes.md"), "notes");
  const declaration = normalizeAmpleFileAutomationDeclaration({
    kind: "amplefile.automation", version: 1, id: "automation-queued-hop", title: "Queued hop", createdBy: "human",
    createdAt: new Date().toISOString(), trigger: { kind: "manual" },
    steps: [{ id: "copy", kind: "files", fromConnectedFolder: source.id, from: { kind: "paths", paths: ["notes.md"] }, toConnectedFolder: target.id, to: "Incoming" }],
  });
  await api.automations.enable({ declaration, expectedDigest: ampleFileAutomationDigest(declaration), grant: { requestId: "automation-queued-hop", surface: "main-window" } });

  const held = hold(target.connectedFolderRoot);
  const run = api.automations.runNow(declaration.id);
  await pause();
  const turns = [await turnAccepted(api, source.id), await turnAccepted(api, target.id)];
  release(); await held;
  const refused = await run;
  assert.equal(refused.outcome, "failure");
  assert.match(String(refused.error), /agent work/);
  assert.equal(existsSync(join(target.connectedFolderRoot, "Incoming", "notes.md")), false);
  await finished(api, ...turns);
  const result = await api.automations.runNow(declaration.id);
  assert.equal(result.outcome, "success", JSON.stringify(result));
  assert.equal(await readFile(join(target.connectedFolderRoot, "Incoming", "notes.md"), "utf8"), "notes");
});
