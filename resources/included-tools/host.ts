import type { McpExtensionOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IncludedToolStatus } from "../../src/shared/included-tools.js";

/** Optional native host context. It never crosses a renderer bridge. */
export function hostContext(pi: ExtensionAPI) {
  const query: { version: 1; context?: {
    version: 1; mode: "catalog" | "session"; cwd: string; agentDir: string; stateRoot: string;
    helperAppPath?: string;
    /** Where Documents looks for its optional engines; the same place the Documents status looks. */
    documentEngineSearch?: { path?: string; home?: string; platform?: string; candidates?: Record<string, string[]> };
    prepareComputerHelper?: () => Promise<void>;
    beginIncludedToolObservation?: (id: "computer" | "documents") => (status: IncludedToolStatus) => IncludedToolStatus;
    getMcpOptions(): McpExtensionOptions & { disposeCredentials?: () => void };
    getSearchConfig(): Promise<{ provider: "duckduckgo" } | { provider: "brave"; apiKey: string }>;
  } } = { version: 1 };
  pi.events.emit("amplefile:extension-host:v1", query);
  return query.context;
}
