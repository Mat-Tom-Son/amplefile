import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { PDFDocument, rgb } from "pdf-lib";

import { registerLinkedConnectedFolder } from "../src/local/connected-folder.js";
import { readImageHeader } from "../src/local/image-header.js";
import { startLocalApi } from "../src/local/server.js";
import { addSidebarFolder } from "../src/local/standard-folders.js";
import { configureAmpleFileStateRoot, connectedFolderStateDir } from "../src/local/state-paths.js";
import { connectedFolderThumbnailRoot, ThumbnailRefusedError, ThumbnailService, thumbnailServiceFor, type ThumbnailAnswer } from "../src/local/thumbnails.js";

// Picture thumbnails for the file manager window's icon view (host only): one
// small WebP per file and size, drawn from the file's own bytes, kept on this
// computer outside every user folder, bounded in input, pixels, time, and
// concurrency, and refused plainly when a file cannot have one.

const canvas = createRequire(import.meta.url)("@napi-rs/canvas") as typeof import("@napi-rs/canvas");

async function folder(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A two-colour picture: left half red, right half blue, so orientation shows. */
function picture(width: number, height: number) {
  const surface = canvas.createCanvas(width, height);
  const context = surface.getContext("2d");
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, Math.ceil(width / 2), height);
  context.fillStyle = "#0000ff";
  context.fillRect(Math.ceil(width / 2), 0, width, height);
  return surface;
}

function bmp(width: number, height: number): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4;
  const bytes = Buffer.alloc(54 + row * height);
  bytes.write("BM");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) bytes[54 + y * row + x * 3 + 2] = 0xff;
  return bytes;
}

/** Inserts an EXIF block saying the camera was turned (orientation 6: rotate 90° clockwise to show). */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0);
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const segment = Buffer.from([0xff, 0xe1, 0, 0]);
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), segment, payload, jpeg.subarray(2)]);
}

/** A PNG whose header claims a picture far larger than its bytes (a decompression bomb's shape). */
function bombPng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

async function letterPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  page.drawRectangle({ x: 0, y: 396, width: 612, height: 396, color: rgb(0, 0, 0) });
  document.addPage([300, 300]);
  return Buffer.from(await document.save());
}

function thumbnailOf(answer: ThumbnailAnswer): Buffer {
  assert.equal(answer.kind, "thumbnail");
  return (answer as Extract<ThumbnailAnswer, { kind: "thumbnail" }>).bytes;
}

async function pixel(webp: Buffer, x: number, y: number): Promise<number[]> {
  const image = new canvas.Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = reject; image.src = webp; });
  const surface = canvas.createCanvas(image.width, image.height);
  const context = surface.getContext("2d");
  context.drawImage(image, 0, 0);
  return [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ThumbnailRefusedError) return error.reason;
    throw error;
  }
  assert.fail("expected a refusal");
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(relative(root, join(entry.parentPath, entry.name)));
  }
  return found.sort();
}

test("each picture kind the Preview shows gets a small WebP, upright, never enlarged", async (t) => {
  const place = await folder(t, "amplefile-thumbs-place-");
  const state = await folder(t, "amplefile-thumbs-state-");
  const service = new ThumbnailService(state);
  t.after(() => service.close());
  const source = picture(400, 200);
  await writeFile(join(place, "photo.png"), await source.encode("png"));
  await writeFile(join(place, "photo.jpg"), await source.encode("jpeg", 90));
  await writeFile(join(place, "photo.webp"), await source.encode("webp", 90));
  await writeFile(join(place, "photo.gif"), await source.encode("gif"));
  await writeFile(join(place, "photo.avif"), await source.encode("avif"));
  await writeFile(join(place, "photo.bmp"), bmp(400, 200));
  await writeFile(join(place, "small.png"), await picture(40, 20).encode("png"));
  await writeFile(join(place, "turned.jpg"), withOrientation(await source.encode("jpeg", 95), 6));
  await writeFile(join(place, "report.pdf"), await letterPdf());

  for (const name of ["photo.png", "photo.jpg", "photo.webp", "photo.gif", "photo.avif", "photo.bmp"]) {
    const bytes = thumbnailOf(await service.thumbnail({ path: join(place, name), size: 128 }));
    assert.equal(bytes.toString("latin1", 0, 4), "RIFF", name);
    assert.equal(bytes.toString("latin1", 8, 12), "WEBP", name);
    assert.deepEqual(readImageHeader(bytes), { format: "webp", width: 128, height: 64 }, `${name} keeps its shape at 128`);
    const [red, , blue] = await pixel(bytes, 10, 32);
    assert.ok(red! > 200 && blue! < 60, `${name} is drawn from its own pixels (left is red)`);
  }
  const big = thumbnailOf(await service.thumbnail({ path: join(place, "photo.jpg"), size: 256 }));
  assert.deepEqual(readImageHeader(big), { format: "webp", width: 256, height: 128 });
  const small = thumbnailOf(await service.thumbnail({ path: join(place, "small.png"), size: 256 }));
  assert.deepEqual(readImageHeader(small), { format: "webp", width: 40, height: 20 }, "a small picture is not enlarged");

  // A photo taken with the camera turned is shown the way it was taken.
  const turned = thumbnailOf(await service.thumbnail({ path: join(place, "turned.jpg"), size: 128 }));
  assert.deepEqual(readImageHeader(turned), { format: "webp", width: 64, height: 128 });
  const [topRed, , topBlue] = await pixel(turned, 32, 10);
  assert.ok(topRed! > 200 && topBlue! < 60, "turned clockwise: the picture's left (red) is at the top");

  // A PDF's first page, on white paper, in the page's shape.
  const page = thumbnailOf(await service.thumbnail({ path: join(place, "report.pdf"), size: 256 }));
  assert.deepEqual(readImageHeader(page), { format: "webp", width: 198, height: 256 });
  assert.deepEqual(await pixel(page, 100, 30), [0, 0, 0], "the top half is the black rectangle");
  const paper = await pixel(page, 100, 220);
  assert.ok(paper.every((channel) => channel > 245), "the bottom half is white paper");
  assert.equal(service.stats.pdfsDrawn, 1);
});

test("a thumbnail is kept outside the folder, answered from the cache, and redrawn when the file changes", async (t) => {
  const place = await folder(t, "amplefile-thumbs-place-");
  const state = await folder(t, "amplefile-thumbs-state-");
  const service = new ThumbnailService(state);
  const path = join(place, "photo.png");
  await writeFile(path, await picture(300, 300).encode("png"));
  const before = await filesUnder(place);

  const first = await service.thumbnail({ path, size: 128 });
  assert.equal(first.kind === "thumbnail" && first.cached, false);
  assert.equal(service.stats.imagesDrawn, 1);
  const kept = await filesUnder(join(state, "thumbnails"));
  assert.equal(kept.length, 1);
  assert.match(kept[0]!, /^[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/, "named by a hash: the file's name and path are not in the cache's names");
  assert.deepEqual(await filesUnder(place), before, "nothing is written into the user's folder");

  // A second ask, or one from a fresh service (a restart), reads the kept one.
  const second = await service.thumbnail({ path, size: 128 });
  assert.equal(second.kind === "thumbnail" && second.cached, true);
  assert.equal(second.etag, first.etag);
  const restarted = new ThumbnailService(state);
  const third = await restarted.thumbnail({ path, size: 128 });
  assert.equal(third.kind === "thumbnail" && third.cached, true);
  assert.equal(restarted.stats.imagesDrawn, 0);

  // The window's If-None-Match: answered without reading the picture or the cache.
  const unchanged = await service.thumbnail({ path, size: 128, ifNoneMatch: first.etag });
  assert.equal(unchanged.kind, "not-modified");
  assert.equal(service.stats.imagesDrawn, 1);
  assert.equal((await service.thumbnail({ path, size: 64, ifNoneMatch: first.etag })).kind, "thumbnail", "each size has its own tag");

  // A changed file (new bytes, new time) gets a new thumbnail and a new tag.
  await writeFile(path, await picture(300, 150).encode("png"));
  const later = new Date(Date.now() + 5_000);
  await utimes(path, later, later);
  const changed = await service.thumbnail({ path, size: 128, ifNoneMatch: first.etag });
  assert.equal(changed.kind, "thumbnail");
  assert.notEqual(changed.etag, first.etag);
  assert.deepEqual(readImageHeader(thumbnailOf(changed)), { format: "webp", width: 128, height: 64 });
  assert.equal(service.stats.imagesDrawn, 3);
  // Same bytes, only a new modification time: still a new key, so nothing stale is shown.
  const touched = new Date(Date.now() + 10_000);
  await utimes(path, touched, touched);
  assert.notEqual((await service.thumbnail({ path, size: 128 })).etag, changed.etag);
});

test("the cache stays under its byte bound, evicting the least recently used, and drops what has gone unused", async (t) => {
  const place = await folder(t, "amplefile-thumbs-place-");
  const state = await folder(t, "amplefile-thumbs-state-");
  const paths: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const path = join(place, `photo-${index}.png`);
    const surface = picture(256, 256);
    // Noise, so each thumbnail is a few kilobytes.
    const context = surface.getContext("2d");
    for (let dot = 0; dot < 400; dot += 1) {
      context.fillStyle = `rgb(${(dot * 37 + index * 11) % 256},${(dot * 91) % 256},${(dot * 53 + index) % 256})`;
      context.fillRect((dot * 13) % 256, (dot * 29 + index * 7) % 256, 6, 6);
    }
    await writeFile(path, await surface.encode("png"));
    paths.push(path);
  }
  const probe = new ThumbnailService(await folder(t, "amplefile-thumbs-probe-"));
  const one = thumbnailOf(await probe.thumbnail({ path: paths[0]!, size: 256 })).length;
  const maxBytes = one * 3.5;
  const service = new ThumbnailService(state, {}, { maxBytes });
  for (const path of paths.slice(0, 3)) await service.thumbnail({ path, size: 256 });
  // Use the first again, so the second is now the least recently used.
  assert.equal((await service.thumbnail({ path: paths[0]!, size: 256 })).kind === "thumbnail", true);
  for (const path of paths.slice(3)) await service.thumbnail({ path, size: 256 });
  await service.cache.sweep();
  const { bytes, files } = await service.cache.size();
  assert.ok(bytes <= maxBytes, `kept ${bytes} bytes, bound ${maxBytes}`);
  assert.ok(files < 6);
  const kept = await filesUnder(join(state, "thumbnails"));
  assert.equal(kept.length, files, "the index matches the disk");
  const second = await service.thumbnail({ path: paths[1]!, size: 256 });
  assert.equal(second.kind === "thumbnail" && second.cached, false, "the least recently used was evicted first");

  // Thumbnails unused past the age bound are removed when the cache is next opened.
  const aged = await folder(t, "amplefile-thumbs-aged-");
  const writer = new ThumbnailService(aged);
  await writer.thumbnail({ path: paths[0]!, size: 64 });
  const [file] = await filesUnder(join(aged, "thumbnails"));
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await utimes(join(aged, "thumbnails", file!), old, old);
  const reopened = new ThumbnailService(aged);
  assert.deepEqual(await reopened.cache.size(), { bytes: 0, files: 0 });
  assert.deepEqual(await filesUnder(join(aged, "thumbnails")), []);
});

test("hostile or unsuitable files are refused quickly and plainly, before any decoding", async (t) => {
  const place = await folder(t, "amplefile-thumbs-place-");
  const state = await folder(t, "amplefile-thumbs-state-");
  const service = new ThumbnailService(state, { imageBytes: 1024 * 1024 });
  t.after(() => service.close());
  await writeFile(join(place, "huge.jpg"), "");
  await truncate(join(place, "huge.jpg"), 1024 * 1024 + 1);
  await writeFile(join(place, "bomb.png"), bombPng(100_000, 100_000));
  await writeFile(join(place, "wide.png"), bombPng(40_000, 10));
  await writeFile(join(place, "garbage.jpg"), "this is not a picture at all");
  await writeFile(join(place, "cut.png"), (await picture(200, 200).encode("png")).subarray(0, 40));
  await writeFile(join(place, "drawing.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script><image href='file:///etc/passwd'/></svg>");
  await writeFile(join(place, "drawing.png"), "<svg xmlns='http://www.w3.org/2000/svg'><image href='https://example.com/x.png'/></svg>");
  await writeFile(join(place, "notes.txt"), "hello");
  await writeFile(join(place, "empty.png"), "");
  await writeFile(join(place, "fake.pdf"), "not a pdf");
  await writeFile(join(place, "broken.pdf"), "%PDF-1.7\n1 0 obj << /Type /Catalog >>\n%%EOF");

  assert.equal(await refusal(service.thumbnail({ path: join(place, "huge.jpg"), size: 128 })), "too-large");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "bomb.png"), size: 128 })), "too-many-pixels");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "wide.png"), size: 128 })), "too-many-pixels", "a side past the canvas ceiling");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "garbage.jpg"), size: 128 })), "damaged");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "cut.png"), size: 128 })), "damaged");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "drawing.svg"), size: 128 })), "unsupported", "SVG is never drawn");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "drawing.png"), size: 128 })), "unsupported", "nor an SVG under a picture's name");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "notes.txt"), size: 128 })), "unsupported");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "empty.png"), size: 128 })), "damaged");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "fake.pdf"), size: 128 })), "damaged");
  assert.equal(await refusal(service.thumbnail({ path: join(place, "broken.pdf"), size: 128 })), "damaged");
  assert.equal(service.stats.imagesDrawn, 1, "only the cut-off PNG, whose header is whole, reached the picture decoder");
  await assert.rejects(service.thumbnail({ path: join(place, "missing.png"), size: 128 }), { statusCode: 404 });

  // A refusal is remembered, so asking again is cheap until the file changes.
  const started = performance.now();
  assert.equal(await refusal(service.thumbnail({ path: join(place, "broken.pdf"), size: 128 })), "damaged");
  assert.equal(service.stats.pdfsDrawn, 1);
  assert.ok(performance.now() - started < 200);
  assert.deepEqual(await filesUnder(join(state)).catch(() => []), [], "nothing is kept for a refusal");
});

test("a link is never read, even as the last part of the path", async (t) => {
  const place = await folder(t, "amplefile-thumbs-place-");
  const outside = await folder(t, "amplefile-thumbs-outside-");
  const service = new ThumbnailService(await folder(t, "amplefile-thumbs-state-"));
  await writeFile(join(outside, "secret.png"), await picture(50, 50).encode("png"));
  await symlink(join(outside, "secret.png"), join(place, "linked.png"));
  // The routes refuse a link through the place's path policy first; the service itself opens without following one.
  await assert.rejects(service.thumbnail({ path: join(place, "linked.png"), size: 64 }), (error: unknown) => {
    return error instanceof ThumbnailRefusedError ? error.reason === "unsupported" : (error as { statusCode?: number }).statusCode === 409;
  });
  assert.equal(service.stats.imagesDrawn, 0);
});

/** A service whose drawings wait at a gate the test opens, so a slot can be held deterministically. */
class GatedThumbnailService extends ThumbnailService {
  private open: () => void = () => undefined;
  private gate = new Promise<void>((resolve) => { this.open = resolve; });
  release(): void { this.open(); }
  close(): Promise<void> { this.release(); return super.close(); }
  protected override beforeDraw(): Promise<void> { return this.gate; }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition());
}

test("drawing is bounded: a request that goes away leaves the queue, a full queue answers busy, a slow one times out", async (t) => {
  const place = await folder(t, "amplefile-thumbs-place-");
  const state = await folder(t, "amplefile-thumbs-state-");
  const big = picture(4000, 3000);
  await writeFile(join(place, "big.png"), await big.encode("png"));
  for (let index = 0; index < 4; index += 1) await writeFile(join(place, `photo-${index}.jpg`), await picture(800, 600).encode("jpeg", 80));
  const service = new GatedThumbnailService(state, { imageConcurrency: 1, queueLength: 2 });
  t.after(() => service.close());

  // One picture holds the only slot; the next ones wait.
  const holding = service.thumbnail({ path: join(place, "big.png"), size: 256 });
  const gone = new AbortController();
  const leaving = service.thumbnail({ path: join(place, "photo-0.jpg"), size: 256, signal: gone.signal });
  const leavingToo = service.thumbnail({ path: join(place, "photo-1.jpg"), size: 256, signal: gone.signal });
  await until(() => service.queued === 2);
  assert.equal(await refusal(service.thumbnail({ path: join(place, "photo-2.jpg"), size: 256 })), "busy", "the queue holds two");
  gone.abort();
  await assert.rejects(leaving, { name: "AbortError" });
  await assert.rejects(leavingToo, { name: "AbortError" });
  assert.equal(service.queued, 0, "the requests that went away left the queue at once");
  const staying = service.thumbnail({ path: join(place, "photo-3.jpg"), size: 256 });
  await until(() => service.queued === 1);
  service.release();
  assert.equal((await holding).kind, "thumbnail");
  assert.equal((await staying).kind, "thumbnail");
  assert.equal(service.stats.imagesDrawn, 2, "the two that went away were never decoded");
  assert.equal((await service.cache.size()).files, 2);

  // Two requests for the same thumbnail share one drawing; one leaving does not stop it for the other.
  const shared = new AbortController();
  const leaver = service.thumbnail({ path: join(place, "photo-0.jpg"), size: 64, signal: shared.signal });
  const keeper = service.thumbnail({ path: join(place, "photo-0.jpg"), size: 64 });
  shared.abort();
  await assert.rejects(leaver, { name: "AbortError" });
  assert.equal((await keeper).kind, "thumbnail");
  assert.equal(service.stats.imagesDrawn, 3);

  // A drawing past its time bound is answered as timed out, and not tried again at once.
  const slow = new ThumbnailService(await folder(t, "amplefile-thumbs-slow-"), { imageTimeoutMs: 1 });
  assert.equal(await refusal(slow.thumbnail({ path: join(place, "big.png"), size: 256 })), "timed-out");
  const drawn = slow.stats.imagesDrawn;
  assert.equal(await refusal(slow.thumbnail({ path: join(place, "big.png"), size: 256 })), "timed-out");
  assert.equal(slow.stats.imagesDrawn, drawn, "the second ask is answered from the remembered refusal");
});

test("a PDF that takes too long ends its worker, and the next PDF starts a new one", async (t) => {
  const place = await folder(t, "amplefile-thumbs-place-");
  await writeFile(join(place, "report.pdf"), await letterPdf());
  await writeFile(join(place, "other.pdf"), await letterPdf());
  const slow = new ThumbnailService(await folder(t, "amplefile-thumbs-state-"), { pdfTimeoutMs: 1 });
  t.after(() => slow.close());
  assert.equal(await refusal(slow.thumbnail({ path: join(place, "report.pdf"), size: 128 })), "timed-out");
  slow.limits.pdfTimeoutMs = 15_000;
  const page = thumbnailOf(await slow.thumbnail({ path: join(place, "other.pdf"), size: 128 }));
  assert.equal(readImageHeader(page)?.height, 128);
});

test("the thumbnail routes serve every kind of place under its path policy, with tags the window can reuse", async (t) => {
  const sandbox = await folder(t, "amplefile-thumbs-api-");
  const home = join(sandbox, "home");
  await mkdir(home, { recursive: true });
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => { await thumbnailServiceFor().close(); await api.close(); configureAmpleFileStateRoot(undefined); });
  const stateRoot = join(sandbox, "state");

  // A Connected Folder.
  const connectedRoot = join(sandbox, "Photos");
  await mkdir(join(connectedRoot, "trip"), { recursive: true });
  await mkdir(join(connectedRoot, ".amplefile"), { recursive: true });
  await writeFile(join(connectedRoot, "trip", "beach.jpg"), await picture(600, 400).encode("jpeg", 85));
  await writeFile(join(connectedRoot, ".amplefile", "hidden.png"), await picture(10, 10).encode("png"));
  await writeFile(join(connectedRoot, "notes.txt"), "hi");
  await writeFile(join(sandbox, "outside.png"), await picture(10, 10).encode("png"));
  await symlink(join(sandbox, "outside.png"), join(connectedRoot, "link.png"));
  await mkdir(join(sandbox, "elsewhere"));
  await symlink(join(sandbox, "elsewhere"), join(connectedRoot, "linked-folder"));
  await writeFile(join(sandbox, "elsewhere", "inside.png"), await picture(10, 10).encode("png"));
  const connected = await registerLinkedConnectedFolder(connectedRoot);
  const before = await filesUnder(connectedRoot);
  const base = `${api.origin}/api/connected-folders/${connected.id}/thumbnail`;

  const answer = await fetch(`${base}?path=trip%2Fbeach.jpg&size=128`);
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.equal(answer.headers.get("content-type"), "image/webp");
  assert.equal(answer.headers.get("cache-control"), "private, no-cache");
  const etag = answer.headers.get("etag");
  assert.match(etag ?? "", /^"[0-9a-f]{32}"$/);
  assert.deepEqual(readImageHeader(Buffer.from(await answer.arrayBuffer())), { format: "webp", width: 128, height: 85 });
  const kept = await filesUnder(connectedFolderThumbnailRoot(connectedRoot));
  assert.equal(kept.length, 1, "a Connected Folder's thumbnails live in its machine-local state");
  assert.ok(connectedFolderThumbnailRoot(connectedRoot).startsWith(stateRoot));
  assert.deepEqual(await filesUnder(connectedRoot), before, "nothing is written into the Connected Folder");

  const again = await fetch(`${base}?path=trip%2Fbeach.jpg&size=128`, { headers: { "if-none-match": etag! } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), etag);
  // Naming the version the listing showed (size and modification time) makes the answer immutable.
  const info = await stat(join(connectedRoot, "trip", "beach.jpg"));
  const version = `${info.size}-${Math.floor(info.mtimeMs)}`;
  const pinned = await fetch(`${base}?path=trip%2Fbeach.jpg&size=128&v=${version}`);
  assert.equal(pinned.headers.get("cache-control"), "private, max-age=31536000, immutable");
  const stale = await fetch(`${base}?path=trip%2Fbeach.jpg&size=128&v=1-2`);
  assert.equal(stale.headers.get("cache-control"), "private, no-cache");

  const refused = await fetch(`${base}?path=notes.txt&size=128`);
  assert.equal(refused.status, 415);
  assert.deepEqual(await refused.json(), { error: "There’s no thumbnail for this kind of file.", reason: "unsupported" });
  assert.equal((await fetch(`${base}?path=missing.jpg&size=128`)).status, 404);
  assert.equal((await fetch(`${base}?path=link.png&size=128`)).status, 400, "a link is refused");
  assert.equal((await fetch(`${base}?path=linked-folder%2Finside.png&size=128`)).status, 400, "so is a path through a linked folder");
  assert.equal((await fetch(`${base}?path=..%2Foutside.png&size=128`)).status, 400, "nothing outside the place");
  assert.equal((await fetch(`${base}?path=.amplefile%2Fhidden.png&size=128`)).status, 400, "nothing in AmpleFile's data");
  assert.equal((await fetch(`${base}?path=trip%2Fbeach.jpg&size=100`)).status, 400, "only the fixed sizes");
  assert.equal((await fetch(`${base}?path=trip%2Fbeach.jpg`)).status, 400);
  assert.equal((await fetch(`${base}?size=128`)).status, 400);
  assert.equal((await fetch(`${api.origin}/api/connected-folders/space-0000000000000000/thumbnail?path=a.png&size=64`)).status, 404);

  // A Standard Folder (one added to the sidebar) and the computer place.
  const added = join(sandbox, "Shared");
  await mkdir(added);
  await writeFile(join(added, "scan.png"), await picture(300, 600).encode("png"));
  const sidebar = addSidebarFolder(added, home);
  const standard = await fetch(`${api.origin}/api/standard-folders/${sidebar.id}/thumbnail?path=scan.png&size=64`);
  assert.equal(standard.status, 200);
  assert.deepEqual(readImageHeader(Buffer.from(await standard.arrayBuffer())), { format: "webp", width: 32, height: 64 });
  assert.equal((await fetch(`${api.origin}/api/standard-folders/${sidebar.id}/thumbnail?path=..%2Foutside.png&size=64`)).status, 400);
  const computerPath = encodeURIComponent(join(added, "scan.png").slice(1));
  const computer = await fetch(`${api.origin}/api/standard-folders/computer/thumbnail?path=${computerPath}&size=256`);
  assert.equal(computer.status, 200);
  assert.deepEqual(readImageHeader(Buffer.from(await computer.arrayBuffer())), { format: "webp", width: 128, height: 256 });
  assert.equal((await fetch(`${api.origin}/api/standard-folders/computer/thumbnail?path=&size=256`)).status, 400);
  assert.equal((await filesUnder(join(stateRoot, "thumbnails"))).length, 2, "other places' thumbnails live under the state root");
  assert.deepEqual(await filesUnder(added), ["scan.png"]);

  // Disconnecting the Connected Folder removes its thumbnails with the rest of its machine-local state.
  const removed = await fetch(`${api.origin}/api/connected-folders/${connected.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200, await removed.text());
  assert.equal(existsSync(connectedFolderThumbnailRoot(connectedRoot)), false);
  assert.equal(existsSync(connectedFolderStateDir(connectedRoot)), false);
  assert.ok(existsSync(join(connectedRoot, "trip", "beach.jpg")), "the folder itself stays");
  assert.equal((await readFile(join(connectedRoot, "notes.txt"), "utf8")), "hi");
});
