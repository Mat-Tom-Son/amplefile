import assert from "node:assert/strict";
import test from "node:test";

import {
  activeFolderTab,
  closeFolderTab,
  closeOtherFolderTabs,
  folderTabLimit,
  folderTabStepKey,
  folderTabTitles,
  isNewTabKey,
  moveFolderTab,
  newFolderTab,
  openFolderTab,
  relocateFolderTabs,
  restoreFolderTabs,
  restoredHistoryLimit,
  selectFolderTab,
  singleFolderTab,
  stepFolderTab,
  storedFolderTabs,
  updateFolderTab,
  withTabHistory,
  type FolderTabs,
} from "../web-local/src/components/file-manager/file-manager-tabs.js";
import { folderViewKey, folderViewLimit, readFolderViews, rememberFolderView } from "../web-local/src/components/file-manager/file-manager-folder-views.js";
import { pushLocation, stepBack } from "../web-local/src/components/file-manager/file-manager-navigation.js";
import type { FileManagerLocation, FileManagerPlace } from "../web-local/src/components/file-manager/file-manager-places.js";

const lab: FileManagerPlace = { kind: "connected-folder", id: "lab" };
const home: FileManagerPlace = { kind: "standard", id: "home" };
const at = (place: FileManagerPlace, path = ""): FileManagerLocation => ({ place, path });
const ids = (state: FolderTabs) => state.tabs.map((tab) => tab.id);

/** Three tabs: 1 at Lab, 2 at Home/Documents, 3 at Lab/Notes, with 2 in front. */
function threeTabs(): FolderTabs {
  let state = singleFolderTab("1", at(lab));
  state = openFolderTab(state, newFolderTab("2", at(home, "Documents")));
  state = openFolderTab(state, newFolderTab("3", at(lab, "Notes")), { after: "2", activate: false });
  return state;
}

test("a new tab opens right after the tab in front and comes to the front; one opened behind leaves the front where it was", () => {
  let state = singleFolderTab("1", at(lab));
  state = openFolderTab(state, newFolderTab("2", at(home)));
  assert.deepEqual(ids(state), ["1", "2"]);
  assert.equal(state.activeId, "2");
  state = selectFolderTab(state, "1");
  state = openFolderTab(state, newFolderTab("3", at(lab, "Notes")), { activate: false });
  assert.deepEqual(ids(state), ["1", "3", "2"], "right after the tab in front, as Finder and GNOME Files put it");
  assert.equal(state.activeId, "1");
  assert.equal(activeFolderTab(state).history.location.place, lab);

  let full = singleFolderTab("0", at(lab));
  for (let index = 1; index < folderTabLimit + 3; index += 1) full = openFolderTab(full, newFolderTab(String(index), at(lab)));
  assert.equal(full.tabs.length, folderTabLimit, "a window holds a bounded number of tabs");
});

test("closing the tab in front brings the next one forward, or the one before at the end; the last tab is not closed here", () => {
  const state = threeTabs();
  assert.deepEqual(ids(state), ["1", "2", "3"]);
  const closedMiddle = closeFolderTab(state, "2")!;
  assert.deepEqual(ids(closedMiddle), ["1", "3"]);
  assert.equal(closedMiddle.activeId, "3", "the tab after it comes forward");
  const closedLast = closeFolderTab(selectFolderTab(state, "3"), "3")!;
  assert.equal(closedLast.activeId, "2", "at the end, the one before");
  const closedBehind = closeFolderTab(state, "1")!;
  assert.equal(closedBehind.activeId, "2", "closing a tab behind leaves the front alone");
  assert.equal(closeFolderTab(singleFolderTab("1", at(lab)), "1"), null, "the window's only tab closes the window instead");
  assert.equal(closeFolderTab(state, "missing"), state);
  assert.deepEqual(ids(closeOtherFolderTabs(state, "3")), ["3"]);
  assert.equal(closeOtherFolderTabs(state, "3").activeId, "3");
});

test("tabs reorder by dragging and the tab keys wrap round", () => {
  const state = threeTabs();
  assert.deepEqual(ids(moveFolderTab(state, "1", 2)), ["2", "3", "1"]);
  assert.deepEqual(ids(moveFolderTab(state, "3", 0)), ["3", "1", "2"]);
  assert.deepEqual(ids(moveFolderTab(state, "2", 9)), ["1", "3", "2"], "past the end lands at the end");
  assert.equal(moveFolderTab(state, "2", 1), state, "a drop where it already is changes nothing");
  assert.equal(moveFolderTab(state, "2", 0).activeId, "2", "the tab in front stays in front");

  assert.equal(stepFolderTab(state, 1).activeId, "3");
  assert.equal(stepFolderTab(selectFolderTab(state, "3"), 1).activeId, "1", "next from the last wraps to the first");
  assert.equal(stepFolderTab(selectFolderTab(state, "1"), -1).activeId, "3", "previous from the first wraps to the last");
  const one = singleFolderTab("1", at(lab));
  assert.equal(stepFolderTab(one, 1), one);
});

test("each tab keeps its own Back and Forward, selection, and search; going elsewhere starts the tab fresh there", () => {
  let state = threeTabs();
  // Tab 2 goes into Documents/Plans and selects something there; tab 1 is untouched.
  state = updateFolderTab(state, "2", (tab) => withTabHistory(tab, pushLocation(tab.history, at(home, "Documents/Plans"))));
  state = updateFolderTab(state, "2", (tab) => ({ ...tab, selection: ["Documents/Plans/a.md"], query: "a", scrollTop: 120 }));
  const two = state.tabs.find((tab) => tab.id === "2")!;
  assert.deepEqual(two.history.back, [at(home, "Documents")]);
  assert.deepEqual(two.selection, ["Documents/Plans/a.md"]);
  const one = state.tabs.find((tab) => tab.id === "1")!;
  assert.deepEqual(one.history.back, [], "another tab's history is its own");
  assert.deepEqual(one.selection, []);

  // Back in tab 2: a different folder, so its selection, search, and scroll start fresh.
  const back = withTabHistory(two, stepBack(two.history)!);
  assert.deepEqual(back.history.location, at(home, "Documents"));
  assert.deepEqual(back.selection, []);
  assert.equal(back.query, "");
  assert.equal(back.scrollTop, 0);
  // Back and Forward changing without the folder changing keeps them.
  const same = withTabHistory(two, { ...two.history, forward: [at(lab)] });
  assert.deepEqual(same.selection, two.selection);
  assert.equal(withTabHistory(two, two.history), two);
});

test("a place that goes away moves every tab showing it", () => {
  const state = threeTabs();
  const moved = relocateFolderTabs(state, (where) => where.place.kind === "connected-folder" && where.place.id === "lab", at(home));
  assert.deepEqual(moved.tabs.map((tab) => tab.history.location), [at(home), at(home, "Documents"), at(home)]);
  assert.deepEqual(moved.tabs[2]!.history.back, [], "no way Back into the place that has gone");
  assert.equal(relocateFolderTabs(state, () => false, at(home)), state);
});

test("tabs are kept and restored with where they were and which was in front; anything malformed is dropped", () => {
  let state = threeTabs();
  state = updateFolderTab(state, "3", (tab) => ({ ...withTabHistory(tab, pushLocation(tab.history, at(lab, "Notes/2025"))), view: "trash", selection: ["x"], query: "q" }));
  const kept = JSON.parse(JSON.stringify(storedFolderTabs(state, true)));
  assert.equal(kept.active, 1);
  assert.equal(kept.showTabBar, true);
  assert.equal(kept.tabs[2].view, "trash");
  assert.equal("selection" in kept.tabs[2], false, "selection and search are not kept");

  let next = 10;
  const restored = restoreFolderTabs(kept, () => String(next++))!;
  assert.deepEqual(restored.state.tabs.map((tab) => tab.history.location), [at(lab), at(home, "Documents"), at(lab, "Notes/2025")]);
  assert.equal(restored.state.activeId, "11", "the same tab is in front, under a fresh id");
  assert.deepEqual(restored.state.tabs[2]!.history.back, [at(lab, "Notes")]);
  assert.equal(restored.state.tabs[2]!.view, "trash");
  assert.deepEqual(restored.state.tabs[2]!.selection, []);
  assert.equal(restored.showTabBar, true);

  // A broken entry before the one in front does not move the front onto another tab.
  const damaged = { tabs: [{ location: { place: { kind: "nowhere", id: "x" }, path: "" } }, kept.tabs[0], { location: { place: lab, path: "../escape" } }, kept.tabs[1]], active: 3, showTabBar: false };
  const repaired = restoreFolderTabs(damaged, () => String(next++))!;
  assert.deepEqual(repaired.state.tabs.map((tab) => tab.history.location), [at(lab), at(home, "Documents")]);
  assert.deepEqual(activeFolderTab(repaired.state).history.location, at(home, "Documents"));
  assert.equal(restoreFolderTabs({ tabs: [] }, () => "x"), null);
  assert.equal(restoreFolderTabs("nonsense", () => "x"), null);
  assert.equal(restoreFolderTabs({ tabs: [{ location: { place: home, path: "/etc" } }] }, () => "x"), null, "an absolute path is not a place's folder");

  // Back and Forward kept are bounded.
  let long = singleFolderTab("1", at(lab));
  for (let index = 0; index < restoredHistoryLimit + 10; index += 1) long = updateFolderTab(long, "1", (tab) => withTabHistory(tab, pushLocation(tab.history, at(lab, `f${index}`))));
  assert.equal(storedFolderTabs(long, false).tabs[0]!.back!.length, restoredHistoryLimit);
});

test("a tab's title is its folder's name, with as much of the path as tells two same-named folders apart", () => {
  const titles = folderTabTitles([
    { name: "Notes", above: ["Lab", "you", "Users"], key: "a" },
    { name: "Notes", above: ["Work", "you", "Users"], key: "b" },
    { name: "Notes", above: ["Lab", "you", "Users"], key: "a" },
    { name: "Plans", above: ["2025", "Lab"], key: "c" },
    { name: "Plans", above: ["2025", "Work"], key: "d" },
    { name: "Trash", above: [], key: "trash" },
  ]);
  assert.deepEqual(titles, ["Notes — Lab", "Notes — Work", "Notes — Lab", "Plans — Lab/2025", "Plans — Work/2025", "Trash"]);
  assert.deepEqual(folderTabTitles([{ name: "Documents", above: ["you"], key: "a" }, { name: "Lab", above: [], key: "b" }]), ["Documents", "Lab"]);
});

test("the tab keys follow each platform", () => {
  const key = (init: Partial<{ key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ key: "", code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init });
  for (const mac of [true, false]) {
    assert.equal(folderTabStepKey(key({ key: "Tab", code: "Tab", ctrlKey: true }), mac), 1, "Ctrl+Tab everywhere");
    assert.equal(folderTabStepKey(key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }), mac), -1);
    assert.equal(folderTabStepKey(key({ key: "Tab", code: "Tab" }), mac), null, "Tab alone moves focus");
  }
  assert.equal(folderTabStepKey(key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }), true), 1);
  assert.equal(folderTabStepKey(key({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }), true), -1);
  assert.equal(folderTabStepKey(key({ key: "]", code: "BracketRight", metaKey: true }), true), null, "⌘] is Forward, not a tab key");
  assert.equal(folderTabStepKey(key({ key: "PageDown", code: "PageDown", ctrlKey: true }), false), 1);
  assert.equal(folderTabStepKey(key({ key: "PageUp", code: "PageUp", ctrlKey: true }), false), -1);
  assert.equal(folderTabStepKey(key({ key: "PageDown", code: "PageDown", ctrlKey: true }), true), null);
  assert.equal(isNewTabKey(key({ key: "t", code: "KeyT", metaKey: true }), true), true);
  assert.equal(isNewTabKey(key({ key: "t", code: "KeyT", ctrlKey: true }), false), true);
  assert.equal(isNewTabKey(key({ key: "t", code: "KeyT", ctrlKey: true }), true), false);
  assert.equal(isNewTabKey(key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), false), false, "Shift+Ctrl+T is the browser's reopen key");
});

test("a folder's view is remembered by its real location, a Connected Folder's by its portable id, and old entries go first", () => {
  assert.equal(folderViewKey(at(lab, "Notes"), "/Users/you/Lab/Notes"), "connected-folder:lab\0Notes", "a moved Connected Folder keeps its views");
  assert.equal(folderViewKey(at(home, "Documents"), "/Users/you/Documents/"), "path:/Users/you/Documents");
  assert.equal(folderViewKey(at({ kind: "standard", id: "documents" }), "/Users/you/Documents"), "path:/Users/you/Documents", "the same folder reached from another place is the same folder");
  assert.equal(folderViewKey(at({ kind: "standard", id: "computer" }), "/"), "path:/");
  assert.equal(folderViewKey(at(home), null), null);

  let views = rememberFolderView({}, "path:/a", { view: "icons", sort: { key: "size", ascending: false } }, 1);
  views = rememberFolderView(views, "path:/b", { view: "list", sort: { key: "name", ascending: true } }, 2);
  views = rememberFolderView(views, "path:/a", { view: "list", sort: { key: "size", ascending: false } }, 3);
  views = rememberFolderView(views, "path:/c", { view: "icons", sort: { key: "kind", ascending: true } }, 4, 2);
  assert.deepEqual(Object.keys(views).sort(), ["path:/a", "path:/c"], "the least recently chosen goes past the bound");
  assert.equal(views["path:/a"]!.view, "list");

  const read = readFolderViews({ "path:/a": { view: "icons", sort: { key: "bogus" }, at: 5 }, "path:/b": "nonsense", "path:/c": { view: "nope" } });
  assert.deepEqual(read["path:/a"], { view: "icons", sort: { key: "name", ascending: true }, at: 5 }, "an unknown sort falls back to Name");
  assert.equal(read["path:/b"], undefined);
  assert.equal(read["path:/c"]!.view, "list");
  assert.deepEqual(readFolderViews(["path:/a"]), {});
  const many = Object.fromEntries(Array.from({ length: folderViewLimit + 50 }, (_, index) => [`path:/${index}`, { view: "icons", sort: { key: "name", ascending: true }, at: index }]));
  const bounded = readFolderViews(many);
  assert.equal(Object.keys(bounded).length, folderViewLimit, "what is read back is bounded too");
  assert.equal(bounded["path:/0"], undefined);
  assert.ok(bounded[`path:/${folderViewLimit + 49}`]);
});
