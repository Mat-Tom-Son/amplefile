import { Dismiss16Regular } from "@fluentui/react-icons";

import type { ConnectedFolderSetUpMode } from "../../lib/connected-folder-setup";

/** Offered once right after a Connected Folder is added; × dismisses it for good. */
export function ConnectedFolderSetUpCard({ connectedFolderName, onSetUp, onDismiss }: {
  connectedFolderName: string;
  onSetUp: (mode: ConnectedFolderSetUpMode) => void;
  onDismiss: () => void;
}) {
  return (
    <section className="connected-folder-setup-card" aria-label={`Set up ${connectedFolderName}`}>
      <button type="button" className="connected-folder-setup-dismiss" aria-label="Dismiss" onClick={onDismiss}>
        <Dismiss16Regular aria-hidden="true" />
      </button>
      <strong>{connectedFolderName}</strong>
      <p>Your Worker can look over this folder and set it up for you.</p>
      <div className="connected-folder-setup-actions">
        <button type="button" className="ui-control ui-control--primary" onClick={() => onSetUp("full")}>Set Up for Me</button>
        <button type="button" className="ui-control" onClick={() => onSetUp("look")}>Just the Look</button>
      </div>
    </section>
  );
}
