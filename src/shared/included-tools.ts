export const includedToolDefinitions = [
  { id: "computer", title: "Computer Control", package: "@injaneity/pi-computer-use", version: "0.5.1", description: "Observe and operate desktop apps, with screenshots and accessibility information." },
  { id: "web", title: "Web", package: "pi-web-access", version: "0.29.0", description: "Search the web and read pages. An optional Brave connection is available." },
  { id: "mcp", title: "Service Connections", package: "@earendil-works/pi-coding-agent", version: "1.1.0", description: "Connect standard MCP tools and services using native Pi discovery." },
  { id: "documents", title: "Documents", package: "amplefile-document-tools", version: "1.0.0", description: "Create and inspect ordinary documents, spreadsheets, presentations, and PDFs." },
] as const;
export type IncludedToolDefinition = typeof includedToolDefinitions[number];
export type IncludedToolId = typeof includedToolDefinitions[number]["id"];

export type IncludedToolReadiness = "ready" | "setup_required" | "unavailable" | "unknown";
export interface IncludedToolStatus {
  id: IncludedToolId; state: IncludedToolReadiness; detail: string; checkedAt: string; stale?: boolean; facts?: Record<string, string | boolean>;
  /** Documents setup only: the installed programs that let a Worker check its documents. */
  documentsSetup?: DocumentsSetup;
}

/** One optional checking program. `version` and `problem` come only from an explicit Check of this exact path. */
export interface DocumentEngineSetup { found: boolean; path?: string; version?: string; problem?: string }
/** `quicklook` is macOS's built-in previewer: nothing to install, so Set up never lists it. */
export interface DocumentsSetup { platform: string; homebrew: boolean; libreoffice: DocumentEngineSetup; tesseract: DocumentEngineSetup; quicklook?: DocumentEngineSetup }
