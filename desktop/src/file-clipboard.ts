import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  pasteboardHolds,
  pasteboardHoldsCut,
  planFileClipboardPaste,
  type FileClipboardPasteRequest,
  type PasteboardFiles,
  type PastePlan,
  type PastePlace,
  type PasteSource,
  type RememberedCut,
} from "./file-clipboard-paste.js";

/**
 * The file manager windows' clipboard in the desktop host
 * (docs/product-model.md, "Finder's file actions"): the Cut, which it
 * remembers for every window, and Paste. A Mac's pasteboard has no
 * Cut marker, so ⌘X puts the files there as Finder's Copy does, with a token
 * written into the file list beside them, and the host keeps what was cut by
 * place. A paste in any window moves the items while the pasteboard still
 * holds exactly those files with that token; every window draws them dimmed
 * and hears each change.
 *
 * The Cut is forgotten when the pasteboard holds something else (a Copy here
 * or in another app, Finder copying the same files fresh), when it is pasted,
 * when it is cancelled, and once any of its items is no longer where it was
 * cut (renamed, deleted, or moved by a paste that failed or was stopped
 * partway). It knows nothing of Electron, so it is tested on its own;
 * desktop/src/main.ts gives it the pasteboard, the disk, and the windows.
 */
export interface FileClipboardHost {
  /** The files on the pasteboard now. */
  read(): Promise<PasteboardFiles> | PasteboardFiles;
  /** Puts the files on the pasteboard, with the token where the pasteboard can carry one. */
  write(nativePaths: readonly string[], token: string | null): Promise<void> | void;
  /** Empties the pasteboard. */
  clear(): void;
  /** Whether something is still at this path on disk (a link counts, wherever it points). */
  exists(nativePath: string): Promise<boolean> | boolean;
  /** A new token for a Cut, or null where the pasteboard carries none. */
  token(): string | null;
  /** Tells every window what is cut now: the files, or null for nothing. */
  changed(nativePaths: readonly string[] | null): void;
}

export interface CutItems {
  place: PastePlace;
  paths: string[];
  nativePaths: string[];
}

/** What a paste asks the place transfer to do (src/local/api/place-routes.ts). */
export interface PasteTransfer {
  mode: "copy" | "move";
  sources: PasteSource[];
  target: FileClipboardPasteRequest["target"];
  operationId?: string;
  conflicts?: unknown;
}

export class FileClipboard {
  readonly #host: FileClipboardHost;
  #cut: RememberedCut | null = null;
  /** Cuts whose own paste is running, and how many: their items leave their places as it goes, so they are kept until it ends. */
  readonly #pasting = new Map<RememberedCut, number>();

  constructor(host: FileClipboardHost) {
    this.#host = host;
  }

  /** What is cut, as last known, without reading the pasteboard. */
  get remembered(): RememberedCut | null {
    return this.#cut;
  }

  /** ⌘X in any window: the files go on the pasteboard with a new token, and every window draws them cut. */
  async cut(items: CutItems): Promise<void> {
    if (!items.nativePaths.length || items.nativePaths.length !== items.paths.length) throw new Error("Choose items to cut.");
    const token = this.#host.token();
    await this.#host.write(items.nativePaths, token);
    this.#set({ place: items.place, paths: [...items.paths], nativePaths: [...items.nativePaths], token });
  }

  /** AmpleFile put something else on the pasteboard (a Copy of items, or text): nothing is cut. */
  replaced(): void {
    this.#set(null);
  }

  /**
   * The Cut while the pasteboard still holds what it put there and its items
   * are all where they were cut; otherwise the Cut is forgotten and every
   * window hears it. `pasteboard` is a reading already taken, so a paste reads
   * the pasteboard once.
   */
  async current(pasteboard?: PasteboardFiles): Promise<RememberedCut | null> {
    const cut = this.#cut;
    if (!cut) return null;
    if (!pasteboardHoldsCut(pasteboard ?? await this.#host.read(), cut)) {
      if (this.#cut === cut) this.#set(null);
      return null;
    }
    // An item was renamed, deleted, or moved by a paste that failed or was stopped partway. The Cut no longer
    // says where its items are, and the move would refuse it, so it is forgotten and leaves the pasteboard.
    // While its own paste runs, its items leave as they move: it is kept until that paste ends.
    if (!this.#pasting.has(cut) && !(await this.#inPlace(cut))) {
      await this.#forget(cut);
      return null;
    }
    return cut;
  }

  /**
   * A paste in any window (desktop/src/file-clipboard-paste.ts plans it): the
   * pasteboard is read once; a Cut it still holds moves by the place it was
   * cut in. A finished paste of a Cut empties the pasteboard, as the system
   * file managers do, so it never moves twice, and every window hears that
   * nothing is cut. The conflicts-first check keeps it, and so does a paste
   * that failed or was stopped before any item left its place.
   *
   * The answer's `plan` names what this paste carries; the run after the
   * conflicts-first check sends it back, and is refused when the pasteboard
   * has changed since, so it never carries items the person was not asked
   * about.
   */
  async paste<Result extends object>(
    request: FileClipboardPasteRequest,
    connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>,
    transfer: (body: PasteTransfer) => Promise<Result>,
  ) {
    const reading = await this.#host.read();
    const remembered = this.#cut;
    const cut = await this.current(reading);
    // The pasteboard held the Cut, but an item of it is gone, so it was just forgotten and left the pasteboard:
    // this paste was for it, and pastes nothing, never a copy of what was cut.
    const forgotten = Boolean(remembered && !cut && pasteboardHoldsCut(reading, remembered));
    const pasteboard: PasteboardFiles = forgotten ? { paths: [], operation: null } : reading;
    const plan = planFileClipboardPaste(request, pasteboard, connectedFolders, cut);
    const planned = pastePlanId(plan);
    if (request.plan !== undefined && request.plan !== planned) throw new Error("The clipboard changed before the paste began. Paste again.");
    if (!plan.sources.length) return { mode: "copy", written: [], restorePoints: [], nothing: true };
    // The remembered Cut, when this paste moves it.
    const pasting = plan.cut && plan.fromHere ? cut : null;
    let result: Result;
    try {
      result = await this.#whilePasting(pasting, () => transfer({
        mode: plan.mode,
        sources: plan.sources,
        target: request.target,
        ...(request.operationId ? { operationId: request.operationId } : {}),
        ...(request.conflicts !== undefined ? { conflicts: request.conflicts } : {}),
      }));
    } catch (error) {
      // A move that failed partway took some items: the Cut is kept only while all are where they were cut.
      if (pasting) await this.current().catch(() => null);
      throw error;
    }
    const stopped = "cancelled" in result && Boolean(result.cancelled);
    if (plan.cut && !stopped && !("conflicts" in result)) {
      if (pasting) await this.#forget(pasting);
      // Another app's Cut (GNOME Files, Dolphin): its files leave the pasteboard too.
      else if (pasteboardHolds(await this.#host.read(), pasteboard.paths)) this.#host.clear();
    } else if (stopped && pasting) await this.current().catch(() => null);
    return { ...result, fromHere: plan.fromHere, count: plan.sources.length, moved: plan.mode === "move", cut: plan.cut, from: plan.from, plan: planned };
  }

  /** The person cancelled the Cut (Esc): the items are no longer cut, and nothing is left to paste. */
  async cancel(): Promise<void> {
    const cut = this.#cut;
    if (cut) await this.#forget(cut);
  }

  async #forget(cut: RememberedCut): Promise<void> {
    if (pasteboardHoldsCut(await this.#host.read(), cut)) this.#host.clear();
    if (this.#cut === cut) this.#set(null);
  }

  async #whilePasting<T>(cut: RememberedCut | null, run: () => Promise<T>): Promise<T> {
    if (!cut) return run();
    this.#pasting.set(cut, (this.#pasting.get(cut) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const left = (this.#pasting.get(cut) ?? 1) - 1;
      if (left > 0) this.#pasting.set(cut, left);
      else this.#pasting.delete(cut);
    }
  }

  async #inPlace(cut: RememberedCut): Promise<boolean> {
    for (const nativePath of cut.nativePaths) {
      if (!(await this.#host.exists(nativePath))) return false;
    }
    return true;
  }

  #set(cut: RememberedCut | null): void {
    if (cut === this.#cut) return;
    this.#cut = cut;
    this.#host.changed(cut ? cut.nativePaths : null);
  }
}

/**
 * Whether something is still at a path on disk, for the host's `exists`: only
 * a missing item or a missing folder on the way counts as gone. A path that
 * cannot be read now (no permission, a drive that is slow to answer) still
 * counts as there, so a Cut is never forgotten for it.
 */
export async function existsOnDisk(nativePath: string): Promise<boolean> {
  try {
    await lstat(nativePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** What a paste carries and whether it moves, as one id: the same pasteboard and request plan the same id. */
export function pastePlanId(plan: PastePlan): string {
  return createHash("sha256").update(JSON.stringify({ mode: plan.mode, cut: plan.cut, sources: plan.sources })).digest("hex");
}

/** A Cut request from a window: native paths and the same items by place, one for one. */
export function parseCutItems(value: unknown, maxItems = 5_000): CutItems {
  if (!isRecord(value) || !Array.isArray(value.paths) || !isRecord(value.from) || !Array.isArray(value.from.paths)) throw new Error("Choose items to cut.");
  const place = value.from.place;
  if (!isRecord(place) || (place.kind !== "connected-folder" && place.kind !== "standard") || typeof place.id !== "string" || !place.id) throw new Error("Choose items to cut.");
  const nativePaths = value.paths;
  const paths = value.from.paths;
  if (!nativePaths.length || nativePaths.length > maxItems || nativePaths.length !== paths.length) throw new Error("Choose items to cut.");
  if (nativePaths.some((item) => typeof item !== "string" || !isAbsolute(item) || item.includes("\0"))) throw new Error("Choose items to cut.");
  if (paths.some((item) => typeof item !== "string" || item.includes("\0"))) throw new Error("Choose items to cut.");
  return { place: { kind: place.kind, id: place.id }, paths: paths as string[], nativePaths: nativePaths as string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
