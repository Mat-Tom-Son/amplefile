import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Comparing paths the way the disk does. One folder can be written more than
 * one way: in another letter case, or with an accent composed or decomposed
 * (macOS and Windows disks take both as the same name by default), or
 * through a symbolic link on the way to it. A check that keeps a change out
 * of a folder, such as a registered Connected Folder, compares a path both
 * as written and as the disk resolves it, so no spelling of the folder gets
 * past it.
 */

/** A path as written, made comparable: absolute, no trailing slash, and outside Linux in composed Unicode and lower case. */
export function comparablePath(value: string): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "") || sep;
  return process.platform === "linux" ? resolved : resolved.normalize("NFC").toLocaleLowerCase();
}

/**
 * A path as the disk resolves it, made comparable: every link on the way
 * followed, for as much of the path as exists. `finalLink` keeps a final
 * symbolic link as itself, for an item that is changed as the link it is,
 * never as what it points to.
 */
export async function comparableRealPath(value: string, options: { finalLink?: boolean } = {}): Promise<string> {
  const path = resolve(value);
  const parent = dirname(path);
  if (options.finalLink && parent !== path) return comparablePath(join(await existingRealPath(parent), basename(path)));
  return comparablePath(await existingRealPath(path));
}

/** The real path of the deepest part of `path` that exists, with the rest as written. */
async function existingRealPath(path: string): Promise<string> {
  const rest: string[] = [];
  for (let current = path; ;) {
    const real = await realpath(current).catch(() => null);
    if (real) return join(real, ...rest);
    const parent = dirname(current);
    if (parent === current) return join(current, ...rest);
    rest.unshift(basename(current));
    current = parent;
  }
}

/** The ways a path is compared: as written, and as the disk resolves it. */
export async function comparableForms(value: string, options: { finalLink?: boolean } = {}): Promise<string[]> {
  return [...new Set([comparablePath(value), await comparableRealPath(value, options)])];
}

/** Whether a comparable path is another one or inside it. */
export function comparableContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Whether any way `child` is written is at or inside any way `parent` is. */
export function formsContain(parent: readonly string[], child: readonly string[]): boolean {
  return parent.some((root) => child.some((path) => comparableContains(root, path)));
}
