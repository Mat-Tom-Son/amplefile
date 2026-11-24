/**
 * A name as a case-insensitive Mac volume compares it, or more loosely, which
 * is the safe side for a reserved name: compatibility forms decomposed ("ﬁ"
 * is "fi", "ſ" is "s"), case fully folded ("ß" is "ss"), and characters a
 * volume may ignore (zero-width joiners and the like) dropped. A name that
 * folds to a reserved one is that name on the volume.
 */
export function foldedName(name: string): string {
  // Most names are plain ASCII, which only case can change.
  if (/^[\x20-\x7e]*$/.test(name)) return name.toLowerCase();
  return name
    .normalize("NFKD")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKD");
}

const reservedSegments = new Set([".amplefile", ".work-fold", ".pi"]);

/**
 * Portable Connected Folder metadata and executable Pi configuration never belong to
 * ordinary Files, History, or attachment payloads.
 * A `.work-fold/` folder an earlier app left behind stays hidden the same way;
 * AmpleFile never reads it.
 * Match as a case-insensitive volume does ({@link foldedName}) on every
 * platform, so neither a look-alike name (".ampleﬁle") nor a package
 * prepared on macOS can reach a reserved path.
 */
export function isReservedConnectedFolderPathSegment(segment: string): boolean {
  return reservedSegments.has(foldedName(segment));
}

export function containsReservedConnectedFolderPathSegment(path: string): boolean {
  return path.split(/[\\/]+/u).some(isReservedConnectedFolderPathSegment);
}
