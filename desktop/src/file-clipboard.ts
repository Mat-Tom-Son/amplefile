import { isAbsolute } from "node:path";

import {
  pasteboardHolds,
  pasteboardHoldsCut,
  planFileClipboardPaste,
  type FileClipboardPasteRequest,
  type PasteboardFiles,
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
 * and when it is cancelled. It knows nothing of Electron, so it is tested on
 * its own; desktop/src/main.ts gives it the pasteboard and the windows.
 */
export interface FileClipboardHost {
  /** The files on the pasteboard now. */
  read(): Promise<PasteboardFiles> | PasteboardFiles;
  /** Puts the files on the pasteboard, with the token where the pasteboard can carry one. */
  write(nativePaths: readonly string[], token: string | null): Promise<void> | void;
  /** Empties the pasteboard. */
  clear(): void;
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
   * The Cut while the pasteboard still holds what it put there; when it does
   * not, the Cut is forgotten and every window hears it. `pasteboard` is a
   * reading already taken, so a paste reads the pasteboard once.
   */
  async current(pasteboard?: PasteboardFiles): Promise<RememberedCut | null> {
    const cut = this.#cut;
    if (!cut) return null;
    const holds = pasteboardHoldsCut(pasteboard ?? await this.#host.read(), cut);
    if (holds) return cut;
    if (this.#cut === cut) this.#set(null);
    return null;
  }

  /**
   * A paste in any window (desktop/src/file-clipboard-paste.ts plans it): the
   * pasteboard is read once; a Cut it still holds moves by the place it was
   * cut in. A finished paste of a Cut empties the pasteboard, as the system
   * file managers do, so it never moves twice, and every window hears that
   * nothing is cut. The conflicts-first check and a stopped paste keep it.
   */
  async paste<Result extends object>(
    request: FileClipboardPasteRequest,
    connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>,
    transfer: (body: PasteTransfer) => Promise<Result>,
  ) {
    const pasteboard = await this.#host.read();
    const cut = await this.current(pasteboard);
    const plan = planFileClipboardPaste(request, pasteboard, connectedFolders, cut);
    if (!plan.sources.length) return { mode: "copy", written: [], restorePoints: [], nothing: true };
    const result = await transfer({
      mode: plan.mode,
      sources: plan.sources,
      target: request.target,
      ...(request.operationId ? { operationId: request.operationId } : {}),
      ...(request.conflicts !== undefined ? { conflicts: request.conflicts } : {}),
    });
    const finished = !("conflicts" in result) && !("cancelled" in result && result.cancelled);
    if (plan.cut && finished) {
      if (cut && plan.fromHere) await this.#forget(cut);
      // Another app's Cut (GNOME Files, Dolphin): its files leave the pasteboard too.
      else if (pasteboardHolds(await this.#host.read(), pasteboard.paths)) this.#host.clear();
    }
    return { ...result, fromHere: plan.fromHere, count: plan.sources.length, moved: plan.mode === "move", cut: plan.cut, from: plan.from };
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

  #set(cut: RememberedCut | null): void {
    if (cut === this.#cut) return;
    this.#cut = cut;
    this.#host.changed(cut ? cut.nativePaths : null);
  }
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
