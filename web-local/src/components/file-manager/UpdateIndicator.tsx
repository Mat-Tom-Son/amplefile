import { useEffect, useRef, type CSSProperties } from "react";
import { updateIndicatorDuringCheck, updateIndicatorFor, type UpdateIndicatorModel } from "../../lib/update-status";
import type { DesktopUpdateStatus } from "../../types";

/**
 * The foot of the sidebar when an update needs the person: a dot in the
 * window's accent with a short label. It renders nothing—and takes no
 * space—in every other phase. A click runs the same action as Settings →
 * About's update button, or opens About where that page holds the detail.
 */
export function UpdateIndicator({ status, onUpdateAction, onOpenAbout }: {
  status: DesktopUpdateStatus | null;
  onUpdateAction: () => void;
  onOpenAbout: () => void;
}) {
  const checking = status?.phase === "checking";
  const shown = useRef<UpdateIndicatorModel | null>(null);
  const fresh = updateIndicatorFor(status);
  const model = checking ? updateIndicatorDuringCheck(shown.current) : fresh;
  useEffect(() => { if (!checking) shown.current = fresh; });
  if (!model) return null;
  const inert = model.click === null;
  const style = model.progressPercent === null ? undefined : { "--fm-update-progress": `${model.progressPercent}%` } as CSSProperties;
  return <div className="fm-update">
    <button
      type="button"
      className={`fm-update-button is-${model.tone}`}
      aria-label={model.accessibleName}
      aria-disabled={inert || undefined}
      title={model.tooltip}
      onClick={() => {
        if (model.click === "update") onUpdateAction();
        else if (model.click === "open-about") onOpenAbout();
      }}
    >
      <span className="fm-update-mark" aria-hidden="true"><span className="fm-update-dot" style={style} /></span>
      <span className="fm-update-label">{model.label}</span>
      {model.detail ? <span className="fm-update-detail" aria-hidden="true">{model.detail}</span> : null}
    </button>
  </div>;
}
