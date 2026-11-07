import type { ReactNode } from "react";
import { ChevronDown20Regular } from "@fluentui/react-icons";
import type { ConnectedFolderIdentity } from "../../lib/connected-folder-identity";

/**
 * The icon, name, and arrow on a Connected Folder banner. The header and Customize's
 * previews both render this, so a preview is exactly what the header shows.
 */
export function ConnectedFolderBannerTitle({ identity, name, caret = true, children }: {
  identity: ConnectedFolderIdentity;
  name: string;
  caret?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className={`connected-folder-banner-title fill-${identity.bannerTitleFill} icon-${identity.bannerIconStyle}`}>
      {identity.bannerIconStyle !== "none" ? <span className="connected-folder-banner-title-icon" aria-hidden="true"><identity.Icon /></span> : null}
      <strong>{name}</strong>
      {caret ? <ChevronDown20Regular className="connected-folder-pane-switch-caret" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
