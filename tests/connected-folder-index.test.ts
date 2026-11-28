import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, truncate, utimes, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { appendMessage, createConversation } from "../src/local/agent/chat-store.js";
import { executeAmpleFileCliActRequest, parseAmpleFileCliActArgv } from "../src/local/cli/act-commands.js";
import { createAmpleFileCliActRequest } from "../src/local/cli/act-protocol.js";
import { setConnectedFolderIgnoreState } from "../src/local/connected-folder-ignore.js";
import { listIndexableFiles } from "../src/local/index/content-policy.js";
import { MacNaturalLanguageEmbedder, noEmbedder, normalizeVector, type ConnectedFolderIndexEmbedder, type EmbedderInput } from "../src/local/index/embedder.js";
import { chunkPlainText, extractIndexableFile, indexExtractionBounds, macPdfPages } from "../src/local/index/extract.js";
import { ConnectedFolderIndexService, embeddingPassages, type IndexedConnectedFolder } from "../src/local/index/indexer.js";
import { ConnectedFolderIndexStore, connectedFolderIndexDir, connectedFolderIndexFile, decodeVector, encodeVector, encodedVectorScorer, splitEncoded } from "../src/local/index/store.js";
import { startLocalApi } from "../src/local/server.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";

/**
 * A deterministic stand-in for sentence embeddings: words map to a few
 * shared concepts, so "agreement awaiting signature" lands near "renewal
 * contract still unsigned" without sharing a word with it. Each concept and
 * each other word is a dense pseudo-random direction, as real sentence
 * vectors are dense (the index stores their signs).
 */
function conceptEmbedder(): ConnectedFolderIndexEmbedder & { calls: number } {
  const concepts: Record<string, number> = {
    contract: 0, agreement: 0, renewal: 0, lease: 0,
    unsigned: 1, signature: 1, sign: 1, signed: 1, awaiting: 1, pending: 1,
    banana: 2, bread: 2, bake: 2, oven: 2, recipe: 2, flour: 2,
    invoice: 3, budget: 3, quarterly: 3, payment: 3,
  };
  const dimension = 256;
  const direction = (seed: number) => Array.from({ length: dimension }, (_, index) => {
    const value = Math.sin((seed + 1) * 12.9898 + index * 78.233) * 43758.5453;
    return (value - Math.floor(value)) * 2 - 1;
  });
  const embedder = {
    id: "test-concepts",
    dimension,
    calls: 0,
    available: () => true,
    async embed(inputs: EmbedderInput[]) {
      embedder.calls++;
      return inputs.map(({ text }) => {
        const values = new Array<number>(dimension).fill(0);
        for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
          const concept = concepts[word];
          const basis = direction(concept !== undefined ? concept : 100 + (hash(word) % 10_000));
          const weight = concept !== undefined ? 3 : 0.2;
          basis.forEach((value, index) => { values[index]! += value * weight; });
        }
        const vector = normalizeVector(values);
        return vector ? { language: "en", vector } : null;
      });
    },
    async close() {},
  };
  return embedder;
}

function hash(value: string): number {
  let result = 7;
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) >>> 0;
  return result;
}

/** A minimal ZIP (deflated members) for Office fixtures. */
function zip(members: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(members)) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(members).length, 8); end.writeUInt16LE(Object.keys(members).length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** A one-font PDF with one line of text per page. */
function pdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (value: string) => { objects.push(value); return objects.length; };
  const catalog = add(""); const pagesObject = add(""); const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObject} 0 R >>`;
  objects[pagesObject - 1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function sandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<{ root: string; state: string; base: string }> {
  const base = await mkdtemp(join(tmpdir(), "amplefile-index-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "folder");
  const state = join(base, "state");
  await mkdir(root, { recursive: true });
  configureAmpleFileStateRoot(state);
  return { root, state, base };
}

function service(folder: IndexedConnectedFolder, embedder: ConnectedFolderIndexEmbedder, extra: { isReserved?: () => boolean } = {}): ConnectedFolderIndexService {
  return new ConnectedFolderIndexService({
    embedder,
    resolve: async (id) => id === folder.id ? folder : null,
    ...(extra.isReserved ? { isReserved: extra.isReserved } : {}),
    delays: { shownMs: 60_000, changedMs: 60_000, turnMs: 60_000, retryMs: 60_000 },
    extract: { pdfPages: null },
  });
}

test("the content policy follows Search's and History's rules and reports its bounds", async (t) => {
  const { root } = await sandbox(t);
  await writeFile(join(root, "notes.txt"), "kept\n");
  await mkdir(join(root, ".amplefile"), { recursive: true });
  await writeFile(join(root, ".amplefile", "connected-folder.json"), "{}");
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "settings.json"), "{}");
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "x");
  await writeFile(join(root, ".gitignore"), "build/\n");
  await mkdir(join(root, "build"), { recursive: true });
  await writeFile(join(root, "build", "out.txt"), "generated");
  await mkdir(join(root, "cache"), { recursive: true });
  await writeFile(join(root, "cache", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55");
  await writeFile(join(root, "cache", "blob.txt"), "cached");
  await writeFile(join(root, "~$report.docx"), "lock");
  await writeFile(join(root, "secret.txt"), "hidden from Files");
  await symlink(join(root, "notes.txt"), join(root, "link.txt"));
  await setConnectedFolderIgnoreState(root, ["secret.txt"], true);

  const walk = await listIndexableFiles(root);
  assert.ok(walk.files.some((file) => file.path === "notes.txt"));
  for (const left of ["node_modules/pkg/index.js", "build/out.txt", "cache/blob.txt", "~$report.docx", "secret.txt", "link.txt", ".pi/settings.json", ".amplefile/connected-folder.json"]) {
    assert.ok(!walk.files.some((file) => file.path === left), `${left} is not indexable`);
  }
  assert.equal(walk.excluded.symbolicLink, 1);
  assert.equal(walk.excluded.lockFile + walk.excluded.hidden >= 3, true, "the lock file and the hidden support folders");
  assert.ok(walk.excluded.ignored >= 1);
  assert.ok(walk.excluded.gitignored >= 1);
  assert.ok(walk.excluded.generated >= 2, "node_modules and the CACHEDIR.TAG cache");
  assert.equal(walk.complete, true);
  assert.equal(walk.stoppedBy, null);

  const bounded = await listIndexableFiles(root, { bounds: { maxFiles: 1 } });
  assert.equal(bounded.files.length, 1);
  assert.equal(bounded.stoppedBy, "files");
  assert.equal(bounded.complete, false);
});

test("text and Markdown are chunked by paragraph with headings, line ranges, and bounds", () => {
  const paragraph = (seed: string, words: number) => Array.from({ length: words }, (_, index) => `${seed}${index}`).join(" ");
  const markdown = [
    "# Plan",
    "",
    paragraph("intro", 120),
    "",
    "## Budget",
    "",
    paragraph("budget", 180),
    "",
    paragraph("more", 180),
    "",
    "```",
    "# not a heading",
    "```",
  ].join("\n");
  const { chunks, truncated } = chunkPlainText(markdown, { markdown: true });
  assert.equal(truncated, false);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.text.split(/\s+/).length <= indexExtractionBounds.maxWords + 60, "a chunk stays near the maximum");
    assert.ok(chunk.location.lines && chunk.location.lines.start <= chunk.location.lines.end);
  }
  const budget = chunks.find((chunk) => chunk.text.includes("budget0"));
  assert.deepEqual(budget?.location.headings, ["Plan", "Budget"]);
  assert.ok(!chunks.some((chunk) => chunk.location.headings?.includes("not a heading")), "a fenced line is not a heading");

  const long = chunkPlainText(Array.from({ length: 300 }, (_, index) => `line ${index} ${paragraph("w", 20)}`).join("\n\n"), { markdown: false });
  assert.equal(long.truncated, false);
  assert.ok(long.chunks[1]!.location.lines!.start <= long.chunks[0]!.location.lines!.end, "consecutive chunks overlap by a short paragraph");
  const huge = chunkPlainText(Array.from({ length: 20_000 }, (_, index) => `line ${index} ${paragraph("w", 20)}`).join("\n\n"), { markdown: false });
  assert.equal(huge.truncated, true);
  assert.equal(huge.chunks.length, indexExtractionBounds.maxChunksPerFile);
});

test("Word, Excel, and PowerPoint text is read from their XML with locations", async (t) => {
  const { root } = await sandbox(t);
  await writeFile(join(root, "memo.docx"), zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<w:document><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Henderson</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Renewal is &amp; remains </w:t></w:r><w:r><w:t>unsigned.</w:t></w:r></w:p>
    </w:body></w:document>`,
  }));
  await writeFile(join(root, "plan.xlsx"), zip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/sharedStrings.xml": `<sst><si><t>Quarterly</t></si><si><r><t>travel</t></r></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c><c r="C3"><v>1200</v></c></row></sheetData></worksheet>`,
  }));
  await writeFile(join(root, "deck.pptx"), zip({
    "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>`,
    "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Launch timeline</a:t></a:r></a:p></p:sld>`,
  }));
  const extract = async (path: string) => {
    const info = await stat(join(root, path));
    return extractIndexableFile(root, path, { size: info.size, mtimeMs: info.mtimeMs }, { pdfPages: null });
  };
  const word = await extract("memo.docx");
  assert.equal(word.status, "indexed");
  if (word.status !== "indexed") return;
  assert.equal(word.kind, "docx");
  assert.match(word.chunks[0]!.text, /Renewal is & remains unsigned\./);
  assert.deepEqual(word.chunks[0]!.location.headings, ["Henderson"]);
  assert.ok(word.chunks[0]!.location.paragraphs);

  const sheet = await extract("plan.xlsx");
  assert.equal(sheet.status, "indexed");
  if (sheet.status !== "indexed") return;
  assert.equal(sheet.chunks[0]!.text, "Quarterly | travel | 1200");
  assert.deepEqual(sheet.chunks[0]!.location, { sheet: "Budget", rows: { start: 3, end: 3 } });

  const slides = await extract("deck.pptx");
  assert.equal(slides.status, "indexed");
  if (slides.status !== "indexed") return;
  assert.deepEqual(slides.chunks.map((chunk) => [chunk.location.slide, chunk.text]), [[1, "Launch timeline"], [2, "Second slide"]]);

  await writeFile(join(root, "scan.pdf"), pdf(["text"]));
  assert.equal((await extract("scan.pdf")).status, "unsupported", "PDFs are unsupported without a PDF reader");
  await writeFile(join(root, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  assert.equal((await extract("photo.png")).status, "unsupported");
  await writeFile(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
  assert.equal((await extract("blob.bin")).status, "binary");
  await writeFile(join(root, "broken.docx"), "not a zip");
  assert.equal((await extract("broken.docx")).status, "unreadable");
});

test("chunks are embedded a sentence or two at a time and stored compactly", () => {
  assert.deepEqual(embeddingPassages("# Henderson\n\n## Status\n\nThe Henderson renewal contract is still unsigned. Legal sent it back on Monday."), [
    "Henderson. Status. The Henderson renewal contract is still unsigned.",
    "Legal sent it back on Monday.",
  ]);
  assert.deepEqual(embeddingPassages("   \n\n"), []);
  const long = embeddingPassages(Array.from({ length: 200 }, (_, index) => `Sentence number ${index} is here.`).join(" "));
  assert.ok(long.length <= 6, "at most six passages per chunk");
  assert.match(long.at(-1)!, /Sentence number 199/, "the last passage keeps the end of the chunk");
  const vector = normalizeVector(Array.from({ length: 512 }, (_, index) => Math.sin(index * 1.7) + Math.cos(index * 0.3)))!;
  const encoded = encodeVector(vector);
  assert.equal(encoded.byteLength, 70, "sign bits and one scale: 70 bytes for 512 dimensions");
  const decoded = decodeVector(encoded);
  assert.equal(decoded.length, 512);
  const norm = Math.sqrt(decoded.reduce((sum, value) => sum + value * value, 0));
  const direction = vector.reduce((sum, value, index) => sum + value * decoded[index]!, 0) / norm;
  assert.ok(direction > 0.75, "sign bits keep the direction");
  // The scorer reads a passage as an approximate cosine, and a chunk as its best passage.
  const other = normalizeVector(Array.from({ length: 512 }, (_, index) => Math.sin(index * 2.9 + 1)))!;
  const score = encodedVectorScorer(vector);
  assert.ok(Math.abs(score(encoded) - 1) < 0.15, "a vector scores near 1 against itself");
  assert.ok(score(Buffer.concat([encodeVector(other), encoded])) > 0.85, "a chunk scores as its best passage");
  assert.deepEqual(splitEncoded(Buffer.concat([encodeVector(other), encoded])).length, 2);
});

test("a damaged or other-version index is deleted and rebuilt", async (t) => {
  const { root } = await sandbox(t);
  assert.equal(ConnectedFolderIndexStore.open(root, { create: false }), null, "no index is not an index");
  await mkdir(connectedFolderIndexDir(root), { recursive: true });
  await writeFile(connectedFolderIndexFile(root), "this is not a database");
  const rebuilt = ConnectedFolderIndexStore.open(root);
  assert.ok(rebuilt);
  rebuilt.setMeta("probe", "1");
  rebuilt.close();
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(connectedFolderIndexFile(root));
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  const fresh = ConnectedFolderIndexStore.open(root)!;
  assert.equal(fresh.getMeta("probe"), null, "a newer schema is not read");
  fresh.close();
});

test("ranked search fuses lexical and semantic matches, keys content by hash, and checks freshness", async (t) => {
  const { root } = await sandbox(t);
  const folder = { id: "space-0000000000000001", connectedFolderRoot: root };
  await writeFile(join(root, "henderson.md"), "# Henderson\n\nThe renewal contract is still unsigned.\n");
  await writeFile(join(root, "baking.txt"), "Banana bread recipe: bake in the oven with flour.\n");
  await mkdir(join(root, "copies"), { recursive: true });
  await writeFile(join(root, "copies", "henderson-copy.md"), "# Henderson\n\nThe renewal contract is still unsigned.\n");
  const embedder = conceptEmbedder();
  const index = service(folder, embedder);
  t.after(() => index.close());

  const before = index.status(folder);
  assert.equal(before.state, "not-indexed");
  assert.equal(before.files, null, "unknown is never reported as zero");

  await index.sync(folder);
  const status = index.status(folder);
  assert.equal(status.files?.indexed, 3);
  assert.equal(status.files?.pending, 0);
  assert.equal(status.complete, true);
  assert.equal(status.embedder, "test-concepts");

  const semantic = await index.recall(folder, "agreement awaiting signature");
  assert.equal(semantic.coverage.ranking, "hybrid");
  const top = semantic.hits[0]!;
  assert.equal(top.source, "file");
  assert.ok(top.source === "file" && top.path.endsWith("henderson.md") || top.source === "file" && top.path.endsWith("henderson-copy.md"));
  assert.deepEqual(top.reasons, ["semantic"]);
  assert.ok(top.source === "file" && top.duplicates?.length === 1, "identical bytes are one hit with their other path");
  assert.equal(top.fresh, true);
  assert.equal(top.sha256.length, 64);
  assert.ok(top.indexedAt);
  assert.deepEqual(top.location, { lines: { start: 1, end: 3 }, headings: ["Henderson"] });
  assert.match(top.excerpt, /renewal contract/);

  const lexical = await index.recall(folder, "banana");
  assert.equal(lexical.hits[0]?.source === "file" && lexical.hits[0].path, "baking.txt");
  assert.ok(lexical.hits[0]!.reasons.includes("lexical"));

  const narrowed = await index.recall(folder, "renewal", { path: "copies" });
  assert.deepEqual(narrowed.hits.map((hit) => hit.source === "file" ? hit.path : null), ["copies/henderson-copy.md"]);

  // A rename costs no extraction: the content is already known by its hash.
  const chunksBefore = ConnectedFolderIndexStore.open(root)!;
  const chunkCount = chunksBefore.countChunks();
  chunksBefore.close();
  const callsBefore = embedder.calls;
  await rename(join(root, "baking.txt"), join(root, "banana-bread.txt"));
  await index.sync(folder);
  const afterRename = ConnectedFolderIndexStore.open(root)!;
  assert.equal(afterRename.countChunks(), chunkCount);
  assert.equal(afterRename.getFile("baking.txt"), null);
  assert.equal(afterRename.getFile("banana-bread.txt")?.status, "indexed");
  afterRename.close();
  assert.equal(embedder.calls, callsBefore, "nothing new to embed after a rename");

  // A file changed after indexing is flagged, never returned as current.
  await writeFile(join(root, "banana-bread.txt"), "Banana bread recipe: now with walnuts and more flour.\n");
  await utimes(join(root, "banana-bread.txt"), new Date(), new Date(Date.now() + 5_000));
  const stale = await recallWithoutSync(index, folder, "banana");
  assert.equal(stale.hits[0]?.fresh, false);
  assert.equal(stale.coverage.staleHits, 1);
  await index.sync(folder);
  const refreshed = await index.recall(folder, "walnuts", { waitMs: 0 });
  assert.equal(refreshed.hits[0]?.fresh, true);

  // A deleted file leaves the index.
  await rm(join(root, "copies"), { recursive: true });
  await index.sync(folder);
  const afterDelete = await index.recall(folder, "renewal", { waitMs: 0 });
  assert.equal(afterDelete.hits.length, 1);
  assert.ok(!(afterDelete.hits[0]!.source === "file" && afterDelete.hits[0]!.duplicates));

  // Related: neighbours of a file, never the file itself.
  await writeFile(join(root, "lease.txt"), "The lease agreement is pending a signature.\n");
  await index.sync(folder);
  const related = await index.recall(folder, "", { similarTo: "henderson.md", waitMs: 0 });
  assert.equal(related.hits[0]?.source === "file" && related.hits[0].path, "lease.txt");
  assert.ok(!related.hits.some((hit) => hit.source === "file" && hit.path === "henderson.md"));
});

async function recallWithoutSync(index: ConnectedFolderIndexService, folder: IndexedConnectedFolder, query: string) {
  const { recallConnectedFolder } = await import("../src/local/index/recall.js");
  return recallConnectedFolder(folder.connectedFolderRoot, query, { embedder: index.embedder });
}

test("without an embedder search ranks by words and says so", async (t) => {
  const { root } = await sandbox(t);
  const folder = { id: "space-0000000000000002", connectedFolderRoot: root };
  await writeFile(join(root, "a.txt"), "The quarterly budget is due Friday.\n");
  const index = service(folder, noEmbedder);
  t.after(() => index.close());
  const result = await index.recall(folder, "budget", { waitMs: 10_000 });
  assert.equal(result.hits.length, 1);
  assert.deepEqual(result.hits[0]!.reasons, ["lexical"]);
  assert.equal(result.coverage.ranking, "lexical");
  assert.equal(result.coverage.embedder, "none");
  assert.equal(result.coverage.lexicalOnlyReason, "embedder-unavailable");
  assert.equal(result.coverage.complete, true, "lexical coverage can be complete");
  const nothing = await index.recall(folder, "agreement", { waitMs: 0 });
  assert.equal(nothing.hits.length, 0);
});

test("code is indexed by words only, and status coverage agrees with what a query does", async (t) => {
  const { root } = await sandbox(t);
  const folder = { id: "space-0000000000000005", connectedFolderRoot: root };
  await writeFile(join(root, "notes.md"), "# Lease\n\nThe lease agreement is pending a signature.\n");
  await writeFile(join(root, "lease.ts"), "// The contract signature is checked here.\nexport const contract = { signature: null };\n");
  await writeFile(join(root, "README"), "The renewal contract is unsigned.\n");
  await writeFile(join(root, ".editorconfig"), "root = true\n");
  const index = service(folder, conceptEmbedder());
  t.after(() => index.close());
  const empty = index.status(folder);
  assert.equal(empty.ranking, "lexical");
  assert.equal(empty.lexicalOnlyReason, "not-embedded-yet");
  await index.sync(folder);
  const status = index.status(folder);
  assert.deepEqual(status.chunks, { total: 4, embedded: 2, embeddable: 2 }, "only prose chunks are embedded");
  assert.equal(status.complete, true, "code waiting for no embedding is still complete");
  assert.equal(status.ranking, "hybrid", "status says what a query would do once vectors exist");
  assert.equal(status.lexicalOnlyReason, undefined);
  const result = await index.recall(folder, "contract signature", { waitMs: 0 });
  assert.equal(result.coverage.ranking, status.ranking);
  const code = result.hits.find((hit) => hit.source === "file" && hit.path === "lease.ts");
  assert.ok(code, "code is found by its words");
  assert.deepEqual(code.reasons, ["lexical"]);
  assert.ok(result.hits.some((hit) => hit.source === "file" && hit.path === "notes.md" && hit.reasons.includes("semantic")));
});

test("Chat messages are indexed with their conversation, message, and role", async (t) => {
  const { root } = await sandbox(t);
  const folder = { id: "space-0000000000000003", connectedFolderRoot: root };
  const conversation = await createConversation(root, "Vendor follow-up");
  await appendMessage(root, conversation.id, { id: "m-user", role: "user", content: "Remind me which vendor sent the invoice.", createdAt: new Date().toISOString() });
  await appendMessage(root, conversation.id, { id: "m-assistant", role: "assistant", content: "Acme sent the invoice on Tuesday.", createdAt: new Date().toISOString() });
  const index = service(folder, conceptEmbedder());
  t.after(() => index.close());
  await index.sync(folder);
  const result = await index.recall(folder, "Acme invoice", { kinds: ["chats"], waitMs: 0 });
  const hit = result.hits.find((item) => item.source === "chat" && item.messageId === "m-assistant");
  assert.ok(hit && hit.source === "chat");
  assert.equal(hit.conversationId, conversation.id);
  assert.equal(hit.role, "assistant");
  assert.equal(hit.title, "Vendor follow-up");
  assert.equal(hit.fresh, true);
  assert.equal(result.coverage.chatMessages, 2);
  const filesOnly = await index.recall(folder, "Acme invoice", { kinds: ["files"], waitMs: 0 });
  assert.equal(filesOnly.hits.length, 0);
});

test("the indexer stops for a reservation, never reads a cloud placeholder, and resumes", async (t) => {
  const { root } = await sandbox(t);
  const folder = { id: "space-0000000000000004", connectedFolderRoot: root };
  for (let index = 0; index < 6; index++) await writeFile(join(root, `note-${index}.txt`), `Note ${index} about the quarterly budget.\n`);
  if (process.platform === "darwin") {
    // A sparse file reports no blocks, as a cloud placeholder does.
    await writeFile(join(root, "cloud.txt"), "");
    await truncate(join(root, "cloud.txt"), 64 * 1024);
  }
  let checks = 0;
  let reserved = true;
  const index = service(folder, conceptEmbedder(), { isReserved: () => reserved && ++checks > 4 });
  t.after(() => index.close());
  await index.sync(folder);
  const stopped = index.status(folder);
  assert.equal(stopped.stoppedFor, "reserved");
  assert.equal(stopped.complete, false);
  assert.ok((stopped.files?.pending ?? 0) > 0, "work left is reported as pending");
  reserved = false;
  await index.sync(folder);
  const resumed = index.status(folder);
  assert.equal(resumed.stoppedFor, undefined);
  assert.equal(resumed.files?.pending, 0);
  assert.equal(resumed.files?.indexed, 6);
  if (process.platform === "darwin") {
    const info = await stat(join(root, "cloud.txt"));
    if (info.blocks === 0) assert.equal(resumed.files?.["not-downloaded"], 1);
  }
  await index.forget(folder);
  assert.equal(existsSync(connectedFolderIndexDir(root)), false, "forgetting a folder deletes its index");
});

test("ranked search through the act lane, the index route, and the CLI flag", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "amplefile-index-api-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(base, "state"),
    connectedFolderBase: join(base, "content"),
    loadEnv: false,
    connectedFolderIndex: { embedder: conceptEmbedder(), extract: { pdfPages: null }, delays: { shownMs: 60_000, changedMs: 60_000, turnMs: 60_000, retryMs: 60_000 } },
  });
  t.after(() => api.close());
  const root = join(base, "Clients");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "henderson.md"), "# Henderson\n\nThe renewal contract is still unsigned.\n");
  await writeFile(join(root, "nested", "inside.md"), "The nested renewal contract belongs to the nested folder.\n");
  const facade = api.actFacade;
  const { connectedFolder } = await facade.registerConnectedFolder({ connectedFolderRoot: root });
  await facade.registerConnectedFolder({ connectedFolderRoot: join(root, "nested") });

  const plain = await facade.search({ connectedFolder: connectedFolder.id, query: "renewal" });
  assert.equal("ranked" in plain, false, "without --ranked the result is unchanged");

  const result = await facade.search({ connectedFolder: connectedFolder.id, query: "agreement awaiting signature", ranked: true });
  assert.ok(Array.isArray(result.files), "the live search fields are still there");
  const ranked = result.ranked!;
  assert.equal(ranked.hits.length, 1, "a nested Connected Folder keeps its own index");
  const hit = ranked.hits[0]!;
  assert.equal(hit.source === "file" && hit.path, "henderson.md");
  assert.deepEqual(hit.location, { lines: { start: 1, end: 3 }, headings: ["Henderson"] });
  assert.match(hit.excerpt, /still unsigned/);
  assert.equal(hit.fresh, true);
  assert.equal(ranked.coverage.ranking, "hybrid");
  assert.equal(ranked.coverage.files?.indexed, 1);
  assert.ok(ranked.coverage.walk && ranked.coverage.walk.excluded.nested >= 1);

  const statusResponse = await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}/index`);
  assert.equal(statusResponse.status, 200);
  const { index: status } = await statusResponse.json() as { index: { connectedFolderId: string; files: { indexed: number }; embedder: string; lastSyncAt: string | null; running: boolean } };
  assert.equal(status.connectedFolderId, connectedFolder.id);
  assert.equal(status.files.indexed, 1);
  assert.equal(status.embedder, "test-concepts");
  assert.ok(status.lastSyncAt);
  assert.equal(typeof status.running, "boolean");

  const route = await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}/search?q=renewal&ranked=1&rankedLimit=5`);
  const routeBody = await route.json() as { files: unknown[]; ranked: { hits: Array<{ path?: string }> } };
  assert.ok(Array.isArray(routeBody.files));
  assert.equal(routeBody.ranked.hits[0]?.path, "henderson.md");
  const related = await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}/search?similarTo=henderson.md`);
  assert.equal(related.status, 200);
  assert.ok("ranked" in (await related.json() as object));
  assert.equal((await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}/search?q=x&ranked=yes`)).status, 400);

  const parsed = parseAmpleFileCliActArgv(["search", "--connected-folder", connectedFolder.id, "--query", "renewal", "--ranked", "--json"]);
  assert.equal(parsed.ranked, true);
  assert.throws(() => parseAmpleFileCliActArgv(["files", "list", "--connected-folder", connectedFolder.id, "--ranked"]), /--ranked|cannot be used|Unknown/);
  const token = "act-token-for-index-tests-0123456789";
  const receipts = {
    append: () => Promise.resolve(true),
    hasAccepted: () => Promise.resolve(false),
    lookup: () => Promise.resolve({ accepted: null, settled: null, rejected: null, journalSince: null }),
  };
  const human = await executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: "33333333-3333-4333-8333-333333333333", argv: ["search", "--connected-folder", connectedFolder.id, "--query", "agreement awaiting signature", "--ranked"], cwd: base, actToken: token }),
    { version: "0.0.0", getActFacade: () => ({ facade, token }), receipts },
  );
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout, /^No exact matches for "agreement awaiting signature" in .*; ranked matches follow:\nBest matches \(1\):\n- henderson\.md:1 — /);

  // Unregistering a Connected Folder deletes its index.
  assert.equal(existsSync(connectedFolderIndexDir(root)), true);
  await facade.connectedFoldersUnregister({ connectedFolder: connectedFolder.id });
  assert.equal(existsSync(connectedFolderIndexDir(root)), false);
});

test("macOS sentence embeddings and PDF text work through their helpers", { skip: process.platform !== "darwin" ? "macOS only" : false }, async () => {
  const embedder = new MacNaturalLanguageEmbedder({ idleMs: 1_000 });
  try {
    if (!embedder.available()) return;
    const [contract, agreement, bread, empty] = await embedder.embed([
      { text: "Henderson renewal contract is still unsigned" },
      { text: "Agreement with Henderson awaiting signature" },
      { text: "Banana bread recipe with walnuts" },
      { text: "   " },
    ]);
    assert.equal(empty, null, "a text with no vector gets none");
    if (!contract || !agreement || !bread) {
      // The helper exists but this Mac has no English sentence model; the index falls back to words.
      assert.equal(embedder.available(), true);
      return;
    }
    assert.equal(contract.vector.length, embedder.dimension);
    const dotProduct = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
    assert.ok(Math.abs(dotProduct(contract.vector, contract.vector) - 1) < 1e-3, "vectors are normalized");
    assert.ok(dotProduct(contract.vector, agreement.vector) > dotProduct(contract.vector, bread.vector));
    const [english] = await embedder.embed([{ text: "contract", language: "en" }]);
    assert.equal(english?.language, "en");
  } finally {
    await embedder.close();
  }
  const pages = await macPdfPages(pdf(["Henderson renewal contract", "Banana bread"]));
  assert.ok(pages);
  assert.equal(pages.length, 2);
  assert.match(pages[0]!, /Henderson renewal contract/);
});
