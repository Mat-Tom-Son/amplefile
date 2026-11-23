import { useEffect, useRef, useState, type RefObject } from "react";

import { errorText } from "../../lib/api";
import { connectedFolderEntryNativePath } from "../../lib/platform";
import { showToast } from "../../ui/feedback";
import type { TreeEntry } from "../../types";
import type { FileManagerLocation, FileManagerPlace } from "./file-manager-places";
import { operationTitle, type FileOperationKind, type TransferAnswer } from "./file-operations-model";
import { moveResultMessage } from "./move-result";
import { historyTurn, transferLabel } from "./file-manager-undo";
import { desktopErrorText } from "./file-manager-view-helpers";
import type { FileChanges } from "./useFileChanges";

type TransferResult = TransferAnswer;

/** What ⌘C copied or ⌘X cut here: the items by place (so a Cut or ⌥⌘V moves them) and as paths on the system pasteboard. */
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
 * Copy, Cut, and Paste of items: the window's own clipboard, kept for the
 * window's life so a copy made in one folder pastes in another, and the system
 * pasteboard, so Finder or a Linux file manager can paste what was copied here
 * and the other way around.
 */
export function useFileClipboard(context: FileClipboardContext) {
  const { fixtureMode, place, placeRoot, location, contentRef, changes, nameOfPlace, onError } = context;
  const fileClipboardRef = useRef<FileClipboardContents | null>(null);
  // Items cut and not yet pasted, drawn dimmed until they are pasted or the clipboard holds something else.
  const [cutItems, setCutItems] = useState<{ place: FileManagerPlace; paths: ReadonlySet<string> } | null>(null);
  // When the folder list last handled ⌘C, ⌘X, or ⌘V itself, so the Edit menu's own command for the same key does not repeat it.
  const clipboardKeyAtRef = useRef(0);
  const clipboardActionsRef = useRef<{ copy: () => void; cut: () => void; paste: () => void }>({ copy: () => undefined, cut: () => undefined, paste: () => undefined });

  /** ⌘C: the selection, here and on the system pasteboard, so Finder can paste it too. */
  async function copySelection(entries = changes.selectedEntries()) {
    await putOnClipboard(entries, false);
  }

  /**
   * ⌘X: Cut. The items stay where they are, dimmed, until Paste moves them
   * (through the same move rules as ⌥⌘V). On Linux the pasteboard carries the
   * cut marker GNOME Files and Dolphin read, so they paste it as a move too; a
   * Mac's pasteboard has none, so there a Cut is this window's own.
   */
  async function cutSelection(entries = changes.selectedEntries()) {
    await putOnClipboard(entries, true);
  }

  async function putOnClipboard(entries: readonly TreeEntry[], cut: boolean) {
    if (!entries.length) return;
    const nativePaths = entries.map((entry) => connectedFolderEntryNativePath(placeRoot, entry.path));
    const paths = entries.map((entry) => entry.path);
    fileClipboardRef.current = { place, paths, nativePaths, cut };
    setCutItems(cut ? { place, paths: new Set(paths) } : null);
    await window.ampleFileDesktop?.fileClipboard?.write(nativePaths, cut ? "cut" : "copy").catch(() => false);
  }

  /** Paste emptied the Cut, or the clipboard holds something else now: nothing is drawn as cut. */
  function forgetCut() {
    if (fileClipboardRef.current?.cut) fileClipboardRef.current = null;
    setCutItems(null);
  }

  /**
   * ⌘V pastes what was copied or cut (here, in Finder, or in a Linux file
   * manager) into a folder; ⌥⌘V moves what was copied. A Cut pastes as a move.
   * The desktop process reads the pasteboard and pastes; the window never
   * reads it, and learns only what landed. Taken names are asked about first.
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
        const request = { target, mode, internal: internal ? { place: internal.place, paths: internal.paths, nativePaths: internal.nativePaths, cut: internal.cut } : null };
        let asked: TransferResult = { written: [], restorePoints: [] };
        const choices = await changes.withConflictChoices(async () => (asked = await paste({ ...request, conflicts: { check: true } })), mode === "move" || internal?.cut ? "Moving" : "Copying", where);
        if (asked.nothing) { showToast({ text: "Nothing to paste", tone: "info" }); return; }
        if (!choices) return;
        kind = asked.moved ? "move" : "copy";
        const what = asked.fromHere && internal ? transferLabel(internal.paths) : `${asked.count ?? 0} items`;
        const touched = [target.place, internal?.place].flatMap((item) => item?.kind === "connected-folder" ? [item.id] : []);
        result = await changes.runOperation(kind, operationTitle(kind, what, where), (handle) => historyTurn(touched, () => {
          handle.beforeSend();
          return paste({ ...request, operationId: handle.operationId, ...(choices.policy ? { conflicts: choices.policy } : {}) });
        }));
      } else {
        if (!internal) { showToast({ text: "Nothing to paste", tone: "info" }); return; }
        const moving = internal.cut || mode === "move";
        kind = moving ? "move" : "copy";
        const answer = await changes.startTransfer({ mode: kind, sources: internal.paths.map((path) => ({ place: internal.place, path })), target }, where, transferLabel(internal.paths));
        if (!answer) return;
        result = { ...answer, fromHere: true, count: internal.paths.length, moved: moving, cut: internal.cut };
      }
      if (result.nothing) { showToast({ text: "Nothing to paste", tone: "info" }); return; }
      const moved = Boolean(result.moved) && !result.copiedInstead;
      const label = result.fromHere && internal ? transferLabel(internal.paths) : result.count === 1 ? transferLabel(result.written) : `${result.count ?? result.written.length} items`;
      await changes.afterTransfer(result, target, `${moved ? "Move" : "Paste"} ${label}`, true);
      if (result.cancelled) { changes.reportOutcome(kind, result); return; }
      // A Cut (or a move by ⌥⌘V) is pasted once; the items are no longer drawn as cut.
      if (result.fromHere && (moved || result.cut)) { fileClipboardRef.current = null; setCutItems(null); }
      const said = changes.reportOutcome(kind, result);
      if (result.copiedInstead) showToast({ text: `Copied ${label}. The original stays where it was.`, tone: "info" });
      else if (moved) {
        // A plain move says nothing, as Finder's does; one that left something behind says so.
        const message = moveResultMessage(label, where, internal && result.fromHere ? nameOfPlace(internal.place) : "the original folder", result);
        if (!said && (message.tone !== "success" || message.text.includes("Recently Deleted"))) showToast(message);
      }
    } catch (caught) {
      onError(desktopErrorText(errorText(caught)));
    }
  }

  /** Paste Here is offered once something was copied or cut here; ⌘V also pastes what Finder or a Linux file manager copied. */
  async function canPaste(): Promise<boolean> {
    return Boolean(fileClipboardRef.current);
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
  // Items cut here stay dimmed until pasted or until the clipboard holds something else (another app copied).
  useEffect(() => {
    if (!cutItems) return;
    const holds = window.ampleFileDesktop?.fileClipboard?.holds;
    if (!holds) return;
    const check = () => {
      const current = fileClipboardRef.current;
      if (!current?.cut) return;
      void holds(current.nativePaths).then((still) => { if (!still && fileClipboardRef.current === current) forgetCut(); }).catch(() => undefined);
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [cutItems]); // eslint-disable-line react-hooks/exhaustive-deps

  return { cutItems, copySelection, cutSelection, pasteInto, canPaste, noteClipboardKey };
}
