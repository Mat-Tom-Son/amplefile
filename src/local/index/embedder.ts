/**
 * Sentence embedders for the index (docs/index-and-recall.md).
 *
 * `mac-natural-language` uses macOS's own sentence embeddings
 * (NaturalLanguage's `NLEmbedding`) through one long-lived
 * `osascript -l JavaScript` child speaking line-delimited JSON on stdin and
 * stdout. It is started on first use, stopped after a minute idle and when
 * the app quits, detects each text's language and falls back to English, and
 * gives no vector for a text it cannot embed. Nothing leaves the computer and
 * no dependency is added.
 *
 * `none` is used when the helper is missing or fails (another system, an
 * error): search then ranks lexically only and says so in its coverage.
 *
 * Vectors are L2-normalized here, so cosine similarity is a dot product.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

export interface EmbedderInput {
  text: string;
  /** Embed in this language (a BCP 47 code such as `en`); omitted, the helper detects it. */
  language?: string;
  /**
   * Inputs of one request sharing a group (the passages of one chunk) share
   * one language detection, made on the group's first text.
   */
  group?: number;
}

export interface EmbeddedVector {
  language: string;
  vector: Float32Array;
}

export interface ConnectedFolderIndexEmbedder {
  /** Stable id; vectors are stored under it, so a new id re-embeds lazily. */
  readonly id: string;
  /** Vector length, or 0 while unknown or for `none`. */
  readonly dimension: number;
  /** False once the embedder has failed for this run; callers then rank lexically. */
  available(): boolean;
  embed(inputs: EmbedderInput[], signal?: AbortSignal): Promise<Array<EmbeddedVector | null>>;
  close(): Promise<void>;
}

export const noEmbedder: ConnectedFolderIndexEmbedder = Object.freeze({
  id: "none",
  dimension: 0,
  available: () => false,
  embed: async (inputs: EmbedderInput[]) => inputs.map(() => null),
  close: async () => undefined,
});

export function normalizeVector(values: ArrayLike<number>): Float32Array | null {
  const vector = Float32Array.from(values);
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (!Number.isFinite(sum) || sum === 0) return null;
  const norm = Math.sqrt(sum);
  for (let index = 0; index < vector.length; index++) vector[index] = vector[index]! / norm;
  return vector;
}

export function dot(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index++) sum += left[index]! * right[index]!;
  return sum;
}

const helperScript = `
ObjC.import('Foundation'); ObjC.import('NaturalLanguage');
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  const output = $.NSFileHandle.fileHandleWithStandardOutput;
  const embeddings = {};
  const embedding = (language) => {
    if (!(language in embeddings)) {
      const value = $.NLEmbedding.sentenceEmbeddingForLanguage(language);
      embeddings[language] = value && !value.isNil() ? value : null;
    }
    return embeddings[language];
  };
  const write = (value) => {
    const text = $.NSString.alloc.initWithUTF8String(JSON.stringify(value) + '\\n');
    output.writeData(text.dataUsingEncoding($.NSUTF8StringEncoding));
  };
  let groups = {};
  const one = (item) => {
    const text = String(item.text || '');
    if (!text.trim()) return null;
    let language = item.language || (item.group !== undefined ? groups[item.group] : null) || null;
    if (!language) {
      try { const found = $.NLLanguageRecognizer.dominantLanguageForString(text); if (found && !found.isNil()) language = found.js; } catch (error) {}
      if (!language || !embedding(language)) language = 'en';
      if (item.group !== undefined) groups[item.group] = language;
    }
    const model = embedding(language);
    if (!model) return null;
    const vector = model.vectorForString(text);
    if (!vector || vector.isNil()) return null;
    return { language: language, vector: ObjC.deepUnwrap(vector) };
  };
  write({ ready: true });
  let buffer = '';
  while (true) {
    const data = input.availableData;
    if (Number(data.length) === 0) break;
    buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    let newline;
    while ((newline = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request;
      try { request = JSON.parse(line); } catch (error) { write({ error: 'unreadable request' }); continue; }
      let vectors;
      groups = {};
      try { vectors = request.items.map(one); } catch (error) { write({ id: request.id, error: String(error) }); continue; }
      write({ id: request.id, vectors: vectors });
    }
  }
}`;

interface PendingRequest {
  resolve: (vectors: Array<EmbeddedVector | null>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface MacNaturalLanguageEmbedderOptions {
  /** Stop the helper after this long without a request. */
  idleMs?: number;
  /** One request's deadline; a helper that misses it is stopped and marked failed. */
  requestTimeoutMs?: number;
  /** Test seam: the executable to run. */
  executable?: string;
}

/** macOS sentence embeddings through one long-lived JXA helper. */
export class MacNaturalLanguageEmbedder implements ConnectedFolderIndexEmbedder {
  readonly id = "mac-natural-language";
  #dimension = 0;
  #failed = false;
  #child: ChildProcessWithoutNullStreams | null = null;
  #ready: Promise<void> | null = null;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  #idleTimer: NodeJS.Timeout | null = null;
  readonly #idleMs: number;
  readonly #requestTimeoutMs: number;
  readonly #executable: string;

  constructor(options: MacNaturalLanguageEmbedderOptions = {}) {
    this.#idleMs = options.idleMs ?? 60_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#executable = options.executable ?? "/usr/bin/osascript";
  }

  get dimension(): number { return this.#dimension; }

  available(): boolean {
    return !this.#failed && process.platform === "darwin" && existsSync(this.#executable);
  }

  async embed(inputs: EmbedderInput[], signal?: AbortSignal): Promise<Array<EmbeddedVector | null>> {
    if (!inputs.length) return [];
    if (!this.available()) return inputs.map(() => null);
    if (signal?.aborted) throw abortError();
    try {
      await this.#start();
      const raw = await this.#request(inputs, signal);
      return raw.map((item) => {
        if (!item) return null;
        const vector = normalizeVector(item.vector);
        if (!vector) return null;
        if (!this.#dimension) this.#dimension = vector.length;
        return { language: item.language, vector };
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      this.#fail();
      return inputs.map(() => null);
    } finally {
      this.#armIdle();
    }
  }

  async close(): Promise<void> {
    this.#stop();
  }

  #start(): Promise<void> {
    if (this.#child && this.#ready) return this.#ready;
    const child = spawn(this.#executable, ["-l", "JavaScript", "-e", helperScript], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    this.#buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The embedding helper did not start.")), this.#requestTimeoutMs);
      const onLine = (line: string) => {
        let message: { ready?: boolean; id?: number; vectors?: Array<{ language: string; vector: number[] } | null>; error?: string };
        try { message = JSON.parse(line) as typeof message; } catch { return; }
        if (message.ready) { clearTimeout(timer); resolve(); return; }
        const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id!);
        clearTimeout(pending.timer);
        if (message.error || !Array.isArray(message.vectors)) pending.reject(new Error(message.error ?? "The embedding helper failed."));
        else pending.resolve(message.vectors.map((item) => item && Array.isArray(item.vector) ? { language: String(item.language), vector: Float32Array.from(item.vector) } : null));
      };
      child.stdout.on("data", (chunk: string) => {
        this.#buffer += chunk;
        let newline: number;
        while ((newline = this.#buffer.indexOf("\n")) >= 0) {
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          if (line.trim()) onLine(line);
        }
      });
      const gone = (error: Error) => {
        clearTimeout(timer);
        reject(error);
        if (this.#child === child) { this.#child = null; this.#ready = null; }
        for (const [id, pending] of this.#pending) { clearTimeout(pending.timer); pending.reject(error); this.#pending.delete(id); }
      };
      child.once("error", gone);
      child.once("exit", () => gone(new Error("The embedding helper stopped.")));
    });
    // A helper that fails to start must not leave an unhandled rejection behind.
    this.#ready.catch(() => undefined);
    return this.#ready;
  }

  #request(items: EmbedderInput[], signal?: AbortSignal): Promise<Array<EmbeddedVector | null>> {
    const child = this.#child;
    if (!child) return Promise.reject(new Error("The embedding helper is not running."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("The embedding helper did not answer in time."));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, items: items.map((item) => ({ text: item.text, ...(item.language ? { language: item.language } : {}), ...(item.group !== undefined ? { group: item.group } : {}) })) })}\n`);
    });
  }

  #armIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (!this.#child) return;
    this.#idleTimer = setTimeout(() => { if (!this.#pending.size) this.#stop(); }, this.#idleMs);
    this.#idleTimer.unref();
  }

  #fail(): void {
    this.#failed = true;
    this.#stop();
  }

  #stop(): void {
    if (this.#idleTimer) { clearTimeout(this.#idleTimer); this.#idleTimer = null; }
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    if (child) {
      try { child.stdin.end(); } catch { /* Already closed. */ }
      try { child.kill(); } catch { /* Already gone. */ }
    }
  }
}

/** The embedder this computer can run: macOS sentence embeddings, or none. */
export function createDefaultConnectedFolderIndexEmbedder(): ConnectedFolderIndexEmbedder {
  return process.platform === "darwin" ? new MacNaturalLanguageEmbedder() : noEmbedder;
}

function abortError(): Error {
  return Object.assign(new Error("Indexing stopped."), { name: "AbortError" });
}
