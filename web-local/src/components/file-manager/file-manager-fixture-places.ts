import type { ConnectedFolderSummary, TreeEntry } from "../../types";
import type { FileManagerPlace, StandardFolderSummary } from "./file-manager-places";
import type { GoToFolderLookup } from "./GoToFolderSheet";
import type { RecentItem } from "./file-manager-view-helpers";

/** The preview's sample folders: each Connected Folder's tree and each Standard Folder's. */
export interface FixturePlaces {
  connectedFolders: readonly ConnectedFolderSummary[];
  connectedFolderTrees: Readonly<Record<string, readonly TreeEntry[]>>;
  standardFolders: readonly StandardFolderSummary[];
  standardFolderTrees: Readonly<Record<string, readonly TreeEntry[]>> | null;
}

/** Go to Folder in the preview: the host's lookup, answered from the sample folders. */
export function fixtureLookup(typed: string, fixture: FixturePlaces): GoToFolderLookup {
  const home = "/Users/you";
  const full = typed === "~" ? home : typed.startsWith("~/") ? `${home}/${typed.slice(2)}` : typed;
  const endsWithSlash = full.endsWith("/");
  const clean = full.replace(/\/+$/, "") || "/";
  const places = [
    ...fixture.connectedFolders.map((item) => ({ place: { kind: "connected-folder" as const, id: item.id }, root: item.connectedFolderRoot, tree: fixture.connectedFolderTrees[item.id] ?? [] })),
    ...fixture.standardFolders.filter((folder) => !folder.connectedFolderId).map((folder) => ({ place: { kind: "standard" as const, id: folder.id }, root: folder.root, tree: fixture.standardFolderTrees?.[folder.id] ?? [] })),
  ];
  const holder = (path: string) => places.filter((item) => path === item.root || path.startsWith(`${item.root}/`)).sort((a, b) => b.root.length - a.root.length)[0] ?? null;
  const entriesAt = (entries: readonly TreeEntry[], relativePath: string): readonly TreeEntry[] => {
    let current = entries;
    for (const part of relativePath.split("/").filter(Boolean)) current = current.find((entry) => entry.name === part && entry.kind === "folder")?.children ?? [];
    return current;
  };
  const listed = endsWithSlash ? clean : clean.slice(0, clean.lastIndexOf("/")) || "/";
  const partial = endsWithSlash ? "" : clean.slice(clean.lastIndexOf("/") + 1).toLocaleLowerCase();
  const listedHolder = holder(listed);
  const suggestions = listedHolder
    ? entriesAt(listedHolder.tree, listed.slice(listedHolder.root.length + 1)).filter((entry) => entry.name.toLocaleLowerCase().startsWith(partial)).slice(0, 12)
      .map((entry) => ({ name: entry.name, kind: entry.kind, path: `${listed}/${entry.name}` }))
    : [];
  const target = holder(clean);
  if (!target) return { target: null, suggestions, message: "The preview opens only its sample folders." };
  const relativePath = clean.slice(target.root.length + 1);
  if (!relativePath) return { target: { place: target.place, path: "", select: null }, suggestions, message: null };
  const parent = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  const found = entriesAt(target.tree, parent).find((entry) => entry.name === relativePath.slice(relativePath.lastIndexOf("/") + 1));
  if (!found) return { target: null, suggestions, message: suggestions.length ? null : "There’s no folder or file at that path." };
  return { target: { place: target.place, path: found.kind === "folder" ? relativePath : parent, select: found.kind === "folder" ? null : relativePath }, suggestions, message: null };
}

/** Recents in the preview: the sample files changed most lately, across the Connected Folders and Desktop, Documents, and Downloads. */
export function fixtureRecents(fixture: FixturePlaces): RecentItem[] {
  const out: RecentItem[] = [];
  const walk = (placeRef: FileManagerPlace, where: string, entries: readonly TreeEntry[]) => {
    for (const entry of entries) {
      if (entry.children && !entry.nestedFolder) walk(placeRef, where, entry.children);
      if (entry.kind === "file" && entry.updatedAt) out.push({ place: placeRef, path: entry.path, name: entry.name, kind: "file", ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}), updatedAt: entry.updatedAt, where });
    }
  };
  for (const item of fixture.connectedFolders) walk({ kind: "connected-folder", id: item.id }, item.name, fixture.connectedFolderTrees[item.id] ?? []);
  for (const folder of fixture.standardFolders) if (["desktop", "documents", "downloads"].includes(folder.id)) walk({ kind: "standard", id: folder.id }, folder.name, fixture.standardFolderTrees?.[folder.id] ?? []);
  return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 40);
}
