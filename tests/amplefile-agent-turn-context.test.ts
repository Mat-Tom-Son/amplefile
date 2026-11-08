import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";
import { appendWorkerInstructions } from "../src/local/agent/pi-runtime-config.js";
import { appendConnectedFolderOperationsGuide, connectedFolderOperationsGuideForScope } from "../src/local/agent/connected-folder-operations-guide.js";
import { ampleFileAgentScopeId } from "../src/local/state-paths.js";

test("each AmpleFile agent turn supersedes stale Connected Folder paths with the current host registry", () => {
  const context = buildTurnContextMessage({
    ampleFileAgentTaskId: "task-current",
    ampleFileAgentConnectedFolders: [{
      id: "connected-folder-current",
      name: "Test Folder",
      connectedFolderRoot: "/current/profile/connected-folders/test-folder",
    }],
  });

  assert.match(context, /Current AmpleFile profile snapshot for this exact request \(authoritative\)/);
  assert.match(context, /"name": "Test Folder"/);
  assert.match(context, /"connectedFolderRoot": "\/current\/profile\/connected-folders\/test-folder"/);
  assert.match(context, /replaces every Connected Folder name, id, and path from earlier conversation messages or tool results/);
  assert.match(context, /Never inspect an older Connected Folder path from conversation memory/);
  assert.match(context, /amplefile --json connected-folders list/);
  assert.match(context, /the CLI reached a different AmpleFile profile/);
  assert.match(context, /task-current/);
});

test("the AmpleFile agent scope never receives a Connected Folder turn's identity block or the Connected Folder guide", () => {
  // The two scope blocks are mutually exclusive by construction: the AmpleFile
  // agent carries the registry snapshot and its task id, never a Connected Folder
  // identity, and its system prompt never gains the Connected Folder operations guide.
  const context = buildTurnContextMessage({
    ampleFileAgentTaskId: "task-current",
    ampleFileAgentConnectedFolders: [{ id: "connected-folder-a", name: "Alpha", connectedFolderRoot: "/connected-folders/alpha" }],
  });
  assert.doesNotMatch(context, /This turn's AmpleFile identity/);
  assert.doesNotMatch(context, /Work only in this Connected Folder/);

  assert.equal(connectedFolderOperationsGuideForScope(ampleFileAgentScopeId), undefined);
  const base = appendWorkerInstructions(["system"], "Prefer short answers.");
  assert.deepEqual(appendConnectedFolderOperationsGuide(base, connectedFolderOperationsGuideForScope(ampleFileAgentScopeId)), base);
});
