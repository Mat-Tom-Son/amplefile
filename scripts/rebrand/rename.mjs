// The AmpleFile rename (docs/rebrand-plan.md): rewrites every spelling of the
// old names in code, strings, CSS, documents, and file names.
//
//   node scripts/rebrand/rename.mjs --dry-run --report <file>
//   node scripts/rebrand/rename.mjs --report <file>
//
// Code (identifiers, identifier-like strings, CSS, paths) keeps each token's
// case style:
//
//   workFolder / WorkFolder / work-folder / WORK_FOLDER → connectedFolder / ConnectedFolder / connected-folder / CONNECTED_FOLDER
//   workFold / WorkFold                                 → ampleFile / AmpleFile
//   work-fold / WORK_FOLD / WORKFOLD / workfold         → amplefile / AMPLEFILE (one word, never ample-file)
//   wf-… (the app kit's classes and --wf-* variables)  → af-…
//
// Prose (comments, interface text, documents) uses the display names, always
// capitalized: "work-folder" → "Connected Folder", "work-fold" → "AmpleFile",
// "work-fold agent" → "AmpleFile agent". The command stays lowercase where
// prose runs it ("work-fold chat send" → "amplefile chat send").
//
// The rule set is idempotent: nothing it writes contains an old name.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scriptExtensions, scriptRegions, tokenPattern } from "../vocabulary/scan.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Never rewritten: the rename's own record, the October codemod, and third-party code. */
const skippedPaths = [
  /^scripts\/rebrand\//,
  /^scripts\/vocabulary\/(?!GLOSSARY\.md$)/,
  /^docs\/rebrand-plan\.md$/,
  /^resources\/included-tools\/.*\/vendor\//,
  /\.patch$/,
  /(^|\/)package-lock\.json$/,
];

const binaryExtensions = /\.(png|jpe?g|webp|gif|ico|icns|woff2?|ttf|otf|pdf|zip|node|dylib|mp4|mov|svg|car|tiff?)$/i;

// --- code tokens --------------------------------------------------------------

/** Splits a token into pieces { sep, word }; `sep` is the separator text before the piece. */
export function pieces(token) {
  const out = [];
  let sep = "";
  for (const segment of token.split(/([-._$/])/)) {
    if (/^[-._$/]$/.test(segment)) { sep += segment; continue; }
    if (!segment) continue;
    const humps = segment.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean);
    humps.forEach((word, index) => out.push({ sep: index === 0 ? sep : "", word }));
    sep = "";
  }
  return { list: out, trailing: sep };
}

function styleOf(word) {
  if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return "upper";
  return /^[A-Z]/.test(word) ? "capital" : "lower";
}

function inStyle(word, model) {
  const style = styleOf(model);
  if (style === "upper") return word.toUpperCase();
  if (style === "capital") return word[0].toUpperCase() + word.slice(1);
  return word;
}

/** Maps one code token, preserving its case style. */
export function mapToken(token) {
  if (!/work|wf/i.test(token)) return token;
  const { list, trailing } = pieces(token);
  const lower = list.map((piece) => piece.word.toLowerCase());
  const out = [];
  let changed = false;
  for (let index = 0; index < list.length; index += 1) {
    const piece = list[index];
    if (lower[index] === "work" && (lower[index + 1] === "folder" || lower[index + 1] === "folders")) {
      out.push({ sep: piece.sep, word: inStyle("connected", piece.word) });
      changed = true;
      continue;
    }
    if (lower[index] === "work" && lower[index + 1] === "fold") {
      const style = styleOf(piece.word);
      const camel = list[index + 1].sep === "";
      if (style === "upper") out.push({ sep: piece.sep, word: "AMPLEFILE" });
      else if (camel) out.push({ sep: piece.sep, word: style === "capital" ? "AmpleFile" : "ampleFile" });
      else out.push({ sep: piece.sep, word: style === "capital" ? "AmpleFile" : "amplefile" });
      index += 1;
      changed = true;
      continue;
    }
    if (lower[index] === "workfold") {
      const style = styleOf(piece.word);
      out.push({ sep: piece.sep, word: style === "upper" ? "AMPLEFILE" : style === "capital" ? "AmpleFile" : "amplefile" });
      changed = true;
      continue;
    }
    // The app kit: wf-button, --wf-accent, `--wf-${name}`. A bare `wf` (a variable, an id) stays.
    if (lower[index] === "wf" && index === 0 && (list[1]?.sep.endsWith("-") || (list.length === 1 && trailing.startsWith("-")))) {
      out.push({ sep: piece.sep, word: inStyle("af", piece.word) });
      changed = true;
      continue;
    }
    out.push(piece);
  }
  return changed ? out.map((piece) => piece.sep + piece.word).join("") + trailing : token;
}

function rewriteCode(text, stats, cls) {
  return text.replace(tokenPattern, (token, offset, whole) => {
    if (offset > 0 && /[A-Za-z0-9_$]/.test(whole[offset - 1])) return token;
    // A kit prefix written on its own: "wf-" + name.
    const next = token === "wf" && whole[offset + 2] === "-" ? "af" : mapToken(token);
    if (next !== token) count(stats, cls, token, next);
    return next;
  });
}

// --- prose --------------------------------------------------------------------

/** Command families and agent verbs: "work-fold chat send" runs the command. */
const cliFamilies = new Set(["agent", "apps", "automations", "capabilities", "chat", "chats", "checks", "context", "files", "help", "history",
  "jobs", "pages", "recently-deleted", "requests", "search", "skill", "tasks", "tools", "version", "work-folders", "worktrees"]);
const agentVerbs = new Set(["abort", "answer", "ask", "list", "overview", "result", "send", "status", "stop", "wait"]);
/** Prose compounds: "work-folder-relative path" → "Connected Folder–relative path". */
const folderAdjectives = new Set(["relative", "owned", "scoped", "bound", "free", "local", "level", "aware", "specific", "wide", "only", "based"]);
const brandAdjectives = new Set(["owned", "only", "managed", "specific", "side", "wide", "native", "free", "facing", "level"]);
/** A name right after one of these is code: a path, flag, placeholder, anchor, or code span. */
const codeBefore = new Set([".", "/", "-", "_", ":", "@", "<", "`", "|", "$", "{", "#", "\\", "=", "~"]);

/** Words after a command name, as text offsets the caller treats as code. */
function commandWords(after) {
  const match = /^ ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/.exec(after);
  if (!match) return 0;
  if (match[1] === "agent") return match[2] && agentVerbs.has(match[2]) ? match[0].length : 0;
  return cliFamilies.has(match[1]) ? match[0].length : 0;
}

export function rewriteProse(text, stats, { cliLead = false } = {}) {
  const phrased = text.replace(/\b([Ss])ub work-folder(s?)\b/g, (match, s, plural) => {
    count(stats, "prose", match, `${s === "S" ? "Nested" : "nested"} Connected Folder${plural}`);
    return `${s === "S" ? "Nested" : "nested"} Connected Folder${plural}`;
  });
  let codeUntil = cliLead ? (/^ ?[a-z][a-z-]*(?: [a-z][a-z-]*)?/.exec(phrased)?.[0].length ?? 0) : -1;
  return phrased.replace(tokenPattern, (token, offset, whole) => {
    if (offset > 0 && /[A-Za-z0-9_$]/.test(whole[offset - 1])) return token;
    if (!/work|wf/i.test(token)) return token;
    const before = whole[offset - 1] ?? "";
    const after = whole.slice(offset + token.length, offset + token.length + 48);
    const code = offset < codeUntil
      || codeBefore.has(before)
      || (/["']/.test(before) && /[=([]/.test(whole[offset - 2] ?? ""))
      || /^[:/][^\s]/.test(after);
    let next = null;
    if (!code) {
      const lower = token.toLowerCase();
      const upper = token === token.toUpperCase();
      if (lower === "work-fold") {
        if (/^ repositor(y|ies)\b/.test(after)) return token;
        const article = /\b(the|a|an|your|this|that|every|its|each)\s$/i.test(whole.slice(Math.max(0, offset - 8), offset));
        const words = article ? 0 : commandWords(after);
        if (words) {
          codeUntil = offset + token.length + words;
          next = "amplefile";
        } else next = upper ? "AMPLEFILE" : "AmpleFile";
      } else if (lower === "work-folder" || lower === "work-folders") {
        next = (upper ? "CONNECTED FOLDER" : "Connected Folder") + (lower.endsWith("s") ? (upper ? "S" : "s") : "");
      } else {
        const compound = /^work-(folders?|fold)-([a-z]+)$/i.exec(token);
        if (compound && compound[1].toLowerCase().startsWith("folder") && folderAdjectives.has(compound[2])) {
          next = `Connected Folder${compound[1].endsWith("s") ? "s" : ""}–${compound[2]}`;
        } else if (compound && compound[1].toLowerCase() === "fold" && brandAdjectives.has(compound[2])) {
          next = `AmpleFile-${compound[2]}`;
        }
      }
    }
    if (next === null) next = mapToken(token);
    if (next !== token) count(stats, code ? "prose-code" : "prose", token, next);
    return next;
  });
}

// --- files --------------------------------------------------------------------

/**
 * A className list ("fm-row work-folder-row") is code even though it has
 * spaces. A lowercase sentence with one hyphenated word ("work-fold
 * executable was not found at") is not: outside a class context, at least
 * half the words must be hyphenated.
 */
function isClassList(value, before = "") {
  const words = value.trim().split(/\s+/);
  if (!words.length || !words.every((word) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(word))) return false;
  const hyphenated = words.filter((word) => word.includes("-")).length;
  if (!hyphenated) return false;
  return /class(?:Name|List|es)?\s*[=:(?]|\b(?:clsx|cx|classNames)\(/.test(before) || hyphenated * 2 >= words.length;
}

/** Strings that are display text even without a space. */
const displayWords = /^(Work-folders?|WORK-FOLDERS?)$/;
/** Interpolations that hold the command's name: `${executable} work-folders list`. */
const commandInterpolation = /\$\{\s*(?:executable|cli|cmd|command|cliCommand|productIdentity\.cliCommand)\s*\}$/;

function rewriteScript(file, text, stats, review) {
  let out = "";
  let cursor = 0;
  for (const region of scriptRegions(file, text)) {
    if (region.start < cursor) continue;
    const value = text.slice(region.start, region.end);
    let next = value;
    if (region.cls === "ident") next = rewriteCode(value, stats, "ident");
    else if (region.cls === "comment" || region.cls === "jsx") next = rewriteProse(value, stats);
    else if (region.cls === "regex") next = /\s/.test(value) ? rewriteProse(value, stats) : rewriteCode(value, stats, "regex");
    else if (region.cls === "string") {
      const cliLead = commandInterpolation.test(text.slice(Math.max(0, region.start - 40), region.start));
      const before = text.slice(Math.max(0, region.start - 60), region.start);
      if (displayWords.test(value) || (/\s/.test(value) && !isClassList(value, before))) next = rewriteProse(value, stats, { cliLead });
      else {
        next = rewriteCode(value, stats, "idstring");
        if (/^work-fold$/i.test(value)) review.push(`${file}:${lineOf(text, region.start)}\t"${value}" → "${next}" (a lone brand string: id or display name?)`);
      }
    }
    out += text.slice(cursor, region.start) + next;
    cursor = region.end;
  }
  return out + text.slice(cursor);
}

function rewriteMarkdown(text, stats) {
  return text.split(/(```[\s\S]*?```)/).map((part) => {
    if (part.startsWith("```")) return rewriteCode(part, stats, "md-code");
    return part.split(/(`[^`\n]+`)/).map((piece) => piece.startsWith("`") && piece.endsWith("`") && piece.length > 1
      ? rewriteCode(piece, stats, "md-code")
      : rewriteProse(piece, stats)).join("");
  }).join("");
}

function rewriteCss(text, stats) {
  return text.split(/(\/\*[\s\S]*?\*\/)/).map((part) => part.startsWith("/*") ? rewriteProse(part, stats) : rewriteCode(part, stats, "css")).join("");
}

function rewriteHtml(text, stats) {
  return text.split(/(<[^>]*>)/).map((part) => part.startsWith("<") ? rewriteCode(part, stats, "html") : rewriteProse(part, stats)).join("");
}

function rewriteJson(text, stats, file, review) {
  return text.replace(/"((?:[^"\\\n]|\\.)*)"/g, (match, value, offset) => {
    const prose = displayWords.test(value) || /\s/.test(value);
    const next = prose ? rewriteProse(value, stats) : rewriteCode(value, stats, "json");
    if (!prose && /^work-fold$/i.test(value)) review.push(`${file}:${lineOf(text, offset)}\t"${value}" → "${next}" (a lone brand string: id or display name?)`);
    return `"${next}"`;
  });
}

function rewriteByType(file, text, stats, review) {
  if (/\.md$/.test(file)) return rewriteMarkdown(text, stats);
  if (scriptExtensions.test(file)) return rewriteScript(file, text, stats, review);
  if (/\.css$/.test(file)) return rewriteCss(text, stats);
  if (/\.html$/.test(file)) return rewriteHtml(text, stats);
  if (/\.(json|jsonl|webmanifest)$/.test(file)) return rewriteJson(text, stats, file, review);
  return rewriteProse(text, stats);
}

/**
 * The old product name was also the app's file name, so code spelled it in
 * lowercase where the new one is "AmpleFile": the app bundle and executable,
 * its application-data folder, and the productName fields that name them.
 * Schema ids such as `amplefile.app-release` stay lowercase.
 */
export const productNameFixes = [
  [/\bamplefile( Local Smoke| Development)\b/g, "AmpleFile$1"],
  [/\bamplefile\.(app|exe)(?![-\w])/g, "AmpleFile.$1"],
  [/(MacOS|Application Support)\/amplefile(?![-.\w])/g, "$1/AmpleFile"],
  [/(%APPDATA%\\)amplefile(?![-.\w])/g, "$1AmpleFile"],
  [/("Application Support",\s*)"amplefile"/g, '$1"AmpleFile"'],
  [/(productName["']?\s*(?:[:=]|\?\?)\s*)(["'])amplefile\2/g, "$1$2AmpleFile$2"],
  [/(ampleFileCliHelp\()"amplefile"/g, '$1"AmpleFile"'],
];

function rewriteFile(file, text, stats, review) {
  let next = rewriteByType(file, text, stats, review);
  for (const [pattern, replacement] of productNameFixes) next = next.replace(pattern, replacement);
  return next;
}

export function mapPath(path) {
  return path.split("/").map((segment) => segment.replace(tokenPattern, (token) => mapToken(token))).join("/");
}

// --- run ----------------------------------------------------------------------

function count(stats, cls, from, to) {
  const key = `${cls}\t${from}\t${to}`;
  stats.set(key, (stats.get(key) ?? 0) + 1);
}

function lineOf(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const reportIndex = args.indexOf("--report");
  const stats = new Map();
  const review = [];
  const all = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const files = all.filter((file) => !skippedPaths.some((pattern) => pattern.test(file)));

  // Plan every move first and refuse a collision before touching anything.
  const renames = new Map();
  for (const file of files) {
    const target = mapPath(file);
    if (target !== file) renames.set(file, target);
  }
  const targets = new Map();
  for (const [from, to] of renames) {
    if (targets.has(to)) throw new Error(`Two files would move to ${to}: ${targets.get(to)} and ${from}`);
    targets.set(to, from);
    if (all.includes(to) && !renames.has(to)) throw new Error(`${from} would overwrite the existing ${to}`);
  }

  let rewritten = 0;
  for (const file of files) {
    if (binaryExtensions.test(file)) continue;
    const full = join(root, file);
    if (!lstatSync(full).isFile()) continue;
    const text = readFileSync(full, "utf8");
    if (text.includes("\u0000")) continue;
    const next = rewriteFile(file, text, stats, review);
    if (next !== text) {
      rewritten += 1;
      if (!dryRun) writeFileSync(full, next);
    }
  }
  if (!dryRun) {
    for (const [from, to] of renames) {
      mkdirSync(dirname(join(root, to)), { recursive: true });
      execFileSync("git", ["-C", root, "mv", from, to]);
    }
  }
  console.log(JSON.stringify({ filesRewritten: rewritten, distinctChanges: stats.size, renames: renames.size, review: review.length }));
  if (reportIndex >= 0) {
    const lines = [...stats.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${n}\t${key}`);
    writeFileSync(args[reportIndex + 1], [
      "# review", ...review, "",
      "# changes (count, class, from, to)", ...lines, "",
      "# renames", ...[...renames].map(([a, b]) => `${a} -> ${b}`),
    ].join("\n"));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
