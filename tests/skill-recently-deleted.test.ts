import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RegisteredConnectedFolderRuntimeProvider,
  RegisteredConnectedFolderTrustAuthority,
} from "../src/local/agent/registered-connected-folder-runtime.js";
import { createAmpleFileCliActRequest, executeAmpleFileCliActRequest } from "../src/local/cli/index.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { AmpleFileKernel } from "../src/local/amplefile-kernel.js";

/**
 * Removing an imported Skill is reversible (docs/act-ledger.md):
 * `.pi/` and Pi's own folder are outside History, so the whole Skill folder
 * goes to Recently deleted with its scope, and restoring puts it back where it
 * was so it loads again — from the desktop's Undo and from the act lane alike.
 */
async function skillHarness(t: test.TestContext): Promise<{
  api: LocalApiHandle;
  agentDir: string;
  connectedFolder: { id: string; name: string; connectedFolderRoot: string };
  importSkill: (scope: "global" | "project", markdown: string) => Promise<void>;
  catalogSkills: () => Promise<Array<{ name: string; path: string; scope?: string }>>;
  removeSkill: (scope: "global" | "project", name: string) => Promise<{ entryId: string; path: string }>;
  execute: (argv: string[]) => ReturnType<typeof executeAmpleFileCliActRequest>;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-skill-recently-deleted-"));
  const agentDir = join(sandbox, "agent");
  const piRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  const connectedFolderTrustAuthority = new RegisteredConnectedFolderTrustAuthority();
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    kernel: new AmpleFileKernel({ runtimeProvider: new RegisteredConnectedFolderRuntimeProvider(piRuntimeProvider, connectedFolderTrustAuthority) }),
    piRuntimeProvider,
    connectedFolderTrustAuthority,
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const created = await api.actFacade.createConnectedFolder({ name: "Skill notes" });
  const connectedFolder = created.connectedFolder;
  const catalogSkills = async () => {
    const catalog = await json(`${api.origin}/api/connected-folders/${connectedFolder.id}/agent/catalog`) as { skills: Array<{ name: string; path: string; scope?: string }> };
    return catalog.skills;
  };
  const token = "a".repeat(64);
  return {
    api,
    agentDir,
    connectedFolder,
    catalogSkills,
    async importSkill(scope, markdown) {
      const form = new FormData();
      form.set("connectedFolderId", connectedFolder.id);
      form.set("scope", scope === "project" ? "project" : "user");
      form.append("files", new Blob([markdown]), "SKILL.md");
      const response = await fetch(`${api.origin}/api/agent/skills/import`, { method: "POST", body: form });
      assert.equal(response.status, 201, await response.text());
    },
    async removeSkill(scope, name) {
      const skill = (await catalogSkills()).find((item) => item.name === name);
      assert.ok(skill, `${name} should be installed before it is removed`);
      const removed = await json(`${api.origin}/api/agent/skills/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectedFolderId: connectedFolder.id, path: skill.path, scope }),
      }) as { removed: boolean; path: string; recentlyDeleted: { entryId: string; restoreBy: string } };
      assert.equal(removed.removed, true);
      assert.match(removed.recentlyDeleted.entryId, /^trash-\d{14}-[0-9a-f]{8}$/);
      return { entryId: removed.recentlyDeleted.entryId, path: removed.path };
    },
    execute: (argv) => executeAmpleFileCliActRequest(
      createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
      {
        version: "test",
        getActFacade: () => ({ facade: api.actFacade, token }),
        resolveLineageParent: (taskId) => api.resolveAmpleFileAgentLineageParent(taskId),
        receipts: { hasAccepted: async () => false, append: async () => true },
      },
    ),
  };
}

test("removing a Skill in either scope keeps it in Recently deleted, and restoring loads it again", async (t) => {
  const h = await skillHarness(t);
  await h.importSkill("global", "---\nname: writer\ndescription: Writes things\n---\nWrite clearly.\n");
  await h.importSkill("project", "---\nname: notes\ndescription: Keeps notes\n---\nKeep notes.\n");
  const everywherePath = join(h.agentDir, "skills", "writer");
  const localPath = join(h.connectedFolder.connectedFolderRoot, ".pi", "skills", "notes");
  assert.equal(existsSync(join(everywherePath, "SKILL.md")), true);
  assert.equal(existsSync(join(localPath, "SKILL.md")), true);

  const everywhere = await h.removeSkill("global", "writer");
  const local = await h.removeSkill("project", "notes");
  assert.equal(everywhere.path, everywherePath);
  assert.equal(local.path, localPath);
  assert.equal(existsSync(everywherePath), false);
  assert.equal(existsSync(localPath), false);
  assert.deepEqual((await h.catalogSkills()).filter((skill) => skill.name === "writer" || skill.name === "notes"), []);

  const listing = await json(`${h.api.origin}/api/settings/recently-deleted`) as {
    entries: Array<Record<string, unknown>>;
  };
  const byId = new Map(listing.entries.map((entry) => [entry.id, entry]));
  assert.deepEqual(pick(byId.get(everywhere.entryId)!), {
    kind: "skill",
    reason: "skills.remove",
    scope: "everywhere",
    connectedFolderId: "amplefile-agent",
    connectedFolderName: "Everywhere",
    originalPath: "writer",
    name: "writer",
    restorable: "in-place",
  });
  assert.deepEqual(pick(byId.get(local.entryId)!), {
    kind: "skill",
    reason: "skills.remove",
    scope: "connected-folder",
    connectedFolderId: h.connectedFolder.id,
    connectedFolderName: "Skill notes",
    originalPath: "notes",
    name: "notes",
    restorable: "in-place",
  });
  // The removal journals a receipt that the kept item names.
  assert.match(String(byId.get(everywhere.entryId)!.receiptId), /^settings:/);

  // The act lane lists the same items in its own words.
  const human = await h.execute(["recently-deleted", "list"]);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`${everywhere.entryId} — Skill "writer" from Everywhere`));
  assert.match(human.stdout, new RegExp(`${local.entryId} — Skill "notes" from Skill notes \\[${h.connectedFolder.id}\\]`));

  // The desktop's Undo uses the Settings restore route.
  const undone = await json(`${h.api.origin}/api/settings/recently-deleted/${everywhere.entryId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }) as { restored: Record<string, unknown> };
  assert.deepEqual(undone.restored, {
    kind: "skill", entryId: everywhere.entryId, scope: "everywhere", name: "writer", path: everywherePath,
  });
  assert.equal(await readFile(join(everywherePath, "SKILL.md"), "utf8"), "---\nname: writer\ndescription: Writes things\n---\nWrite clearly.\n");

  // The act lane restores the Connected Folder Skill.
  const restored = await h.execute(["recently-deleted", "restore", "--entry", local.entryId, "--json"]);
  assert.equal(restored.exitCode, 0, restored.stderr);
  const restoredJson = JSON.parse(restored.stdout) as { data: { restored: Record<string, unknown> } };
  assert.equal(restoredJson.data.restored.kind, "skill");
  assert.equal(restoredJson.data.restored.scope, "connected-folder");
  assert.equal(restoredJson.data.restored.path, localPath);
  assert.equal((restoredJson.data.restored.connectedFolder as { id: string }).id, h.connectedFolder.id);
  assert.equal(existsSync(join(localPath, "SKILL.md")), true);

  const loaded = await h.catalogSkills();
  assert.equal(loaded.some((skill) => skill.name === "writer" && skill.path === join(everywherePath, "SKILL.md")), true, "the Everywhere Skill loads again");
  assert.equal(loaded.some((skill) => skill.name === "notes" && skill.path === join(localPath, "SKILL.md")), true, "the Connected Folder Skill loads again");
  assert.deepEqual((await h.api.recentlyDeleted.list()).entries, []);
});

test("a Skill installed again under the same name blocks the restore, and the kept one stays", async (t) => {
  const h = await skillHarness(t);
  await h.importSkill("global", "---\nname: writer\ndescription: The first writer\n---\nFirst.\n");
  const removed = await h.removeSkill("global", "writer");
  await h.importSkill("global", "---\nname: writer\ndescription: The second writer\n---\nSecond.\n");

  const refused = await fetch(`${h.api.origin}/api/settings/recently-deleted/${removed.entryId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /A Skill named \\?"writer\\?" is already installed Everywhere/);
  const cli = await h.execute(["recently-deleted", "restore", "--entry", removed.entryId, "--json"]);
  assert.notEqual(cli.exitCode, 0);
  assert.equal((JSON.parse(cli.stderr) as { error: { code: string } }).error.code, "conflict");

  // The new Skill is untouched and the old one is still waiting.
  assert.match(await readFile(join(h.agentDir, "skills", "writer", "SKILL.md"), "utf8"), /The second writer/);
  assert.equal((await h.api.recentlyDeleted.get(removed.entryId))?.kind, "skill");

  // Once the new one is removed too, the first one comes back.
  const second = await h.removeSkill("global", "writer");
  const back = await json(`${h.api.origin}/api/settings/recently-deleted/${removed.entryId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }) as { restored: { path: string } };
  assert.match(await readFile(join(back.restored.path, "SKILL.md"), "utf8"), /The first writer/);
  assert.equal((await h.api.recentlyDeleted.get(second.entryId))?.kind, "skill", "the second removal is kept as well");
});

function pick(entry: Record<string, unknown>): Record<string, unknown> {
  const { kind, reason, scope, connectedFolderId, connectedFolderName, originalPath, name, restorable } = entry;
  return { kind, reason, scope, connectedFolderId, connectedFolderName, originalPath, name, restorable };
}

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, `${response.status} ${text}`);
  return JSON.parse(text) as unknown;
}
