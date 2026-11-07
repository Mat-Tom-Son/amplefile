import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  defaultAgentSdkDir,
  connectedFolderSessionDir,
  connectedFolderStorageKey,
} from "../src/local/agent/agent-data-dir.js";

test("AmpleFile preserves Pi's native agent override and ignores the old product override", () => {
  assert.equal(defaultAgentSdkDir({
    AMPLEFILE_AGENT_DIR: "/tmp/amplefile-agent",
    PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    WORKSPACE_AGENT_DIR: "/tmp/legacy-agent",
  }), "/tmp/amplefile-agent");
  assert.equal(defaultAgentSdkDir({
    PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    WORKSPACE_AGENT_DIR: "/tmp/legacy-agent",
  }), "/tmp/pi-agent");
});

test("AmpleFile Pi sessions use a product namespace beneath the shared Pi agent root", () => {
  const root = "/Users/example/Documents/Shared Connected Folder";
  const agentRoot = "/Users/example/.pi/agent";
  assert.equal(
    connectedFolderSessionDir(root, agentRoot),
    join(agentRoot, "sessions", "amplefile", connectedFolderStorageKey(root)),
  );
  assert.notEqual(
    connectedFolderSessionDir(root, agentRoot),
    join(agentRoot, "sessions", connectedFolderStorageKey(root)),
  );
});
