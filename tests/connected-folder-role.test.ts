import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyConnectedFolderRoleInput,
  connectedFolderRoleLimits,
  describeConnectedFolderRole,
  parseConnectedFolderRoleFile,
} from "../src/shared/connected-folder-role.js";
import {
  ConnectedFolderRoleError,
  clearConnectedFolderRole,
  connectedFolderRoleFile,
  readConnectedFolderRole,
  writeConnectedFolderRole,
} from "../src/local/connected-folder-role.js";
import { startLocalApi } from "../src/local/server.js";
import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";
import { buildConnectedFolderTurnContext } from "../src/local/agent/connected-folder-turn-context.js";

/**
 * A Role says what a Connected Folder is for (docs/product-model.md, "Role"):
 * the portable `.amplefile/role.json`, its bounded atomic store, the receipted
 * verbs and the window's routes over the same change path, and what a turn is
 * told. A read never writes.
 */

const at = "2026-11-27T10:00:00.000Z";

test("a Role file reads bounded and tolerant: malformed, newer, and empty read as no Role", () => {
  assert.deepEqual(parseConnectedFolderRoleFile("{not json"), { kind: "malformed" });
  assert.deepEqual(parseConnectedFolderRoleFile("[]"), { kind: "malformed" });
  assert.deepEqual(parseConnectedFolderRoleFile(JSON.stringify({ purpose: "no version" })), { kind: "malformed" });
  assert.deepEqual(parseConnectedFolderRoleFile(JSON.stringify({ version: 1, purpose: 7 })), { kind: "malformed" });
  assert.deepEqual(parseConnectedFolderRoleFile(JSON.stringify({ version: 1, askFor: "a" })), { kind: "malformed" });
  assert.deepEqual(parseConnectedFolderRoleFile(JSON.stringify({ version: 2, purpose: "future" })), { kind: "newer-version" });
  assert.deepEqual(parseConnectedFolderRoleFile(JSON.stringify({ version: 1 })), { kind: "empty" });
  assert.deepEqual(parseConnectedFolderRoleFile(JSON.stringify({ version: 1, purpose: "  ", askFor: [""] })), { kind: "empty" });

  const parsed = parseConnectedFolderRoleFile(JSON.stringify({
    version: 1,
    purpose: `Household\npaperwork ${"x".repeat(400)}`,
    askFor: Array.from({ length: 12 }, (_, index) => `question ${index}`),
    produces: ["summary", "summary", "  tax\nlist  "],
    updatedAt: at,
  }));
  assert.equal(parsed.kind, "role");
  if (parsed.kind !== "role") return;
  assert.equal(parsed.role.purpose!.length, connectedFolderRoleLimits.purpose, "an overlong hand-edited purpose is cut to the bound");
  assert.match(parsed.role.purpose!, /^Household paperwork x+$/, "one line");
  assert.equal(parsed.role.askFor!.length, connectedFolderRoleLimits.listEntries);
  assert.deepEqual(parsed.role.produces, ["summary", "tax list"]);
  assert.equal(parsed.role.accepts, undefined);
});

test("a change names its bounds instead of cutting, replaces only the fields it gives, and clears with an empty value", () => {
  const role = applyConnectedFolderRoleInput(null, { purpose: "Keeps  the\nbooks", askFor: ["invoices", "invoices", "VAT"] }, at)!;
  assert.deepEqual(role, { version: 1, purpose: "Keeps the books", askFor: ["invoices", "VAT"], updatedAt: at });
  const next = applyConnectedFolderRoleInput(role, { produces: ["monthly summary"] }, at)!;
  assert.equal(next.purpose, "Keeps the books", "an omitted field stays");
  assert.deepEqual(next.produces, ["monthly summary"]);
  const cleared = applyConnectedFolderRoleInput(next, { askFor: [], produces: [] }, at)!;
  assert.deepEqual(cleared, { version: 1, purpose: "Keeps the books", updatedAt: at });
  assert.equal(applyConnectedFolderRoleInput(cleared, { purpose: "" }, at), null, "an empty Role is the same as none");

  assert.throws(() => applyConnectedFolderRoleInput(null, { purpose: "x".repeat(281) }, at), /280 characters/);
  assert.throws(() => applyConnectedFolderRoleInput(null, { accepts: ["y".repeat(141)] }, at), /140 characters/);
  assert.throws(() => applyConnectedFolderRoleInput(null, { produces: Array.from({ length: 9 }, (_, index) => `item ${index}`) }, at), /at most 8 entries/);
  assert.equal(applyConnectedFolderRoleInput(null, { purpose: "x".repeat(280) }, at)!.purpose!.length, 280, "the bound itself is allowed");
});

test("the Role store writes .amplefile/role.json atomically, reports the previous Role, and a read never writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-role-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = connectedFolderRoleFile(root);
  assert.equal(file, join(root, ".amplefile", "role.json"));
  assert.equal(await readConnectedFolderRole(root), null);
  assert.deepEqual(await readdir(root), [], "reading a folder with no Role creates nothing");

  const first = await writeConnectedFolderRole(root, { purpose: "Tax records", accepts: ["receipts"] }, { now: () => new Date(at) });
  assert.equal(first.changed, true);
  assert.equal(first.previousRole, null);
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(onDisk, { version: 1, purpose: "Tax records", accepts: ["receipts"], updatedAt: at });
  assert.deepEqual(await readdir(join(root, ".amplefile")), ["role.json"], "no temporary file is left behind");
  assert.deepEqual(await readConnectedFolderRole(root), onDisk);

  const same = await writeConnectedFolderRole(root, { purpose: "Tax records" }, { now: () => new Date("2027-01-01T00:00:00Z") });
  assert.equal(same.changed, false, "a change that leaves the Role as it was writes nothing");
  assert.equal(JSON.parse(await readFile(file, "utf8")).updatedAt, at);

  const second = await writeConnectedFolderRole(root, { produces: ["a yearly pack"] });
  assert.equal(second.previousRole?.purpose, "Tax records", "the previous Role comes back so it can be put back");
  assert.deepEqual(second.role?.produces, ["a yearly pack"]);
  assert.deepEqual(second.role?.accepts, ["receipts"]);

  await assert.rejects(writeConnectedFolderRole(root, { purpose: "z".repeat(300) }), (error) => error instanceof ConnectedFolderRoleError && error.code === "invalid");
  assert.equal((await readConnectedFolderRole(root))?.purpose, "Tax records", "a refused change leaves the file alone");

  const cleared = await clearConnectedFolderRole(root);
  assert.equal(cleared.changed, true);
  assert.equal(cleared.previousRole?.purpose, "Tax records");
  assert.equal(await readConnectedFolderRole(root), null);
  assert.equal((await clearConnectedFolderRole(root)).changed, false);

  // Emptying a Role through a change removes the file too.
  await writeConnectedFolderRole(root, { purpose: "Temporary" });
  const emptied = await writeConnectedFolderRole(root, { purpose: "" });
  assert.equal(emptied.role, null);
  assert.deepEqual(await readdir(join(root, ".amplefile")), []);
});

test("a malformed file is never overwritten by a read, a newer one is never overwritten at all, and a link is never followed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-role-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = connectedFolderRoleFile(root);
  await mkdir(join(root, ".amplefile"));

  await writeFile(file, "{ half written", "utf8");
  assert.equal(await readConnectedFolderRole(root), null);
  assert.equal(await readFile(file, "utf8"), "{ half written", "a read leaves a malformed file exactly as it was");
  const repaired = await writeConnectedFolderRole(root, { purpose: "Mended" });
  assert.equal(repaired.previousRole, null);
  assert.equal((await readConnectedFolderRole(root))?.purpose, "Mended", "a deliberate change replaces a malformed file");

  const future = JSON.stringify({ version: 3, purpose: "Written by tomorrow's AmpleFile", extra: { kept: true } });
  await writeFile(file, future, "utf8");
  assert.equal(await readConnectedFolderRole(root), null, "a newer-version file reads as no Role");
  await assert.rejects(writeConnectedFolderRole(root, { purpose: "Today" }), (error) => error instanceof ConnectedFolderRoleError && error.code === "newer-version");
  await assert.rejects(clearConnectedFolderRole(root), (error) => error instanceof ConnectedFolderRoleError && error.code === "newer-version");
  assert.equal(await readFile(file, "utf8"), future, "neither a read nor a refused change touches it");

  const elsewhere = join(root, "elsewhere.json");
  await writeFile(elsewhere, JSON.stringify({ version: 1, purpose: "Through a link" }), "utf8");
  await rm(file);
  await symlink(elsewhere, file);
  assert.equal(await readConnectedFolderRole(root), null, "a symbolic link is not read through");
  await assert.rejects(writeConnectedFolderRole(root, { purpose: "No" }), (error) => error instanceof ConnectedFolderRoleError && error.code === "unavailable");
  assert.equal(JSON.parse(await readFile(elsewhere, "utf8")).purpose, "Through a link");

  await rm(file);
  await writeFile(file, JSON.stringify({ version: 1, purpose: "p", padding: "x".repeat(connectedFolderRoleLimits.fileBytes) }), "utf8");
  assert.equal(await readConnectedFolderRole(root), null, "an oversized file is not ours to read");

  const missing = join(root, "gone");
  await assert.rejects(writeConnectedFolderRole(missing, { purpose: "Nowhere" }), (error) => error instanceof ConnectedFolderRoleError && error.code === "unavailable");
  assert.deepEqual((await readdir(root)).includes("gone"), false, "a missing folder is never created to hold a Role");
});

test("the verbs and the window's routes share one change path, and a parent's turn lists its nested folders' roles", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-role-api-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  // A Pi extension command answers turns without a model call.
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "noop.ts"), `export default function (pi) {
    pi.registerCommand("noop", { description: "Answer without a model", handler: async () => {} });
  }\n`, "utf8");
  const events: Array<{ connectedFolderId: string; connectedFolderTurn?: { nestedFolders?: Array<{ connectedFolderId: string; name: string; path: string; role?: unknown }> } }> = [];
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    async beforeAgentPrompt(event) { events.push(event as never); },
  });
  t.after(() => api.close());

  const { connectedFolder: parent } = await api.actFacade.createConnectedFolder({ name: "Book" });
  await mkdir(join(parent.connectedFolderRoot, "chapters", "one"), { recursive: true });
  const nestedResponse = await fetch(`${api.origin}/api/connected-folders/${parent.id}/nested-folders`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "chapters/one" }),
  });
  assert.equal(nestedResponse.status, 201);
  const nested = ((await nestedResponse.json()) as { connectedFolder: { id: string; connectedFolderRoot: string } }).connectedFolder;

  // The act verb writes the portable file and reports the previous Role.
  const shown = await api.actFacade.connectedFoldersRoleShow({ connectedFolder: nested.id });
  assert.equal(shown.role, null);
  const set = await api.actFacade.connectedFoldersRoleSet({
    connectedFolder: nested.id,
    purpose: "Chapter one: drafting and revising",
    askFor: ["a revised draft", "a continuity check"],
    produces: ["chapter text"],
  });
  assert.equal(set.changed, true);
  assert.equal(set.previousRole, null);
  assert.equal(set.role?.purpose, "Chapter one: drafting and revising");
  const stored = JSON.parse(await readFile(join(nested.connectedFolderRoot, ".amplefile", "role.json"), "utf8"));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.askFor, ["a revised draft", "a continuity check"]);
  assert.equal(JSON.parse(await readFile(join(nested.connectedFolderRoot, ".amplefile", "connected-folder.json"), "utf8")).version, 1, "the identity manifest is untouched");

  const replaced = await api.actFacade.connectedFoldersRoleSet({ connectedFolder: nested.id, purpose: "Chapter one: drafting" });
  assert.equal(replaced.previousRole?.purpose, "Chapter one: drafting and revising", "the receipt's previous Role is what a person puts back");
  assert.deepEqual(replaced.role?.askFor, ["a revised draft", "a continuity check"], "a field not given stays");
  await assert.rejects(api.actFacade.connectedFoldersRoleSet({ connectedFolder: nested.id, purpose: "x".repeat(400) }), /280 characters/);

  // The window's routes read and save the same file.
  const route = `${api.origin}/api/connected-folders/${nested.id}/role`;
  assert.equal(((await (await fetch(route)).json()) as { role: { purpose: string } }).role.purpose, "Chapter one: drafting");
  const saved = await fetch(route, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ accepts: ["notes"] }) });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as { role: { purpose: string; accepts: string[] }; previousRole: { accepts?: string[] }; changed: boolean };
  assert.equal(savedBody.role.purpose, "Chapter one: drafting");
  assert.deepEqual(savedBody.role.accepts, ["notes"]);
  assert.equal(savedBody.previousRole.accepts, undefined);
  const refused = await fetch(route, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "x".repeat(400) }) });
  assert.equal(refused.status, 400);
  assert.equal((await fetch(route, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ surprise: 1 }) })).status, 400);
  assert.equal((await fetch(`${api.origin}/api/connected-folders/space-0000000000000000/role`)).status, 404);

  // The AmpleFile Agent's snapshot and `connected-folders list` carry the purpose, additively.
  const listed = (await api.kernel.getConnectedFolders({ kind: "cli" }, { includeRolePurpose: true })).connectedFolders;
  assert.equal(listed.find((item) => item.id === nested.id)?.rolePurpose, "Chapter one: drafting");
  assert.equal("rolePurpose" in listed.find((item) => item.id === parent.id)!, false, "a folder with no Role carries no field");
  const plain = (await api.kernel.getConnectedFolders({ kind: "cli" })).connectedFolders;
  assert.equal(plain.some((item) => "rolePurpose" in item), false, "other readers of the registry are unchanged");

  // The @ menus read the registry-only outline, which carries the purpose the same additive way.
  const outline = ((await (await fetch(`${api.origin}/api/connected-folders/outline`)).json()) as { connectedFolders: Array<{ id: string; rolePurpose?: string }> }).connectedFolders;
  assert.equal(outline.find((item) => item.id === nested.id)?.rolePurpose, "Chapter one: drafting");
  assert.equal("rolePurpose" in outline.find((item) => item.id === parent.id)!, false, "a folder with no Role carries no field");

  // The turn context a parent's Worker gets lists each nested folder with its Role.
  const sent = await api.actFacade.sendMessage({ connectedFolder: parent.id, newConversation: true, content: "/noop" });
  const waitFor = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await waitFor(() => events.some((event) => event.connectedFolderId === parent.id), "the parent's turn");
  // Let the turn finish before the sandbox is removed under it.
  await waitFor(() => ["done", "partial", "failed", "stopped"].includes(api.requests.byTaskId(sent.taskId)?.state ?? ""), "the parent's turn to settle");
  const nestedEntry = events.find((event) => event.connectedFolderId === parent.id)!.connectedFolderTurn!.nestedFolders!;
  assert.equal(nestedEntry.length, 1);
  assert.deepEqual(nestedEntry[0], {
    connectedFolderId: nested.id,
    name: nestedEntry[0]!.name,
    path: "chapters/one",
    role: { purpose: "Chapter one: drafting", askFor: ["a revised draft", "a continuity check"], produces: ["chapter text"], accepts: ["notes"] },
  });

  // Clearing removes the file, and the next turn's entry carries no role.
  const clearedResult = await api.actFacade.connectedFoldersRoleClear({ connectedFolder: nested.id });
  assert.equal(clearedResult.previousRole?.purpose, "Chapter one: drafting");
  assert.equal(clearedResult.changed, true);
  assert.deepEqual((await readdir(join(nested.connectedFolderRoot, ".amplefile"))).includes("role.json"), false);
});

test("a turn context renders a nested folder's Role and a describe block never reads as JSON", () => {
  const turn = buildConnectedFolderTurnContext({ connectedFolderId: "connected-folder-1", taskId: "task-1", requestId: "req-1", handleSalt: "salt" });
  turn.nestedFolders = [
    { connectedFolderId: "connected-folder-2", name: "Receipts", path: "receipts", role: { purpose: "Sorts receipts", askFor: ["a monthly total"] } },
    { connectedFolderId: "connected-folder-3", name: "Misc", path: "misc" },
  ];
  const rendered = buildTurnContextMessage({ connectedFolderTurn: turn });
  assert.match(rendered, /"purpose": "Sorts receipts"/);
  assert.match(rendered, /"askFor": \[\s+"a monthly total"\s+\]/);
  assert.match(rendered, /route work by it/);
  const misc = rendered.slice(rendered.indexOf('"connectedFolderId": "connected-folder-3"'));
  assert.doesNotMatch(misc.slice(0, misc.indexOf("}")), /role/, "a folder with no Role carries no role");
  assert.equal(
    describeConnectedFolderRole({ version: 1, purpose: "Tax records", askFor: ["totals"], produces: ["packs"], accepts: ["receipts"], updatedAt: at }),
    "Purpose: Tax records\nAsk it for: totals\nIt produces: packs\nIt accepts: receipts",
  );
});
