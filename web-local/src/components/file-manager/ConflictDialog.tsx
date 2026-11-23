import { useCallback, useId, useRef, useState } from "react";
import "./file-manager-operations.css";

import { useModalDialog } from "../../hooks/useModalDialog";
import { formatFileManagerDate } from "./file-manager-model";
import {
  conflictChoiceLabels,
  conflictChoices,
  conflictItemLine,
  conflictPolicy,
  remainingConflicts,
  type ConflictChoice,
  type ConflictDecision,
  type ConflictPolicy,
  type InsideChoice,
  type TransferConflict,
} from "./file-operations-model";

interface ConflictQuestion {
  conflicts: TransferConflict[];
  /** "Copying", "Moving", "Extracting": what is being done. */
  verb: string;
  /** Where the items are going. */
  where: string;
  resolve: (policy: ConflictPolicy | null) => void;
}

/**
 * The name-clash question (docs/product-model.md, "Finder's file actions"),
 * asked once before anything is written: one clash at a time, both items'
 * kind, size, and date, and Keep Both, Skip, Replace, or for two folders
 * Merge, with "Apply to all" while more clashes wait. Each Merge carries its
 * own answer about same-named items inside, asked when the engine counted
 * some or could not count them (an archive is not read before Extract).
 * Stop answers null and nothing happens.
 */
export function useConflictQuestion() {
  const [question, setQuestion] = useState<ConflictQuestion | null>(null);
  const ask = useCallback((conflicts: TransferConflict[], verb: string, where: string) => new Promise<ConflictPolicy | null>((resolve) => {
    setQuestion({ conflicts, verb, where, resolve });
  }), []);
  const element = question ? <ConflictDialog
    key={question.conflicts.map((conflict) => conflict.key).join("\n")}
    question={question}
    onDone={(policy) => { question.resolve(policy); setQuestion(null); }}
  /> : null;
  return { ask, element };
}

function ConflictDialog({ question, onDone }: { question: ConflictQuestion; onDone: (policy: ConflictPolicy | null) => void }) {
  const [decisions, setDecisions] = useState<ConflictDecision[]>([]);
  const [applyToAll, setApplyToAll] = useState(false);
  const [inside, setInside] = useState<InsideChoice>("keep-both");
  const keepBothRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const dialogRef = useModalDialog({ onClose: () => onDone(null), initialFocusRef: keepBothRef });
  const remaining = remainingConflicts(question.conflicts, decisions);
  const conflict = remaining[0];
  if (!conflict) return null;
  const more = remaining.length - 1;
  // Same-named items inside are asked about when the engine counted some, or could not count them quickly (null).
  const insideCount = conflict.canMerge && conflict.insideClashes !== undefined ? conflict.insideClashes : 0;

  function choose(choice: ConflictChoice) {
    const next = [...decisions, { key: conflict!.key, choice, applyToAll: applyToAll && more > 0, ...(choice === "merge" ? { inside } : {}) }];
    if (!remainingConflicts(question.conflicts, next).length) { onDone(conflictPolicy(question.conflicts, next)); return; }
    setDecisions(next);
    setInside("keep-both");
  }

  return (
    <div className="modal-backdrop confirm-dialog-backdrop" role="presentation">
      <section ref={dialogRef} tabIndex={-1} className="confirm-dialog fm-clash" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${titleId}-body`}>
        <div className="modal-title confirm-dialog-title">
          <div>
            <h2 id={titleId}>An item named “{conflict.name}” is already in {question.where}</h2>
            <p id={`${titleId}-body`}>{question.verb} would put another item with the same name there. Choose what to do{question.conflicts.length > 1 ? ` (${question.conflicts.length - remaining.length + 1} of ${question.conflicts.length})` : ""}.</p>
          </div>
        </div>
        <dl className="fm-clash-items">
          <div><dt>Already there</dt><dd>{conflictItemLine(conflict.existing, formatClashDate)}</dd></div>
          <div><dt>{question.verb === "Extracting" ? "From the archive" : "Coming in"}</dt><dd>{conflictItemLine(conflict.source, formatClashDate)}</dd></div>
        </dl>
        {conflict.canMerge && insideCount !== 0 ? <label className="fm-clash-inside">
          <span>{insideCount === null ? "Items inside with the same names" : `${insideCount.toLocaleString()} ${insideCount === 1 ? "item" : "items"} inside with the same name`}, if merged:</span>
          <select value={inside} onChange={(event) => setInside(event.currentTarget.value as InsideChoice)}>
            <option value="keep-both">Keep Both</option>
            <option value="skip">Skip</option>
            <option value="replace">Replace</option>
          </select>
        </label> : null}
        {more > 0 ? <label className="fm-clash-all">
          <input type="checkbox" checked={applyToAll} onChange={(event) => setApplyToAll(event.currentTarget.checked)} />
          <span>Apply to all {more + 1} items with the same name</span>
        </label> : null}
        <div className="confirm-dialog-footer fm-clash-footer">
          <button className="ui-control" type="button" onClick={() => onDone(null)}>Stop</button>
          <span className="fm-clash-spacer" />
          {conflictChoices(conflict).map((choice) => <button
            key={choice}
            ref={choice === "keep-both" ? keepBothRef : undefined}
            className={choice === "keep-both" ? "ui-control ui-control--primary" : "ui-control"}
            type="button"
            title={choiceHint(choice, conflict)}
            onClick={() => choose(choice)}
          >{conflictChoiceLabels[choice]}</button>)}
        </div>
      </section>
    </div>
  );
}

function choiceHint(choice: ConflictChoice, conflict: TransferConflict): string {
  if (choice === "keep-both") return "Keep both: the new item gets a name with “copy”.";
  if (choice === "skip") return "Leave the item that is already there, and don’t bring this one.";
  if (choice === "merge") return "Put the folder’s items into the folder that is already there. Items inside with the same name follow the choice above.";
  return conflict.existing.kind === "folder" ? "Replace the folder that is already there, and everything in it." : "Replace the item that is already there.";
}

function formatClashDate(iso: string): string {
  return formatFileManagerDate(iso, new Date());
}
