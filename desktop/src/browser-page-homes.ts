/**
 * Which file manager window a built-in browser page belongs to
 * (docs/built-in-browser.md, "Pages and windows"). A page is a desktop-hosted
 * view placed inside one window, its home:
 *
 * - a tab the person opens belongs to the window it was opened in, and a tab
 *   or pop-up a page opens belongs to that page's window;
 * - a page a Worker opens appears in the window showing that Worker's
 *   Connected Folder, else the most recently focused window;
 * - a page with no window (the last one closed, or none was open yet) keeps
 *   running unseen and joins the next window that lists its tabs.
 *
 * When one of several windows closes, a page a Worker opened or is using
 * moves to another window as a background tab, so its work goes on; the
 * person's own pages close with their window, as a browser's tabs do. When
 * the last window closes every page keeps running unseen, as before.
 */

export type ClosingWindowPageFate = "keep-unseen" | "move" | "close";

export interface PageUse {
  openedBy: "person" | "agent";
  /** A Worker's step is running in the page, or ran a moment ago (the "Worker in …" marker shows). */
  workerUsing: boolean;
}

/** What happens to a page whose window closes, given how many file manager windows stay open. */
export function pageFateOnWindowClose(page: PageUse, otherWindowsOpen: number): ClosingWindowPageFate {
  if (otherWindowsOpen <= 0) return "keep-unseen";
  return page.openedBy === "agent" || page.workerUsing ? "move" : "close";
}
