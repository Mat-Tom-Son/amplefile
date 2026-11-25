import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { errorText } from "../../lib/api";
import { connectedFolderEntryNativePath, nativePathEntryPath } from "../../lib/platform";
import { showToast } from "../../ui/feedback";
import type { TreeEntry } from "../../types";
import { samePlace, type FileManagerLocation, type FileManagerPlace } from "./file-manager-places";
import type { TransferAnswer } from "../../../../src/shared/file-transfer";
import { operationTitle, type FileOperationKind } from "./file-operations-model";
import { moveResultMessage } from "./move-result";
import { historyTurn, transferLabel } from "./file-manager-undo";
import { desktopErrorText } from "./file-manager-view-helpers";
import type { FileChanges } from "./useFileChanges";

type TransferResult = TransferAnswer;

/**
 * What ⌘C copied here, by place (so ⌥⌘V moves it) and as paths on the system
 * pasteboard. With the desktop app a Cut is the host's, for every window;
 * `cut` is set only in the plain browser, which has no host.
 */
export interface FileClipboardContents { place: FileManagerPlace; paths: string[]; nativePaths: string[]; cut: boolean }

export interface FileClipboardContext {
  fixtureMode: boolean;
  place: FileManagerPlace;
  placeRoot: string;
  location: FileManagerLocation;
  /** The folder list: the Edit menu's Cut, Copy, and Paste act on it only while it has the keyboard. */
  contentRef: RefObject<HTMLDivElement | null>;
  changes: FileChanges;
  nameOfPlace: (place: FileManagerPlace) => string;
  onError: (message: string | null) => void;
}

/**
 * Copy, Cut, and Paste of items: the window's own Copy, kept for the window's
 * life so a copy made in one folder pastes in another; the Cut, which the
 * desktop host keeps for every window (desktop/src/file-clipboard.ts); and
 * the system pasteboard, so Finder or a Linux file manager can paste what was
 * copied here and the other way around.
 */
export function useFileClipboard(context: FileClipboardContext) {
  const { fixtureMode, place, placeRoot, location, contentRef, changes, nameOfPlace, onError } = context;
  const fileClipboardRef = useRef<FileClipboardContents | null>(null);
  // What is cut in any window, as paths on disk, as the desktop host last said; drawn dimmed in every window.
  const [desktopCut, setDesktopCut] = useState<ReadonlySet<string> | null>(null);
  // The plain browser has no host: a Cut there is this window's own.
  const [localCut, setLocalCut] = useState<{ place: FileManagerPlace; paths: ReadonlySet<string> } | null>(null);
  // When the folder list last handled ⌘C, ⌘X, or ⌘V itself, so the Edit menu's own command for the same key does not repeat it.
  const clipboardKeyAtRef = useRef(0);
  const clipboardActionsRef = useRef<{ copy: () => void; cut: () => void; paste: () => void }>({ copy: () => undefined, cut: () => undefined, paste: () => undefined });

  /** The items of the place shown that are cut, by their paths in it. */
  const cutPaths = useMemo<ReadonlySet<string> | null>(() => {
    if (desktopCut) {
      if (!placeRoot) return null;
      const paths = new Set<string>();
      for (const nativePath of desktopCut) {
        const path = nativePathEntryPath(placeRoot, nativePath);
        if (path) paths.add(path);
      }
      return paths.size ? paths : null;
    }
    return localCut && samePlace(localCut.place, place) ? localCut.paths : null;
  }, [desktopCut, localCut, place, placeRoot]);

  /** ⌘C: the selection, here and on the system pasteboard, so Finder can paste it too. */
  async function copySelection(entries = changes.selectedEntries()) {
    await putOnClipboard(entries, false);
  }

  /**
   * ⌘X: Cut. The items stay where they are, dimmed in every window, until a
   * Paste in any window moves them (through the same move rules as ⌥⌘V). A
   * Mac's pasteboard has no Cut marker, so the desktop host remembers the Cut
   * by the exact files it put there; on Linux the pasteboard also carries the
   * marker GNOME Files and Dolphin read, so they paste it as a move too.
   */
  async function cutSelection(entries = changes.selectedEntries()) {
    await putOnClipboard(entries, true);
  }

  async function putOnClipboard(entries: readonly TreeEntry[], cut: boolean) {
    if (!entries.length) return;
    const nativePaths = entries.map((entry) => connectedFolderEntryNativePath(placeRoot, entry.path));
    const paths = entries.map((entry) => entry.path);
    const desktop = window.ampleFileDesktop?.fileClipboard;
    if (desktop) {
      // The host keeps a Cut and tells every window; the window keeps only its Copy.
      fileClipboardRef.current = cut ? null : { place, paths, nativePaths, cut: false };
      await (cut ? desktop.write(nativePaths, "cut", { place, paths }) : desktop.write(nativePaths, "copy")).catch(() => false);
      return;
    }
    fileClipboardRef.current = { place, paths, nativePaths, cut };
    setLocalCut(cut ? { place, paths: new Set(paths) } : null);
  }

  /** Esc with nothing selected: the Cut is cancelled in every window and nothing is left to paste. */
  async function cancelCut() {
    const desktop = window.ampleFileDesktop?.fileClipboard;
    if (desktop?.cancelCut) { await desktop.cancelCut().catch(() => undefined); return; }
    if (fileClipboardRef.current?.cut) fileClipboardRef.current = null;
    setLocalCut(null);
  }

  /**
   * ⌘V pastes what was copied or cut (here, in another window, in Finder, or
   * in a Linux file manager) into a folder; ⌥⌘V moves what was copied. A Cut
   * pastes as a move. The desktop process reads the pasteboard and pastes;
   * the window never reads it, and learns only what landed. Taken names are
   * asked about first.
   */
  async function pasteInto(targetPath = location.path, mode: "copy" | "move" = "copy") {
    if (fixtureMode) { showToast({ text: "Pasting is disabled in the preview", tone: "info" }); return; }
    const internal = fileClipboardRef.current;
    const target = { place, path: targetPath };
    const where = changes.folderLabel(target);
    const paste = window.ampleFileDesktop?.fileClipboard?.paste;
    try {
      let result: TransferResult;
      let kind: FileOperationKind;
      if (paste) {
        const copied = internal && !internal.cut ? { place: internal.place, paths: internal.paths, nativePaths: internal.nativePaths } : null;
        const request = { target, mode, internal: copied };
        let asked: TransferResult = { written: [], restorePoints: [] };
        // Whether it moves is the host's answer: a Cut made in any window moves.
        const choices = await changes.withConflictChoices(async () => (asked = await paste({ ...request, conflicts: { check: true } })), (answer) => answer.moved ? "Moving" : "Copying", where);
        if (asked.nothing) { showToast({ text: "Nothing to paste", tone: "info" }); return; }
        if (!choices) return;
        kind = asked.moved ? "move" : "copy";
        const from = asked.from ?? null;
        const what = from ? transferLabel(from.paths) : `${asked.count ?? 0} items`;
        const touched = [target.place, from?.place].flatMap((item) => item?.kind === "connected-folder" ? [item.id] : []);
        // The run carries what the person was asked about: the host refuses it if the pasteboard changed meanwhile.
        const plan = asked.plan;
        result = await changes.runOperation(kind, operationTitle(kind, what, where), (handle) => historyTurn(touched, () => {
          handle.beforeSend();
          return paste({ ...request, operationId: handle.operationId, ...(plan ? { plan } : {}), ...(choices.policy ? { conflicts: choices.policy } : {}) });
        }));
      } else {
        if (!internal) { showToast({ text: "Nothing to paste", tone: "info" }); return; }
        const moving = internal.cut || mode === "move";
        kind = moving ? "move" : "copy";
        const answer = await changes.startTransfer({ mode: kind, sources: internal.paths.map((path) => ({ place: internal.place, path })), target }, where, transferLabel(internal.paths));
        if (!answer) return;
        result = { ...answer, fromHere: true, count: internal.paths.length, moved: moving, cut: internal.cut, from: { place: internal.place, paths: internal.paths } };
      }
      if (result.nothing) { showToast({ text: "Nothing to paste", tone: "info" }); return; }
      const moved = Boolean(result.moved) && !result.copiedInstead;
      const from = result.from ?? null;
      const label = from ? transferLabel(from.paths) : result.count === 1 ? transferLabel(result.written) : `${result.count ?? result.written.length} items`;
      await changes.afterTransfer(result, target, `${moved ? "Move" : "Paste"} ${label}`, true);
      if (result.cancelled) { changes.reportOutcome(kind, result); return; }
      // A Cut (or a move by ⌥⌘V) is pasted once. The host forgets a Cut and tells every window; the window's Copy goes too.
      if (result.fromHere && (moved || result.cut)) { fileClipboardRef.current = null; setLocalCut(null); }
      const said = changes.reportOutcome(kind, result);
      if (result.copiedInstead) showToast({ text: `Copied ${label}. The original stays where it was.`, tone: "info" });
      else if (moved) {
        // A plain move says nothing, as Finder's does; one that left something behind says so.
        const message = moveResultMessage(label, where, from ? nameOfPlace(from.place) : "the original folder", result);
        if (!said && (message.tone !== "success" || message.text.includes("Recently Deleted"))) showToast(message);
      }
    } catch (caught) {
      onError(desktopErrorText(errorText(caught)));
    }
  }

  /** Paste Here is offered once something was copied here or is cut in any window; ⌘V also pastes what Finder or a Linux file manager copied. */
  async function canPaste(): Promise<boolean> {
    return Boolean(fileClipboardRef.current) || Boolean(desktopCut?.size);
  }

  /** The folder list handled ⌘C, ⌘X, or ⌘V itself just now. */
  function noteClipboardKey() {
    clipboardKeyAtRef.current = Date.now();
  }

  // The Edit menu's Cut, Copy, and Paste act on the selected items while the folder list has the keyboard.
  clipboardActionsRef.current = { copy: () => void copySelection(), cut: () => void cutSelection(), paste: () => void pasteInto(location.path, "copy") };
  useEffect(() => {
    function clipboardCommand(event: ClipboardEvent) {
      const list = contentRef.current;
      if (!list || !(document.activeElement instanceof HTMLElement) || !list.contains(document.activeElement)) return;
      if (document.activeElement.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      if (Date.now() - clipboardKeyAtRef.current < 400) return;
      clipboardActionsRef.current[event.type as "copy" | "cut" | "paste"]();
    }
    document.addEventListener("copy", clipboardCommand);
    document.addEventListener("cut", clipboardCommand);
    document.addEventListener("paste", clipboardCommand);
    return () => {
      document.removeEventListener("copy", clipboardCommand);
      document.removeEventListener("cut", clipboardCommand);
      document.removeEventListener("paste", clipboardCommand);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // What is cut in any window: asked when the window opens and each time it comes to the front (the host forgets a
  // Cut once the pasteboard holds something else, such as another app's Copy), and heard on every change.
  useEffect(() => {
    const desktop = window.ampleFileDesktop?.fileClipboard;
    if (!desktop?.cut || !desktop.onCutChanged) return;
    const ask = desktop.cut;
    let disposed = false;
    // Bumped by each change heard, so an answer asked for before it never draws an older Cut.
    let heard = 0;
    const take = (cut: { nativePaths: string[] } | null) => setDesktopCut(cut?.nativePaths.length ? new Set(cut.nativePaths) : null);
    const unsubscribe = desktop.onCutChanged((cut) => { heard += 1; if (!disposed) take(cut); });
    const check = () => {
      const asked = heard;
      void ask().then((cut) => { if (!disposed && asked === heard) take(cut); }).catch(() => undefined);
    };
    check();
    window.addEventListener("focus", check);
    return () => { disposed = true; unsubscribe(); window.removeEventListener("focus", check); };
  }, []);

  return { cutPaths, copySelection, cutSelection, cancelCut, pasteInto, canPaste, noteClipboardKey };
}
