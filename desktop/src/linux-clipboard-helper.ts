import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  formatGnomeCopiedFiles,
  formatUriList,
  gnomeCopiedFilesFormat,
  kdeCutSelectionFormat,
  readLinuxClipboardFiles,
  uriListFormat,
  type LinuxClipboardFiles,
  type LinuxFileClipboardAccess,
} from "./linux-file-clipboard.js";

/**
 * AmpleFile's X11 clipboard helper (`desktop/native/linux-clipboard`).
 *
 * Electron's clipboard writes one custom format per transaction, so on its
 * own it can offer copied files only as `text/uri-list`. The helper takes the
 * X `CLIPBOARD` selection and offers every target at once: GNOME's
 * `x-special/gnome-copied-files` (GNOME Files, Nemo, Caja, Thunar),
 * `text/uri-list` (Dolphin, GTK file lists) and the paths as plain text (text
 * editors and terminals). It serves until another app copies, the app quits
 * or crashes (its stdin pipe closes and its parent-death signal fires), or
 * its time bound passes. Where it cannot own the selection the caller falls
 * back to Electron's single-format write.
 *
 * The pipe format is the crate's `frames` module: an 8-byte magic, then
 * (u32 LE name length, name, u32 LE data length, data) frames, ended by a
 * zero name length. `read` output uses the same frames, with a data length
 * of 0xFFFFFFFF for a target the owner did not provide.
 */

const magic = Buffer.from("AFCLIP1\n", "latin1");
const absent = 0xffff_ffff;
/** Plain-text targets X11 and GTK/Qt apps ask for; each carries the UTF-8 paths. */
export const linuxPlainTextTargets = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "TEXT"] as const;

export interface LinuxClipboardOffer {
  target: string;
  data: Buffer;
}

/**
 * Every target a copy of `paths` offers: GNOME's copy list, the URI list,
 * then the absolute paths as newline-separated text. `STRING` (Latin-1 by
 * definition) is offered only when every path is Latin-1, so it never
 * carries mangled names.
 */
export function linuxFileClipboardOffers(paths: readonly string[]): LinuxClipboardOffer[] {
  if (!paths.length) throw new Error("Choose items to copy.");
  const text = paths.join("\n");
  const offers: LinuxClipboardOffer[] = [
    { target: gnomeCopiedFilesFormat, data: Buffer.from(formatGnomeCopiedFiles(paths), "utf8") },
    { target: uriListFormat, data: Buffer.from(formatUriList(paths), "utf8") },
    ...linuxPlainTextTargets.map((target) => ({ target, data: Buffer.from(text, "utf8") })),
  ];
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-ÿ]*$/.test(text)) offers.push({ target: "STRING", data: Buffer.from(text, "latin1") });
  return offers;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

/** The helper's `serve` request for these offers. */
export function encodeClipboardRequest(offers: readonly LinuxClipboardOffer[]): Buffer {
  const parts: Buffer[] = [magic];
  for (const { target, data } of offers) {
    if (!/^[\x20-\x7e]{1,255}$/.test(target)) throw new Error(`Invalid clipboard target ${JSON.stringify(target)}.`);
    parts.push(u32(target.length), Buffer.from(target, "latin1"), u32(data.length), data);
  }
  parts.push(u32(0));
  return Buffer.concat(parts);
}

/** The helper's `read` output: each requested target's bytes, or null when the owner did not provide it. */
export function decodeClipboardResults(bytes: Buffer): Map<string, Buffer | null> {
  if (bytes.length < magic.length || !bytes.subarray(0, magic.length).equals(magic)) throw new Error("Not clipboard helper output.");
  const results = new Map<string, Buffer | null>();
  let offset = magic.length;
  const take = (length: number): Buffer => {
    if (offset + length > bytes.length) throw new Error("Truncated clipboard helper output.");
    const piece = bytes.subarray(offset, offset + length);
    offset += length;
    return piece;
  };
  for (;;) {
    const nameLength = take(4).readUInt32LE();
    if (nameLength === 0) return results;
    const name = take(nameLength).toString("latin1");
    const dataLength = take(4).readUInt32LE();
    results.set(name, dataLength === absent ? null : Buffer.from(take(dataLength)));
  }
}

/** The file formats a paste asks the helper for; plain text is asked for only when none holds files. */
export const linuxFileClipboardReadTargets = [gnomeCopiedFilesFormat, uriListFormat, kdeCutSelectionFormat] as const;
const linuxTextReadTarget = "UTF8_STRING";

/** The helper's `read` results in the shape `readLinuxClipboardFiles` takes. */
export function clipboardAccessFromResults(results: ReadonlyMap<string, Buffer | null>): Pick<LinuxFileClipboardAccess, "read" | "readText"> {
  return {
    read: (format) => results.get(format)?.toString("utf8") ?? "",
    readText: () => results.get(linuxTextReadTarget)?.toString("utf8") ?? "",
  };
}

/**
 * Whether the helper can own the clipboard this app's windows use: only when
 * Chromium runs on X11 (XWayland on a Wayland desktop, per the display rule)
 * with a display to talk to. On native Wayland a background process cannot
 * set the selection on every compositor, so Electron's own write is used.
 */
export function linuxClipboardHelperUsable(options: { ozonePlatform: string; display: string | undefined }): boolean {
  return options.ozonePlatform === "x11" && Boolean(options.display?.trim());
}

/**
 * Whether the bundled helper is the one its `source.json` describes, the way
 * the other Linux helpers are checked before they run: schema, protocol,
 * target, an executable regular file, and the binary's SHA-256.
 */
export async function verifiedClipboardHelper(helperPath: string): Promise<boolean> {
  try {
    const source = JSON.parse(await readFile(join(dirname(helperPath), "source.json"), "utf8")) as Record<string, unknown>;
    const metadata = await lstat(helperPath);
    return source.schema === "amplefile.clipboard-helper-source.v1" && source.protocolVersion === 1
      && source.target === "x86_64-unknown-linux-gnu" && metadata.isFile() && (metadata.mode & 0o111) !== 0
      && source.binarySha256 === createHash("sha256").update(await readFile(helperPath)).digest("hex");
  } catch {
    return false;
  }
}

type Spawn = (command: string, args: readonly string[], options: { stdio: ["pipe", "pipe", "pipe"] }) => ChildProcess;

export interface LinuxClipboardOwnerOptions {
  helperPath: string;
  /** How long to wait for the helper to say it owns the selection. */
  readyTimeoutMs?: number;
  /** The helper's own bound on how long it serves one copy. */
  maxSeconds?: number;
  spawn?: Spawn;
  log?: (message: string) => void;
}

/**
 * Runs the helper: one serving process for the latest copy, and short `read`
 * processes for pastes. Nothing here blocks the main process.
 */
export class LinuxClipboardOwner {
  private current: ChildProcess | null = null;
  /** The latest copy's offer; the next one waits for it. */
  private offered: Promise<unknown> = Promise.resolve();
  private readonly spawn: Spawn;

  constructor(private readonly options: LinuxClipboardOwnerOptions) {
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawnProcess(command, args, spawnOptions));
  }

  /**
   * Puts the offers on the clipboard; false when the helper could not own it
   * (the caller then falls back). Copies are taken in order, so a slow helper
   * can never put an older copy over a newer one.
   */
  offer(offers: readonly LinuxClipboardOffer[]): Promise<boolean> {
    const next = this.offered.then(() => this.offerNow(offers));
    this.offered = next.catch(() => false);
    return next;
  }

  private offerNow(offers: readonly LinuxClipboardOffer[]): Promise<boolean> {
    const request = encodeClipboardRequest(offers);
    const args = ["serve", ...(this.options.maxSeconds ? ["--max-seconds", String(this.options.maxSeconds)] : [])];
    let child: ChildProcess;
    try {
      child = this.spawn(this.options.helperPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      this.options.log?.(`clipboard helper did not start: ${String(error)}`);
      return Promise.resolve(false);
    }
    const previous = this.current;
    this.current = child;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      const settle = (owned: boolean, reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.removeAllListeners("data");
        if (owned) {
          // The new owner took the selection, so the old one is already leaving; make sure.
          if (previous && previous.exitCode === null && previous.signalCode === null) previous.kill("SIGTERM");
        } else {
          if (reason) this.options.log?.(`clipboard helper unavailable: ${reason}`);
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          if (this.current === child) this.current = null;
        }
        resolve(owned);
      };
      const timer = setTimeout(() => settle(false, "it did not answer in time"), this.options.readyTimeoutMs ?? 3_000);
      child.on("error", (error) => settle(false, String(error)));
      child.on("exit", (code, signal) => {
        if (this.current === child) this.current = null;
        settle(false, `it exited (${signal ?? code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { if (stderr.length < 4096) stderr += chunk; });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        const line = stdout.split("\n", 1)[0];
        if (!stdout.includes("\n") || line === undefined) return;
        if (line === "owned") settle(true);
        else settle(false, line.replace(/^unavailable\s*/, "") || "unexpected answer");
      });
      // The pipe stays open: its end of file is how the helper learns the app is gone.
      child.stdin?.on("error", () => settle(false, "its input closed"));
      child.stdin?.write(request);
    });
  }

  /** The current clipboard converted to each target through X11 directly; null when the helper could not read. */
  read(targets: readonly string[], timeoutMs = 6_000): Promise<Map<string, Buffer | null> | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawn(this.options.helperPath, ["read", ...targets], { stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        resolve(null);
        return;
      }
      child.stdin?.end();
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 300 << 20) child.kill("SIGKILL");
        else chunks.push(chunk);
      });
      child.stderr?.resume();
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) { resolve(null); return; }
        try { resolve(decodeClipboardResults(Buffer.concat(chunks))); } catch { resolve(null); }
      });
    });
  }

  /**
   * The files on the clipboard, read off the main thread: Electron's own read
   * is synchronous (a 5,000-file copy holds the main process for about 200 ms)
   * and returns another Chromium app's `text/uri-list` as empty. Null when the
   * helper could not read, so the caller falls back to Electron's read.
   */
  async readFiles(): Promise<LinuxClipboardFiles | null> {
    const results = await this.read(linuxFileClipboardReadTargets);
    if (!results) return null;
    const files = readLinuxClipboardFiles(clipboardAccessFromResults(results));
    if (files.paths.length) return files;
    // Older Nautilus put its marked list only in text.
    const text = await this.read([linuxTextReadTarget]);
    return text ? readLinuxClipboardFiles(clipboardAccessFromResults(text)) : null;
  }

  /** Stops serving the current copy (the clipboard then empties unless a clipboard manager kept it). */
  release(): void {
    const child = this.current;
    this.current = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
