import { useCallback, useEffect, useState } from "react";

import { api } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";
import { descendantFolders, folderAncestors, folderTreeRows } from "../../lib/folder-nesting";
import { mentionNames } from "../../lib/folder-mentions";
import type { ConnectedFolderSummary } from "../../types";
import type { MentionFolderOption } from "../chat/FolderMentionMenu";
import { Folder } from "../chrome/icons";

/**
 * Each Connected Folder's Role purpose by id, for the @ menu's second line. The
 * registry-only outline carries it; a failed read leaves the menu without the
 * line, never without the Workers. The preview passes its sample purposes.
 */
export function useRolePurposes(fixturePurposes: Readonly<Record<string, string>> | null): Record<string, string> {
  const [purposes, setPurposes] = useState<Record<string, string>>({});
  useEffect(() => {
    if (fixturePurposes) return;
    let cancelled = false;
    const read = () => {
      void api<{ connectedFolders: Array<{ id: string; rolePurpose?: string }> }>("/api/connected-folders/outline")
        .then(({ connectedFolders }) => {
          if (cancelled) return;
          setPurposes(Object.fromEntries(connectedFolders.flatMap((item) => item.rolePurpose ? [[item.id, item.rolePurpose] as const] : [])));
        })
        .catch(() => undefined);
    };
    read();
    // A Worker or a verb may change a Role at any time.
    const unsubscribe = subscribeControlEvents((hint) => { if (hint === "connected-folders" || hint === "reset") read(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [fixturePurposes]);
  return fixturePurposes ?? purposes;
}

/**
 * The Workers a Chat in `target` can address with @: the Connected Folders
 * inside it first (nested ones indented), then the ones containing it, then
 * everything else A–Z. Each is named so that `@Name` means exactly one Worker.
 */
export function useMentionFolders(connectedFolders: readonly ConnectedFolderSummary[], rolePurposes: Readonly<Record<string, string>>) {
  return useCallback((target: ConnectedFolderSummary): MentionFolderOption[] => {
    const inside = folderTreeRows(descendantFolders(target, connectedFolders));
    const containing = folderAncestors(target, connectedFolders).reverse();
    const seen = new Set([target.id, ...inside.map((row) => row.connectedFolder.id), ...containing.map((item) => item.id)]);
    const others = connectedFolders.filter((item) => !seen.has(item.id)).sort((left, right) => left.name.localeCompare(right.name));
    const names = mentionNames(connectedFolders);
    const option = (item: ConnectedFolderSummary, depth: number): MentionFolderOption => ({
      id: item.id,
      name: names.get(item.id) ?? item.name,
      ...(rolePurposes[item.id] ? { rolePurpose: rolePurposes[item.id]! } : {}),
      icon: <Folder aria-hidden="true" />,
      style: { paddingLeft: `${8 + depth * 16}px` },
    });
    return [...inside.map((row) => option(row.connectedFolder, row.depth)), ...containing.map((item) => option(item, 0)), ...others.map((item) => option(item, 0))];
  }, [connectedFolders, rolePurposes]);
}
