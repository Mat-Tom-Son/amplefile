import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { connectedFolderOperationsGuideForScope } from "../src/local/agent/connected-folder-operations-guide.js";
import { createHelperRecallTool } from "../src/local/agent/helper-tool.js";
import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { coverageLine, createRecallTool, parseRecallToolInput, presentRecallResult, recallToolMaxLimit, type RecallToolHost } from "../src/local/agent/recall-tool.js";
import { createRecallToolHost } from "../src/local/api/recall.js";
import type { LocalApiState } from "../src/local/api/state.js";
import { executeAmpleFileCliActRequest } from "../src/local/cli/act-commands.js";
import { createAmpleFileCliActRequest } from "../src/local/cli/act-protocol.js";
import { normalizeVector, type ConnectedFolderIndexEmbedder, type EmbedderInput } from "../src/local/index/embedder.js";
import { ConnectedFolderIndexService, type IndexedConnectedFolder } from "../src/local/index/indexer.js";
import { folderPrefix, recallAcrossConnectedFolders, type RecallAcrossResult } from "../src/local/index/recall-across.js";
import type { RecallHit } from "../src/local/index/recall.js";
import { isManagedWorkingCopyRoot, managedWorkingCopiesRoot } from "../src/local/managed-worktrees.js";
import { ensureAmpleFileAgentInstructions } from "../src/local/amplefile-agent-instructions.js";
import { startLocalApi } from "../src/local/server.js";
import { ampleFileAgentRoot, configureAmpleFileStateRoot } from "../src/local/state-paths.js";

/**
 * Words map to a few shared concepts, so "agreement awaiting signature" lands
 * near "renewal contract still unsigned". Each concept and each other word is
 * a dense pseudo-random direction, as real sentence vectors are dense (the
 * index stores their signs).
 */
function conceptEmbedder(): ConnectedFolderIndexEmbedder {
  const concepts: Record<string, number> = {
    contract: 0, agreement: 0, renewal: 0, lease: 0,
    unsigned: 1, signature: 1, sign: 1, signed: 1, awaiting: 1, pending: 1,
    banana: 2, bread: 2, bake: 2, oven: 2, recipe: 2, flour: 2,
    invoice: 3, budget: 3, quarterly: 3, payment: 3,
  };
  const dimension = 256;
  const direction = (seed: number) => Array.from({ length: dimension }, (_, index) => {
    const value = Math.sin((seed + 1) * 12.9898 + index * 78.233) * 43758.5453;
    return (value - Math.floor(value)) * 2 - 1;
  });
  return {
    id: "test-concepts",
    dimension,
    available: () => true,
    async embed(inputs: EmbedderInput[]) {
      return inputs.map(({ text }) => {
        const values = new Array<number>(dimension).fill(0);
        for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
          const concept = concepts[word];
          const basis = direction(concept !== undefined ? concept : 100 + (word.length * 7 + word.charCodeAt(0)) % 1000);
          const weight = concept !== undefined ? 3 : 0.2;
          basis.forEach((value, index) => { values[index]! += value * weight; });
        }
        const vector = normalizeVector(values);
        return vector ? { language: "en", vector } : null;
      });
    },
    async close() {},
  };
}

const quiet = { shownMs: 60_000, changedMs: 60_000, turnMs: 60_000, retryMs: 60_000 };

async function writeRole(root: string, purpose: string): Promise<void> {
  await mkdir(join(root, ".amplefile"), { recursive: true });
  await writeFile(join(root, ".amplefile", "role.json"), JSON.stringify({ version: 1, purpose, updatedAt: "2026-11-27T10:00:00.000Z" }), "utf8");
}

/**
 * A parent with two nested Connected Folders at different depths, each with a
 * Role, and a third that was never indexed. The Worker's `recall` tool is
 * built into a real Pi session, as the desktop builds it.
 */
test("a Worker's recall tool searches its folder, and with tree scope its nested folders grouped by owner with Roles", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "amplefile-recall-tree-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const api = await startLocalApi({
    port: 0, stateBase: join(base, "state"), connectedFolderBase: join(base, "content"), loadEnv: false,
    connectedFolderIndex: { embedder: conceptEmbedder(), extract: { pdfPages: null }, delays: quiet },
  });
  t.after(() => api.close());
  const parentRoot = join(base, "Studio");
  const hendersonRoot = join(parentRoot, "Clients", "Henderson");
  const kitchenRoot = join(parentRoot, "Kitchen");
  const archiveRoot = join(parentRoot, "Archive");
  for (const root of [hendersonRoot, kitchenRoot, archiveRoot]) await mkdir(root, { recursive: true });
  await writeFile(join(parentRoot, "budget.md"), "# Budget\n\nThe quarterly invoice payment is due on Friday.\n");
  await writeFile(join(hendersonRoot, "contract.md"), "# Henderson\n\nThe renewal contract is still unsigned.\n");
  await writeFile(join(kitchenRoot, "recipes.md"), "Banana bread recipe: flour, then bake in the oven.\n");
  await writeFile(join(archiveRoot, "lease.md"), "An old lease agreement awaiting signature.\n");
  const facade = api.actFacade;
  const parent = (await facade.registerConnectedFolder({ connectedFolderRoot: parentRoot })).connectedFolder;
  const henderson = (await facade.registerConnectedFolder({ connectedFolderRoot: hendersonRoot })).connectedFolder;
  const kitchen = (await facade.registerConnectedFolder({ connectedFolderRoot: kitchenRoot })).connectedFolder;
  const archive = (await facade.registerConnectedFolder({ connectedFolderRoot: archiveRoot })).connectedFolder;
  await writeRole(hendersonRoot, "Henderson client work: contracts and renewals");
  await writeRole(kitchenRoot, "Recipes and meal plans");

  const byId = new Map([parent, henderson, kitchen, archive].map((folder) => [folder.id, { id: folder.id, connectedFolderRoot: folder.connectedFolderRoot }]));
  const index = new ConnectedFolderIndexService({ embedder: conceptEmbedder(), extract: { pdfPages: null }, delays: quiet, resolve: async (id) => byId.get(id) ?? null });
  t.after(() => index.close());
  for (const folder of [parent, henderson, kitchen]) await index.sync(byId.get(folder.id)!);
  const scheduled: string[] = [];
  const watched = Object.assign(Object.create(index) as ConnectedFolderIndexService, {
    schedule: (folder: IndexedConnectedFolder, trigger: Parameters<ConnectedFolderIndexService["schedule"]>[1]) => { scheduled.push(`${folder.id}:${trigger}`); },
    status: (folder: IndexedConnectedFolder) => index.status(folder),
    recall: (folder: IndexedConnectedFolder, query: string, options: Parameters<ConnectedFolderIndexService["recall"]>[2]) => index.recall(folder, query, options),
  });
  const state = { connectedFolderIndex: watched } as unknown as LocalApiState;

  // A real Worker session gets the tool beside the collaboration tools.
  const agentDir = join(base, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const provider = { async resolveRuntime() { return { agentDir }; } };
  const client = new PiConversationClient("recall", parentRoot, provider, undefined, {
    operationsGuide: connectedFolderOperationsGuideForScope(parent.id)!,
    recall: createRecallToolHost(state, parent.id),
  });
  t.after(() => client.stop());
  const catalog = await client.getCatalog();
  assert.ok(catalog.tools.some((tool) => tool.name === "recall"), "the Worker session lists recall");
  const session = (client as unknown as { session: { agent: { state: { tools: Array<{ name: string; description: string; execute(id: string, args: unknown, signal?: AbortSignal): Promise<{ content: Array<{ text: string }> }> }> } }; resourceLoader: { getAppendSystemPrompt(): string[] } } }).session;
  const tool = session.agent.state.tools.find((candidate) => candidate.name === "recall")!;
  assert.match(tool.description, /Read the original before relying on or quoting anything/);
  assert.match(tool.description, /fresh:false/);
  assert.match(tool.description, /coverage says what is not indexed yet/);
  assert.match(tool.description, /which nested Worker holds something[\s\S]*chat_handoff/);
  const call = async (args: unknown) => JSON.parse((await tool.execute(randomUUID(), args)).content[0]!.text) as Record<string, any>;

  // Folder scope: this folder's own index only; a nested folder keeps its own.
  const own = await call({ query: "agreement awaiting signature" });
  assert.equal(own.scope, undefined);
  assert.deepEqual(own.hits, [], "the nested Henderson contract is not in the parent's own index");
  assert.match(own.coverage, /No hits: that does not prove it is not here/);
  const budget = await call({ query: "invoice payment" });
  assert.equal(budget.hits[0].path, "budget.md");
  assert.equal(budget.hits[0].at, "lines 1–3, under Budget");
  assert.equal(budget.hits[0].fresh, true);
  assert.match(budget.hits[0].modified, /^\d{4}-\d{2}-\d{2}, (just now|\d+ minutes? ago)$/);
  assert.match(budget.hits[0].matched, /words/);
  assert.match(budget.coverage, /Index complete: 1 file indexed\. Ranked by words and meaning\./);

  // Tree scope: nested folders at any depth, grouped by owner with id, name, path, and Role.
  const tree = await call({ query: "agreement awaiting signature", scope: "tree" });
  assert.equal(tree.scope, "tree");
  assert.equal(tree.folders[0].connectedFolder, henderson.id);
  assert.equal(tree.folders[0].name, henderson.name);
  assert.equal(tree.folders[0].path, "Clients/Henderson");
  assert.equal(tree.folders[0].role, "Henderson client work: contracts and renewals");
  assert.equal(tree.folders[0].hits[0].path, "Clients/Henderson/contract.md", "a hit's path is relative to the caller, so it can be read");
  assert.match(tree.folders[0].hits[0].matched, /meaning/);
  assert.match(tree.folders[0].hits[0].excerpt, /still unsigned/);
  // The never-indexed folder is reported and scheduled, not shown as empty.
  assert.deepEqual(tree.notIndexed, [{ connectedFolder: archive.id, name: archive.name, path: "Archive" }]);
  assert.ok(scheduled.includes(`${archive.id}:query`), "a never-indexed nested folder is asked to index");
  assert.match(tree.coverage, /Searched this Connected Folder and 3 nested Connected Folders; nested Workers' Chats are not searched\./);
  assert.match(tree.coverage, /1 folder not indexed yet \(Archive\): indexing has started; this is not the same as empty/);

  // Merge by rank: one query that each folder answers, groups best first, the limit over all of them.
  const merged = await recallAcrossConnectedFolders(watched, [
    { id: parent.id, name: parent.name, connectedFolderRoot: parentRoot, path: "" },
    { id: henderson.id, name: henderson.name, connectedFolderRoot: hendersonRoot, path: "Clients/Henderson" },
    { id: kitchen.id, name: kitchen.name, connectedFolderRoot: kitchenRoot, path: "Kitchen" },
  ], "unsigned renewal contract and banana bread and invoice", { limit: 2, kinds: ["files"] });
  assert.equal(merged.groups.reduce((sum, group) => sum + group.hits.length, 0), 2, "the limit applies across folders");
  assert.equal(merged.searched, 3);
  assert.equal(merged.withoutHits, 1);
  const best = merged.groups.map((group) => group.hits[0]!.score);
  assert.deepEqual(best, [...best].sort((a, b) => b - a), "groups come best first");

  // A path narrows to the folders that hold it, inside the nested one.
  const narrowed = await call({ query: "renewal contract", scope: "tree", path: "Clients/Henderson" });
  assert.deepEqual(narrowed.folders.map((folder: { name: string }) => folder.name), [henderson.name]);
  assert.equal(folderPrefix("Clients/Henderson", "Clients/Henderson/notes"), "notes");
  assert.equal(folderPrefix("Clients/Henderson", "Clients"), "");
  assert.equal(folderPrefix("Kitchen", "Clients"), null);
  assert.equal(folderPrefix("", "Clients"), "Clients");
  await assert.rejects(() => call({ query: "x", path: "../elsewhere", scope: "tree" }), /stay inside the Connected Folder/);

  // The read-only helper's recall is folder scope only.
  const helperRecall = createHelperRecallTool(createRecallToolHost(state, parent.id));
  assert.equal("scope" in (helperRecall.parameters.properties as object), false);
  const helperResult = JSON.parse((await helperRecall.execute({ query: "agreement awaiting signature", scope: "tree" }, new AbortController().signal)).content[0]!.text);
  assert.deepEqual(helperResult.hits, [], "the helper never reaches nested folders' indexes");

  // The teaching reaches the real session's prompt.
  const guide = session.resourceLoader.getAppendSystemPrompt().join("\n");
  assert.match(guide, /- Recall: the `recall` tool finds where to look/);
  assert.match(guide, /Read the original before relying on or quoting anything\. A hit with fresh:false changed since it was indexed/);
  assert.match(guide, /coverage line says what the index has not read yet/);
  assert.match(guide, /With scope tree it also searches the files of every Connected Folder nested inside this one[\s\S]*Changing a nested folder's files still goes to its Worker with chat_handoff/);
  assert.match(guide, /`recall` with scope tree searches their files, and you may read a file such a hit names, but you change nothing there/);
});

test("the recall tool's input and output are bounded", async () => {
  assert.throws(() => parseRecallToolInput({}), /needs a query/);
  assert.throws(() => parseRecallToolInput({ query: "x", limit: 0 }), /limit must be/);
  assert.throws(() => parseRecallToolInput({ query: "x", scope: "everywhere" }), /scope must be folder or tree/);
  assert.throws(() => parseRecallToolInput({ query: "x", kinds: ["mail"] }), /kinds may hold files and chats/);
  assert.throws(() => parseRecallToolInput({ query: "x", scope: "tree" }, ["folder"]), /not available here/);
  assert.deepEqual(parseRecallToolInput({ query: "  x  ", limit: 500 }), { query: "x", limit: recallToolMaxLimit, scope: "folder" });

  const long = "word ".repeat(400);
  const hits: RecallHit[] = Array.from({ length: 25 }, (_, index) => index % 5 === 0
    ? { source: "chat", conversationId: `c${index}`, messageId: `m${index}`, title: "Planning", role: "assistant", createdAt: "2026-11-20T10:00:00.000Z", location: { part: 2 }, excerpt: long, score: 1 - index / 100, reasons: ["semantic"], sha256: "b".repeat(64), indexedAt: null, fresh: true }
    : { source: "file", path: `notes/${index}.md`, modifiedAt: "2026-10-28T10:00:00.000Z", duplicates: ["a.md", "b.md", "c.md", "d.md"], location: { sheet: "Budget", rows: { start: 2, end: 2 } }, excerpt: long, score: 1 - index / 100, reasons: ["lexical", "semantic"], sha256: "a".repeat(64), indexedAt: "2026-11-01T00:00:00.000Z", fresh: index !== 3 });
  let asked: unknown;
  const result = (limit: number): RecallAcrossResult => ({
    query: "budget",
    groups: [{ connectedFolder: { id: "cf-1", name: "Home", connectedFolderRoot: "/tmp/home", path: "" }, hits: hits.slice(0, limit), coverage: {} as never }],
    notIndexed: [], searched: 1, withoutHits: 0, failed: [], leftOut: { workingCopies: 0, beyondLimit: 0 },
    coverage: { complete: false, folders: { complete: 0, partial: 1, notIndexed: 0, failed: 0 }, files: { indexed: 40, pending: 3, "not-downloaded": 2, unsupported: 1 }, ranking: "hybrid", staleHits: 1, running: true },
  });
  const host: RecallToolHost = { async recall(input) { asked = input; return result(input.limit); } };
  const tool = createRecallTool(host);
  const output = await tool.execute("call-1", { query: "budget", limit: 50 }, undefined, undefined, undefined as never);
  assert.deepEqual(asked, { query: "budget", limit: 20, scope: "folder" });
  const presented = JSON.parse((output.content[0] as { text: string }).text) as { hits: Array<Record<string, any>>; coverage: string };
  assert.equal(presented.hits.length, 20);
  for (const pointer of presented.hits) assert.ok(pointer.excerpt.length <= 240, "excerpts are short");
  assert.deepEqual(Object.keys(presented.hits[1]!), ["path", "at", "matched", "modified", "fresh", "excerpt", "sameBytesAlsoAt"]);
  assert.equal(presented.hits[1]!.at, "sheet Budget, row 2");
  assert.equal(presented.hits[1]!.sameBytesAlsoAt.length, 3);
  assert.match(presented.hits[1]!.modified, /^2026-10-28, \d+ (days|months?) ago$/);
  assert.equal(presented.hits[3]!.fresh, false);
  assert.deepEqual(Object.keys(presented.hits[0]!), ["chat", "conversationId", "messageId", "role", "at", "matched", "written", "fresh", "excerpt"]);
  assert.equal(presented.hits[0]!.at, "part 2");
  assert.equal(presented.hits[0]!.matched, "meaning");
  assert.match(presented.coverage, /Index partial: 40 files indexed; 3 still being read, 2 not downloaded from a sync service \(never read\), 1 of a kind the index does not read; catching up now\./);
  assert.match(presented.coverage, /1 hit changed since indexed \(fresh:false\): read it again\./);
  assert.ok((output.content[0] as { text: string }).text.length < 16_000, "the whole result stays small");

  const unindexed: RecallAcrossResult = { ...result(0), groups: [], notIndexed: [{ id: "cf-1", name: "Home", connectedFolderRoot: "/tmp/home", path: "" }], coverage: { ...result(0).coverage, folders: { complete: 0, partial: 0, notIndexed: 1, failed: 0 }, files: {} } };
  assert.match(coverageLine("folder", unindexed), /has not been indexed yet; indexing has started, so nothing here means unknown, not absent/);
  const tree = presentRecallResult({ scope: "tree" }, { ...unindexed, notIndexed: Array.from({ length: 30 }, (_, index) => ({ id: `cf-${index}`, name: `F${index}`, connectedFolderRoot: `/tmp/f${index}`, path: `f${index}` })) });
  assert.equal(tree.notIndexed?.length, 20, "at most 20 not-indexed folders are named");
});

test("everywhere search groups by Connected Folder with Roles, leaves out working copies, and names never-indexed folders", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "amplefile-recall-everywhere-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const api = await startLocalApi({
    port: 0, stateBase: join(base, "state"), connectedFolderBase: join(base, "content"), loadEnv: false,
    connectedFolderIndex: { embedder: conceptEmbedder(), extract: { pdfPages: null }, delays: quiet },
  });
  t.after(() => api.close());
  const clientsRoot = join(base, "Clients");
  const kitchenRoot = join(base, "Kitchen");
  const archiveRoot = join(base, "Archive");
  const copyRoot = join(managedWorkingCopiesRoot(), `worktree-${randomUUID()}`);
  assert.ok(isManagedWorkingCopyRoot(copyRoot));
  assert.equal(isManagedWorkingCopyRoot(clientsRoot), false);
  for (const root of [clientsRoot, kitchenRoot, archiveRoot, copyRoot]) await mkdir(root, { recursive: true });
  await writeFile(join(clientsRoot, "henderson.md"), "# Henderson\n\nThe renewal contract is still unsigned.\n");
  await writeFile(join(kitchenRoot, "recipes.md"), "Banana bread recipe: flour, then bake in the oven.\n");
  await writeFile(join(archiveRoot, "lease.md"), "An old lease agreement awaiting signature.\n");
  await writeFile(join(copyRoot, "henderson.md"), "# Henderson\n\nThe renewal contract is still unsigned.\n");
  const facade = api.actFacade;
  const clients = (await facade.registerConnectedFolder({ connectedFolderRoot: clientsRoot })).connectedFolder;
  const kitchen = (await facade.registerConnectedFolder({ connectedFolderRoot: kitchenRoot })).connectedFolder;
  const archive = (await facade.registerConnectedFolder({ connectedFolderRoot: archiveRoot })).connectedFolder;
  const copy = (await facade.registerConnectedFolder({ connectedFolderRoot: copyRoot })).connectedFolder;
  await writeRole(clientsRoot, "Client contracts and renewals");
  // Index three of them (the working copy too, to show it is left out, not just unindexed).
  for (const folder of [clients, kitchen, copy]) await facade.search({ connectedFolder: folder.id, query: "warm up", ranked: true });

  const result = await facade.searchEverywhere({ query: "agreement awaiting signature" });
  assert.equal(result.everywhere, true);
  assert.equal(result.scope, "all");
  const { ranked } = result;
  assert.equal(ranked.groups.length, 1);
  assert.equal(ranked.groups[0]!.connectedFolder.id, clients.id);
  assert.equal(ranked.groups[0]!.connectedFolder.name, clients.name);
  assert.equal(ranked.groups[0]!.connectedFolder.rolePurpose, "Client contracts and renewals");
  assert.equal(ranked.groups[0]!.connectedFolder.path, undefined, "everywhere hits have no caller-relative path");
  const hit = ranked.groups[0]!.hits[0]!;
  assert.equal(hit.source === "file" && hit.path, "henderson.md");
  assert.equal(ranked.leftOut.workingCopies, 1);
  assert.ok(!ranked.groups.some((group) => group.connectedFolder.id === copy.id), "a managed working copy is left out");
  assert.deepEqual(ranked.notIndexed.map((folder) => folder.id), [archive.id], "a never-indexed folder is named, not counted as empty");
  assert.equal(ranked.searched, 3);
  assert.equal(ranked.withoutHits, 1);
  assert.equal(ranked.coverage.folders.notIndexed, 1);
  assert.equal(ranked.coverage.complete, false);

  // Through the act lane: words grouped by folder, and a receipt without a Connected Folder.
  const token = "act-token-for-recall-tests-0123456789";
  const records: Array<Record<string, unknown>> = [];
  const receipts = {
    append: (record: Record<string, unknown>) => { records.push(record); return Promise.resolve(true); },
    hasAccepted: () => Promise.resolve(false),
    lookup: () => Promise.resolve({ accepted: null, settled: null, rejected: null, journalSince: null }),
  };
  const run = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd: base, actToken: token }),
    { version: "0.0.0", getActFacade: () => ({ facade, token }), receipts },
  );
  // The first everywhere search asked Archive to index, so by now it may answer too.
  const human = await run(["search", "--everywhere", "--ranked", "--query", "henderson"]);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`^Best matches for "henderson" across 3 Connected Folders \\(scope all\\):\\n${clients.name} \\[${clients.id}\\] — Client contracts and renewals\\n  - henderson\\.md:1 — `));
  assert.match(human.stdout, /Left out 1 managed working copy\./);
  const ok = records.filter((record) => record.outcome === "ok").at(-1)!;
  assert.equal(ok.connectedFolderId, undefined);
  assert.equal(ok.detail, "scope all; everywhere");
  const json = await run(["search", "--everywhere", "--ranked", "--query", "banana bread", "--scope", "files", "--json"]);
  const parsed = JSON.parse(json.stdout) as { data: { ranked: RecallAcrossResult } };
  assert.equal(parsed.data.ranked.groups[0]?.connectedFolder.id, kitchen.id);
  const refused = await run(["search", "--everywhere", "--query", "banana"]);
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, /--everywhere needs --ranked/);
  const both = await run(["search", "--everywhere", "--ranked", "--connected-folder", clients.id, "--query", "banana"]);
  assert.match(both.stderr, /leave out --connected-folder/);
});

test("the AmpleFile Agent is taught to find the Worker with everywhere search, then hand the work there", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "amplefile-recall-agent-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  configureAmpleFileStateRoot(join(base, "state"));
  await ensureAmpleFileAgentInstructions();
  const text = await readFile(join(ampleFileAgentRoot(), "AGENTS.md"), "utf8");
  assert.match(text, /amplefile search --everywhere --ranked --query "<text>"[^\n]*find which Worker knows about something/);
  assert.match(text, /read the original \(or ask that Worker\) before relying on or quoting anything/);
  assert.match(text, /`ranked\.notIndexed` and `ranked\.coverage` as what was not searched yet, never as empty/);
  assert.match(text, /hand the work to the Worker that holds it/);
});
