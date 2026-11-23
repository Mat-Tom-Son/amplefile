import { ArrowSync16Regular } from "@fluentui/react-icons";
import "./file-manager-operations.css";

import { canStop, operationDetail, operationFraction, type WindowOperation } from "./file-operations-model";

/**
 * The operations area: the copies, moves, Compresses, and Extracts running
 * now, docked at the foot of the folder above the path bar, one notice-style
 * row each (icon, what it is with its progress, Stop). The folder stays
 * usable around it, and it goes when nothing long is running.
 */
export function FileOperationsTray({ operations, onStop }: { operations: readonly WindowOperation[]; onStop: (id: string) => void }) {
  if (!operations.length) return null;
  return (
    <div className="fm-ops" role="region" aria-label="File operations">
      {operations.map((operation) => {
        const fraction = operationFraction(operation.progress);
        const detail = operationDetail(operation);
        return <div className="fm-op" key={operation.id}>
          <span className="fm-op-icon" aria-hidden="true"><ArrowSync16Regular /></span>
          <div className="fm-op-copy">
            <strong title={operation.title}>{operation.title}</strong>
            <small title={detail}>{detail}</small>
            <div
              className={`fm-op-bar${fraction === null ? " is-indeterminate" : ""}`}
              role="progressbar"
              aria-label={operation.title}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(fraction === null ? {} : { "aria-valuenow": Math.round(fraction * 100) })}
            >
              <span style={fraction === null ? undefined : { width: `${Math.round(fraction * 1000) / 10}%` }} />
            </div>
          </div>
          <button type="button" className="fm-op-stop" disabled={!canStop(operation)} onClick={() => onStop(operation.id)}>
            {operation.stopping ? "Stopping…" : "Stop"}
          </button>
        </div>;
      })}
    </div>
  );
}
