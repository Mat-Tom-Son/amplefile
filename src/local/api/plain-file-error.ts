/**
 * Disk errors in a person's words, shared by the window's file routes and
 * every `amplefile` act (runActOperation), so a refused rename or move reads
 * the same on both surfaces and never shows a raw errno or a full path.
 */

import { basename } from "node:path";

import { AmpleFileCliError } from "../cli/protocol.js";
import { errorMessage, httpError } from "./http.js";

/** A raw error from the disk as it reads in a message: its code, what it was doing, and the path. */
const rawDiskError = /\bE[A-Z0-9]{3,}: [^,'\n]+(?:, [a-z]+)?(?: '([^'\n]*)')?(?: -> '[^'\n]*')?/g;

/**
 * Why something failed, in a person's words. The disk's own error codes and
 * full paths are never shown: an error that is only that becomes a sentence
 * about the item, and one quoted inside another message is put in words too.
 */
export function plainFileError(error: unknown, item?: string): string {
  const { code, path, statusCode } = error as { code?: unknown; path?: unknown; statusCode?: unknown };
  const fromDisk = typeof code === "string" && /^E[A-Z0-9]{3,}$/.test(code) && typeof statusCode !== "number" && !(error instanceof AmpleFileCliError);
  if (!fromDisk) {
    return errorMessage(error).replace(rawDiskError, (_whole, at: string | undefined) => at ? `the disk would not change “${basename(at)}”` : "the disk would not allow it");
  }
  const at = typeof path === "string" && path ? path : item;
  const name = at ? `“${basename(at)}”` : "The item";
  switch (code) {
    case "ENOENT": return `${name} is no longer where it was.`;
    case "EACCES":
    case "EPERM": return `${name} can’t be changed: it is locked, or you don’t have permission.`;
    case "EROFS": return `${name} is on a disk that can’t be changed.`;
    case "ENOSPC":
    case "EDQUOT": return "There is not enough room on the disk.";
    case "EEXIST":
    case "ENOTEMPTY": return `${name} could not take its name: an item is there already.`;
    case "EBUSY": return `${name} is in use.`;
    case "ENAMETOOLONG": return `${name} has a name too long for where it was going.`;
    default: return `The disk would not move ${name === "The item" ? "the item" : name}.`;
  }
}

/** A raw error from the disk as a refusal with a plain message; any other error as it is. */
export function plainTransferError(error: unknown): unknown {
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
  if (typeof statusCode === "number" || error instanceof AmpleFileCliError || typeof code !== "string" || !/^E[A-Z0-9]{3,}$/.test(code)) return error;
  const status = code === "ENOENT" ? 404 : code === "EACCES" || code === "EPERM" || code === "EROFS" ? 403 : code === "ENOSPC" || code === "EDQUOT" ? 507 : 409;
  return Object.assign(httpError(status, plainFileError(error)), { cause: error });
}

/** File system calls whose errors name a file the person can act on. */
const fileSystemCall = /^(?:open|close|read|write|rename|unlink|rmdir|mkdir|mkdtemp|stat|lstat|fstat|access|copyfile|cp|readdir|scandir|opendir|readlink|realpath|symlink|link|chmod|chown|lchown|utime|futime|lutimes|truncate|ftruncate|fsync|fdatasync|rm)$/;

/** The disk refusals `plainFileError` puts in words; anything else is not about a file. */
const knownFileErrorCodes = new Set(["ENOENT", "EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "EEXIST", "ENOTEMPTY", "EBUSY", "ENAMETOOLONG"]);

/**
 * A failed system call as an act's error. A file refusal with a known cause
 * reads as the window says it, with the status that cause deserves; any
 * other failed call (a network connection, a program that could not start,
 * too many open files) stays a plain failure in neutral words, never a full
 * path or a refused move. Errors that are not failed system calls pass
 * through unchanged.
 */
export function plainSystemCallError(error: unknown): unknown {
  const { syscall, code } = error as { syscall?: unknown; code?: unknown };
  if (typeof syscall !== "string" || typeof code !== "string") return error;
  if (fileSystemCall.test(syscall) && knownFileErrorCodes.has(code)) return plainTransferError(error);
  return Object.assign(new Error(`The system refused this request (${code}).`), { cause: error });
}
