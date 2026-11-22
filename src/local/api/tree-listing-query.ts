import { maxOneLevelTreeEntries } from "../connected-folder.js";
import { badRequest } from "./http.js";

/**
 * The optional parameters a `/tree` listing accepts beyond `path`, `maxDepth`,
 * and `includeIgnored`, shared by Connected Folders and Standard Folders.
 * Each is off unless asked for, so a request without them gets exactly the
 * listing it always did.
 *
 * - `includeLinks=1`: symbolic links appear, each with `link` (never followed).
 * - `includeHidden=1`: entries the system file manager hides carry
 *   `hidden: true`; a Standard Folder listing then includes them.
 * - `maxEntries=N`: a one-level listing (`maxDepth=0`) returns up to N
 *   entries, at most `maxOneLevelTreeEntries`, instead of the usual bound;
 *   `truncated` still says when the folder holds more.
 */
export interface TreeListingQuery {
  includeLinks?: true;
  includeHidden?: true;
  maxEntries?: number;
}

export function treeListingQuery(params: URLSearchParams, oneLevel: boolean): TreeListingQuery {
  const query: TreeListingQuery = {};
  if (params.get("includeLinks") === "1") query.includeLinks = true;
  if (params.get("includeHidden") === "1") query.includeHidden = true;
  const maxEntries = params.get("maxEntries");
  if (maxEntries !== null) {
    if (!oneLevel) throw badRequest("maxEntries applies only to a one-level listing (maxDepth=0).");
    if (!/^[1-9]\d{0,8}$/.test(maxEntries)) throw badRequest("maxEntries must be a whole number of entries.");
    query.maxEntries = Math.min(Number(maxEntries), maxOneLevelTreeEntries);
  }
  return query;
}
