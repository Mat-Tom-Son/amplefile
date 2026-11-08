
/** The fields nesting reads; the renderer's and the kernel's Connected Folder records both fit. */
export interface NestableFolder {
  id: string;
  name: string;
  connectedFolderRoot: string;
}

/**
 * Connected Folders registered inside other Connected Folders. The registry already
 * allows nesting and the host treats each child as separately owned (History,
 * Search, automations); these helpers give the renderer and the host one
 * shared reading of that shape so the switcher, Files, the composer, and the
 * Workers' turn context agree.
 * The deepest containing Connected Folder is the parent, matching the kernel's
 * cwd resolution.
 */

export interface FolderTreeRow<T extends NestableFolder = NestableFolder> {
  connectedFolder: T;
  depth: number;
  parentId: string | null;
}

function slashPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function comparablePath(value: string): string {
  const normalized = slashPath(value);
  // Drive-letter and UNC paths are Windows paths, which ignore case.
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

/** True when `childRoot` sits strictly inside `parentRoot`. */
export function folderRootContains(parentRoot: string, childRoot: string): boolean {
  const parent = comparablePath(parentRoot);
  const child = comparablePath(childRoot);
  return child !== parent && child.startsWith(`${parent}/`);
}

/** Each Connected Folder's nearest containing Connected Folder, or null for a top-level Connected Folder. */
export function folderParentIds(connectedFolders: readonly NestableFolder[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const connectedFolder of connectedFolders) {
    let parent: NestableFolder | null = null;
    for (const candidate of connectedFolders) {
      if (candidate.id === connectedFolder.id || !folderRootContains(candidate.connectedFolderRoot, connectedFolder.connectedFolderRoot)) continue;
      if (!parent || comparablePath(candidate.connectedFolderRoot).length > comparablePath(parent.connectedFolderRoot).length) parent = candidate;
    }
    result.set(connectedFolder.id, parent?.id ?? null);
  }
  return result;
}

/** Depth-first rows: top-level Connected Folders A–Z, each followed by its children A–Z. */
export function folderTreeRows<T extends NestableFolder>(connectedFolders: readonly T[]): FolderTreeRow<T>[] {
  const parents = folderParentIds(connectedFolders);
  const childrenOf = new Map<string | null, T[]>();
  for (const connectedFolder of connectedFolders) {
    const parentId = parents.get(connectedFolder.id) ?? null;
    const list = childrenOf.get(parentId) ?? [];
    list.push(connectedFolder);
    childrenOf.set(parentId, list);
  }
  const rows: FolderTreeRow<T>[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const list = [...(childrenOf.get(parentId) ?? [])].sort((left, right) => left.name.localeCompare(right.name));
    for (const connectedFolder of list) {
      rows.push({ connectedFolder, depth, parentId });
      visit(connectedFolder.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** The containing Connected Folders of `connected-folder`, outermost first. */
export function folderAncestors<T extends NestableFolder>(connectedFolder: NestableFolder, connectedFolders: readonly T[]): T[] {
  const parents = folderParentIds(connectedFolders);
  const byId = new Map(connectedFolders.map((item) => [item.id, item]));
  const chain: T[] = [];
  let parentId = parents.get(connectedFolder.id) ?? null;
  while (parentId && chain.length < connectedFolders.length) {
    const parent = byId.get(parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parents.get(parent.id) ?? null;
  }
  return chain;
}

/** The Connected Folders directly inside `connected-folder`, A–Z. */
export function childFolders<T extends NestableFolder>(connectedFolder: NestableFolder, connectedFolders: readonly T[]): T[] {
  const parents = folderParentIds(connectedFolders);
  return connectedFolders
    .filter((item) => parents.get(item.id) === connectedFolder.id)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Direct child Connected Folders keyed by their path relative to `connected-folder`, as Files names entries. */
export function childFolderPaths<T extends NestableFolder>(connectedFolder: NestableFolder, connectedFolders: readonly T[]): Map<string, T> {
  // Slice the on-disk spelling, not the comparison form: Files and the host
  // name entries with their real case.
  const root = slashPath(connectedFolder.connectedFolderRoot);
  return new Map(childFolders(connectedFolder, connectedFolders).map((child) => [
    slashPath(child.connectedFolderRoot).slice(root.length + 1),
    child,
  ]));
}

/** Every Connected Folder nested anywhere inside `connected-folder`. */
export function descendantFolders<T extends NestableFolder>(connectedFolder: NestableFolder, connectedFolders: readonly T[]): T[] {
  return connectedFolders.filter((item) => folderRootContains(connectedFolder.connectedFolderRoot, item.connectedFolderRoot));
}
