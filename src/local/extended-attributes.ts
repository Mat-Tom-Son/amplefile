import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

/**
 * What a Mac item has besides its contents that a copy made by this app does
 * not carry (src/local/file-transfer.ts): extended attributes, which hold a
 * resource fork, Finder tags and comments, and a download's quarantine mark,
 * and the flags that hide or lock it. A move across disks copies, so before
 * its original goes, each entry of the original is compared with its copy
 * here, and the original is kept when the copy lacks something it has.
 *
 * The system's own tools are asked, without a shell: `/usr/bin/xattr` for
 * the attributes, `/usr/bin/stat` for the flags, and `/bin/ls` for access
 * control lists. An original stays when its metadata cannot be verified or
 * any entry has an ACL, which the copy engine does not carry. Elsewhere than
 * on the Mac nothing is asked.
 *
 * A disk with no extended attributes of its own (FAT, exFAT) has macOS keep
 * a file's in a companion beside it, named `._file`. The companion is that
 * file's attributes, not an item with extras of its own: the system answers
 * for the file, and refuses to answer for the companion. When both entries
 * are present, a companion with the AppleDouble header is checked through
 * the file. An ordinary file whose name starts with `._` is checked directly.
 */

/** The mark macOS itself puts on a file an app wrote. Every copy gets its own, so it is not something a copy lacks. */
const provenance = "com.apple.provenance";

/** The flags a person sets: no-dump, locked, append-only, opaque, and hidden. */
const personalFlags = 0x1 | 0x2 | 0x4 | 0x8 | 0x8000;

export interface AttributeLimits {
  /** How many entries one check reads at most. */
  maxEntries: number;
  /** How long one call to a tool may take. */
  callTimeoutMs: number;
  /** How long the whole check may take. */
  totalTimeoutMs: number;
}

const limits: AttributeLimits = { maxEntries: 100_000, callTimeoutMs: 15_000, totalTimeoutMs: 120_000 };

/** Tests only: the check's bounds, and whether it runs at all (null restores both). */
export function setAttributeCheckForTests(options: Partial<AttributeLimits> & { platform?: NodeJS.Platform } | null): void {
  Object.assign(limits, { maxEntries: 100_000, callTimeoutMs: 15_000, totalTimeoutMs: 120_000 }, options ?? {});
  checkedPlatform = options?.platform ?? process.platform;
}

let checkedPlatform: NodeJS.Platform = process.platform;

/**
 * What a copy lacks that its source has: the first entry found, with the
 * attribute's name or `flags`. `unknown` when the extras could not be read
 * (too many entries, a tool that failed or ran out of time, a name the
 * answer cannot be matched to). Null when the copy has everything.
 */
export type MissingExtras = { path: string; name: string } | { unknown: string } | null;

/**
 * Compares what `entries` (paths at and under `source`) have besides their
 * contents with the same entries of `copy`.
 */
export async function extrasCopyLacks(source: string, copy: string, entries: readonly string[]): Promise<MissingExtras> {
  if (checkedPlatform !== "darwin") return null;
  if (entries.length > limits.maxEntries) return { unknown: `it holds more than ${limits.maxEntries.toLocaleString()} items` };
  if (entries.some((path) => path.includes("\n"))) return { unknown: "one of its names has a line break in it" };
  const present = new Set(entries);
  const deadline = Date.now() + limits.totalTimeoutMs;
  for (const batch of batches(entries)) {
    if (Date.now() > deadline) return { unknown: "the check took too long" };
    const asked: string[] = [];
    for (const path of batch) {
      if (!isCompanionOf(path, present) || !await hasAppleDoubleHeader(path)) asked.push(path);
    }
    if (!asked.length) continue;
    const copies = asked.map((path) => join(copy, relative(source, path)));
    const [has, kept, flags, keptFlags, acl] = await Promise.all([
      attributeNames(asked), attributeNames(copies), fileFlags(asked), fileFlags(copies), hasAccessControlList(asked),
    ]);
    if (!has || !kept || !flags || !keptFlags || acl === null) return { unknown: "the system did not answer" };
    if (acl) return { path: source, name: "ACL" };
    for (const [index, path] of asked.entries()) {
      const carried = kept[index]!;
      for (const name of has[index]!) {
        if (name === provenance) continue;
        if (!carried.includes(name)) return { path, name };
        if (Date.now() > deadline) return { unknown: "the check took too long" };
        const [value, copiedValue] = await Promise.all([attributeValue(path, name), attributeValue(copies[index]!, name)]);
        if (value === null || copiedValue === null) return { unknown: "the system did not answer" };
        if (value !== copiedValue) return { path, name };
      }
      if ((flags[index]! & personalFlags & ~keptFlags[index]!) !== 0) return { path, name: "flags" };
    }
  }
  return null;
}

/** Whether `path` is the `._name` companion of a file that is also among the entries. */
function isCompanionOf(path: string, present: ReadonlySet<string>): boolean {
  const name = basename(path);
  return name.startsWith("._") && name.length > 2 && present.has(join(dirname(path), name.slice(2)));
}

async function hasAppleDoubleHeader(path: string): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!file) return false;
  try {
    if (!(await file.stat()).isFile()) return false;
    const header = Buffer.alloc(4);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.readUInt32BE(0) === 0x00051607;
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

/** What an attribute is, in a person's words. */
export function extraInWords(name: string): string {
  if (name === "flags") return "a flag that hides or locks it";
  if (name === "ACL") return "additional access rules";
  if (name === "com.apple.ResourceFork") return "a resource fork";
  if (name === "com.apple.metadata:_kMDItemUserTags") return "Finder tags";
  if (name === "com.apple.metadata:kMDItemFinderComment") return "a Finder comment";
  if (name === "com.apple.FinderInfo") return "Finder information, such as a label or a custom icon";
  if (name === "com.apple.quarantine") return "the mark macOS puts on a download";
  if (name === "com.apple.metadata:kMDItemWhereFroms") return "a record of where it was downloaded from";
  return `extra information (“${name}”)`;
}

/** Paths in groups small enough for one call's arguments. */
function* batches(paths: readonly string[]): Generator<string[]> {
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (batch.length && (batch.length >= 200 || bytes + size > 96 * 1024)) { yield batch; batch = []; bytes = 0; }
    batch.push(path);
    bytes += size;
  }
  if (batch.length) yield batch;
}

function ask(tool: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(tool, args, { timeout: limits.callTimeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } }, (error, stdout, stderr) => {
      resolve(error || stderr ? null : stdout);
    });
  });
}

/**
 * The attribute names of each path, in the paths' order; null when not
 * known. `xattr` names one path's attributes bare and several paths' as
 * "path: name", in the order asked; a line that could belong to more than
 * one path is not guessed at.
 */
export async function attributeNames(paths: readonly string[]): Promise<string[][] | null> {
  if (!paths.length) return [];
  const answer = await ask("/usr/bin/xattr", ["-s", "--", ...paths]);
  if (answer === null) return null;
  const lines = answer.split("\n").filter(Boolean);
  if (paths.length === 1) return [lines];
  const names = paths.map((): string[] => []);
  for (const line of lines) {
    const owners = paths.flatMap((path, index) => line.startsWith(`${path}: `) ? [index] : []);
    // The same path asked twice is one owner; two different paths that both fit are not told apart.
    if (!owners.length || owners.some((index) => paths[index] !== paths[owners[0]!])) return null;
    for (const index of owners) names[index]!.push(line.slice(paths[index]!.length + 2));
  }
  return names;
}

/** The numbered ACL lines are separate from the escaped file names in the long listing. */
async function hasAccessControlList(paths: readonly string[]): Promise<boolean | null> {
  const answer = await ask("/bin/ls", ["-ledbn", "--", ...paths]);
  return answer === null ? null : /^ +[0-9]+: /m.test(answer);
}

async function attributeValue(path: string, name: string): Promise<string | null> {
  const answer = await ask("/usr/bin/xattr", ["-p", "-x", "-s", "--", name, path]);
  return answer === null ? null : answer.replace(/\s+/g, "");
}

/** The flags of each path, in the paths' order; null when not known. */
export async function fileFlags(paths: readonly string[]): Promise<number[] | null> {
  if (!paths.length) return [];
  const answer = await ask("/usr/bin/stat", ["-f", "%f", "--", ...paths]);
  if (answer === null) return null;
  const flags = answer.split("\n").filter(Boolean).map((line) => Number(line));
  return flags.length === paths.length && flags.every((flag) => Number.isInteger(flag) && flag >= 0) ? flags : null;
}
