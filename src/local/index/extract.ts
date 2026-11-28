/**
 * Text extraction and chunking for the index (docs/index-and-recall.md).
 *
 * Plain text and Markdown are chunked by paragraph into pieces of roughly
 * 200 to 400 words with a small overlap; Markdown chunks carry the headings
 * that enclose them. Word-processing documents, spreadsheets, and
 * presentations (DOCX, XLSX, PPTX and their macro and template variants) are
 * read from their own XML with a bounded in-process ZIP reader, so nothing
 * runs LibreOffice or loads the Documents tool's libraries into the host. A
 * PDF's text comes from macOS PDFKit in a short-lived `osascript` child; on
 * other systems a PDF is `unsupported`.
 *
 * Every read is one bounded read of an already-open file that is closed
 * before anything else is awaited.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { looksBinary } from "../search.js";
import type { ChunkLocation, IndexedChunk, IndexedFileStatus } from "./store.js";

export const indexExtractionBounds = Object.freeze({
  /** Plain text and Markdown larger than this are recorded `too-large`. */
  maxTextBytes: 4 * 1024 * 1024,
  /** Office documents and PDFs larger than this are recorded `too-large`. */
  maxDocumentBytes: 32 * 1024 * 1024,
  /** One ZIP member (such as `word/document.xml`) is inflated to at most this. */
  maxArchiveMemberBytes: 16 * 1024 * 1024,
  maxChunksPerFile: 400,
  maxPdfPages: 500,
  targetWords: 300,
  maxWords: 400,
  overlapWords: 50,
  /** One chunk's text is cut at this many characters (a line with no spaces). */
  maxChunkCharacters: 8_000,
});

export type IndexedContentKind = "text" | "code" | "markdown" | "docx" | "xlsx" | "pptx" | "pdf" | "chat";

/**
 * Kinds whose chunks get sentence vectors: prose. Source code, structured
 * data, and spreadsheets are searched by words only; a sentence embedding
 * adds little to them and costs most of the indexing time.
 */
export const embeddedContentKinds: readonly IndexedContentKind[] = ["text", "markdown", "docx", "pptx", "pdf", "chat"];

/** Plain-text files read as prose; any other text file is indexed as `code` (words only). */
const proseTextExtensions = new Set(["", ".txt", ".text", ".rst", ".adoc", ".asciidoc", ".org", ".tex", ".rtf", ".eml", ".textile", ".wiki"]);

export type FileExtraction =
  | { status: "indexed"; kind: IndexedContentKind; sha256: string; chunks: IndexedChunk[]; truncated: boolean }
  | { status: Exclude<IndexedFileStatus, "indexed" | "pending" | "not-downloaded">; sha256: string | null }
  /** The file changed while it was read; it stays pending for the next pass. */
  | { status: "changed"; sha256: null };

const markdownExtensions = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);
const wordExtensions = new Set([".docx", ".docm", ".dotx", ".dotm"]);
const sheetExtensions = new Set([".xlsx", ".xlsm", ".xltx", ".xltm"]);
const slideExtensions = new Set([".pptx", ".pptm", ".potx", ".potm"]);
/** Formats that are never text and are not extracted. */
const unsupportedExtensions = new Set([
  ".doc", ".xls", ".ppt", ".pages", ".numbers", ".key", ".rtfd",
  ".png", ".jpg", ".jpeg", ".gif", ".heic", ".heif", ".webp", ".tif", ".tiff", ".bmp", ".ico", ".psd", ".raw", ".dng",
  ".mp3", ".m4a", ".wav", ".aiff", ".flac", ".mp4", ".mov", ".m4v", ".avi", ".mkv",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".dmg", ".iso", ".pkg",
  ".app", ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".class", ".jar", ".wasm",
  ".sqlite", ".db", ".ttf", ".otf", ".woff", ".woff2",
]);

export function indexedContentKindForPath(path: string): IndexedContentKind | "unsupported" | "sniff" {
  const extension = extname(path).toLowerCase();
  if (markdownExtensions.has(extension)) return "markdown";
  if (wordExtensions.has(extension)) return "docx";
  if (sheetExtensions.has(extension)) return "xlsx";
  if (slideExtensions.has(extension)) return "pptx";
  if (extension === ".pdf") return "pdf";
  if (unsupportedExtensions.has(extension)) return "unsupported";
  return "sniff";
}

export interface ExtractOptions {
  signal?: AbortSignal;
  /** Test seam and platform switch for PDF text; null means PDFs are unsupported here. */
  pdfPages?: ((bytes: Buffer, signal?: AbortSignal) => Promise<string[] | null>) | null;
}

/**
 * Extracts one file the walk listed. `expected` is the size and modification
 * time the walk saw: a file that differs is reported `changed` and left for
 * the next pass rather than indexed under the wrong version.
 */
export async function extractIndexableFile(
  connectedFolderRoot: string,
  path: string,
  expected: { size: number; mtimeMs: number },
  options: ExtractOptions = {},
): Promise<FileExtraction> {
  const kind = indexedContentKindForPath(path);
  if (kind === "unsupported") return { status: "unsupported", sha256: null };
  if (kind === "pdf" && (options.pdfPages === null || (options.pdfPages === undefined && process.platform !== "darwin"))) {
    return { status: "unsupported", sha256: null };
  }
  const limit = kind === "text" || kind === "markdown" || kind === "sniff" ? indexExtractionBounds.maxTextBytes : indexExtractionBounds.maxDocumentBytes;
  if (expected.size > limit) return { status: "too-large", sha256: null };
  let bytes: Buffer;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(join(connectedFolderRoot, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) return { status: "unreadable", sha256: null };
    if (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) return { status: "changed", sha256: null };
    if (before.size > limit) return { status: "too-large", sha256: null };
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { status: "changed", sha256: null };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    return { status: "unreadable", sha256: null };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  aborted(options.signal);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    switch (kind) {
      case "markdown":
      case "sniff": {
        if (looksBinary(bytes.subarray(0, 8192))) return { status: "binary", sha256 };
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return { status: "binary", sha256 }; }
        const chunked = chunkPlainText(text, { markdown: kind === "markdown" });
        const textKind: IndexedContentKind = kind === "markdown" ? "markdown" : proseTextExtensions.has(extname(path).toLowerCase()) && !basename(path).startsWith(".") ? "text" : "code";
        return { status: "indexed", kind: textKind, sha256, ...chunked };
      }
      case "docx": return documentResult("docx", sha256, chunkWordDocument(bytes));
      case "xlsx": return documentResult("xlsx", sha256, chunkWorkbook(bytes));
      case "pptx": return documentResult("pptx", sha256, chunkPresentation(bytes));
      case "pdf": {
        const pages = await (options.pdfPages ?? macPdfPages)(bytes, options.signal);
        if (!pages) return { status: "unreadable", sha256 };
        return documentResult("pdf", sha256, chunkPages(pages));
      }
      default: return { status: "unsupported", sha256 };
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    return { status: "unreadable", sha256 };
  }
}

function documentResult(kind: IndexedContentKind, sha256: string, chunked: { chunks: IndexedChunk[]; truncated: boolean } | null): FileExtraction {
  if (!chunked) return { status: "unreadable", sha256 };
  return { status: "indexed", kind, sha256, ...chunked };
}

// ---------------------------------------------------------------------------
// Chunking

interface Block {
  /** 1-based first and last unit (line, paragraph, row) the block covers. */
  start: number;
  end: number;
  text: string;
  words: number;
  headings: string[];
  heading: boolean;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

/** Splits text into blocks at blank lines; Markdown headings are blocks of their own and set the heading path. */
function textBlocks(text: string, markdown: boolean): Block[] {
  const lines = text.split(/\r?\n/u);
  const blocks: Block[] = [];
  const headings: string[] = [];
  let fence: string | null = null;
  let current: { start: number; lines: string[] } | null = null;
  const flush = (end: number) => {
    if (!current) return;
    const body = current.lines.join("\n");
    if (body.trim()) blocks.push({ start: current.start, end, text: body, words: wordCount(body), headings: [...headings], heading: false });
    current = null;
  };
  lines.forEach((line, index) => {
    const number = index + 1;
    if (markdown) {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (fenceMatch) fence = fence === null ? fenceMatch[1]![0]! : (fenceMatch[1]![0] === fence ? null : fence);
      const heading = fence === null && !fenceMatch ? /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line) : null;
      if (heading) {
        flush(number - 1);
        const level = heading[1]!.length;
        headings.splice(level - 1);
        while (headings.length < level - 1) headings.push("");
        headings.push(heading[2]!.trim());
        blocks.push({ start: number, end: number, text: line.trim(), words: wordCount(heading[2]!), headings: headings.filter(Boolean), heading: true });
        return;
      }
    }
    if (!line.trim() && fence === null) { flush(number - 1); return; }
    current ??= { start: number, lines: [] };
    current.lines.push(line);
  });
  flush(lines.length);
  return blocks;
}

/** Splits a block longer than the chunk maximum: by line when it has several, else by words. */
function splitLongBlock(block: Block, maxWords: number): Block[] {
  if (block.words <= maxWords) return [block];
  const lines = block.text.split("\n");
  if (lines.length > 1) {
    const pieces: Block[] = [];
    let start = block.start;
    let pieceLines: string[] = [];
    let pieceWords = 0;
    for (let offset = 0; offset < lines.length; offset++) {
      const words = wordCount(lines[offset]!);
      if (pieceLines.length && pieceWords + words > maxWords) {
        pieces.push({ ...block, start, end: block.start + offset - 1, text: pieceLines.join("\n"), words: pieceWords });
        start = block.start + offset; pieceLines = []; pieceWords = 0;
      }
      pieceLines.push(lines[offset]!); pieceWords += words;
    }
    if (pieceLines.length) pieces.push({ ...block, start, end: block.end, text: pieceLines.join("\n"), words: pieceWords });
    // A single line longer than the maximum is split again by words.
    return pieces.flatMap((part) => part.words > maxWords && !part.text.includes("\n") ? splitLongBlock(part, maxWords) : [part]);
  }
  const words = block.text.trim().split(/\s+/u);
  const pieces: Block[] = [];
  for (let index = 0; index < words.length; index += maxWords) {
    const text = words.slice(index, index + maxWords).join(" ");
    pieces.push({ ...block, text, words: wordCount(text) });
  }
  return pieces;
}

/**
 * Packs blocks into chunks of roughly targetWords (never more than maxWords
 * unless one unit alone is longer), starting a new chunk at a heading when
 * the current one is already substantial. A short closing block is repeated
 * at the start of the next chunk as overlap.
 */
function packBlocks(
  input: Block[],
  locate: (start: number, end: number, headings: string[]) => ChunkLocation,
  ordinalStart = 0,
  budget: number = indexExtractionBounds.maxChunksPerFile,
): { chunks: IndexedChunk[]; truncated: boolean } {
  const { targetWords, maxWords, overlapWords, maxChunkCharacters } = indexExtractionBounds;
  const blocks = input.flatMap((block) => splitLongBlock(block, maxWords));
  const chunks: IndexedChunk[] = [];
  let current: Block[] = [];
  let words = 0;
  let truncated = false;
  let fresh = 0;
  const flush = (carry: boolean) => {
    if (!current.length) return;
    fresh = 0;
    if (chunks.length >= budget) { truncated = true; current = []; words = 0; return; }
    const first = current[0]!;
    const last = current.at(-1)!;
    let text = current.map((block) => block.text).join("\n\n").trim();
    if (text.length > maxChunkCharacters) text = text.slice(0, maxChunkCharacters);
    if (text) chunks.push({ ordinal: ordinalStart + chunks.length, location: locate(first.start, last.end, first.headings), text });
    const overlap = carry && current.length > 1 && !last.heading && last.words <= overlapWords ? last : null;
    current = overlap ? [overlap] : [];
    words = overlap ? overlap.words : 0;
  };
  for (const block of blocks) {
    if (truncated) break;
    if (block.heading && words >= 50) flush(false);
    if (current.length && words + block.words > maxWords) flush(true);
    current.push(block);
    words += block.words;
    fresh++;
    if (words >= targetWords) flush(true);
  }
  // An overlap block left behind on its own adds nothing new.
  if (fresh) flush(false);
  return { chunks, truncated };
}

export function chunkPlainText(text: string, options: { markdown: boolean }): { chunks: IndexedChunk[]; truncated: boolean } {
  return packBlocks(textBlocks(text, options.markdown), (start, end, headings) => ({
    lines: { start, end },
    ...(options.markdown && headings.length ? { headings } : {}),
  }));
}

/** One Chat message: one chunk, or several numbered parts when it is long. */
export function chunkChatMessage(text: string): IndexedChunk[] {
  const { chunks } = packBlocks(textBlocks(text, false), () => ({}), 0, 20);
  return chunks.map((chunk, index) => ({ ...chunk, location: chunks.length > 1 ? { part: index + 1 } : {} }));
}

function chunkPages(pages: string[]): { chunks: IndexedChunk[]; truncated: boolean } {
  const chunks: IndexedChunk[] = [];
  let truncated = pages.length >= indexExtractionBounds.maxPdfPages;
  pages.forEach((page, index) => {
    if (chunks.length >= indexExtractionBounds.maxChunksPerFile) { truncated = true; return; }
    const packed = packBlocks(textBlocks(page, false), () => ({ page: index + 1 }), chunks.length, indexExtractionBounds.maxChunksPerFile - chunks.length);
    chunks.push(...packed.chunks);
    truncated ||= packed.truncated;
  });
  return { chunks, truncated };
}

// ---------------------------------------------------------------------------
// Office documents

function chunkWordDocument(bytes: Buffer): { chunks: IndexedChunk[]; truncated: boolean } | null {
  const members = readZipMembers(bytes, (name) => name === "word/document.xml");
  const xml = members?.get("word/document.xml");
  if (!xml) return null;
  const blocks: Block[] = [];
  const headings: string[] = [];
  let number = 0;
  for (const paragraph of xml.toString("utf8").matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/gu)) {
    number++;
    const body = paragraph[0];
    const text = xmlRunText(body, /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/gu).trim();
    if (!text) continue;
    const style = /<w:pStyle\s+w:val="([^"]+)"/u.exec(body)?.[1] ?? "";
    const level = /^heading\s?(\d)$/iu.exec(style)?.[1] ?? (/^title$/iu.test(style) ? "1" : null);
    if (level) {
      const depth = Number(level);
      headings.splice(depth - 1);
      while (headings.length < depth - 1) headings.push("");
      headings.push(text);
      blocks.push({ start: number, end: number, text, words: wordCount(text), headings: headings.filter(Boolean), heading: true });
    } else {
      blocks.push({ start: number, end: number, text, words: wordCount(text), headings: headings.filter(Boolean), heading: false });
    }
  }
  return packBlocks(blocks, (start, end, path) => ({ paragraphs: { start, end }, ...(path.length ? { headings: path } : {}) }));
}

function chunkPresentation(bytes: Buffer): { chunks: IndexedChunk[]; truncated: boolean } | null {
  const members = readZipMembers(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  if (!members) return null;
  const slides = [...members.entries()]
    .map(([name, xml]) => ({ number: Number(/slide(\d+)\.xml$/u.exec(name)![1]), xml: xml.toString("utf8") }))
    .sort((a, b) => a.number - b.number);
  const chunks: IndexedChunk[] = [];
  let truncated = false;
  for (const slide of slides) {
    if (chunks.length >= indexExtractionBounds.maxChunksPerFile) { truncated = true; break; }
    const blocks: Block[] = [];
    let line = 0;
    for (const paragraph of slide.xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/gu)) {
      line++;
      const text = xmlRunText(paragraph[0], /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\/>/gu).trim();
      if (text) blocks.push({ start: line, end: line, text, words: wordCount(text), headings: [], heading: false });
    }
    const packed = packBlocks(blocks, () => ({ slide: slide.number }), chunks.length, indexExtractionBounds.maxChunksPerFile - chunks.length);
    chunks.push(...packed.chunks);
    truncated ||= packed.truncated;
  }
  return { chunks, truncated };
}

function chunkWorkbook(bytes: Buffer): { chunks: IndexedChunk[]; truncated: boolean } | null {
  const members = readZipMembers(bytes, (name) => name === "xl/sharedStrings.xml" || name === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/u.test(name));
  if (!members) return null;
  const shared = [...(members.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/gu)]
    .map((item) => xmlRunText(item[1]!, /<t(?:\s[^>]*)?>([^<]*)<\/t>/gu));
  const sheetNames = [...(members.get("xl/workbook.xml")?.toString("utf8") ?? "").matchAll(/<sheet\s[^>]*name="([^"]*)"/gu)].map((item) => decodeXml(item[1]!));
  const sheets = [...members.entries()]
    .filter(([name]) => name.startsWith("xl/worksheets/"))
    .map(([name, xml]) => ({ number: Number(/sheet(\d+)\.xml$/u.exec(name)![1]), xml: xml.toString("utf8") }))
    .sort((a, b) => a.number - b.number);
  const chunks: IndexedChunk[] = [];
  let truncated = false;
  for (const sheet of sheets) {
    if (chunks.length >= indexExtractionBounds.maxChunksPerFile) { truncated = true; break; }
    const name = sheetNames[sheet.number - 1] ?? `Sheet ${sheet.number}`;
    const blocks: Block[] = [];
    for (const row of sheet.xml.matchAll(/<row\s([^>]*)>([\s\S]*?)<\/row>/gu)) {
      const rowNumber = Number(/\br="(\d+)"/u.exec(row[1]!)?.[1] ?? blocks.length + 1);
      const cells: string[] = [];
      for (const cell of row[2]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
        const attributes = cell[1]!;
        const body = cell[2] ?? "";
        const type = /\bt="([^"]+)"/u.exec(attributes)?.[1];
        const value = /<v>([^<]*)<\/v>/u.exec(body)?.[1];
        let text = "";
        if (type === "s" && value !== undefined) text = shared[Number(value)] ?? "";
        else if (type === "inlineStr") text = xmlRunText(body, /<t(?:\s[^>]*)?>([^<]*)<\/t>/gu);
        else if (value !== undefined) text = decodeXml(value);
        if (text.trim()) cells.push(text.trim());
      }
      if (cells.length) {
        const text = cells.join(" | ");
        blocks.push({ start: rowNumber, end: rowNumber, text, words: wordCount(text), headings: [], heading: false });
      }
    }
    const packed = packBlocks(blocks, (start, end) => ({ sheet: name, rows: { start, end } }), chunks.length, indexExtractionBounds.maxChunksPerFile - chunks.length);
    chunks.push(...packed.chunks);
    truncated ||= packed.truncated;
  }
  return { chunks, truncated };
}

function xmlRunText(xml: string, pattern: RegExp): string {
  let text = "";
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) text += decodeXml(match[1]);
    else text += match[0].includes("tab") ? "\t" : "\n";
  }
  return text;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * A bounded reader for the members of an in-memory ZIP archive. It reads the
 * central directory, never trusts a member's declared size past the bound,
 * and refuses ZIP64 and encrypted members. Returns null for a damaged archive.
 */
export function readZipMembers(bytes: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> | null {
  const minimumEnd = Math.max(0, bytes.length - 0xffff - 22);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimumEnd; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) return null;
  const entries = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (offset === 0xffffffff) return null;
  const members = new Map<string, Buffer>();
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) return null;
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name) || flags & 1 || size > indexExtractionBounds.maxArchiveMemberBytes) continue;
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) return null;
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) return null;
    if (method === 0) members.set(name, data);
    else if (method === 8) {
      try { members.set(name, inflateRawSync(data, { maxOutputLength: indexExtractionBounds.maxArchiveMemberBytes })); } catch { continue; }
    }
  }
  return members;
}

// ---------------------------------------------------------------------------
// PDF on macOS

const pdfScript = `
ObjC.import('Foundation'); ObjC.import('PDFKit');
function run(argv) {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const doc = $.PDFDocument.alloc.initWithData(data);
  if (!doc || doc.isNil()) return JSON.stringify({ error: 'unreadable' });
  if (doc.isLocked) return JSON.stringify({ error: 'locked' });
  const count = Number(doc.pageCount); const max = Number(argv[0]); const pages = [];
  for (let i = 0; i < Math.min(count, max); i++) { const page = doc.pageAtIndex(i); const text = page.string; pages.push(text && !text.isNil() ? text.js : ''); }
  return JSON.stringify({ pageCount: count, pages: pages });
}`;

/** A PDF's page text from macOS PDFKit, in a short-lived child that reads the bytes this process already read. */
export async function macPdfPages(bytes: Buffer, signal?: AbortSignal): Promise<string[] | null> {
  if (process.platform !== "darwin") return null;
  aborted(signal);
  return await new Promise<string[] | null>((resolve) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", pdfScript, String(indexExtractionBounds.maxPdfPages)], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    let settled = false;
    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      try { child.kill(); } catch { /* Already gone. */ }
      resolve(value);
    };
    const stop = () => finish(null);
    const timer = setTimeout(stop, 30_000);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) finish(null);
    });
    child.on("close", () => {
      try {
        const parsed = JSON.parse(output) as { pages?: unknown };
        finish(Array.isArray(parsed.pages) ? parsed.pages.map((page) => typeof page === "string" ? page : "") : null);
      } catch { finish(null); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(bytes);
  }).then((pages) => { aborted(signal); return pages; });
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Indexing stopped."), { name: "AbortError" });
}
