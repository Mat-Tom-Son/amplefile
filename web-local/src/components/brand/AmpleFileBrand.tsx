import type * as React from "react";
import { productName } from "../../constants";
import lockupBlackUrl from "../../assets/brand/amplefile-lockup-black.png";
import lockupWhiteUrl from "../../assets/brand/amplefile-lockup-white.png";
export function AmpleFileLockup({ className = "", animated = false }: { className?: string; animated?: boolean }) {
  // The provided horizontal lockups are single images: black carries light
  // themes, white carries dark themes.
  return (
    <div
      className={["amplefile-lockup", className].filter(Boolean).join(" ")}
      data-animated={animated ? "true" : undefined}
      role="img"
      aria-label={productName}
    >
      <img className="amplefile-lockup-art amplefile-lockup-art-black" src={lockupBlackUrl} alt="" draggable={false} />
      <img className="amplefile-lockup-art amplefile-lockup-art-white" src={lockupWhiteUrl} alt="" draggable={false} />
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
