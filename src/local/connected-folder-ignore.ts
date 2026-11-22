import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./agent/turn-store.js";
import { connectedFolderStateDir } from "./state-paths.js";
import { ensureSafeConnectedFolderRoot, resolveConnectedFolderPath } from "./connected-folder.js";

export interface ConnectedFolderIgnoreState {
  version: 1;
  patterns: string[];
}

export interface ConnectedFolderIgnoreUpdate {
  ignored: boolean;
  paths: string[];
  patterns: string[];
}

const builtInPatterns = [".amplefile", ".work-fold", ".pi", ".DS_Store", "Thumbs.db", "~$*", ".~lock.*#"];

export async function readConnectedFolderIgnoreState(connectedFolderRoot: string): Promise<ConnectedFolderIgnoreState> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const file = ignoreStateFile(root);
  if (!existsSync(file)) return { version: 1, patterns: [] };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ConnectedFolderIgnoreState>;
    return {
      version: 1,
      patterns: Array.isArray(parsed.patterns)
        ? parsed.patterns.filter((item): item is string => typeof item === "string").map(normalizePattern).filter(Boolean).slice(0, 500)
        : [],
    };
  } catch {
    return { version: 1, patterns: [] };
  }
}

export async function setConnectedFolderIgnoreState(
  connectedFolderRoot: string,
  paths: string[],
  ignored: boolean,
): Promise<ConnectedFolderIgnoreUpdate> {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  const normalizedPaths = [...new Set(paths.map(normalizeConnectedFolderPath).filter(Boolean))].slice(0, 100);
  if (!normalizedPaths.length || normalizedPaths.includes(".")) throw new Error("Choose at least one Connected Folder item.");
  const requestedPatterns: string[] = [];
  for (const path of normalizedPaths) {
    const absolute = resolveConnectedFolderPath(root, path);
    if (absolute === root) throw new Error("The Connected Folder root cannot be ignored.");
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`Connected Folder item not found: ${path}`);
    requestedPatterns.push(info.isDirectory() ? `${path}/` : path);
  }

  // Read, change, and replace the rules as one queued step per Connected Folder, so
  // two changes in flight cannot each start from the same old rules.
  const file = ignoreStateFile(root);
  const previous = ignoreStateUpdates.get(file) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const state = await readConnectedFolderIgnoreState(root);
    const existing = new Set(state.patterns);
    for (const pattern of requestedPatterns) {
      existing.delete(pattern);
      existing.delete(`!${pattern}`);
      if (ignored) existing.add(pattern);
      else if (isConnectedFolderIgnored(pattern.replace(/\/$/, ""), [...existing])) existing.add(`!${pattern}`);
    }
    const patterns = [...existing].sort((left, right) => left.localeCompare(right));
    await mkdir(dirname(file), { recursive: true });
    // A torn file would read back as no rules at all, so replace it whole.
    await writeFileAtomic(file, `${JSON.stringify({ version: 1, patterns }, null, 2)}\n`);
    return patterns;
  });
  ignoreStateUpdates.set(file, operation);
  try {
    return { ignored, paths: normalizedPaths, patterns: await operation };
  } finally {
    if (ignoreStateUpdates.get(file) === operation) ignoreStateUpdates.delete(file);
  }
}

const ignoreStateUpdates = new Map<string, Promise<string[]>>();

export function isConnectedFolderIgnored(relativePath: string, configuredPatterns: string[]): boolean {
  const path = normalizeConnectedFolderPath(relativePath);
  if (!path) return false;
  let ignored = false;
  const segments = path.split("/");
  for (const rule of compiledIgnoreRules(configuredPatterns)) {
    if (ruleMatches(path, rule, segments)) ignored = !rule.negated;
  }
  return ignored;
}

export function isAlwaysHiddenConnectedFolderEntry(name: string): boolean {
  const path = normalizeConnectedFolderPath(name);
  const segments = path.split("/");
  return builtInRules.some((rule) => ruleMatches(path, rule, segments));
}

interface CompiledIgnoreRule {
  negated: boolean;
  folderPattern: boolean;
  /** Normalized; empty when the rule can never match. */
  pattern: string;
  regex: RegExp | null;
}

// A listing tests every entry against every rule. Each rule is normalized and
// compiled once per rule list, not once per entry, so a folder of 100,000
// entries does not compile millions of expressions.
function compileIgnoreRule(rawPattern: string, negated: boolean): CompiledIgnoreRule {
  const pattern = normalizeConnectedFolderPath(rawPattern);
  return { negated, folderPattern: rawPattern.endsWith("/"), pattern, regex: pattern ? globRegex(pattern) : null };
}

const builtInRules = builtInPatterns.map((pattern) => compileIgnoreRule(pattern, false));
const compiledRuleLists = new WeakMap<readonly string[], CompiledIgnoreRule[]>();

function compiledIgnoreRules(configuredPatterns: readonly string[]): CompiledIgnoreRule[] {
  const cached = compiledRuleLists.get(configuredPatterns);
  if (cached) return cached;
  const rules: CompiledIgnoreRule[] = [];
  for (const rawPattern of [...builtInPatterns, ...configuredPatterns]) {
    const negated = rawPattern.startsWith("!");
    const pattern = normalizePattern(negated ? rawPattern.slice(1) : rawPattern);
    if (pattern) rules.push(compileIgnoreRule(pattern, negated));
  }
  // Rule lists are read whole from ignore.json and never changed in place.
  compiledRuleLists.set(configuredPatterns, rules);
  return rules;
}

function ignoreStateFile(connectedFolderRoot: string): string {
  return join(connectedFolderStateDir(connectedFolderRoot), "ignore.json");
}

function normalizePattern(value: string): string {
  const negated = value.trim().startsWith("!");
  const normalized = normalizeConnectedFolderPath(value.trim().replace(/^!/, ""));
  if (!normalized || normalized.includes("..")) return "";
  const withFolderMarker = /[\\/]$/.test(value.trim()) ? `${normalized}/` : normalized;
  return negated ? `!${withFolderMarker}` : withFolderMarker;
}

function normalizeConnectedFolderPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "");
}

/** `path` is already normalized, and `segments` is its `/`-separated parts. */
function ruleMatches(path: string, rule: CompiledIgnoreRule, segments: readonly string[]): boolean {
  const { pattern, regex } = rule;
  if (!pattern || !regex) return false;
  if (regex.test(path)) return true;
  if (rule.folderPattern && (path === pattern || path.startsWith(`${pattern}/`))) return true;
  if (!pattern.includes("/")) return segments.some((segment) => regex.test(segment));
  return false;
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}
