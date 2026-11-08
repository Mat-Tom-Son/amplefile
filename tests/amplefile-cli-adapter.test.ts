import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { PiResourceCatalog } from "../src/local/agent/skill-catalog.js";
import {
  AmpleFileCliError,
  AmpleFileCliExitCode,
} from "../src/local/cli/protocol.js";
import { AmpleFileCliKernelAdapter } from "../src/local/amplefile-cli-adapter.js";
import { AmpleFileKernel } from "../src/local/amplefile-kernel.js";
import type { ConnectedFolderSummary } from "../src/local/connected-folder.js";

test("AmpleFileCliKernelAdapter resolves --connected-folder by exact id before case-insensitive name", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter", "beta");
  const alphaId = "space-aaaaaaaaaaaaaaaa";
  const betaId = "space-bbbbbbbbbbbbbbbb";
  const connectedFolders = [
    connectedFolder(alphaId, "Primary", alphaRoot),
    connectedFolder(betaId, alphaId.toUpperCase(), betaRoot),
  ];
  const adapter = new AmpleFileCliKernelAdapter(new AmpleFileKernel(connectedFolderDependencies(connectedFolders)));
  const actor = { kind: "cli" as const, cwd: join(betaRoot, "documents") };

  const byId = await adapter.getContext(actor, { connectedFolder: ` ${alphaId} ` });
  assert.equal(byId.connectedFolder?.id, alphaId, "an exact id must win over another Connected Folder's matching name");

  const byName = await adapter.getContext(actor, { connectedFolder: "primary" });
  assert.equal(byName.connectedFolder?.id, alphaId);

  const inferred = await adapter.listConnectedFolders(actor, {});
  assert.deepEqual(inferred.map(({ id, active }) => ({ id, active })), [
    { id: alphaId, active: false },
    { id: betaId, active: true },
  ]);

  const selected = await adapter.listConnectedFolders(actor, { connectedFolder: "PRIMARY" });
  assert.deepEqual(selected.map(({ id, active }) => ({ id, active })), [{ id: alphaId, active: true }]);
});

test("AmpleFileCliKernelAdapter reports missing and ambiguous Connected Folder selectors as CLI errors", async () => {
  const root = join(process.cwd(), "cli-adapter-errors");
  const connectedFolders = [
    connectedFolder("space-1111111111111111", "Shared", join(root, "one")),
    connectedFolder("space-2222222222222222", "SHARED", join(root, "two")),
  ];
  const adapter = new AmpleFileCliKernelAdapter(new AmpleFileKernel(connectedFolderDependencies(connectedFolders)));
  const actor = { kind: "cli" as const, cwd: root };

  await assert.rejects(
    adapter.getContext(actor, { connectedFolder: "shared" }),
    (error: unknown) => error instanceof AmpleFileCliError
      && error.code === "conflict"
      && error.exitCode === AmpleFileCliExitCode.conflict
      && /ambiguous/i.test(error.message),
  );
  await assert.rejects(
    adapter.listTasks(actor, { connectedFolder: "missing" }),
    (error: unknown) => error instanceof AmpleFileCliError
      && error.code === "notFound"
      && error.exitCode === AmpleFileCliExitCode.notFound
      && /not found/i.test(error.message),
  );
});

test("AmpleFileCliKernelAdapter flattens scoped kernel tasks", async () => {
  const alphaRoot = join(process.cwd(), "cli-adapter-tasks", "alpha");
  const betaRoot = join(process.cwd(), "cli-adapter-tasks", "beta");
  const alphaId = "space-3333333333333333";
  const betaId = "space-4444444444444444";
  const connectedFolders = [
    connectedFolder(alphaId, "Alpha", alphaRoot),
    connectedFolder(betaId, "Beta", betaRoot),
  ];
  const timestamps = [new Date("2026-07-11T12:00:00.000Z"), new Date("2026-07-11T12:01:00.000Z")];
  const kernel = new AmpleFileKernel({
    ...connectedFolderDependencies(connectedFolders),
    now: () => timestamps.shift() ?? new Date("2026-07-11T12:02:00.000Z"),
  });
  kernel.startTask({ id: "turn-alpha", kind: "assistant_turn", connectedFolderId: alphaId, actor: { kind: "assistant" } });
  kernel.startTask({ id: "compact-beta", kind: "compaction", connectedFolderId: betaId, actor: { kind: "assistant" } });
  const adapter = new AmpleFileCliKernelAdapter(kernel);

  const tasks = await adapter.listTasks(
    { kind: "cli", cwd: join(alphaRoot, "documents") },
    { connectedFolder: "beta" },
  );
  assert.deepEqual(tasks, [{
    id: "compact-beta",
    label: "Chat compaction",
    status: "running",
    connectedFolderId: betaId,
    updatedAt: "2026-07-11T12:01:00.000Z",
  }]);
});

test("AmpleFileCliKernelAdapter flattens every capability kind without exposing Skill contents", async () => {
  const root = join(process.cwd(), "cli-adapter-capabilities");
  const connectedFolderSummary = connectedFolder("space-5555555555555555", "Capabilities", root);
  const projectPackage = "npm:@demo/project-kit@1.0.0";
  const catalog: PiResourceCatalog = {
    projectTrust: { required: true, trusted: true, savedDecision: true },
    packages: [],
    toolManagement: {
      mode: "session-only",
      persisted: false,
      mutable: false,
      scope: "chat",
      reason: "Tools belong to the Chat.",
    },
    skills: [{
      name: "project-research",
      description: "Research a project",
      path: join(root, ".pi", "skills", "research", "SKILL.md"),
      baseDir: root,
      disableModelInvocation: false,
      content: "TOP SECRET SKILL CONTENT",
      source: source("skills/research/SKILL.md", projectPackage, "project", "package", root),
    }],
    extensions: [{
      path: "extensions/review.ts",
      resolvedPath: join(root, ".pi", "extensions", "review.ts"),
      source: source("extensions/review.ts", "auto", "user", "top-level"),
      tools: ["review"],
      commands: [],
      flags: [],
    }],
    surfaces: [{
      id: "private-dashboard",
      title: "Private dashboard",
      extensionPath: join(root, ".pi", "extensions", "review.ts"),
      manifestPath: join(root, ".pi", "extensions", "surface.json"),
      source: source("extensions/review.ts", "auto", "user", "top-level"),
      views: [{
        id: "overview",
        title: "Overview",
        blocks: [{ type: "text", text: "PRIVATE SURFACE CONTENT" }],
      }],
    }],
    tools: [{
      name: "read",
      label: "Read",
      description: "Read a file",
      active: true,
      kind: "core",
      core: true,
      configurable: false,
      configurationScope: "chat",
      source: source("builtin:read", "builtin", "user", "top-level"),
    }],
    prompts: [{
      name: "handoff",
      description: "Prepare a handoff",
      path: join(root, ".pi", "prompts", "handoff.md"),
      source: source("prompts/handoff.md", "auto", "project", "top-level", root),
    }],
    themes: [{
      name: "Kai Dark",
      path: join(root, ".pi", "themes", "kai-dark.json"),
      source: source("themes/kai-dark.json", "auto", "temporary", "top-level"),
    }],
    contextFiles: [],
    commands: [{
      name: "trust",
      description: "Show trust",
      source: "builtin",
    }],
    diagnostics: [],
  };
  const kernel = new AmpleFileKernel({
    ...connectedFolderDependencies([connectedFolderSummary]),
    async loadCapabilityCatalog() { return catalog; },
    async listPackages() {
      return [{
        source: projectPackage,
        scope: "project" as const,
        filtered: false,
        installedPath: join(root, ".pi", "npm", "project-kit"),
      }];
    },
    async isProjectMutationTrusted() { return true; },
  });
  const adapter = new AmpleFileCliKernelAdapter(kernel);

  const capabilities = await adapter.listCapabilities(
    { kind: "cli", cwd: join(process.cwd(), "outside-capability-connected-folder") },
    { connectedFolder: "capabilities" },
  );
  assert.deepEqual(new Set(capabilities.map((item) => item.kind)), new Set([
    "skill",
    "extension",
    "tool",
    "package",
    "other",
  ]));
  assert.deepEqual(
    capabilities.filter((item) => item.kind === "other").map((item) => item.id.split(":", 1)[0]).sort(),
    ["command", "prompt", "theme"],
  );
  assert.equal(capabilities.find((item) => item.kind === "skill")?.scope, "connected-folder");
  assert.equal(capabilities.find((item) => item.kind === "extension")?.scope, "everywhere");
  assert.equal(capabilities.find((item) => item.id.startsWith("theme:"))?.scope, "temporary");
  assert.equal(JSON.stringify(capabilities).includes("TOP SECRET SKILL CONTENT"), false);
  assert.equal(JSON.stringify(capabilities).includes("PRIVATE SURFACE CONTENT"), false);
  assert.equal(Object.hasOwn(capabilities.find((item) => item.kind === "skill") ?? {}, "content"), false);
});

test("AmpleFileCliKernelAdapter maps missing cwd capability context to notFound", async () => {
  const root = join(process.cwd(), "cli-adapter-context-required");
  const adapter = new AmpleFileCliKernelAdapter(new AmpleFileKernel(connectedFolderDependencies([
    connectedFolder("space-6666666666666666", "Only", root),
  ])));

  await assert.rejects(
    adapter.listCapabilities({ kind: "cli", cwd: join(process.cwd(), "outside-all-connected-folders") }, {}),
    (error: unknown) => error instanceof AmpleFileCliError
      && error.code === "notFound"
      && error.exitCode === AmpleFileCliExitCode.notFound
      && /--connected-folder/.test(error.message),
  );
});

function connectedFolderDependencies(connectedFolders: ConnectedFolderSummary[]) {
  return {
    async listConnectedFolders() { return connectedFolders; },
    async getConnectedFolder(connectedFolderId: string) {
      const connectedFolderSummary = connectedFolders.find((item) => item.id === connectedFolderId);
      if (!connectedFolderSummary) throw new Error(`Unknown Connected Folder: ${connectedFolderId}`);
      return connectedFolderSummary;
    },
  };
}

function connectedFolder(id: string, name: string, connectedFolderRoot: string): ConnectedFolderSummary {
  return {
    id,
    name,
    connectedFolderRoot,
    location: { kind: "local", storage: "linked" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function source(
  path: string,
  sourceName: string,
  scope: "user" | "project" | "temporary",
  origin: "package" | "top-level",
  baseDir?: string,
) {
  return {
    path,
    source: sourceName,
    scope,
    origin,
    ...(baseDir ? { baseDir } : {}),
  };
}
