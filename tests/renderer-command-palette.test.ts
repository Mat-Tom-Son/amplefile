import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalApi } from "../src/local/server.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";
import { commandPaletteResultGroups, type CommandPaletteCommand } from "../web-local/src/components/modals/CommandPaletteHost.js";

test("command palette searches real API Connected Folder summaries by name and folder without crashing", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-palette-contract-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  try {
    const response = await fetch(`${api.origin}/api/connected-folders`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Editorial" }),
    });
    assert.equal(response.status, 201);
    const { connectedFolder } = await response.json() as { connectedFolder: ConnectedFolderSummary };
    assert.equal(connectedFolder.connectedFolderRoot, join(sandbox, "content", "editorial"));
    const commands: CommandPaletteCommand[] = [
      { id: "go:checks", groupId: "go-to", groupLabel: "Go to", label: "Checks", run() {} },
      { id: `connected-folder:${connectedFolder.id}`, groupId: "switch-connected-folder", groupLabel: "Switch Connected Folder", label: connectedFolder.name, matchTargets: [connectedFolder.name, connectedFolder.connectedFolderRoot], run() {} },
    ];
    const ids = (query: string) => commandPaletteResultGroups(commands, query).flatMap((group) => group.results.map((result) => result.command.id));
    // The random temporary path may also be a legitimate fuzzy match.
    assert.equal(ids("Checks")[0], "go:checks");
    assert.deepEqual(ids("Editorial"), [`connected-folder:${connectedFolder.id}`]);
    assert.deepEqual(ids(join(sandbox, "content")), [`connected-folder:${connectedFolder.id}`]);
  } finally { await api.close(); await rm(sandbox, { recursive: true, force: true }); }
});
