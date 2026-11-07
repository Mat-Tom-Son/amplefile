import { startLocalApi } from "./server.js";
import { includedToolsRoot } from "./agent/included-tools.js";
import { ampleFileStateRoot } from "./state-paths.js";
import { join } from "node:path";

await startLocalApi({ appMode: "dev", piRuntimeProvider: { resolveRuntime: async () => ({ includedTools: {
  rootPath: includedToolsRoot(), stateRoot: join(ampleFileStateRoot(), "assistant-tools"),
  helperAppPath: join(includedToolsRoot(), "..", "..", "out", "included-tools", "computer-helper", "AmpleFile Computer.app"),
} }) } }).then((api) => {
  console.log(`AmpleFile local API listening on ${api.origin}`);
});
