import { resolve } from "node:path";

import type {
  PiModelCatalogRefreshResult,
  PiModelCatalogStatus,
  PiPreferredModel,
  PiRuntimeConfig,
  PiRuntimeProvider,
} from "./pi-runtime-config.js";

/**
 * In AmpleFile, registering a Connected Folder is the host-level grant to load its Pi
 * project resources. The ordinary Connected Folder registry remains the durable source
 * of truth; Pi's own trust store is left untouched for native Pi consumers.
 */
export class RegisteredConnectedFolderTrustAuthority {
  readonly #roots = new Set<string>();

  constructor(rootPaths: Iterable<string> = []) {
    for (const rootPath of rootPaths) this.grant(rootPath);
  }

  grant(rootPath: string): void {
    this.#roots.add(rootKey(rootPath));
  }

  revoke(rootPath: string): void {
    this.#roots.delete(rootKey(rootPath));
  }

  isRegistered(rootPath: string): boolean {
    return this.#roots.has(rootKey(rootPath));
  }
}

/**
 * Applies the Connected Folder registry decision at the host boundary. An accidental call
 * with an unregistered root is explicitly denied even if another Pi host has
 * trusted that folder independently.
 */
export class RegisteredConnectedFolderRuntimeProvider implements PiRuntimeProvider {
  readonly setPreferredModel?: (connectedFolderRoot: string, model: PiPreferredModel) => Promise<void>;
  readonly getWorkerInstructions?: (connectedFolderRoot: string) => Promise<string>;
  readonly setWorkerInstructions?: (connectedFolderRoot: string, instructions: string) => Promise<void>;
  readonly refreshModelCatalog?: (providerId: string) => Promise<PiModelCatalogRefreshResult>;
  readonly listModelCatalogs?: () => Promise<PiModelCatalogStatus[]>;

  constructor(
    private readonly base: PiRuntimeProvider,
    private readonly authority: RegisteredConnectedFolderTrustAuthority,
  ) {
    if (base.setPreferredModel) {
      this.setPreferredModel = (connectedFolderRoot, model) => base.setPreferredModel!(connectedFolderRoot, model);
    }
    if (base.getWorkerInstructions) {
      this.getWorkerInstructions = (connectedFolderRoot) => base.getWorkerInstructions!(connectedFolderRoot);
    }
    if (base.setWorkerInstructions) {
      this.setWorkerInstructions = (connectedFolderRoot, instructions) => base.setWorkerInstructions!(connectedFolderRoot, instructions);
    }
    if (base.refreshModelCatalog) {
      this.refreshModelCatalog = (providerId) => base.refreshModelCatalog!(providerId);
    }
    if (base.listModelCatalogs) {
      this.listModelCatalogs = () => base.listModelCatalogs!();
    }
  }

  async resolveRuntime(connectedFolderRoot: string): Promise<PiRuntimeConfig> {
    const runtime = await this.base.resolveRuntime(connectedFolderRoot);
    return {
      ...runtime,
      projectTrust: {
        ...runtime.projectTrust,
        override: this.authority.isRegistered(connectedFolderRoot),
      },
    };
  }

}

function rootKey(rootPath: string): string {
  const normalized = resolve(rootPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
