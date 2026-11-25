import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CapabilityRegistryService } from "../src/local/agent/capability-registry.js";
import {
  RegisteredConnectedFolderRuntimeProvider,
  RegisteredConnectedFolderTrustAuthority,
} from "../src/local/agent/registered-connected-folder-runtime.js";
import { AmpleFileKernel } from "../src/local/amplefile-kernel.js";
import { AmpleFileCliError } from "../src/local/cli/protocol.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * A Skill bundle installs from the window (Add → Skill files, Discover →
 * install) and from the act lane (`tools import-skill`, `tools install --id`)
 * through one import (src/local/agent/skill-import.ts). The window installs
 * the bytes it read in that same request. The act lane reads the bytes once
 * to name them in the receipt and again when the act takes effect, so it
 * installs only bytes whose digest matches what it named, and otherwise
 * refuses and installs nothing.
 */

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} for tests\n---\n${body}\n`;

interface Harness {
  api: LocalApiHandle;
  sandbox: string;
  agentDir: string;
  connectedFolder: { id: string; connectedFolderRoot: string };
  /** What the catalog's bundle holds the next time it is built. */
  catalogBundle: { text: string; builds: number };
  /** Runs once, just before a Connected Folder–scoped act re-reads what it pinned. */
  beforeEffect: { run: (() => Promise<void>) | null };
}

async function harness(t: test.TestContext): Promise<Harness> {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-skill-bundle-import-"));
  const agentDir = join(sandbox, "agent");
  const catalogBundle = { text: skill("catalog-helper", "Version one."), builds: 0 };
  const beforeEffect: Harness["beforeEffect"] = { run: null };
  const bundleItem = {
    id: "test:catalog-helper",
    name: "Catalog helper",
    description: "A catalog Skill bundle",
    types: ["skill" as const],
    sourceKind: "bundle" as const,
    official: true,
    skills: ["catalog-helper"],
  };
  const capabilityRegistry: CapabilityRegistryService = {
    async search() { return { items: [bundleItem], total: 1, offset: 0, limit: 24, truncated: false, diagnostics: [] }; },
    async details(id) {
      if (id !== bundleItem.id) throw new Error(`Unknown capability: ${id}`);
      return { ...bundleItem, extensions: [], prompts: [], themes: [] };
    },
    async buildOfficialSkillBundle(id) {
      assert.equal(id, bundleItem.id);
      catalogBundle.builds += 1;
      return { fileName: "SKILL.md", bytes: new TextEncoder().encode(catalogBundle.text), item: bundleItem };
    },
  };
  const piRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
  const connectedFolderTrustAuthority = new RegisteredConnectedFolderTrustAuthority();
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    capabilityRegistry,
    kernel: new AmpleFileKernel({ runtimeProvider: new RegisteredConnectedFolderRuntimeProvider(piRuntimeProvider, connectedFolderTrustAuthority) }),
    piRuntimeProvider,
    connectedFolderTrustAuthority,
    async beforeConnectedFolderMutationRevalidation() {
      const run = beforeEffect.run;
      beforeEffect.run = null;
      await run?.();
    },
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const created = await api.actFacade.createConnectedFolder({ name: "Skill desk" });
  return { api, sandbox, agentDir, connectedFolder: created.connectedFolder, catalogBundle, beforeEffect };
}

test("the window installs the Skill bytes it was sent, and a Discover install the bundle it built for that install", async (t) => {
  const h = await harness(t);
  const uploaded = skill("uploaded-helper", "Exactly these words.");
  const form = new FormData();
  form.set("connectedFolderId", h.connectedFolder.id);
  form.set("scope", "project");
  form.append("files", new Blob([uploaded]), "SKILL.md");
  const response = await fetch(`${h.api.origin}/api/agent/skills/import`, { method: "POST", body: form });
  assert.equal(response.status, 201, await response.clone().text());
  const { imported } = await response.json() as { imported: Array<{ scope: string; bundlePath: string; skills: Array<{ name: string }> }> };
  assert.equal(imported.length, 1);
  assert.equal(imported[0]!.scope, "project");
  assert.deepEqual(imported[0]!.skills.map((item) => item.name), ["uploaded-helper"]);
  assert.equal(await readFile(join(h.connectedFolder.connectedFolderRoot, ".pi", "skills", "uploaded-helper", "SKILL.md"), "utf8"), uploaded);

  // The details dialog is read first; the install builds the bundle once and installs those bytes.
  const details = await fetch(`${h.api.origin}/api/agent/capabilities/details?id=test%3Acatalog-helper`);
  assert.equal(details.status, 200);
  assert.equal(h.catalogBundle.builds, 0, "showing the details builds nothing");
  h.catalogBundle.text = skill("catalog-helper", "Version two.");
  const installed = await fetch(`${h.api.origin}/api/agent/capabilities/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectedFolderId: h.connectedFolder.id, id: "test:catalog-helper", scope: "global" }),
  });
  assert.equal(installed.status, 201, await installed.clone().text());
  assert.equal((await installed.json() as { installed: { kind: string } }).installed.kind, "skill");
  assert.equal(h.catalogBundle.builds, 1, "one build per install");
  assert.equal(await readFile(join(h.agentDir, "skills", "catalog-helper", "SKILL.md"), "utf8"), h.catalogBundle.text);
});

test("the act lane installs a Skill file only while it still holds the bytes it named", async (t) => {
  const h = await harness(t);
  const path = join(h.sandbox, "SKILL.md");
  const named = skill("desk-helper", "As named.");
  await writeFile(path, named, "utf8");
  const installedPath = join(h.connectedFolder.connectedFolderRoot, ".pi", "skills", "desk-helper", "SKILL.md");

  // The file changes after the act named its digest and before it takes effect.
  h.beforeEffect.run = () => writeFile(path, skill("desk-helper", "Swapped in."), "utf8");
  await assert.rejects(
    () => h.api.actFacade.toolsImportSkill({ scope: "connected-folder", connectedFolder: h.connectedFolder.id, from: path, cwd: h.sandbox, requestId: "req-import-changed" }),
    (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /no longer matches/.test(error.message),
  );
  assert.equal(existsSync(installedPath), false, "a refused import installs nothing");

  // Unchanged, the same file installs, byte for byte.
  await writeFile(path, named, "utf8");
  const imported = await h.api.actFacade.toolsImportSkill({ scope: "connected-folder", connectedFolder: h.connectedFolder.id, from: path, cwd: h.sandbox, requestId: "req-import-same" });
  assert.deepEqual(imported.skillNames, ["desk-helper"]);
  assert.equal(await readFile(installedPath, "utf8"), named);
});

test("the act lane installs a catalog Skill only while its rebuilt bundle matches the one it named", async (t) => {
  const h = await harness(t);
  const installedPath = join(h.connectedFolder.connectedFolderRoot, ".pi", "skills", "catalog-helper", "SKILL.md");

  // The catalog's bundle changes between the build the act names and the one it installs.
  h.beforeEffect.run = async () => { h.catalogBundle.text = skill("catalog-helper", "Changed upstream."); };
  await assert.rejects(
    () => h.api.actFacade.toolsInstall({ scope: "connected-folder", connectedFolder: h.connectedFolder.id, catalogId: "test:catalog-helper", requestId: "req-install-changed" }),
    (error: unknown) => error instanceof AmpleFileCliError && error.code === "conflict" && /no longer matches/.test(error.message),
  );
  assert.equal(existsSync(installedPath), false, "a refused install installs nothing");

  const installed = await h.api.actFacade.toolsInstall({ scope: "connected-folder", connectedFolder: h.connectedFolder.id, catalogId: "test:catalog-helper", requestId: "req-install-same" });
  assert.equal(installed.source, "test:catalog-helper");
  assert.equal(await readFile(installedPath, "utf8"), h.catalogBundle.text);
});
