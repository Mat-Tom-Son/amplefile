import type { Dirent, Stats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AmpleFileCheckTarget, AmpleFileCheckTargetRole } from "../../shared/checks.js";
import { isReservedConnectedFolderPathSegment } from "../connected-folder-path-policy.js";

/**
 * Ceilings that only stop a runaway walk. Resolution reads metadata, never
 * file contents, so it carries no byte ceiling of its own; every caller that
 * goes on to read bytes passes the read budget it actually needs.
 */
export const ampleFileCheckTargetHardLimits = Object.freeze({
  maxSelectors: 1_024,
  maxVisitedEntries: 10_000_000,
  maxDepth: 1_024,
  maxFiles: 1_000_000,
  maxFileBytes: Number.MAX_SAFE_INTEGER,
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
});

export interface AmpleFileCheckTargetLimits {
  maxSelectors: number;
  maxVisitedEntries: number;
  maxDepth: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface AmpleFileCheckResolvedFile {
  /** Canonical Connected Folder–relative path, using `/` separators. */
  path: string;
  /** Internal filesystem path for the runner. Never expose this through a content-free projection. */
  absolutePath: string;
  sizeBytes: number;
  selectorIndexes: number[];
  roles: AmpleFileCheckTargetRole[];
}

export interface AmpleFileCheckMissingExactTarget {
  path: string;
  selectorIndexes: number[];
  roles: AmpleFileCheckTargetRole[];
}

export interface AmpleFileCheckTargetResolution {
  files: AmpleFileCheckResolvedFile[];
  missingExactTargets: AmpleFileCheckMissingExactTarget[];
  totalBytes: number;
  visitedEntries: number;
}

export type AmpleFileCheckTargetResolutionErrorCode =
  | "INVALID_ROOT"
  | "INVALID_LIMIT"
  | "INVALID_SELECTOR"
  | "UNSAFE_PATH"
  | "RESERVED_PATH"
  | "SYMLINK"
  | "TARGET_NOT_FOUND"
  | "TYPE_MISMATCH"
  | "LIMIT_EXCEEDED"
  | "FILESYSTEM_ERROR";

export class AmpleFileCheckTargetResolutionError extends Error {
  readonly code: AmpleFileCheckTargetResolutionErrorCode;
  readonly targetPath?: string;

  constructor(
    code: AmpleFileCheckTargetResolutionErrorCode,
    message: string,
    options: { targetPath?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AmpleFileCheckTargetResolutionError";
    this.code = code;
    this.targetPath = options.targetPath;
  }
}

export interface ResolveAmpleFileCheckTargetsOptions {
  /** Callers may tighten, but never widen, the resolver's hard limits. */
  limits?: Partial<AmpleFileCheckTargetLimits>;
  signal?: AbortSignal;
}

interface PreparedRoot {
  lexicalRoot: string;
  canonicalRoot: string;
}

interface MutableResolvedFile extends Omit<AmpleFileCheckResolvedFile, "selectorIndexes" | "roles"> {
  selectorIndexes: Set<number>;
  roles: Set<AmpleFileCheckTargetRole>;
}

interface MutableMissingTarget extends Omit<AmpleFileCheckMissingExactTarget, "selectorIndexes" | "roles"> {
  selectorIndexes: Set<number>;
  roles: Set<AmpleFileCheckTargetRole>;
}

interface ResolutionState {
  root: PreparedRoot;
  limits: AmpleFileCheckTargetLimits;
  files: Map<string, MutableResolvedFile>;
  missing: Map<string, MutableMissingTarget>;
  totalBytes: number;
  visitedEntries: number;
  signal?: AbortSignal;
}

/**
 * Resolves one already-normalized Check declaration's targets without reading
 * file contents. Exact targets may remain missing; every other inability to
 * establish a bounded, link-free target set is a resolver error.
 */
export async function resolveAmpleFileCheckTargets(
  root: string,
  targets: readonly AmpleFileCheckTarget[],
  options: ResolveAmpleFileCheckTargetsOptions = {},
): Promise<AmpleFileCheckTargetResolution> {
  const limits = resolvedLimits(options.limits);
  if (!Array.isArray(targets) || targets.length < 1) {
    throw new AmpleFileCheckTargetResolutionError("INVALID_SELECTOR", "At least one explicit Check target is required.");
  }
  if (targets.length > limits.maxSelectors) {
    throw limitError(`Check target count exceeds the ${limits.maxSelectors}-selector limit.`);
  }

  const state: ResolutionState = {
    root: await prepareRoot(root),
    limits,
    files: new Map(),
    missing: new Map(),
    totalBytes: 0,
    visitedEntries: 0,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  for (const [selectorIndex, target] of targets.entries()) {
    throwIfAborted(state.signal);
    const path = safeTargetPath(target?.path);
    const role = target?.role;
    if (role !== "primary" && role !== "reference") {
      throw new AmpleFileCheckTargetResolutionError("INVALID_SELECTOR", `Check target ${selectorIndex + 1} has an invalid role.`, { targetPath: path });
    }
    if (target.kind === "file") {
      await resolveExactFile(state, path, selectorIndex, role);
      continue;
    }
    if (target.kind !== "tree" || typeof target.recursive !== "boolean") {
      throw new AmpleFileCheckTargetResolutionError("INVALID_SELECTOR", `Check target ${selectorIndex + 1} is invalid.`, { targetPath: path });
    }
    const extensions = normalizedExtensions(target.extensions, path);
    await resolveTree(state, path, target.recursive, extensions, selectorIndex, role);
  }

  return {
    files: [...state.files.values()]
      .map((file) => ({
        ...file,
        selectorIndexes: [...file.selectorIndexes].sort((left, right) => left - right),
        roles: sortedRoles(file.roles),
      }))
      .sort((left, right) => compareText(left.path, right.path)),
    missingExactTargets: [...state.missing.values()]
      .map((target) => ({
        ...target,
        selectorIndexes: [...target.selectorIndexes].sort((left, right) => left - right),
        roles: sortedRoles(target.roles),
      }))
      .sort((left, right) => compareText(left.path, right.path)),
    totalBytes: state.totalBytes,
    visitedEntries: state.visitedEntries,
  };
}

async function prepareRoot(root: string): Promise<PreparedRoot> {
  if (typeof root !== "string" || !root.trim() || !isAbsolute(root)) {
    throw new AmpleFileCheckTargetResolutionError("INVALID_ROOT", "The Check resolver requires an absolute Connected Folder root.");
  }
  const lexicalRoot = resolve(root);
  const info = await checkedLstat(lexicalRoot, "The Connected Folder root is unavailable.", "INVALID_ROOT");
  if (info.isSymbolicLink()) {
    throw new AmpleFileCheckTargetResolutionError("SYMLINK", "A Connected Folder root used for Checks cannot be a symbolic link or junction.");
  }
  if (!info.isDirectory()) {
    throw new AmpleFileCheckTargetResolutionError("INVALID_ROOT", "The Check resolver Connected Folder root must be a directory.");
  }
  const canonicalRoot = await checkedRealpath(lexicalRoot, "The Connected Folder root could not be canonicalized.");
  return { lexicalRoot, canonicalRoot };
}

async function resolveExactFile(
  state: ResolutionState,
  path: string,
  selectorIndex: number,
  role: AmpleFileCheckTargetRole,
): Promise<void> {
  const target = await inspectRelativePath(state.root, path, true);
  if (!target) {
    const missing = state.missing.get(path) ?? { path, selectorIndexes: new Set(), roles: new Set() };
    missing.selectorIndexes.add(selectorIndex);
    missing.roles.add(role);
    state.missing.set(path, missing);
    return;
  }
  if (!target.info.isFile()) {
    throw new AmpleFileCheckTargetResolutionError("TYPE_MISMATCH", `Exact Check target is not a regular file: ${path}`, { targetPath: path });
  }
  addFile(state, path, target.absolutePath, target.info, selectorIndex, role);
}

async function resolveTree(
  state: ResolutionState,
  path: string,
  recursive: boolean,
  extensions: ReadonlySet<string>,
  selectorIndex: number,
  role: AmpleFileCheckTargetRole,
): Promise<void> {
  const target = await inspectRelativePath(state.root, path, false);
  if (!target) {
    throw new AmpleFileCheckTargetResolutionError("TARGET_NOT_FOUND", `Check tree target does not exist: ${path}`, { targetPath: path });
  }
  if (!target.info.isDirectory()) {
    throw new AmpleFileCheckTargetResolutionError("TYPE_MISMATCH", `Check tree target is not a directory: ${path}`, { targetPath: path });
  }
  await visitTree(state, target.absolutePath, path, recursive, extensions, selectorIndex, role, 0);
}

async function visitTree(
  state: ResolutionState,
  absoluteDirectory: string,
  relativeDirectory: string,
  recursive: boolean,
  extensions: ReadonlySet<string>,
  selectorIndex: number,
  role: AmpleFileCheckTargetRole,
  depth: number,
): Promise<void> {
  throwIfAborted(state.signal);
  if (depth > state.limits.maxDepth) {
    throw limitError(`Check target traversal exceeds the ${state.limits.maxDepth}-level depth limit.`, relativeDirectory);
  }
  const entries: Dirent[] = [];
  try {
    const directory = await opendir(absoluteDirectory);
    try {
      for await (const entry of directory) {
        if (state.visitedEntries + entries.length + 1 > state.limits.maxVisitedEntries) {
          throw limitError(`Check target traversal exceeds the ${state.limits.maxVisitedEntries}-entry limit.`, relativeDirectory);
        }
        entries.push(entry);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof AmpleFileCheckTargetResolutionError) throw error;
    throw filesystemError(error, `AmpleFile could not enumerate Check target tree: ${relativeDirectory}`, relativeDirectory);
  }

  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    throwIfAborted(state.signal);
    state.visitedEntries += 1;
    if (state.visitedEntries > state.limits.maxVisitedEntries) {
      throw limitError(`Check target traversal exceeds the ${state.limits.maxVisitedEntries}-entry limit.`, relativeDirectory);
    }
    const path = `${relativeDirectory}/${entry.name}`;
    const absolutePath = join(absoluteDirectory, entry.name);
    assertLexicallyInside(state.root.lexicalRoot, absolutePath, path);
    const info = await checkedLstat(absolutePath, `AmpleFile could not inspect Check target: ${path}`, "FILESYSTEM_ERROR", path);
    if (info.isSymbolicLink()) {
      throw new AmpleFileCheckTargetResolutionError("SYMLINK", `Check target trees cannot contain symbolic links or junctions: ${path}`, { targetPath: path });
    }
    if (isReservedConnectedFolderPathSegment(entry.name)) continue;
    if (info.isDirectory()) {
      if (!recursive) continue;
      const canonical = await checkedRealpath(absolutePath, `AmpleFile could not canonicalize Check target directory: ${path}`, path);
      assertCanonicalInside(state.root.canonicalRoot, canonical, path);
      await visitTree(state, absolutePath, path, recursive, extensions, selectorIndex, role, depth + 1);
      continue;
    }
    if (!info.isFile() || !matchesExtension(entry.name, extensions)) continue;
    const canonical = await checkedRealpath(absolutePath, `AmpleFile could not canonicalize Check target file: ${path}`, path);
    assertCanonicalInside(state.root.canonicalRoot, canonical, path);
    addFile(state, path, absolutePath, info, selectorIndex, role);
  }
}

async function inspectRelativePath(
  root: PreparedRoot,
  path: string,
  allowMissing: boolean,
): Promise<{ absolutePath: string; info: Stats } | null> {
  let cursor = root.lexicalRoot;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    assertLexicallyInside(root.lexicalRoot, cursor, path);
    let info: Stats;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (allowMissing && isMissingError(error)) return null;
      if (isMissingError(error)) return null;
      throw filesystemError(error, `AmpleFile could not inspect Check target: ${path}`, path);
    }
    if (info.isSymbolicLink()) {
      throw new AmpleFileCheckTargetResolutionError("SYMLINK", `Check targets cannot traverse symbolic links or junctions: ${path}`, { targetPath: path });
    }
    const final = index === segments.length - 1;
    if (!final && !info.isDirectory()) {
      throw new AmpleFileCheckTargetResolutionError("TYPE_MISMATCH", `Check target path traverses a non-directory: ${path}`, { targetPath: path });
    }
  }
  const info = await checkedLstat(cursor, `AmpleFile could not inspect Check target: ${path}`, "FILESYSTEM_ERROR", path);
  const canonical = await checkedRealpath(cursor, `AmpleFile could not canonicalize Check target: ${path}`, path);
  assertCanonicalInside(root.canonicalRoot, canonical, path);
  return { absolutePath: cursor, info };
}

function addFile(
  state: ResolutionState,
  path: string,
  absolutePath: string,
  info: Stats,
  selectorIndex: number,
  role: AmpleFileCheckTargetRole,
): void {
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > state.limits.maxFileBytes) {
    throw limitError(`Check target exceeds the ${state.limits.maxFileBytes}-byte per-file limit: ${path}`, path);
  }
  const existing = state.files.get(path);
  if (existing) {
    if (existing.sizeBytes !== info.size) {
      throw new AmpleFileCheckTargetResolutionError("FILESYSTEM_ERROR", `Check target changed during resolution: ${path}`, { targetPath: path });
    }
    existing.selectorIndexes.add(selectorIndex);
    existing.roles.add(role);
    return;
  }
  if (state.files.size >= state.limits.maxFiles) {
    throw limitError(`Resolved Check targets exceed the ${state.limits.maxFiles}-file limit.`, path);
  }
  if (!Number.isSafeInteger(state.totalBytes + info.size) || state.totalBytes + info.size > state.limits.maxTotalBytes) {
    throw limitError(`Resolved Check targets exceed the ${state.limits.maxTotalBytes}-byte total limit.`, path);
  }
  state.files.set(path, {
    path,
    absolutePath,
    sizeBytes: info.size,
    selectorIndexes: new Set([selectorIndex]),
    roles: new Set([role]),
  });
  state.totalBytes += info.size;
}

function safeTargetPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\0") || value.includes("\\")) {
    throw new AmpleFileCheckTargetResolutionError("UNSAFE_PATH", "Check targets must use bounded Connected Folder–relative paths.");
  }
  if (value === "." || isAbsolute(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new AmpleFileCheckTargetResolutionError("UNSAFE_PATH", "Check targets cannot select the Connected Folder root or an absolute path.", { targetPath: value });
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AmpleFileCheckTargetResolutionError("UNSAFE_PATH", "Check targets must be normalized paths beneath the Connected Folder root.", { targetPath: value });
  }
  if (segments.some(isReservedConnectedFolderPathSegment)) {
    throw new AmpleFileCheckTargetResolutionError("RESERVED_PATH", "Check targets cannot select .amplefile, .workspace, or .pi material.", { targetPath: value });
  }
  if (segments.some(isUnsafeWindowsPathSegment)) {
    throw new AmpleFileCheckTargetResolutionError("UNSAFE_PATH", "Check targets cannot contain Windows-reserved or ambiguous path segments.", { targetPath: value });
  }
  return segments.join("/");
}

function isUnsafeWindowsPathSegment(segment: string): boolean {
  if (segment.includes(":") || /[. ]$/.test(segment)) return true;
  const stem = segment.split(".", 1)[0]!.toLocaleLowerCase("en-US");
  return stem === "con" || stem === "prn" || stem === "aux" || stem === "nul"
    || /^com[1-9]$/.test(stem) || /^lpt[1-9]$/.test(stem);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AmpleFileCheckTargetResolutionError("FILESYSTEM_ERROR", String(signal.reason || "Check target resolution was aborted."));
  }
}

function normalizedExtensions(value: unknown, targetPath: string): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw new AmpleFileCheckTargetResolutionError("INVALID_SELECTOR", "Check tree targets require explicit extension filters.", { targetPath });
  }
  const extensions = value.map((item) => {
    if (typeof item !== "string" || item.length > 24) {
      throw new AmpleFileCheckTargetResolutionError("INVALID_SELECTOR", "Check tree target contains an invalid extension filter.", { targetPath });
    }
    const extension = item.toLocaleLowerCase("en-US");
    if (!/^\.[a-z0-9][a-z0-9._+-]*$/.test(extension)) {
      throw new AmpleFileCheckTargetResolutionError("INVALID_SELECTOR", "Check tree target contains an invalid extension filter.", { targetPath });
    }
    return extension;
  });
  return new Set(extensions.sort(compareText));
}

function matchesExtension(name: string, extensions: ReadonlySet<string>): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  return [...extensions].some((extension) => normalized.endsWith(extension));
}

function resolvedLimits(value: Partial<AmpleFileCheckTargetLimits> | undefined): AmpleFileCheckTargetLimits {
  const result: AmpleFileCheckTargetLimits = { ...ampleFileCheckTargetHardLimits };
  if (!value) return result;
  for (const key of Object.keys(result) as Array<keyof AmpleFileCheckTargetLimits>) {
    const requested = value[key];
    if (requested === undefined) continue;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > ampleFileCheckTargetHardLimits[key]) {
      throw new AmpleFileCheckTargetResolutionError("INVALID_LIMIT", `Check target ${key} must be a positive integer no greater than the hard limit.`);
    }
    result[key] = requested;
  }
  return result;
}

function sortedRoles(roles: ReadonlySet<AmpleFileCheckTargetRole>): AmpleFileCheckTargetRole[] {
  return [...roles].sort((left, right) => roleOrder(left) - roleOrder(right));
}

function roleOrder(role: AmpleFileCheckTargetRole): number {
  return role === "primary" ? 0 : 1;
}

function assertLexicallyInside(root: string, candidate: string, targetPath: string): void {
  if (!pathContains(root, candidate)) {
    throw new AmpleFileCheckTargetResolutionError("UNSAFE_PATH", "Check target path escapes its Connected Folder.", { targetPath });
  }
}

function assertCanonicalInside(root: string, candidate: string, targetPath: string): void {
  if (!pathContains(root, candidate)) {
    throw new AmpleFileCheckTargetResolutionError("UNSAFE_PATH", "Check target resolves outside its Connected Folder.", { targetPath });
  }
}

function pathContains(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function checkedLstat(
  path: string,
  fallback: string,
  code: AmpleFileCheckTargetResolutionErrorCode,
  targetPath?: string,
): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    if (code === "INVALID_ROOT") {
      throw new AmpleFileCheckTargetResolutionError(code, fallback, { targetPath, cause: error });
    }
    throw filesystemError(error, fallback, targetPath);
  }
}

async function checkedRealpath(path: string, fallback: string, targetPath?: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw filesystemError(error, fallback, targetPath);
  }
}

function filesystemError(error: unknown, fallback: string, targetPath?: string): AmpleFileCheckTargetResolutionError {
  if (error instanceof AmpleFileCheckTargetResolutionError) return error;
  return new AmpleFileCheckTargetResolutionError("FILESYSTEM_ERROR", fallback, { targetPath, cause: error });
}

function limitError(message: string, targetPath?: string): AmpleFileCheckTargetResolutionError {
  return new AmpleFileCheckTargetResolutionError("LIMIT_EXCEEDED", message, { targetPath });
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
