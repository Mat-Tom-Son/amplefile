import { useState } from "react";
import { Dismiss20Regular } from "@fluentui/react-icons";

import { useModalDialog } from "../../hooks/useModalDialog";
import { CapabilitiesPane } from "../panes/CapabilitiesPane";
import type { AgentCatalog, AgentStatus, SkillsExtensionsView, ConnectedFolderSummary } from "../../types";

/**
 * Skills & Extensions as a popup like Settings (2026-09-25). The rail's Add
 * button opens it for the Connected Folder that was active, and "This Connected Folder only"
 * keeps meaning that Connected Folder for as long as the popup is open.
 */
export function SkillsExtensionsModal({ connectedFolder, status, initialView, fixtureMode = false, onError, onCatalogChanged, onClose }: {
  connectedFolder: ConnectedFolderSummary;
  status: AgentStatus;
  initialView: SkillsExtensionsView;
  fixtureMode?: boolean;
  onError: (message: string | null) => void;
  onCatalogChanged?: (catalog: AgentCatalog) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<SkillsExtensionsView>(initialView);
  const dialogRef = useModalDialog({ onClose });
  return (
    <div className="modal-backdrop skills-extensions-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="skills-extensions-modal" role="dialog" aria-modal="true" aria-label="Skills & Extensions" onMouseDown={(event) => event.stopPropagation()}>
        <button className="ui-control ui-control--icon skills-extensions-close" type="button" onClick={onClose} aria-label="Close Skills & Extensions"><Dismiss20Regular /></button>
        <CapabilitiesPane
          connectedFolder={connectedFolder}
          status={status}
          view={view}
          fixtureMode={fixtureMode}
          onViewChange={setView}
          onError={onError}
          onCatalogChanged={onCatalogChanged}
        />
      </section>
    </div>
  );
}
