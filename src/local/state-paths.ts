import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

let configuredStateRoot: string | null = null;

export function configureAmpleFileStateRoot(stateRoot: string | undefined): void {
  configuredStateRoot = stateRoot?.trim() ? resolve(stateRoot) : null;
}

export function ampleFileStateRoot(): string {
  if (configuredStateRoot) return configuredStateRoot;
  const override = process.env.AMPLEFILE_STATE_DIR?.trim();
  if (override) return resolve(override);
  return join(platformAppDataBase(), "AmpleFile");
}

export function managedConnectedFolderRoot(): string {
  const override = process.env.AMPLEFILE_CONTENT_DIR?.trim();
  return override ? resolve(override) : join(ampleFileStateRoot(), "spaces");
}

export function connectedFolderRegistryFile(): string {
  return join(ampleFileStateRoot(), "connected-folder-registry.json");
}

/** Machine-local Connected Folder identity and appearance preferences. */
export function connectedFolderAppearanceFile(): string {
  return join(ampleFileStateRoot(), "appearance.json");
}

/** Machine-local staged code and lifecycle receipts for restricted apps. */
export function restrictedAppRoot(): string {
  return join(ampleFileStateRoot(), "restricted-apps");
}

/** Recently deleted, the machine-local trash for reversible destruction (docs/receipts-not-gates.md, F20). */
export function ampleFileRecentlyDeletedRoot(): string {
  return join(ampleFileStateRoot(), "recently-deleted");
}

/** Machine-local durable request graph (docs/collaboration-contract.md, F25). */
export function ampleFileRequestsRoot(): string {
  return join(ampleFileStateRoot(), "requests");
}

/** Background job records and their output (docs/background-jobs.md); never inside a Connected Folder. */
export function ampleFileJobsRoot(): string {
  return join(ampleFileStateRoot(), "jobs");
}

/**
 * Scope id for the AmpleFile agent that sits above all Connected Folders. It is
 * a distinct conversation scope, not a Connected Folder: its records describe this
 * machine's Connected Folder registry, so they are machine-local application state.
 */
export const ampleFileAgentScopeId = "amplefile-agent";

/** Machine-local root holding the AmpleFile agent scope's conversation records. */
export function ampleFileAgentRoot(): string {
  return join(ampleFileStateRoot(), "management");
}

export function connectedFolderStateDir(connectedFolderRoot: string): string {
  const resolved = resolve(connectedFolderRoot);
  const key = connectedFolderStateKey(resolved);
  return join(ampleFileStateRoot(), "state", "connected-folders", key);
}

export function connectedFolderMetadataDir(connectedFolderRoot: string): string {
  return portableMetadataPath(join(resolve(connectedFolderRoot), ".amplefile"), "Connected Folder metadata directory");
}

export function connectedFolderStateKey(connectedFolderRoot: string): string {
  const resolved = resolve(connectedFolderRoot);
  const readable = safeSegment(basename(resolved)).slice(0, 40) || "space";
  const normalized = process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${readable}-${hash}`;
}

export function connectedFolderManifestFile(connectedFolderRoot: string): string {
  return portableMetadataPath(join(connectedFolderMetadataDir(connectedFolderRoot), "connected-folder.json"), "Connected Folder manifest");
}

export function connectedFolderConversationDir(connectedFolderRoot: string): string {
  return portableMetadataPath(join(connectedFolderMetadataDir(connectedFolderRoot), "conversations"), "Connected Folder conversation directory");
}

export function connectedFolderHistoryRoot(connectedFolderRoot: string): string {
  return join(connectedFolderStateDir(connectedFolderRoot), "history");
}

function platformAppDataBase(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) return appData;
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function portableMetadataPath(path: string, label: string): string {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link or junction.`);
  }
  return path;
}
