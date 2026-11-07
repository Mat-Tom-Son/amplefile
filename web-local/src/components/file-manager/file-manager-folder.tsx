import type { CSSProperties } from "react";

import { ConnectedFolderIconGlyph } from "../chrome/common";
import type { ConnectedFolderIconOption } from "../../connected-folder-icons";

/**
 * A Connected Folder's folder in its own color, with the icon chosen in Customize
 * Connected Folder stamped on its front, the way macOS lets a folder carry a
 * symbol. A Connected Folder nobody gave an icon shows a plain tinted folder.
 */
export function TintedFolder({ color, symbol }: { color: string; symbol?: ConnectedFolderIconOption["Icon"] | null }) {
  return <span className="fm-ic fm-ic-folder is-tinted" style={{ "--fold-base": color } as CSSProperties} aria-hidden="true">
    {symbol ? <span className="fm-folder-symbol"><ConnectedFolderIconGlyph icon={symbol} size={16} /></span> : null}
  </span>;
}
