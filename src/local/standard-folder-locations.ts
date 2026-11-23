import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const keys = { desktop: "DESKTOP", documents: "DOCUMENTS", downloads: "DOWNLOAD", pictures: "PICTURES" } as const;
type UserFolder = keyof typeof keys;

/** Read XDG data without evaluating its shell-like syntax or executing commands. */
export function parseUserDirectories(text: string, home: string): Partial<Record<UserFolder, string>> {
  const result: Partial<Record<UserFolder, string>> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*XDG_(DESKTOP|DOCUMENTS|DOWNLOAD|PICTURES)_DIR="((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const key = (Object.keys(keys) as UserFolder[]).find(key => keys[key] === match[1])!;
    // Only HOME is expandable. Preserve escaped literal shell metacharacters.
    const raw = match[2]!;
    const expanded = raw.startsWith("$HOME/") ? home + raw.slice(5) : raw === "$HOME" ? home : raw;
    if (/(?<!\\)[$`]/.test(expanded) || /[\u0000-\u001f\u007f]/.test(expanded)) continue;
    const path = expanded.replace(/\\([\\"$`])/g, "$1");
    if (isAbsolute(path)) result[key] = resolve(path);
  }
  return result;
}

export function linuxUserDirectories(home: string, env: NodeJS.ProcessEnv = process.env): Partial<Record<UserFolder, string>> {
  // A supplied test home must never consult the person's actual configuration.
  const config = resolve(home) === resolve(homedir()) && env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : join(home, ".config");
  try { return parseUserDirectories(readFileSync(join(config, "user-dirs.dirs"), "utf8"), home); }
  catch { return {}; }
}
