/**
 * Progress and cancel for the file manager's long file operations: copy,
 * duplicate, move, Compress, and Extract (docs/product-model.md, "The file
 * manager window"). A caller names an operation with an id when it starts
 * one; while it runs, the host reports items and bytes done over the event
 * stream, and a cancel by that id stops it at the next safe boundary. A
 * caller that names no id gets the plain operation, with no events.
 *
 * Operations are process-wide: the desktop's paste runs a transfer without a
 * local API request, and the window's event connection still sees it.
 */

/** `delete` is Empty Trash and Delete Immediately in the window's Trash. */
export type FileOperationKind = "copy" | "duplicate" | "move" | "compress" | "extract" | "delete";

/**
 * Where an operation is. `preparing` measures what it will do; `copying`,
 * `moving`, `compressing`, and `extracting` write; `removing` takes moved
 * items out of their source; `finishing` places the result and keeps its
 * restore point, and cannot be stopped.
 */
export type FileOperationStage = "preparing" | "copying" | "moving" | "removing" | "compressing" | "extracting" | "finishing";

/** One running operation as the event stream reports it. */
export interface FileOperationProgress {
  operationId: string;
  kind: FileOperationKind;
  stage: FileOperationStage;
  /** Files, folders, and links handled; for a move inside one place, the items chosen. */
  itemsDone: number;
  itemsTotal: number | null;
  bytesDone: number;
  /** Null while unknown, and for a move inside one place, which only renames. */
  bytesTotal: number | null;
  /** The name of the item in hand. */
  current: string | null;
  /** Whether a cancel can still stop it; false once it is finishing. */
  cancellable: boolean;
  /** A cancel was asked for and the operation is stopping at its next safe boundary. */
  cancelling: boolean;
  startedAt: string;
}

export type FileOperationOutcome = "succeeded" | "cancelled" | "failed";

/** What the file operation event stream sends. */
export type FileOperationEvent =
  | { type: "operations"; operations: FileOperationProgress[] }
  | { type: "progress"; operation: FileOperationProgress }
  | { type: "finished"; operationId: string; kind: FileOperationKind; outcome: FileOperationOutcome; error?: string };

/** The most often one operation reports progress. Stage changes and the end are sent at once. */
export const fileOperationProgressIntervalMs = 100;

/** A caller-chosen operation id: letters, digits, `_` and `-`. */
export const fileOperationIdPattern = /^[A-Za-z0-9_-]{1,80}$/;

/** Thrown at a safe boundary once a cancel was asked for; the operation catches it and says what was done. */
export class FileOperationCancelledError extends Error {
  readonly cancelled = true;
  constructor() {
    super("Stopped.");
    this.name = "FileOperationCancelledError";
  }
}

export function isFileOperationCancelled(error: unknown): error is FileOperationCancelledError {
  return error instanceof FileOperationCancelledError;
}

/** What the file engine reports to, and asks about cancellation. */
export interface FileOperationControl {
  readonly operationId: string | null;
  readonly cancelRequested: boolean;
  stage(stage: FileOperationStage, options?: { cancellable?: boolean }): void;
  /** Adds to the totals as the operation measures what it will do. */
  addTotals(items: number, bytes: number): void;
  /** Sets totals outright; null leaves a total unknown. */
  setTotals(items: number | null, bytes: number | null): void;
  current(name: string | null): void;
  itemsDone(count?: number): void;
  bytesDone(count: number): void;
  /**
   * A safe place to stop: throws {@link FileOperationCancelledError} once a
   * cancel was asked for. Async so a test can hold the operation here.
   */
  boundary(point: FileOperationBoundary): Promise<void>;
}

/**
 * Where a boundary sits: before an item (`item`), inside a file between
 * chunks (`chunk`), before a moved item leaves its source (`remove`), or
 * before an archive entry (`entry`).
 */
export type FileOperationBoundary = "item" | "chunk" | "remove" | "entry";

/** The control for an operation nobody named: no events, never cancelled. */
export const untrackedFileOperation: FileOperationControl = Object.freeze({
  operationId: null,
  cancelRequested: false,
  stage() {},
  addTotals() {},
  setTotals() {},
  current() {},
  itemsDone() {},
  bytesDone() {},
  async boundary() {},
});

type Listener = (event: FileOperationEvent) => void;

class RunningFileOperation implements FileOperationControl {
  readonly operationId: string;
  private readonly progress: FileOperationProgress;
  private cancelAsked = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;

  constructor(operationId: string, kind: FileOperationKind) {
    this.operationId = operationId;
    this.progress = {
      operationId,
      kind,
      stage: "preparing",
      itemsDone: 0,
      itemsTotal: null,
      bytesDone: 0,
      bytesTotal: null,
      current: null,
      cancellable: true,
      cancelling: false,
      startedAt: new Date().toISOString(),
    };
  }

  get cancelRequested(): boolean { return this.cancelAsked && this.progress.cancellable; }

  snapshot(): FileOperationProgress { return { ...this.progress }; }

  stage(stage: FileOperationStage, options: { cancellable?: boolean } = {}): void {
    this.progress.stage = stage;
    this.progress.cancellable = options.cancellable ?? stage !== "finishing";
    this.progress.cancelling = this.cancelAsked && this.progress.cancellable;
    this.progress.current = null;
    this.send(true);
  }

  addTotals(items: number, bytes: number): void {
    this.progress.itemsTotal = (this.progress.itemsTotal ?? 0) + items;
    this.progress.bytesTotal = (this.progress.bytesTotal ?? 0) + bytes;
    this.send(false);
  }

  setTotals(items: number | null, bytes: number | null): void {
    this.progress.itemsTotal = items;
    this.progress.bytesTotal = bytes;
    this.send(false);
  }

  current(name: string | null): void {
    this.progress.current = name;
    this.send(false);
  }

  itemsDone(count = 1): void {
    this.progress.itemsDone += count;
    this.send(false);
  }

  bytesDone(count: number): void {
    this.progress.bytesDone += count;
    this.send(false);
  }

  async boundary(point: FileOperationBoundary): Promise<void> {
    if (boundaryHook) await boundaryHook({ operationId: this.operationId, point, progress: this.snapshot() });
    if (this.cancelRequested) throw new FileOperationCancelledError();
  }

  /** Returns whether the operation can still be stopped. */
  requestCancel(): boolean {
    if (!this.progress.cancellable) return false;
    this.cancelAsked = true;
    this.progress.cancelling = true;
    this.send(true);
    return true;
  }

  /** Sends the latest numbers if a throttled send is still waiting, so the last progress before the end is exact. */
  close(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    emit({ type: "progress", operation: this.snapshot() });
  }

  /** Sends now, or at most once per interval with the latest numbers. */
  private send(now: boolean): void {
    const elapsed = Date.now() - this.lastSentAt;
    if (now || elapsed >= fileOperationProgressIntervalMs) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.lastSentAt = Date.now();
      emit({ type: "progress", operation: this.snapshot() });
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!running.has(this.operationId)) return;
      this.lastSentAt = Date.now();
      emit({ type: "progress", operation: this.snapshot() });
    }, fileOperationProgressIntervalMs - elapsed);
    this.timer.unref?.();
  }
}

const running = new Map<string, RunningFileOperation>();
const listeners = new Set<Listener>();

function emit(event: FileOperationEvent): void {
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* one listener never stops another */ }
  }
}

/** Reads an optional operation id from a request body; absent means untracked. */
export function parseFileOperationId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !fileOperationIdPattern.test(value)) {
    throw Object.assign(new Error("An operation id is letters, digits, _ and -, at most 80 characters."), { status: 400, statusCode: 400 });
  }
  return value;
}

/**
 * Runs `operation` as the named file operation, or untracked when `operationId`
 * is null. The id is taken while it runs (a second operation with the same id
 * is refused), the end is reported once whatever happens, and the id is freed.
 * `outcome` reads a result as cancelled when the operation stopped early.
 */
export async function runFileOperation<T>(
  operationId: string | null,
  kind: FileOperationKind,
  operation: (control: FileOperationControl) => Promise<T>,
  outcome: (result: T) => FileOperationOutcome = () => "succeeded",
): Promise<T> {
  if (!operationId) return operation(untrackedFileOperation);
  if (running.has(operationId)) {
    throw Object.assign(new Error("An operation with this id is already running."), { status: 409, statusCode: 409 });
  }
  const control = new RunningFileOperation(operationId, kind);
  running.set(operationId, control);
  emit({ type: "progress", operation: control.snapshot() });
  try {
    const result = await operation(control);
    finish(control, kind, outcome(result));
    return result;
  } catch (error) {
    finish(control, kind, isFileOperationCancelled(error) ? "cancelled" : "failed", isFileOperationCancelled(error) ? undefined : error);
    throw error;
  }
}

function finish(control: RunningFileOperation, kind: FileOperationKind, outcome: FileOperationOutcome, error?: unknown): void {
  control.close();
  running.delete(control.operationId);
  emit({
    type: "finished",
    operationId: control.operationId,
    kind,
    outcome,
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
  });
}

/**
 * Asks a running operation to stop. Returns null when no operation with that
 * id is running, else whether it will stop (false once it is finishing) and
 * where it is.
 */
export function cancelFileOperation(operationId: string): { cancelling: boolean; operation: FileOperationProgress } | null {
  const control = running.get(operationId);
  if (!control) return null;
  const cancelling = control.requestCancel();
  return { cancelling, operation: control.snapshot() };
}

/** The operations running now. */
export function runningFileOperations(): FileOperationProgress[] {
  return [...running.values()].map((control) => control.snapshot());
}

/** Follows every operation's progress; the first event lists those already running. */
export function subscribeFileOperations(listener: Listener): () => void {
  listeners.add(listener);
  try { listener({ type: "operations", operations: runningFileOperations() }); } catch { /* the listener's own failure */ }
  return () => { listeners.delete(listener); };
}

type BoundaryHook = (at: { operationId: string; point: FileOperationBoundary; progress: FileOperationProgress }) => Promise<void> | void;
let boundaryHook: BoundaryHook | null = null;

/** Tests only: runs at every boundary of a named operation, before the cancel check, so a test can hold an operation where it wants. */
export function setFileOperationBoundaryHookForTests(hook: BoundaryHook | null): void {
  boundaryHook = hook;
}
