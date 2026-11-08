/**
 * A link to a server on this computer, such as the dev server a Worker
 * started. Chat replies open it in the default browser.
 */

/** The address of a server on this computer, or null for anything else. */
export function localServerHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    const local = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "0.0.0.0";
    if (!local) return null;
    if (host === "0.0.0.0") url.hostname = "localhost";
    return url.toString();
  } catch {
    return null;
  }
}
