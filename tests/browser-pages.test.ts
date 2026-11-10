import assert from "node:assert/strict";
import test from "node:test";

import { isBrowserPageId, type BrowserPageState } from "../src/shared/browser.js";
import {
  browserAddressToOpen,
  browserErrorText,
  browserHost,
  browserLoadErrorText,
  browserTabTitle,
  browserTabsReducer,
  browserWorkerChat,
  clampBrowserFraction,
  effectiveBrowserLayout,
  emptyBrowserTabs,
  newBrowserPageId,
  savedFileName,
  type BrowserTabsAction,
  type BrowserTabsState,
} from "../web-local/src/lib/browser-pages.js";

function page(pageId: string, extra: Partial<BrowserPageState> = {}): BrowserPageState {
  return {
    pageId, url: `https://${pageId}.example.com/`, title: pageId, favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false,
    audible: false, sitePermissions: [], permissionRequest: null, notice: null, muted: false, zoomPercent: 100, blockedPopup: null, worker: null, leaveQuestion: null, ...extra,
  };
}

const run = (actions: BrowserTabsAction[], from: BrowserTabsState = emptyBrowserTabs) => actions.reduce(browserTabsReducer, from);
const ids = (state: BrowserTabsState) => state.tabs.map((tab) => tab.pageId);

test("the desktop host is the authority for the tab list", () => {
  // A page the host already has (the window reloaded, or a Worker opened it before the window existed) becomes a tab.
  let state = run([{ type: "page-state", state: page("aaaaaa") }]);
  assert.deepEqual(ids(state), ["aaaaaa"]);
  assert.equal(state.activeId, "aaaaaa", "the first tab is the one in front");

  // A Worker's tab opens behind the person's; a link the person followed comes to the front.
  state = run([{ type: "host-open", command: { pageId: "bbbbbb", url: "https://b.example.com/", title: "B", show: false } }], state);
  assert.deepEqual(ids(state), ["aaaaaa", "bbbbbb"]);
  assert.equal(state.activeId, "aaaaaa");
  state = run([{ type: "host-open", command: { pageId: "cccccc", url: "https://c.example.com/", title: "C", show: true } }], state);
  assert.equal(state.activeId, "cccccc");

  // The host announcing a tab the window already shows adds nothing.
  state = run([{ type: "host-open", command: { pageId: "bbbbbb", url: "https://b.example.com/", title: "B", show: false } }], state);
  assert.deepEqual(ids(state), ["aaaaaa", "bbbbbb", "cccccc"]);

  // A page the host closed (a Worker closed its own tab) leaves, and is not offered for reopening.
  state = run([{ type: "host-close", pageId: "cccccc" }], state);
  assert.deepEqual(ids(state), ["aaaaaa", "bbbbbb"]);
  assert.equal(state.activeId, "bbbbbb", "the tab beside it comes to the front");
  assert.equal(state.closed.length, 0);
});

test("a page's state updates its tab, and a page with no address yet keeps the tab's own", () => {
  let state = run([{ type: "new", pageId: "newtab", url: "https://typed.example.com/" }]);
  state = run([{ type: "page-state", state: page("newtab", { url: "", title: "" }) }], state);
  assert.equal(state.tabs[0]!.url, "https://typed.example.com/");
  state = run([{ type: "page-state", state: page("newtab", { url: "https://typed.example.com/home", title: "Home" }) }], state);
  assert.deepEqual(state.tabs[0], { pageId: "newtab", url: "https://typed.example.com/home", title: "Home" });
  assert.equal(state.pages.newtab!.title, "Home");
});

test("closing a tab shows its neighbour, remembers it for Reopen Closed Tab, and a late state does not bring it back", () => {
  let state = run([
    { type: "page-state", state: page("aaaaaa") },
    { type: "page-state", state: page("bbbbbb") },
    { type: "page-state", state: page("cccccc") },
    { type: "select", pageId: "bbbbbb" },
  ]);
  state = run([{ type: "close", pageId: "bbbbbb" }], state);
  assert.deepEqual(ids(state), ["aaaaaa", "cccccc"]);
  assert.equal(state.activeId, "cccccc", "the tab to its right");
  assert.equal(state.pages.bbbbbb, undefined);
  assert.deepEqual(state.closed, [{ url: "https://bbbbbb.example.com/", title: "bbbbbb" }]);

  // The host sent this before it heard the tab was closed.
  state = run([{ type: "page-state", state: page("bbbbbb") }], state);
  assert.deepEqual(ids(state), ["aaaaaa", "cccccc"]);

  state = run([{ type: "close", pageId: "cccccc" }], state);
  assert.equal(state.activeId, "aaaaaa", "the last tab when there is none to the right");

  state = run([{ type: "reopen", pageId: "dddddd" }], state);
  assert.deepEqual(state.tabs.at(-1), { pageId: "dddddd", url: "https://cccccc.example.com/", title: "cccccc" });
  assert.equal(state.activeId, "dddddd");
  assert.equal(state.closed.length, 1);

  // A blank tab has nothing to reopen.
  state = run([{ type: "new", pageId: "blank1" }, { type: "close", pageId: "blank1" }], state);
  assert.equal(state.closed.length, 1);
  assert.equal(run([{ type: "close", pageId: "aaaaaa" }, { type: "close", pageId: "dddddd" }], state).activeId, null);
});

test("a new tab's id is one the desktop host accepts", () => {
  for (let index = 0; index < 50; index += 1) assert.ok(isBrowserPageId(newBrowserPageId()));
  assert.ok(isBrowserPageId(newBrowserPageId(() => 0.999999)));
  assert.notEqual(newBrowserPageId(), newBrowserPageId());
});

test("a tab is named by its page's title, then its site, then New Tab", () => {
  assert.equal(browserTabTitle({ pageId: "a", url: "", title: "" }, undefined), "New Tab");
  assert.equal(browserTabTitle({ pageId: "a", url: "https://example.com/path", title: "" }, undefined), "example.com");
  assert.equal(browserTabTitle({ pageId: "a", url: "https://example.com/", title: "Saved" }, page("a", { title: "Live" })), "Live");
  assert.equal(browserTabTitle({ pageId: "a", url: "", title: "" }, page("a", { url: "about:blank", title: "" })), "New Tab");
  assert.equal(browserHost("http://localhost:3000/x"), "localhost:3000");
  assert.equal(browserHost("file:///Users/me/My%20Site/index.html"), "index.html");
  assert.equal(browserHost("not an address"), "not an address");
});

test("the Chat a Worker uses a page from is read from the host's owner", () => {
  assert.deepEqual(browserWorkerChat("space-0123456789abcdef/chat-1"), { connectedFolderId: "space-0123456789abcdef", conversationId: "chat-1" });
  assert.equal(browserWorkerChat("no-slash"), null);
  assert.equal(browserWorkerChat("/chat"), null);
  assert.equal(browserWorkerChat("folder/"), null);
});

test("the pane is not drawn without a tab, and its share of the area stays between the limits", () => {
  assert.equal(effectiveBrowserLayout("split", 0), "hidden");
  assert.equal(effectiveBrowserLayout("full", 0), "hidden");
  assert.equal(effectiveBrowserLayout("hidden", 2), "collapsed");
  assert.equal(effectiveBrowserLayout("full", 1), "full");
  assert.equal(clampBrowserFraction(0.4), 0.4);
  assert.equal(clampBrowserFraction(0.55 + 0.03), 0.58, "steps from the keyboard stay round");
  assert.equal(clampBrowserFraction(0), 0.15);
  assert.equal(clampBrowserFraction(3), 0.85);
  assert.equal(clampBrowserFraction("wide"), 0.55);
  assert.equal(clampBrowserFraction(Number.NaN), 0.55);
});

test("what the address field opens: web addresses and files as they are, a search for anything else", () => {
  assert.deepEqual(browserAddressToOpen(" example.com "), { url: "https://example.com", search: false });
  assert.deepEqual(browserAddressToOpen("localhost:3000"), { url: "http://localhost:3000", search: false });
  assert.deepEqual(browserAddressToOpen("/Users/me/My Site/index.html"), { url: "file:///Users/me/My%20Site/index.html", search: false });
  assert.deepEqual(browserAddressToOpen("https://example.com/a?b=c"), { url: "https://example.com/a?b=c", search: false });
  assert.deepEqual(browserAddressToOpen("how tall is a giraffe"), { url: "https://www.google.com/search?q=how%20tall%20is%20a%20giraffe", search: true });
  // Addresses only another program could open are searched for, so Return always leads somewhere and no tab is left blank.
  for (const typed of ["chrome://settings", "data:text/html,<h1>hi</h1>", "view-source:https://example.com", "about:config", "ftp://example.com/file", "mailto:someone@example.com"]) {
    assert.deepEqual(browserAddressToOpen(typed), { url: `https://www.google.com/search?q=${encodeURIComponent(typed)}`, search: true }, typed);
  }
  assert.deepEqual(browserAddressToOpen("javascript:alert(1)"), { url: "https://www.google.com/search?q=javascript%3Aalert(1)", search: true });
  assert.equal(browserAddressToOpen("   "), null);
});

test("a failed browser call is said in the desktop's own words", () => {
  assert.equal(browserErrorText(new Error("Error invoking remote method 'amplefile:browser:navigate': Error: Type an address or something to search for."), "fallback"), "Type an address or something to search for.");
  assert.equal(browserErrorText(new Error("Error invoking remote method 'amplefile:browser:command': The text to find is invalid."), "fallback"), "The text to find is invalid.");
  assert.equal(browserErrorText(new Error("The page stopped."), "fallback"), "The page stopped.");
  assert.equal(browserErrorText(new Error(""), "The page could not open."), "The page could not open.");
  assert.equal(browserErrorText(undefined, "The page could not open."), "The page could not open.");
});

test("why a page did not load is said in plain words, whatever Chromium calls it", () => {
  const say = (code: number, description = "") => browserLoadErrorText({ code, description });
  assert.equal(say(-105, "ERR_NAME_NOT_RESOLVED"), "This site’s address couldn’t be found.");
  assert.equal(say(-106, "ERR_INTERNET_DISCONNECTED"), "This Mac isn’t connected to the internet.");
  assert.equal(say(-102, "ERR_CONNECTION_REFUSED"), "The site refused the connection.");
  assert.equal(say(-118, "ERR_CONNECTION_TIMED_OUT"), "The site took too long to respond.");
  assert.equal(say(-312, "ERR_UNSAFE_PORT"), "This address uses a port that browsers block.");
  assert.equal(say(-202, "ERR_CERT_AUTHORITY_INVALID"), "This site’s security certificate isn’t trusted, so the page was not loaded.");
  assert.equal(say(-6, "ERR_FILE_NOT_FOUND"), "There’s no file at that path.");
  assert.equal(say(-999, "ERR_SOMETHING_NEW"), "The page couldn’t be loaded.");
  for (const code of [-105, -106, -102, -118, -312, -202, -6, -999]) assert.doesNotMatch(say(code), /ERR_|net::/);
});

test("a download is named as it was saved", () => {
  assert.equal(savedFileName("/Users/me/Downloads/same (1).bin", "same.bin"), "same (1).bin");
  assert.equal(savedFileName("C:\\Users\\me\\Downloads\\report (2).txt", "report.txt"), "report (2).txt");
  assert.equal(savedFileName("", "same.bin"), "same.bin");
});
