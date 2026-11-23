import { useEffect, useState } from "react";

import { apiUrl } from "../../lib/api";
import type { TreeEntry } from "../../types";
import { placeApiBase, type FileManagerPlace } from "./file-manager-places";

/**
 * Picture and PDF thumbnails in the file manager window (docs/product-model.md,
 * "The file manager window"). The host draws them (`GET …/thumbnail`); the
 * window asks only for the items it draws, so in a large folder that is the
 * tiles near the view, and a tile scrolled away withdraws its request. A few
 * requests are out at once, the newest first, because the newest are the
 * tiles in view; the rest wait. Anything the host cannot draw keeps its icon.
 */

/** The kinds the host draws, by name; it is never asked about anything else. */
const thumbnailKinds = /\.(?:png|jpe?g|jpe|jfif|gif|webp|bmp|avif|pdf)$/i;

export type ThumbnailSize = 64 | 128 | 256;

/** Whether the host could draw a thumbnail for this item: a file (never a link) of a kind it draws. */
export function canThumbnail(entry: Pick<TreeEntry, "kind" | "name" | "link">): boolean {
  return entry.kind === "file" && !entry.link && thumbnailKinds.test(entry.name);
}

/** The size asked for: the icon tile's 128 at 1x and 256 on a sharper screen; Info always asks for 256. */
export function thumbnailSize(use: "tile" | "info", pixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1): ThumbnailSize {
  if (use === "info") return 256;
  return pixelRatio > 1 ? 256 : 128;
}

/**
 * The file's version as the host spells it (size in bytes and modification
 * time in whole milliseconds): with it in the address, a thumbnail already
 * drawn comes from the cache with no request at all, and a changed file has a
 * new address.
 */
export function thumbnailVersion(entry: Pick<TreeEntry, "sizeBytes" | "updatedAt">): string | null {
  if (typeof entry.sizeBytes !== "number" || !entry.updatedAt) return null;
  const time = Date.parse(entry.updatedAt);
  return Number.isNaN(time) ? null : `${entry.sizeBytes}-${time}`;
}

export function thumbnailPath(place: FileManagerPlace | string, entry: Pick<TreeEntry, "path" | "sizeBytes" | "updatedAt">, size: ThumbnailSize): string {
  const base = typeof place === "string" ? place : placeApiBase(place);
  const query = new URLSearchParams({ path: entry.path, size: String(size) });
  const version = thumbnailVersion(entry);
  if (version) query.set("v", version);
  return `${base}/thumbnail?${query.toString()}`;
}

/** What one fetch ends in: a picture, a refusal to remember (show the icon), or a refusal worth asking again later. */
export type ThumbnailOutcome = { kind: "image"; blob: Blob } | { kind: "refused" } | { kind: "retry" };
export type ThumbnailFetcher = (path: string, signal: AbortSignal) => Promise<ThumbnailOutcome>;

interface QueueEntry { path: string; controller: AbortController; resolve: (outcome: ThumbnailOutcome) => void; started: boolean }

/**
 * At most `concurrency` thumbnail requests out at once. A request waiting
 * leaves the queue when withdrawn and is never sent; one out is aborted.
 * The newest request goes first.
 */
export class ThumbnailQueue {
  private readonly waiting: QueueEntry[] = [];
  private running = 0;

  constructor(private readonly fetcher: ThumbnailFetcher, private readonly concurrency = 3) {}

  /** Asks for one thumbnail; the returned function withdraws it. */
  request(path: string): { promise: Promise<ThumbnailOutcome>; cancel: () => void } {
    let entry!: QueueEntry;
    const promise = new Promise<ThumbnailOutcome>((resolve) => {
      entry = { path, controller: new AbortController(), resolve, started: false };
    });
    this.waiting.push(entry);
    this.pump();
    return {
      promise,
      cancel: () => {
        if (entry.controller.signal.aborted) return;
        entry.controller.abort();
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        entry.resolve({ kind: "retry" });
      },
    };
  }

  /** Requests waiting, for tests and diagnostics. */
  get pending(): number { return this.waiting.length; }
  get active(): number { return this.running; }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length) {
      const entry = this.waiting.pop()!;
      entry.started = true;
      this.running += 1;
      void this.fetcher(entry.path, entry.controller.signal)
        .catch((): ThumbnailOutcome => ({ kind: "retry" }))
        .then((outcome) => entry.resolve(entry.controller.signal.aborted ? { kind: "retry" } : outcome))
        .finally(() => { this.running -= 1; this.pump(); });
    }
  }
}

/**
 * Thumbnails drawn so far, as `blob:` URLs, by address. One in use by a
 * tile on screen is never revoked; the least recently used of the rest go
 * once there are more than `limit`.
 */
export class ThumbnailCache {
  private readonly entries = new Map<string, { url: string | null; users: number }>();

  constructor(private readonly limit = 400, private readonly revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)) {}

  /** The picture (a URL) or a remembered refusal (null); undefined when not known. */
  peek(path: string): string | null | undefined {
    return this.entries.get(path)?.url;
  }

  /** Marks a picture in use until the returned function is called. */
  use(path: string): () => void {
    const entry = this.entries.get(path);
    if (!entry) return () => undefined;
    entry.users += 1;
    // Most recently used last.
    this.entries.delete(path);
    this.entries.set(path, entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.users = Math.max(0, entry.users - 1);
      this.trim();
    };
  }

  store(path: string, url: string | null): void {
    const existing = this.entries.get(path);
    if (existing?.url && existing.url !== url) this.revoke(existing.url);
    this.entries.delete(path);
    this.entries.set(path, { url, users: existing?.users ?? 0 });
    this.trim();
  }

  get size(): number { return this.entries.size; }

  private trim(): void {
    if (this.entries.size <= this.limit) return;
    for (const [path, entry] of this.entries) {
      if (this.entries.size <= this.limit) break;
      if (entry.users > 0) continue;
      this.entries.delete(path);
      if (entry.url) this.revoke(entry.url);
    }
  }
}

async function fetchThumbnail(path: string, signal: AbortSignal): Promise<ThumbnailOutcome> {
  const headers = await window.ampleFileDesktop?.api.getSessionHeaders?.();
  const response = await fetch(apiUrl(path), { headers: headers ?? {}, signal });
  if (response.ok) return { kind: "image", blob: await response.blob() };
  // Busy, timed out, or a file that changed while it was drawn: worth asking again another time.
  return response.status === 503 || response.status === 409 ? { kind: "retry" } : { kind: "refused" };
}

let sharedQueue: ThumbnailQueue | null = null;
let sharedCache: ThumbnailCache | null = null;
const inFlight = new Map<string, { promise: Promise<ThumbnailOutcome>; cancel: () => void; waiters: number }>();

function queue(): ThumbnailQueue { return sharedQueue ??= new ThumbnailQueue(fetchThumbnail, 3); }
function cache(): ThumbnailCache { return sharedCache ??= new ThumbnailCache(); }

/**
 * A thumbnail for one item while it is drawn, or null (show the icon).
 * Disabled, or for a kind the host does not draw, nothing is asked.
 */
export function useThumbnail(place: FileManagerPlace | string, entry: Pick<TreeEntry, "path" | "name" | "kind" | "link" | "sizeBytes" | "updatedAt">, size: ThumbnailSize, enabled: boolean): string | null {
  const wanted = enabled && canThumbnail(entry);
  const path = wanted ? thumbnailPath(place, entry, size) : null;
  const [url, setUrl] = useState<string | null>(() => path ? cache().peek(path) ?? null : null);
  useEffect(() => {
    if (!path) { setUrl(null); return; }
    const known = cache().peek(path);
    if (known !== undefined) {
      setUrl(known);
      return known ? cache().use(path) : undefined;
    }
    setUrl(null);
    let shared = inFlight.get(path);
    if (!shared) {
      const request = queue().request(path);
      shared = { ...request, waiters: 0 };
      inFlight.set(path, shared);
      const settled = shared;
      void request.promise.then((outcome) => {
        if (inFlight.get(path) === settled) inFlight.delete(path);
        if (outcome.kind === "image") cache().store(path, URL.createObjectURL(outcome.blob));
        else if (outcome.kind === "refused") cache().store(path, null);
      });
    }
    shared.waiters += 1;
    const current = shared;
    let release: (() => void) | null = null;
    let done = false;
    void current.promise.then(() => {
      if (done) return;
      const drawn = cache().peek(path);
      if (drawn) { release = cache().use(path); setUrl(drawn); }
    });
    return () => {
      done = true;
      release?.();
      current.waiters -= 1;
      // The last tile that wanted it scrolled away: the request is withdrawn.
      if (current.waiters <= 0 && inFlight.get(path) === current) { inFlight.delete(path); current.cancel(); }
    };
  }, [path]);
  return path ? url : null;
}
