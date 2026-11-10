// A guard against the predecessor's names coming back. It finds the old
// brand ("work-fold"), its folder noun ("work-folder"), its agent ("work-fold
// agent"), its environment prefix (WORKFOLD_), and its app kit's "wf" prefix,
// in every spelling, and sorts each use three ways:
//
//   concept  which name it is
//   area     where it lives (interface, local server, CLI, desktop, tests, docs…)
//   class    how it is written (code identifier, identifier-like string,
//            interface text, comment, document, CSS, JSON)
//
// It also names the contracts a use belongs to: names written to disk, sent
// between processes, or read by something AmpleFile does not ship.
//
//   node scripts/rebrand/inventory.mjs                  # summary
//   node scripts/rebrand/inventory.mjs --markdown <file> # full report
//   node scripts/rebrand/inventory.mjs --json <file>     # every token
//   node scripts/rebrand/inventory.mjs --check           # fail if any remain
//
// Third-party code, patches, and binary assets are skipped.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const scriptExtensions = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

/** Third-party code, patches, generated files, and binary assets. */
const excludedPaths = [
  /^patches\//,
  /^desktop\/assets\//,
  /^resources\/included-tools\/.*\/vendor\//,
  /package-lock\.json$/,
  /\.(png|jpe?g|webp|gif|ico|icns|woff2?|ttf|otf|pdf|zip|node|dylib|mp4|mov|svg)$/,
];

/** Files that name the old spellings on purpose: this guard itself. */
const guardPaths = [
  /^scripts\/rebrand\//,
];

function trackedFiles() {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !excludedPaths.some((pattern) => pattern.test(file)));
}

/** Identifier-shaped token: camelCase, PascalCase, snake, kebab, dotted. */
const tokenPattern = /[A-Za-z_$][A-Za-z0-9_$]*(?:[-.][A-Za-z0-9_$]+)*/g;

/** Split an identifier-shaped token into lowercase word parts. */
function wordParts(token) {
  return token
    .split(/[-._$]+/)
    .flatMap((piece) => piece.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/**
 * Walk a script file and yield every text region with its syntactic class:
 * ident (code identifier), string (literal or template text), jsx (JSX text),
 * regex, comment.
 */
function* scriptRegions(file, text) {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : /\.(m|c)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const seenComments = new Set();
  const comments = [];
  const collectComments = (pos) => {
    for (const range of [...(ts.getLeadingCommentRanges(text, pos) ?? []), ...(ts.getTrailingCommentRanges(text, pos) ?? [])]) {
      if (seenComments.has(range.pos)) continue;
      seenComments.add(range.pos);
      comments.push({ cls: "comment", start: range.pos, end: range.end });
    }
  };
  const regions = [];
  const visit = (node) => {
    collectComments(node.getFullStart());
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      regions.push({ cls: "ident", start: node.getStart(source), end: node.getEnd() });
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      regions.push({ cls: "string", start: node.getStart(source) + 1, end: node.getEnd() - 1 });
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = node.getStart(source);
      const raw = text.slice(start, node.getEnd());
      const openLen = raw.startsWith("`") || raw.startsWith("}") ? 1 : 0;
      const closeLen = raw.endsWith("${") ? 2 : raw.endsWith("`") ? 1 : 0;
      regions.push({ cls: "string", start: start + openLen, end: node.getEnd() - closeLen });
    } else if (ts.isJsxText(node)) {
      regions.push({ cls: "jsx", start: node.getStart(source, false), end: node.getEnd() });
    } else if (ts.isRegularExpressionLiteral(node)) {
      regions.push({ cls: "regex", start: node.getStart(source), end: node.getEnd() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  collectComments(source.endOfFileToken.getFullStart());
  yield* [...regions, ...comments].sort((a, b) => a.start - b.start);
}

/** A string region is identifier-like when it has no whitespace (keys, routes, ids, paths). */
function isIdentifierLikeString(value) {
  return value.length > 0 && !/\s/.test(value);
}

export const concepts = [
  { id: "agent", label: "work-fold agent", test: (parts) => hasRun(parts, ["work", "fold", "agent"]) },
  { id: "noun", label: "work-folder", test: (parts) => hasRun(parts, ["work", "folder"]) || hasRun(parts, ["work", "folders"]) },
  { id: "brand", label: "work-fold", test: (parts) => hasRun(parts, ["work", "fold"]) || parts.includes("workfold") },
  { id: "kit", label: "wf (app kit prefix)", test: (parts, token) => /^(--)?wf-/i.test(token) },
];

export const areas = [
  { id: "cli", label: "CLI (installed command, act lane)", test: (file) => /^src\/local\/cli\/|^desktop\/cli\//.test(file) },
  { id: "interface", label: "Interface (web-local)", test: (file) => file.startsWith("web-local/") },
  { id: "server", label: "Local server and agents (src/local)", test: (file) => file.startsWith("src/local/") },
  { id: "shared", label: "Shared contracts (src/shared)", test: (file) => file.startsWith("src/shared/") },
  { id: "desktop", label: "Desktop process (desktop/)", test: (file) => file.startsWith("desktop/") },
  { id: "tools", label: "Included tools (resources/)", test: (file) => file.startsWith("resources/") },
  { id: "tests", label: "Tests", test: (file) => file.startsWith("tests/") },
  { id: "skills", label: "Agent Skills and harness files", test: (file) => /^\.agents\/|^\.claude\/|^\.codex\/|^AGENTS\.md$|^CLAUDE\.md$/.test(file) },
  { id: "docs", label: "Documents", test: (file) => /\.md$/.test(file) },
  { id: "build", label: "Build, packaging, and scripts", test: () => true },
];

/** Contracts: a name that leaves the source code. */
export const contracts = [
  { id: "identity", label: "Product identity file (src/shared/product-identity.json)", test: (value, file) => file === "src/shared/product-identity.json" },
  { id: "bundle", label: "App ids, bundle ids, and URL scheme", test: (value) => /com\.work-fold|work-fold-desktop:|^work-fold-desktop$/.test(value) },
  { id: "portable", label: "Portable metadata folder (.work-fold/)", test: (value) => /(^|[^\w-])\.work-fold(\/|$|[^\w-])/.test(value) },
  { id: "env", label: "Environment variables (WORKFOLD_*)", test: (value) => /\bWORKFOLD_[A-Z0-9_]+/.test(value) },
  { id: "routes", label: "Local HTTP routes and headers", test: (value) => /\/api\/work-fold|\/api\/work-folders|x-work-fold-/.test(value) },
  { id: "ipc", label: "Desktop IPC channels (work-fold:…)", test: (value) => /^work-fold:[a-z]/.test(value) },
  { id: "storage", label: "Renderer storage keys (work-fold.…)", test: (value) => /^work-fold\.[a-z]/.test(value) },
  { id: "globals", label: "Window globals", test: (value) => /\b(workFoldDesktop|workFoldRestrictedApp|workFoldPage)\b/.test(value) },
  { id: "command", label: "The installed command name (work-fold …)", test: (value, file, cls) => /(^|[\s`'"(])work-fold (agent|chat|chats|context|history|files|search|work-folders|tools|automations|recently-deleted|requests|jobs|worktrees|help)\b/.test(value) || (cls === "idstring" && value === "work-fold") },
  { id: "skills", label: "Skill and folder names the agent uses", test: (value) => /manage-work-folders|work-fold-agent/.test(value) },
  { id: "repos", label: "Source and release repositories", test: (value) => /Mat-Tom-Son\/work-fold|work-fold-mac-releases/.test(value) },
];

function hasRun(parts, run) {
  for (let index = 0; index + run.length <= parts.length; index += 1) {
    if (run.every((part, offset) => parts[index + offset] === part)) return true;
  }
  return false;
}

function classRegions(file, text) {
  if (scriptExtensions.test(file)) {
    return [...scriptRegions(file, text)].map((region) => {
      const value = text.slice(region.start, region.end);
      const cls = region.cls === "string" ? (isIdentifierLikeString(value) ? "idstring" : "text") : region.cls === "jsx" ? "text" : region.cls;
      return { cls, value };
    });
  }
  if (/\.(md|txt)$/.test(file)) return [{ cls: "doc", value: text }];
  if (/\.css$/.test(file)) return [{ cls: "css", value: text }];
  if (/\.(json|jsonl)$/.test(file)) return [{ cls: "json", value: text }];
  return [{ cls: "other", value: text }];
}

/** Every old product-name use in the tracked tree. */
export function collect() {
  const uses = [];
  for (const file of trackedFiles()) {
    if (guardPaths.some((pattern) => pattern.test(file))) continue;
    let text;
    try { text = readFileSync(join(root, file), "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue;
    const area = areas.find((candidate) => candidate.test(file)).id;
    const fileName = file.split("/").pop();
    const nameParts = wordParts(fileName.replace(/\.[^.]+$/, ""));
    const fileConcept = concepts.find((concept) => concept.test(nameParts, fileName));
    if (fileConcept) uses.push({ file, area, cls: "filename", concept: fileConcept.id, token: fileName, contract: null });
    for (const region of classRegions(file, text)) {
      const lineContracts = contractsIn(region.value, file, region.cls);
      for (const match of region.value.matchAll(tokenPattern)) {
        const token = match[0];
        // A literal value that keeps the old spelling: the earlier app's
        // portable `.work-fold/` folder, which AmpleFile hides and never reads.
        if (/^work-fold$/i.test(token) && region.value[match.index - 1] === ".") continue;
        const parts = wordParts(token);
        let concept = concepts.find((candidate) => candidate.test(parts, token));
        if (!concept) continue;
        // Prose writes the agent as two words: "work-fold agent".
        if (concept.id === "brand" && /^ agents?\b/.test(region.value.slice(match.index + token.length, match.index + token.length + 8))) {
          concept = concepts.find((candidate) => candidate.id === "agent");
        }
        const context = region.value.slice(Math.max(0, match.index - 60), match.index + token.length + 60);
        const contract = contracts.find((candidate) => candidate.test(region.cls === "idstring" ? region.value : context, file, region.cls) && lineContracts.has(candidate.id))?.id ?? null;
        uses.push({ file, area, cls: region.cls, concept: concept.id, token, contract });
      }
    }
  }
  return uses;
}

function contractsIn(value, file, cls) {
  const found = new Set();
  for (const contract of contracts) if (contract.test(value, file, cls)) found.add(contract.id);
  return found;
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function distinct(items, key) {
  return new Set(items.map(key)).size;
}

function markdown(uses) {
  const lines = [];
  const files = distinct(uses, (use) => use.file);
  lines.push("# Old product-name inventory", "", `Generated by \`node scripts/rebrand/inventory.mjs --markdown <file>\` on ${new Date().toISOString().slice(0, 10)}.`, "");
  lines.push(`**${uses.length.toLocaleString("en-US")} uses in ${files} files.**`, "");
  lines.push("## By concept", "", "| Concept | Uses | Files | Distinct spellings |", "|---|---:|---:|---:|");
  for (const concept of concepts) {
    const rows = uses.filter((use) => use.concept === concept.id);
    lines.push(`| ${concept.label} | ${rows.length} | ${distinct(rows, (use) => use.file)} | ${distinct(rows, (use) => use.token)} |`);
  }
  lines.push("", "## By area", "", "| Area | Uses | Files |", "|---|---:|---:|");
  for (const area of areas) {
    const rows = uses.filter((use) => use.area === area.id);
    if (rows.length) lines.push(`| ${area.label} | ${rows.length} | ${distinct(rows, (use) => use.file)} |`);
  }
  const classLabels = { ident: "Code identifiers", idstring: "Identifier-like strings (keys, routes, ids, paths)", text: "Interface and message text", comment: "Comments", doc: "Documents", css: "CSS", json: "JSON", other: "Other files", regex: "Regular expressions", filename: "File names" };
  lines.push("", "## By how it is written", "", "| Class | Uses |", "|---|---:|");
  for (const [cls, count] of countBy(uses, (use) => use.cls)) lines.push(`| ${classLabels[cls] ?? cls} | ${count} |`);
  lines.push("", "## Contracts", "", "Names that leave the source code.", "");
  for (const contract of contracts) {
    const rows = uses.filter((use) => use.contract === contract.id);
    if (!rows.length) continue;
    lines.push(`### ${contract.label}`, "", `${rows.length} uses in ${distinct(rows, (use) => use.file)} files. Most frequent spellings:`, "");
    for (const [token, count] of countBy(rows, (use) => use.token).slice(0, 12)) lines.push(`- \`${token}\` (${count})`);
    lines.push("");
  }
  lines.push("## File names", "", "Files and folders whose own names carry an old product name:", "");
  for (const use of uses.filter((item) => item.cls === "filename").sort((a, b) => a.file.localeCompare(b.file))) lines.push(`- \`${use.file}\``);
  lines.push("", "## Most frequent spellings per concept", "");
  for (const concept of concepts) {
    const rows = uses.filter((use) => use.concept === concept.id && use.cls !== "filename");
    if (!rows.length) continue;
    lines.push(`### ${concept.label}`, "");
    for (const [token, count] of countBy(rows, (use) => use.token).slice(0, 25)) lines.push(`- \`${token}\` (${count})`);
    lines.push("");
  }
  lines.push("## Files with the most uses", "", "| File | Uses |", "|---|---:|");
  for (const [file, count] of countBy(uses, (use) => use.file).slice(0, 40)) lines.push(`| \`${file}\` | ${count} |`);
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const uses = collect();
  if (args.includes("--check")) {
    if (uses.length) {
      console.error(`${uses.length} old product-name uses remain in ${distinct(uses, (use) => use.file)} files. Run with --markdown to see where.`);
      process.exit(1);
    }
    console.log("No old product names remain.");
    return;
  }
  console.log(`${uses.length} uses in ${distinct(uses, (use) => use.file)} files`);
  console.log("by concept:", Object.fromEntries(concepts.map((concept) => [concept.id, uses.filter((use) => use.concept === concept.id).length])));
  console.log("by area:", Object.fromEntries(countBy(uses, (use) => use.area)));
  console.log("contracts:", Object.fromEntries(countBy(uses.filter((use) => use.contract), (use) => use.contract)));
  const markdownPath = valueAfter("--markdown");
  if (markdownPath) writeFileSync(markdownPath, markdown(uses));
  const jsonPath = valueAfter("--json");
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(uses));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
