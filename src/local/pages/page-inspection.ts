/**
 * Validating and assembling one page folder (docs/pages.md, "How a page
 * runs", "For the Worker"): page.json, the entry, every reference, sizes, and
 * nested pages. The page tab, the local API, and `amplefile pages validate`
 * all report the same problems from here.
 */
import type { PageDeclaration, PageInspection, PageProblem } from "../../shared/pages/index.js";
import { formatPageDeclarationProblem, pageEntryProblem, parsePageDeclarationText } from "../../shared/pages/index.js";
import { processPageEntry, type PageDocumentMode } from "./page-document.js";
import {
  type PageFolderFile,
  enclosingPageFolder,
  formatBytes,
  normalizePagePath,
  pageDeclarationFileName,
  pageFolderLimits,
  readConnectedFolderFileBytes,
  readConnectedFolderTextFile,
  resolvePageFolder,
  walkPageFolder,
} from "./page-folder-files.js";

/** At most this many problems are listed; one more line says how many were left out. */
const maxListedProblems = 200;

export interface PageFolderAnalysis extends PageInspection {
  /** The parsed declaration, or null while page.json has problems. */
  declaration: PageDeclaration | null;
  /** The assembled document ("assemble" mode, no errors), otherwise null. */
  html: string | null;
  /** The files that make up the page, in path order: what publishing uploads. */
  files: PageFolderFile[];
}

export interface PageDeclarationRead {
  path: string;
  declaration: PageDeclaration | null;
  problems: PageProblem[];
  /** Best-effort title for display even while page.json has problems. */
  title: string;
}

/** Reads and parses just page.json: what page calls and the Data view need. */
export async function readPageFolderDeclaration(connectedFolderRoot: string, page: unknown): Promise<PageDeclarationRead> {
  const path = normalizePagePath(page);
  await resolvePageFolder(connectedFolderRoot, path);
  return readDeclaration(connectedFolderRoot, path);
}

async function readDeclaration(connectedFolderRoot: string, path: string): Promise<PageDeclarationRead & { rawEntry: string | null; rawDescription: string | null }> {
  const folderName = path.split("/").at(-1) ?? path;
  let text: string;
  try {
    text = await readConnectedFolderTextFile(connectedFolderRoot, `${path}/${pageDeclarationFileName}`, pageFolderLimits.maxDeclarationBytes);
  } catch (failure) {
    const message = failure instanceof Error && /larger than/u.test(failure.message)
      ? `page.json can be at most ${formatBytes(pageFolderLimits.maxDeclarationBytes)}.`
      : failure instanceof Error && /UTF-8/u.test(failure.message) ? "page.json isn't UTF-8 text." : "page.json couldn't be read.";
    return { path, declaration: null, problems: [{ file: pageDeclarationFileName, message, severity: "error" }], title: folderName, rawEntry: null, rawDescription: null };
  }
  const parsed = parsePageDeclarationText(text);
  if (parsed.ok) {
    return {
      path,
      declaration: parsed.declaration,
      problems: [],
      title: parsed.declaration.title,
      rawEntry: parsed.declaration.entry,
      rawDescription: parsed.declaration.description ?? null,
    };
  }
  // Still show what can be shown: a title, a description, and the entry.
  let raw: Record<string, unknown> = {};
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) raw = value as Record<string, unknown>;
  } catch { /* Reported as a problem already. */ }
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 120) : folderName;
  return {
    path,
    declaration: null,
    problems: parsed.problems.map((problem) => ({ file: pageDeclarationFileName, message: formatPageDeclarationProblem(problem), severity: "error" as const })),
    title,
    rawEntry: pageEntryProblem(raw.entry) === null ? raw.entry as string : null,
    rawDescription: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim().slice(0, 500) : null,
  };
}

/**
 * Checks one page folder. In "assemble" mode it also builds the document,
 * which is returned only when nothing is an error.
 */
export async function analyzePageFolder(connectedFolderRoot: string, page: unknown, mode: PageDocumentMode = "check"): Promise<PageFolderAnalysis> {
  const path = normalizePagePath(page);
  await resolvePageFolder(connectedFolderRoot, path);
  const problems: PageProblem[] = [];
  const enclosing = await enclosingPageFolder(connectedFolderRoot, path);
  if (enclosing) {
    problems.push({ file: "", message: `This folder is inside another page folder (${enclosing}). A page folder can't contain another page folder.`, severity: "error" });
  }
  const declarationRead = await readDeclaration(connectedFolderRoot, path);
  problems.push(...declarationRead.problems);
  const walk = await walkPageFolder(connectedFolderRoot, path);
  problems.push(...walk.problems);

  const declaration = declarationRead.declaration;
  const entry = declaration?.entry ?? declarationRead.rawEntry ?? "index.html";
  let html: string | null = null;
  if (!walk.files.has(entry)) {
    problems.push({ file: entry, message: `The page's entry file ${entry} isn't in the page folder.`, severity: "error" });
  } else {
    const processed = await processPageEntry(entry, {
      files: walk.files,
      readText: (file) => readConnectedFolderTextFile(connectedFolderRoot, `${path}/${file}`, pageFolderLimits.maxFileBytes),
      readBytes: (file) => readConnectedFolderFileBytes(connectedFolderRoot, `${path}/${file}`, pageFolderLimits.maxFileBytes),
    }, mode);
    problems.push(...processed.problems);
    html = processed.html;
  }
  for (const file of walk.files.keys()) {
    if (file !== entry && /\.html?$/iu.test(file)) {
      problems.push({ file, message: `Only ${entry} is the page, so this file isn't used. A page that needs several screens switches them in script.`, severity: "warning" });
    }
  }

  const ordered = dedupeProblems([
    ...problems.filter((problem) => problem.severity === "error"),
    ...problems.filter((problem) => problem.severity === "warning"),
  ]);
  const listed = ordered.length > maxListedProblems
    ? [...ordered.slice(0, maxListedProblems), { file: "", message: `…and ${ordered.length - maxListedProblems} more problems.`, severity: "error" as const }]
    : ordered;
  const hasErrors = ordered.some((problem) => problem.severity === "error");
  return {
    page: {
      path,
      title: declarationRead.title,
      description: declarationRead.rawDescription,
      entry,
      tables: declaration?.tables ?? [],
    },
    problems: listed,
    summary: { files: walk.files.size, bytes: walk.bytes },
    declaration,
    html: mode === "assemble" && !hasErrors ? html : null,
    files: [...walk.files.values()].map((file) => ({ path: file.path, size: file.size })),
  };
}

/** `GET …/pages/inspect`: the page, its problems, and a summary. */
export async function inspectPageFolder(connectedFolderRoot: string, page: unknown): Promise<PageInspection> {
  const { page: summaryPage, problems, summary } = await analyzePageFolder(connectedFolderRoot, page, "check");
  return { page: summaryPage, problems, summary };
}

/** `GET …/pages/document`: the assembled document, or null when errors prevent it. */
export async function assemblePageFolder(connectedFolderRoot: string, page: unknown): Promise<{ html: string | null; problems: PageProblem[] }> {
  const { html, problems } = await analyzePageFolder(connectedFolderRoot, page, "assemble");
  return { html, problems };
}

function dedupeProblems(problems: PageProblem[]): PageProblem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.severity}\u0000${problem.file}\u0000${problem.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
