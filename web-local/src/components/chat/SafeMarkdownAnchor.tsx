import type { ReactNode } from "react";

import { safeExternalHref } from "../../lib/api";
import { localServerHref } from "../../lib/browser-links";

/**
 * A Markdown link outside the Connected Folder: a server on this computer
 * (such as a Worker's dev server) or a safe external address opens in the
 * default browser; anything else, including a relative path, stays plain text
 * so a click can never navigate the app's own window away.
 */
export function SafeMarkdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const localServer = localServerHref(href);
  if (localServer) return <a className="message-external-link" href={localServer} target="_blank" rel="noreferrer">{children}</a>;
  const safeHref = safeExternalHref(href);
  return safeHref ? <a className="message-external-link" href={safeHref} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;
}
