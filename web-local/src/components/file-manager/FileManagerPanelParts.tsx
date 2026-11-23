import type { ComponentProps } from "react";

import { historyTimeLabel, fileManagerSuggestions } from "./file-manager-model";
import { FileManagerComposer } from "./FileManagerPanel";
import { useFolderSuggestions } from "./useFolderSuggestions";
import { workerChangesSummary, type useWorkerChanges } from "./useWorkerChanges";

/**
 * The Worker's receipt at the top of Info: how many items its last reply
 * changed and how, the first few by name (each shows itself in the list), and
 * Undo or Done.
 */
export function WorkerReceipt({ changes, onShow, onUndo, onDone }: {
  changes: NonNullable<ReturnType<typeof useWorkerChanges>["changes"]>;
  onShow: (path: string) => void;
  onUndo: () => void;
  onDone: () => void;
}) {
  const rows = [
    ...changes.added.map((path) => ({ path, verb: "Added" })),
    ...changes.moved.map((move) => ({ path: move.to, verb: "Moved" })),
    ...changes.changed.map((path) => ({ path, verb: "Changed" })),
  ];
  const total = rows.length;
  return <section className="fm-receipt" data-exit-motion="collapse" aria-label="What the Worker changed">
    <div className="fm-receipt-head">
      <span className="fm-dot is-done" aria-hidden="true" />
      <span className="fm-receipt-title">The Worker changed {total === 1 ? "1 item" : `${total} items`}</span>
      <span className="fm-receipt-time">{historyTimeLabel(changes.createdAt)}</span>
    </div>
    <div className="fm-receipt-sum">{workerChangesSummary(changes)}</div>
    <div className="fm-receipt-list">
      {rows.slice(0, 4).map((row) => <button type="button" key={`${row.verb}:${row.path}`} className="fm-receipt-row" title={row.path} onClick={() => onShow(row.path)}>
        <span className="fm-receipt-name">{row.path.slice(row.path.lastIndexOf("/") + 1)}</span>
        <span className="fm-receipt-verb">{row.verb}</span>
      </button>)}
      {total > 4 ? <div className="fm-receipt-more">and {total - 4} more, marked in the list</div> : null}
    </div>
    <div className="fm-receipt-actions">
      <button type="button" className="fm-btn is-small" onClick={onUndo}>Undo</button>
      <button type="button" className="fm-btn is-small" onClick={onDone}>Done</button>
    </div>
  </section>;
}

/** The one place Set Up for Me is offered: a card at the top of Info, right after a folder is connected. Either button closes it for good. */
export function SetUpOffer({ name, onSetUp, onDismiss }: { name: string; onSetUp: () => void; onDismiss: () => void }) {
  return <section className="fm-receipt fm-setup-offer" data-exit-motion="collapse" aria-label={`Set up ${name}`}>
    <div className="fm-receipt-head">
      <span className="fm-receipt-title">Set Up This Folder</span>
    </div>
    <p className="fm-setup-offer-s">Your Worker can look this folder over, organize it, and give it a look that fits.</p>
    <div className="fm-receipt-actions">
      <button type="button" className="fm-btn is-small is-primary" onClick={onSetUp}>Set Up for Me</button>
      <button type="button" className="fm-btn is-small" onClick={onDismiss}>No Thanks</button>
    </div>
  </section>;
}

/**
 * The panel's message box. Its suggestions are written by the Worker's model
 * only while they would show: Info is the tab shown and nothing is selected.
 */
export function SuggestingComposer({ connectedFolderId, path, writtenSuggestions, showSuggestions, automationsOn, ...composer }: Omit<ComponentProps<typeof FileManagerComposer>, "suggestions"> & {
  connectedFolderId: string;
  path: string;
  /** The Worker can write suggestions here (AI connected, not the preview). */
  writtenSuggestions: boolean;
  showSuggestions: boolean;
  automationsOn: boolean;
}) {
  const references = composer.chips;
  const written = useFolderSuggestions(connectedFolderId, path, writtenSuggestions && showSuggestions && !references.length);
  const suggestions = !showSuggestions ? []
    : !references.length && written.length ? written.slice(0, automationsOn ? 2 : 4)
    : fileManagerSuggestions({ selection: references, inSubfolder: Boolean(path), automationsOn });
  return <FileManagerComposer {...composer} suggestions={suggestions} />;
}
