import type * as React from "react";
import { productName } from "../../constants";
import lockupUrl from "../../../../desktop/assets/brand/amplefile-lockup.svg";
import lockupDarkUrl from "../../../../desktop/assets/brand/amplefile-lockup-dark.svg";
export function AmpleFileLockup({ className = "", animated = false }: { className?: string; animated?: boolean }) {
  // The brand lockups are single outlined images: Ink lettering on light
  // themes, light lettering on dark themes. The folder and dot keep their color.
  return (
    <div
      className={["amplefile-lockup", className].filter(Boolean).join(" ")}
      data-animated={animated ? "true" : undefined}
      role="img"
      aria-label={productName}
    >
      <img className="amplefile-lockup-art amplefile-lockup-art-on-light" src={lockupUrl} alt="" draggable={false} />
      <img className="amplefile-lockup-art amplefile-lockup-art-on-dark" src={lockupDarkUrl} alt="" draggable={false} />
    </div>
  );
}

export function AmpleFileLoadingState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="amplefile-loading-state" role="status" aria-live="polite">
      <AmpleFileLockup className="amplefile-loading-lockup" animated />
      <p>{message}</p>
      {action}
    </div>
  );
}
