import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  RegisteredConnectedFolderRuntimeProvider,
  RegisteredConnectedFolderTrustAuthority,
} from "../src/local/agent/registered-connected-folder-runtime.js";

test("registered Connected Folder membership grants Pi project trust and removal revokes it", async () => {
  const registeredRoot = join(process.cwd(), "registered-connected-folder-runtime", "registered");
  const otherRoot = join(process.cwd(), "registered-connected-folder-runtime", "other");
  const authority = new RegisteredConnectedFolderTrustAuthority([registeredRoot]);
  const provider = new RegisteredConnectedFolderRuntimeProvider({
    async resolveRuntime() {
      return { projectTrust: { request: async () => true } };
    },
  }, authority);

  assert.equal((await provider.resolveRuntime(registeredRoot)).projectTrust?.override, true);
  assert.equal((await provider.resolveRuntime(otherRoot)).projectTrust?.override, false);
  assert.equal((await provider.resolveRuntime(join(registeredRoot, "child"))).projectTrust?.override, false, "authorization is exact-root, not inherited by descendants");

  authority.grant(otherRoot);
  assert.equal((await provider.resolveRuntime(otherRoot)).projectTrust?.override, true);

  authority.revoke(registeredRoot);
  assert.equal((await provider.resolveRuntime(registeredRoot)).projectTrust?.override, false);
});
