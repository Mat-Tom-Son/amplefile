/**
 * Picture thumbnails for the file manager window's icon view.
 *
 * A thumbnail is a small WebP drawn from a file's own bytes: PNG, JPEG, GIF
 * (its first frame), WebP, BMP, and AVIF through the bundled canvas library,
 * and a PDF's first page through PDF.js in a worker thread. SVG is left out:
 * it is a document that can name other files and carry script, and nothing
 * here draws one. Image files are hostile input, so:
 *
 * - the format comes from the bytes (image-header.ts), never the name, and
 *   the pixel count is checked from the header before anything decodes;
 * - every input has a byte bound, every decode a time bound, and at most
 *   `imageConcurrency` pictures and one PDF are drawn at once, so a folder of
 *   thousands of photos queues instead of stalling the app or the Worker;
 * - a request that goes away leaves the queue at once; a picture already
 *   being drawn finishes and is kept, so scrolling back finds it.
 *
 * Thumbnails are kept on this computer, never in a user's folder: those of a
 * Connected Folder's files in its machine-local state folder (so disconnecting
 * removes them with the rest of that state), every other place's under the
 * state root's `thumbnails/`. Each one's name is a hash of the file's absolute
 * path, inode, size, and modification time and the thumbnail size, so a
 * changed file gets a new thumbnail and the old one ages out. The cache is
 * bounded in bytes and age, evicting what was used least recently.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { readImageHeader } from "./image-header.js";
import { ampleFileStateRoot, connectedFolderStateDir } from "./state-paths.js";

/** Longest side, in pixels. 128 fills the icon view's 80-point tile at 1x and 2x Info-sized use; 256 is the tile at 2x; 64 suits a list row. */
export const thumbnailSizes = [64, 128, 256] as const;
export type ThumbnailSize = (typeof thumbnailSizes)[number];

export function isThumbnailSize(value: number): value is ThumbnailSize {
  return (thumbnailSizes as readonly number[]).includes(value);
}

/** Names a thumbnail is attempted for. Anything else is refused before the file is opened. */
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".gif", ".webp", ".bmp", ".avif"]);
const pdfExtension = ".pdf";

export interface ThumbnailLimits {
  /** Largest picture file read. */
  imageBytes: number;
  /** Largest PDF read. */
  pdfBytes: number;
  /** Largest picture decoded, in pixels (width × height from its header). */
  imagePixels: number;
  /** Largest side a picture may claim; the canvas library's own ceiling is 32,767. */
  imageSide: number;
  /** Largest picture inside a PDF that PDF.js decodes; bigger ones are left out of the drawing. */
  pdfImagePixels: number;
  imageTimeoutMs: number;
  pdfTimeoutMs: number;
  /** Pictures drawn at once; PDFs are drawn one at a time beside them. */
  imageConcurrency: number;
  /** Requests waiting beyond this are answered `busy` straight away. */
  queueLength: number;
  /** Heap bound for the PDF worker thread. */
  pdfHeapMb: number;
}

export const defaultThumbnailLimits: ThumbnailLimits = Object.freeze({
  imageBytes: 64 * 1024 * 1024,
  pdfBytes: 50 * 1024 * 1024,
  imagePixels: 64_000_000,
  imageSide: 30_000,
  pdfImagePixels: 50_000_000,
  imageTimeoutMs: 10_000,
  pdfTimeoutMs: 15_000,
  imageConcurrency: 2,
  queueLength: 1_000,
  pdfHeapMb: 256,
});

export interface ThumbnailCacheLimits {
  /** Total bytes of kept thumbnails; past it, the least recently used go first. */
  maxBytes: number;
  /** A thumbnail unused this long is removed. */
  maxAgeMs: number;
}

export const defaultThumbnailCacheLimits: ThumbnailCacheLimits = Object.freeze({
  maxBytes: 256 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

/**
 * Why there is no thumbnail. The window shows the file's icon for all of
 * them; the reason is for logs and tests.
 */
export type ThumbnailRefusal =
  | "unsupported" // not a kind thumbnails are drawn for, or its bytes are not that kind
  | "too-large" // the file is over its byte bound
  | "too-many-pixels" // the picture claims more pixels than the bound
  | "damaged" // the bytes could not be decoded
  | "locked" // a PDF that needs a password
  | "timed-out" // drawing took longer than its bound
  | "busy" // too many requests are already waiting
  | "unavailable"; // the decoder could not be loaded on this computer

const refusalStatus: Record<ThumbnailRefusal, number> = {
  unsupported: 415,
  "too-large": 413,
  "too-many-pixels": 413,
  damaged: 422,
  locked: 422,
  "timed-out": 503,
  busy: 503,
  unavailable: 503,
};

const refusalMessage: Record<ThumbnailRefusal, string> = {
  unsupported: "There’s no thumbnail for this kind of file.",
  "too-large": "This file is too large for a thumbnail.",
  "too-many-pixels": "This picture is too large for a thumbnail.",
  damaged: "This file can’t be read as a picture.",
  locked: "This PDF needs a password.",
  "timed-out": "This thumbnail took too long to draw.",
  busy: "Too many thumbnails are waiting; ask again shortly.",
  unavailable: "Thumbnails can’t be drawn on this computer right now.",
};

export class ThumbnailRefusedError extends Error {
  readonly reason: ThumbnailRefusal;
  readonly statusCode: number;
  constructor(reason: ThumbnailRefusal) {
    super(refusalMessage[reason]);
    this.name = "ThumbnailRefusedError";
    this.reason = reason;
    this.statusCode = refusalStatus[reason];
  }
}

export type ThumbnailAnswer =
  | { kind: "not-modified"; etag: string; version: string }
  | { kind: "thumbnail"; etag: string; version: string; bytes: Buffer; cached: boolean };

export interface ThumbnailRequest {
  /** The file, already resolved under its place's path policy. */
  path: string;
  size: ThumbnailSize;
  /** The Connected Folder holding the file, when it was asked for through one; its thumbnails live with its machine-local state. */
  connectedFolderRoot?: string;
  /** The window's `If-None-Match`; a match answers `not-modified` without reading anything. */
  ifNoneMatch?: string | null;
  signal?: AbortSignal;
}

interface ThumbnailJob {
  key: string;
  size: ThumbnailSize;
  path: string;
  kind: "image" | "pdf";
  expected: FileIdentity;
  cacheFile: string;
  waiters: number;
  started: boolean;
  withdraw: () => void;
  promise: Promise<Buffer>;
  resolve: (bytes: Buffer) => void;
  reject: (error: unknown) => void;
}

interface FileIdentity { ino: bigint; size: bigint; mtimeNs: bigint }

/**
 * The thumbnail service for one state root. The local API keeps one per state
 * root (`thumbnailServiceFor`); tests make their own with small limits.
 */
export class ThumbnailService {
  readonly limits: ThumbnailLimits;
  readonly cache: ThumbnailCache;
  private readonly inFlight = new Map<string, ThumbnailJob>();
  private readonly imageQueue = new Limiter();
  private readonly pdfQueue = new Limiter();
  private readonly refused = new Map<string, { reason: ThumbnailRefusal; until: number }>();
  private pdf: PdfRenderer | null = null;
  /** Counts of drawing work actually started, for tests and measurements. */
  readonly stats = { imagesDrawn: 0, pdfsDrawn: 0, cacheHits: 0, notModified: 0 };

  constructor(readonly stateRoot: string, limits: Partial<ThumbnailLimits> = {}, cacheLimits: Partial<ThumbnailCacheLimits> = {}) {
    this.limits = { ...defaultThumbnailLimits, ...limits };
    this.cache = new ThumbnailCache(stateRoot, { ...defaultThumbnailCacheLimits, ...cacheLimits });
    this.imageQueue.concurrency = this.limits.imageConcurrency;
    this.pdfQueue.concurrency = 1;
  }

  async thumbnail(request: ThumbnailRequest): Promise<ThumbnailAnswer> {
    request.signal?.throwIfAborted();
    const kind = thumbnailKind(request.path);
    if (!kind) throw new ThumbnailRefusedError("unsupported");
    const info = await stat(request.path, { bigint: true }).catch(() => null);
    if (!info?.isFile()) throw Object.assign(new Error("File not found."), { statusCode: 404 });
    if (info.size > BigInt(kind === "pdf" ? this.limits.pdfBytes : this.limits.imageBytes)) throw new ThumbnailRefusedError("too-large");
    if (info.size === 0n) throw new ThumbnailRefusedError("damaged");
    const identity = fileIdentity(info);
    const key = thumbnailKey(request.path, identity, request.size);
    const etag = `"${key.slice(0, 32)}"`;
    const version = thumbnailVersion(info);
    if (request.ifNoneMatch && etagMatches(request.ifNoneMatch, etag)) {
      this.stats.notModified += 1;
      return { kind: "not-modified", etag, version };
    }
    const cacheFile = this.cache.fileFor(key, request.connectedFolderRoot);
    const kept = await this.cache.read(cacheFile);
    if (kept) {
      this.stats.cacheHits += 1;
      return { kind: "thumbnail", etag, version, bytes: kept, cached: true };
    }
    const refusal = this.refused.get(key);
    if (refusal && refusal.until > Date.now()) throw new ThumbnailRefusedError(refusal.reason);
    const bytes = await this.join({ key, size: request.size, path: request.path, kind, expected: identity, cacheFile }, request.signal);
    return { kind: "thumbnail", etag, version, bytes, cached: false };
  }

  /** Stops the PDF worker; the next PDF starts a new one. */
  async close(): Promise<void> {
    await this.pdf?.close();
    this.pdf = null;
  }

  /** Waits on the job drawing this key, starting one if none is; leaves it when the signal aborts. */
  private join(spec: Pick<ThumbnailJob, "key" | "size" | "path" | "kind" | "expected" | "cacheFile">, signal?: AbortSignal): Promise<Buffer> {
    let job = this.inFlight.get(spec.key);
    if (!job) {
      const queue = spec.kind === "pdf" ? this.pdfQueue : this.imageQueue;
      if (queue.waiting >= this.limits.queueLength) return Promise.reject(new ThumbnailRefusedError("busy"));
      let resolve!: (bytes: Buffer) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<Buffer>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
      // Nobody may be listening when a job is dropped; that is not an unhandled rejection.
      promise.catch(() => undefined);
      const created: ThumbnailJob = { ...spec, waiters: 0, started: false, withdraw: () => undefined, promise, resolve, reject };
      job = created;
      this.inFlight.set(spec.key, created);
      created.withdraw = queue.run(() => {
        created.started = true;
        return this.draw(created);
      });
    }
    const current = job;
    current.waiters += 1;
    if (!signal) return current.promise;
    return new Promise<Buffer>((resolvePromise, rejectPromise) => {
      const leave = () => {
        current.waiters -= 1;
        // Everyone who asked has gone away before it started: it leaves the queue and is never drawn.
        if (current.waiters === 0 && !current.started) {
          current.withdraw();
          if (this.inFlight.get(current.key) === current) this.inFlight.delete(current.key);
          current.reject(abortError());
        }
        rejectPromise(abortError());
      };
      if (signal.aborted) { leave(); return; }
      signal.addEventListener("abort", leave, { once: true });
      current.promise.then(
        (bytes) => { signal.removeEventListener("abort", leave); resolvePromise(bytes); },
        (error) => { signal.removeEventListener("abort", leave); rejectPromise(error); },
      );
    });
  }

  /** Draws one job and settles it; the returned promise holds its queue slot until the work has really stopped. */
  private draw(job: ThumbnailJob): Promise<void> {
    const timeoutMs = job.kind === "pdf" ? this.limits.pdfTimeoutMs : this.limits.imageTimeoutMs;
    const work = (job.kind === "pdf" ? this.drawPdf(job) : this.drawImage(job)).then(async (bytes) => {
      await this.cache.write(job.cacheFile, bytes).catch(() => undefined);
      return bytes;
    });
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ThumbnailRefusedError("timed-out")), timeoutMs);
      timer.unref?.();
    });
    const settled = Promise.race([work, timedOut]).then(
      (bytes) => { job.resolve(bytes); },
      (error) => {
        if (error instanceof ThumbnailRefusedError && error.reason !== "busy" && error.reason !== "unavailable") {
          this.remember(job.key, error.reason);
        }
        job.reject(error);
      },
    ).finally(() => {
      clearTimeout(timer);
      this.inFlight.delete(job.key);
    });
    // A picture decoder cannot be interrupted, so its slot stays taken until
    // it returns; a hung decoder gives the slot back after a hard bound so the
    // queue never stops for good. A PDF settles within its bound (its thread
    // is ended on time-out), so it holds its slot to the end.
    const finished = work.then(() => undefined, () => undefined);
    if (job.kind === "pdf") return finished.then(() => settled);
    let hardTimer: NodeJS.Timeout | undefined;
    const hardBound = new Promise<void>((resolve) => { hardTimer = setTimeout(resolve, Math.max(timeoutMs * 3, 30_000)); hardTimer.unref?.(); });
    return Promise.race([finished, hardBound]).then(() => { clearTimeout(hardTimer); return settled; });
  }

  /** Runs as a drawing takes its slot, before the file is read. Tests hold a slot open with it. */
  protected async beforeDraw(_job: { path: string; kind: "image" | "pdf" }): Promise<void> {}

  /** Requests waiting for a slot. */
  get queued(): number {
    return this.imageQueue.waiting + this.pdfQueue.waiting;
  }

  private async drawImage(job: ThumbnailJob): Promise<Buffer> {
    await this.beforeDraw(job);
    const bytes = await readBounded(job.path, job.expected, this.limits.imageBytes);
    const header = readImageHeader(bytes);
    if (!header) throw new ThumbnailRefusedError(looksLikeSvg(bytes) ? "unsupported" : "damaged");
    if (header.width > this.limits.imageSide || header.height > this.limits.imageSide || header.width * header.height > this.limits.imagePixels) {
      throw new ThumbnailRefusedError("too-many-pixels");
    }
    const canvas = loadCanvas();
    if (!canvas) throw new ThumbnailRefusedError("unavailable");
    this.stats.imagesDrawn += 1;
    const image = new canvas.Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new ThumbnailRefusedError("damaged"));
      image.src = bytes;
    });
    // The decoder turns the picture upright by its EXIF orientation, which swaps width and height but not their product.
    const width = image.width;
    const height = image.height;
    if (!(width > 0 && height > 0) || width * height > this.limits.imagePixels) throw new ThumbnailRefusedError("damaged");
    const scale = Math.min(1, job.size / Math.max(width, height));
    const surface = canvas.createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const context = surface.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, surface.width, surface.height);
    return surface.encode("webp", 80);
  }

  private async drawPdf(job: ThumbnailJob): Promise<Buffer> {
    await this.beforeDraw(job);
    const bytes = await readBounded(job.path, job.expected, this.limits.pdfBytes);
    if (bytes.subarray(0, 1024).indexOf("%PDF-") < 0) throw new ThumbnailRefusedError("damaged");
    this.pdf ??= new PdfRenderer(this.limits);
    this.stats.pdfsDrawn += 1;
    return this.pdf.render(bytes, job.size, this.limits.pdfTimeoutMs);
  }

  private remember(key: string, reason: ThumbnailRefusal): void {
    // A file that cannot be drawn is not tried again until it changes (its
    // key changes), or for a minute after a time-out.
    const lifetime = reason === "timed-out" ? 60_000 : 10 * 60_000;
    this.refused.set(key, { reason, until: Date.now() + lifetime });
    if (this.refused.size > 4096) {
      for (const stale of this.refused.keys()) {
        this.refused.delete(stale);
        if (this.refused.size <= 3072) break;
      }
    }
  }
}

/**
 * The thumbnails kept on disk. Its index lives in memory, built from the
 * folders on first use and rebuilt when it may have drifted (a Connected
 * Folder's state removed under it); usage time is the file's modification
 * time, refreshed at most daily when a thumbnail is reused.
 */
export class ThumbnailCache {
  private index: Map<string, { bytes: number; usedAt: number }> | null = null;
  private loading: Promise<void> | null = null;
  private total = 0;
  private scannedAt = 0;
  private sweeping: Promise<void> | null = null;

  constructor(readonly stateRoot: string, readonly limits: ThumbnailCacheLimits) {}

  /** Where other places' thumbnails are kept. */
  get otherPlacesRoot(): string {
    return join(this.stateRoot, "thumbnails");
  }

  fileFor(key: string, connectedFolderRoot?: string): string {
    const root = connectedFolderRoot ? connectedFolderThumbnailRoot(connectedFolderRoot) : this.otherPlacesRoot;
    return join(root, key.slice(0, 2), `${key}.webp`);
  }

  async read(file: string): Promise<Buffer | null> {
    await this.ready();
    const bytes = await readFile(file).catch(() => null);
    const entry = this.index!.get(file);
    if (!bytes) {
      if (entry) { this.index!.delete(file); this.total -= entry.bytes; }
      return null;
    }
    const now = Date.now();
    if (entry) {
      if (now - entry.usedAt > 24 * 60 * 60 * 1000) {
        const seconds = now / 1000;
        void utimes(file, seconds, seconds).catch(() => undefined);
      }
      entry.usedAt = now;
    } else {
      this.index!.set(file, { bytes: bytes.length, usedAt: now });
      this.total += bytes.length;
    }
    return bytes;
  }

  async write(file: string, bytes: Buffer): Promise<void> {
    await this.ready();
    const folder = join(file, "..");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    const previous = this.index!.get(file);
    if (previous) this.total -= previous.bytes;
    this.index!.set(file, { bytes: bytes.length, usedAt: Date.now() });
    this.total += bytes.length;
    if (this.total > this.limits.maxBytes) void this.sweep().catch(() => undefined);
  }

  /** Total bytes the index holds, after loading it. */
  async size(): Promise<{ bytes: number; files: number }> {
    await this.ready();
    return { bytes: this.total, files: this.index!.size };
  }

  /** Removes thumbnails unused for `maxAgeMs`, then the least recently used until the total is under 90% of `maxBytes`. */
  sweep(): Promise<void> {
    this.sweeping ??= this.sweepOnce().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<void> {
    // The index can only overstate: rescan before evicting what may already be gone.
    if (Date.now() - this.scannedAt > 10 * 60 * 1000) await this.scan();
    const now = Date.now();
    const entries = [...this.index!.entries()].sort((left, right) => left[1].usedAt - right[1].usedAt);
    const target = Math.floor(this.limits.maxBytes * 0.9);
    for (const [file, entry] of entries) {
      const expired = now - entry.usedAt > this.limits.maxAgeMs;
      if (!expired && this.total <= target) break;
      await unlink(file).catch(() => undefined);
      this.index!.delete(file);
      this.total -= entry.bytes;
    }
  }

  private async ready(): Promise<void> {
    if (this.index) return;
    this.loading ??= this.scan().then(async () => {
      // Age out what was left unused since the last run.
      await this.sweepOnce();
    });
    await this.loading;
  }

  private async scan(): Promise<void> {
    const index = new Map<string, { bytes: number; usedAt: number }>();
    let total = 0;
    const roots = [this.otherPlacesRoot];
    const stateFolders = join(this.stateRoot, "state", "connected-folders");
    for (const name of await readdir(stateFolders).catch(() => [] as string[])) roots.push(join(stateFolders, name, "thumbnails"));
    for (const root of roots) {
      for (const shard of await readdir(root).catch(() => [] as string[])) {
        if (!/^[0-9a-f]{2}$/.test(shard)) continue;
        for (const name of await readdir(join(root, shard)).catch(() => [] as string[])) {
          const file = join(root, shard, name);
          if (name.endsWith(".tmp")) { await rm(file, { force: true }).catch(() => undefined); continue; }
          if (!name.endsWith(".webp")) continue;
          const info = await stat(file).catch(() => null);
          if (!info?.isFile()) continue;
          index.set(file, { bytes: info.size, usedAt: info.mtimeMs });
          total += info.size;
        }
      }
    }
    this.index = index;
    this.total = total;
    this.scannedAt = Date.now();
  }
}

/** Where a Connected Folder's thumbnails live: inside its machine-local state, which disconnecting removes. */
export function connectedFolderThumbnailRoot(connectedFolderRoot: string): string {
  return join(connectedFolderStateDir(connectedFolderRoot), "thumbnails");
}

const services = new Map<string, ThumbnailService>();

/** The local API's thumbnail service for the current state root. */
export function thumbnailServiceFor(stateRoot = ampleFileStateRoot()): ThumbnailService {
  let service = services.get(stateRoot);
  if (!service) {
    service = new ThumbnailService(stateRoot);
    services.set(stateRoot, service);
  }
  return service;
}

/** Stops every service's PDF worker (the local API closing). */
export async function closeThumbnailServices(): Promise<void> {
  await Promise.all([...services.values()].map((service) => service.close()));
}

/**
 * The file's version as the window's listing can name it: its size and its
 * modification time in whole milliseconds (`sizeBytes` and `Date.parse(updatedAt)`
 * of a listed entry). A request naming the current version may be cached by
 * the window without asking again.
 */
export function thumbnailVersion(info: { size: bigint; mtimeNs: bigint }): string {
  return `${info.size}-${info.mtimeNs / 1_000_000n}`;
}

function thumbnailKind(path: string): "image" | "pdf" | null {
  const extension = extname(path).toLowerCase();
  if (imageExtensions.has(extension)) return "image";
  if (extension === pdfExtension) return "pdf";
  return null;
}

function fileIdentity(info: BigIntStats): FileIdentity {
  return { ino: info.ino, size: info.size, mtimeNs: info.mtimeNs };
}

function thumbnailKey(path: string, identity: FileIdentity, size: ThumbnailSize): string {
  return createHash("sha256")
    .update(["thumbnail-v1", String(size), path, String(identity.ino), String(identity.size), String(identity.mtimeNs)].join("\0"))
    .digest("hex");
}

function etagMatches(header: string, etag: string): boolean {
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === etag || value === `W/${etag}` || value === "*";
  });
}

/**
 * Reads a whole file that must still be the one that was keyed: opened
 * without following a link in its last segment, and with the same inode, size,
 * and modification time. A file that changed in between is read again by the
 * next request under its new key.
 */
async function readBounded(path: string, expected: FileIdentity, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") throw new ThumbnailRefusedError("unsupported");
    throw Object.assign(new Error("File not found."), { statusCode: 404 });
  });
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new ThumbnailRefusedError("unsupported");
    if (info.ino !== expected.ino || info.size !== expected.size || info.mtimeNs !== expected.mtimeNs) {
      throw Object.assign(new Error("The file changed while its thumbnail was being drawn."), { statusCode: 409 });
    }
    if (info.size > BigInt(limit)) throw new ThumbnailRefusedError("too-large");
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

function abortError(): Error {
  return Object.assign(new Error("The request went away."), { name: "AbortError" });
}

type CanvasModule = typeof import("@napi-rs/canvas");
let canvasModule: CanvasModule | null | undefined;

function loadCanvas(): CanvasModule | null {
  if (canvasModule === undefined) {
    try {
      canvasModule = createRequire(import.meta.url)("@napi-rs/canvas") as CanvasModule;
    } catch {
      canvasModule = null;
    }
  }
  return canvasModule;
}

/** A first-in, first-out queue that runs at most `concurrency` tasks at once; a waiting task can be withdrawn. */
class Limiter {
  concurrency = 1;
  private running = 0;
  private live = 0;
  private queue: Array<{ task: () => Promise<void>; withdrawn: boolean }> = [];
  private head = 0;

  /** Tasks waiting for a slot, not counting withdrawn ones. */
  get waiting(): number {
    return this.live;
  }

  /** Queues a task; the returned function withdraws it if it has not started. */
  run(task: () => Promise<void>): () => void {
    const entry = { task, withdrawn: false };
    this.queue.push(entry);
    this.live += 1;
    this.pump();
    return () => {
      if (entry.withdrawn) return;
      entry.withdrawn = true;
      this.live -= 1;
    };
  }

  private pump(): void {
    while (this.running < this.concurrency && this.head < this.queue.length) {
      const entry = this.queue[this.head]!;
      this.head += 1;
      if (this.head > 1024 && this.head * 2 > this.queue.length) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      if (entry.withdrawn) continue;
      entry.withdrawn = true;
      this.live -= 1;
      this.running += 1;
      void entry.task().finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }
}

/**
 * The PDF worker thread: started on the first PDF, one page at a time, ended
 * and started again after a time-out or a crash. Its time bound counts from
 * the request, start-up included, so a render always settles within it. If
 * the thread cannot start (the bundled PDF library missing), PDFs are refused
 * as unavailable for a minute before it is tried again. The thread keeps the
 * process alive only while a page is being drawn.
 */
class PdfRenderer {
  private instance: PdfWorkerInstance | null = null;
  private nextId = 1;
  private failedUntil = 0;

  constructor(private readonly limits: ThumbnailLimits) {}

  render(bytes: Buffer, size: ThumbnailSize, timeoutMs: number): Promise<Buffer> {
    if (Date.now() < this.failedUntil) return Promise.reject(new ThumbnailRefusedError("unavailable"));
    const instance = this.instance ?? this.spawn();
    const id = this.nextId++;
    const copy = new Uint8Array(bytes).buffer;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        // PDF.js cannot be interrupted inside a page; end the thread.
        settle(id, new ThumbnailRefusedError("timed-out"));
        this.end(instance);
      }, timeoutMs);
      const settle = (jobId: number, result: Buffer | Error) => {
        if (!instance.pending.delete(jobId)) return;
        clearTimeout(timer);
        if (!instance.pending.size) instance.worker.unref();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      instance.pending.set(id, settle);
      instance.worker.ref();
      instance.ready.then(
        () => { if (instance.pending.has(id)) instance.worker.postMessage({ id, bytes: copy, size, maxImagePixels: this.limits.pdfImagePixels }, [copy]); },
        (error: unknown) => settle(id, error instanceof Error ? error : new ThumbnailRefusedError("unavailable")),
      );
    });
  }

  async close(): Promise<void> {
    if (this.instance) await this.end(this.instance);
  }

  private spawn(): PdfWorkerInstance {
    const entry = new URL(`./thumbnail-pdf-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url);
    const worker = new Worker(entry, { resourceLimits: { maxOldGenerationSizeMb: this.limits.pdfHeapMb } });
    let markReady!: () => void;
    let failStart!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failStart = reject; });
    ready.catch(() => undefined);
    const instance: PdfWorkerInstance = { worker, ready, pending: new Map(), started: false, ending: false };
    this.instance = instance;
    worker.on("message", (message: { ready?: true; id?: number; ok?: boolean; webp?: ArrayBuffer; reason?: ThumbnailRefusal }) => {
      if (message.ready) { instance.started = true; markReady(); return; }
      if (message.id === undefined) return;
      const settle = instance.pending.get(message.id);
      if (!settle) return;
      settle(message.id, message.ok && message.webp ? Buffer.from(message.webp) : new ThumbnailRefusedError(message.reason === "locked" ? "locked" : "damaged"));
    });
    const ended = () => {
      if (this.instance === instance) this.instance = null;
      if (!instance.started && !instance.ending) {
        this.failedUntil = Date.now() + 60_000;
        failStart(new ThumbnailRefusedError("unavailable"));
      }
      // A page that ran out of memory or crashed the thread is damaged as far as thumbnails go;
      // one still waiting behind a page that timed out may be asked for again.
      const reason: ThumbnailRefusal = instance.ending ? "busy" : instance.started ? "damaged" : "unavailable";
      for (const [id, settle] of [...instance.pending]) settle(id, new ThumbnailRefusedError(reason));
    };
    worker.on("error", ended);
    worker.on("exit", ended);
    // Listeners first: a listener added later would hold the process open again.
    worker.unref();
    return instance;
  }

  private async end(instance: PdfWorkerInstance): Promise<void> {
    instance.ending = true;
    if (this.instance === instance) this.instance = null;
    await instance.worker.terminate().catch(() => undefined);
  }
}

interface PdfWorkerInstance {
  worker: Worker;
  ready: Promise<void>;
  pending: Map<number, (id: number, result: Buffer | Error) => void>;
  started: boolean;
  ending: boolean;
}
