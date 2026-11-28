/**
 * Recall across Connected Folders (docs/index-and-recall.md): the host side
 * of a Worker's `recall` tool, and the everywhere search the AmpleFile Agent
 * and the CLI use to find which Worker knows about something.
 *
 * Both read each folder's own index through `recallAcrossConnectedFolders`;
 * neither reads a Connected Folder's Chats for another Worker, and both leave
 * managed Git working copies out.
 */
import type { RecallToolHost } from "../agent/recall-tool.js";
import { getConnectedFolder, listConnectedFolders } from "../connected-folder.js";
import { readConnectedFolderRolePurpose } from "../connected-folder-role.js";
import { recallAcrossConnectedFolders, type RecallAcrossFolder, type RecallAcrossResult } from "../index/recall-across.js";
import type { RecallKind } from "../index/recall.js";
import { descendantFolders } from "../../shared/folder-nesting.js";
import type { LocalApiState } from "./state.js";

function requireIndex(state: LocalApiState) {
  const index = state.connectedFolderIndex;
  if (!index) throw new Error("Recall is not available: AmpleFile's index is not running.");
  return index;
}

async function rolePurpose(connectedFolderRoot: string): Promise<string | undefined> {
  return (await readConnectedFolderRolePurpose(connectedFolderRoot).catch(() => "")) || undefined;
}

/** A folder's root relative to another's, `/`-separated, with its real case. */
function relativeFolderPath(parentRoot: string, childRoot: string): string {
  const slash = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  return slash(childRoot).slice(slash(parentRoot).length + 1);
}

/**
 * The `recall` tool's host for one Connected Folder's Worker. Folder scope
 * asks this folder's index; tree scope also asks every Connected Folder
 * registered anywhere inside it, files only.
 */
export function createRecallToolHost(state: LocalApiState, connectedFolderId: string): RecallToolHost {
  return {
    async recall(input, signal) {
      const index = requireIndex(state);
      const own = await getConnectedFolder(connectedFolderId);
      const folders: RecallAcrossFolder[] = [{
        id: own.id, name: own.name, connectedFolderRoot: own.connectedFolderRoot, path: "",
        ...await rolePurpose(own.connectedFolderRoot).then((purpose) => (purpose ? { rolePurpose: purpose } : {})),
      }];
      if (input.scope === "tree") {
        const nested = descendantFolders(own, await listConnectedFolders());
        folders.push(...await Promise.all(nested.map(async (child): Promise<RecallAcrossFolder> => {
          const purpose = await rolePurpose(child.connectedFolderRoot);
          return {
            id: child.id, name: child.name, connectedFolderRoot: child.connectedFolderRoot,
            path: relativeFolderPath(own.connectedFolderRoot, child.connectedFolderRoot),
            ...(purpose ? { rolePurpose: purpose } : {}),
          };
        })));
      }
      return recallAcrossConnectedFolders(index, folders, input.query, {
        limit: input.limit,
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.path ? { path: input.path } : {}),
        // A parent reads its nested folders' files, never their Workers' Chats.
        chats: "own",
        ...(signal ? { signal } : {}),
      });
    },
  };
}

/**
 * Ranked search over every registered Connected Folder's index, grouped by
 * owner with each folder's Role purpose. For the AmpleFile Agent and the CLI
 * (`amplefile search --everywhere --ranked`); its transcript travels with no
 * Connected Folder.
 */
export async function recallEverywhere(
  state: LocalApiState,
  query: string,
  options: { kinds?: RecallKind[]; limit?: number; signal?: AbortSignal } = {},
): Promise<RecallAcrossResult> {
  const index = requireIndex(state);
  const registered = await listConnectedFolders();
  const folders = await Promise.all(registered.map(async (folder): Promise<RecallAcrossFolder> => {
    const purpose = await rolePurpose(folder.connectedFolderRoot);
    return { id: folder.id, name: folder.name, connectedFolderRoot: folder.connectedFolderRoot, ...(purpose ? { rolePurpose: purpose } : {}) };
  }));
  return recallAcrossConnectedFolders(index, folders, query, {
    ...(options.kinds ? { kinds: options.kinds } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
