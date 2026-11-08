import { useEffect, useRef } from "react";
import { Dismiss20Regular, ChevronRight20Regular } from "@fluentui/react-icons";

import { useModalDialog } from "../../hooks/useModalDialog";
import { connectedFolderIdentityStyle } from "../../lib/connected-folder-identity";
import { ConnectedFolderAppearancePanel, ConnectedFolderNameEditor } from "../panes/connectedFolderChrome";
import type { ConnectedFolderSummary } from "../../types";

export type ConnectedFolderAppearanceSection = "banner" | "title" | "icon" | "color";

export function ConnectedFolderAppearanceModal({ onRenameConnectedFolder, onClose, onOpenWorkerSettings, initialSection = "banner", ...appearance }: Omit<Parameters<typeof ConnectedFolderAppearancePanel>[0], "activeSection"> & {
  onRenameConnectedFolder: (connectedFolder: ConnectedFolderSummary, name: string) => Promise<void>;
  onClose: () => void;
  initialSection?: ConnectedFolderAppearanceSection;
  onOpenWorkerSettings?: (section: "model" | "instructions", returnSection: ConnectedFolderAppearanceSection) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeRef });
  const sections = ["icon", "color"] as const;
  // One scrolling page (2026-11-05): opening at a section scrolls to it.
  useEffect(() => {
    if (initialSection === "banner" || initialSection === "title") return;
    document.getElementById(`folder-appearance-section-${initialSection}`)?.scrollIntoView({ block: "start" });
  }, [initialSection]);
  /** The section at the top of the page, so Settings can bring the person back to it. */
  function sectionInView(): ConnectedFolderAppearanceSection {
    const scroller = dialogRef.current?.querySelector<HTMLElement>(".connected-folder-appearance-sections");
    const top = (scroller?.getBoundingClientRect().top ?? 0) + 24;
    return [...sections].reverse().find((section) => (document.getElementById(`folder-appearance-section-${section}`)?.getBoundingClientRect().top ?? Infinity) <= top) ?? sections[0];
  }

  return (
    <div className="modal-backdrop connected-folder-appearance-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="connected-folder-appearance-surface professional-appearance-surface connected-folder-appearance-modal"
        style={connectedFolderIdentityStyle(appearance.identity)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connected-folder-appearance-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="connected-folder-appearance-modal-title">
          <h2 id="connected-folder-appearance-title">Customize Connected Folder</h2>
          <button ref={closeRef} className="ui-control ui-control--icon" type="button" onClick={onClose} aria-label="Close Customize Connected Folder"><Dismiss20Regular /></button>
        </header>
        <div className="connected-folder-appearance-modal-body">
          <div className="connected-folder-appearance-surface-heading">
            <ConnectedFolderNameEditor connectedFolder={appearance.connectedFolder} onRenameConnectedFolder={onRenameConnectedFolder} />
          </div>
          <ConnectedFolderAppearancePanel {...appearance} />
        </div>
        {onOpenWorkerSettings ? <footer className="connected-folder-customize-worker">
          <button type="button" onClick={() => onOpenWorkerSettings("model", sectionInView())}>Model<ChevronRight20Regular /></button>
          <button type="button" onClick={() => onOpenWorkerSettings("instructions", sectionInView())}>Instructions<ChevronRight20Regular /></button>
        </footer> : null}
      </section>
    </div>
  );
}
