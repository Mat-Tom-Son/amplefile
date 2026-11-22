import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  maxOneLevelTreeEntries,
  resolveListedSymbolicLink,
  scanConnectedFolderTree,
  type TreeEntry,
} from "../src/local/connected-folder.js";
import { setConnectedFolderIgnoreState } from "../src/local/connected-folder-ignore.js";
import { treeListingQuery } from "../src/local/api/tree-listing-query.js";
import { startLocalApi } from "../src/local/server.js";
import { addSidebarFolder, scanStandardFolder } from "../src/local/standard-folders.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";

/**
 * What a folder listing reports beyond its default: symbolic links, hidden
 * entries, and a higher bound for one level. Every addition is asked for; a
 * listing that asks for none is exactly what it always was.
 */

async function sandbox(t: test.TestContext, prefix: string): Promise<string> {
  // Resolved, so paths compare equal to what realpath reports (macOS /var → /private/var).
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function byName(entries: readonly TreeEntry[]): Map<string, TreeEntry> {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

function countEntries(entries: readonly TreeEntry[]): number {
  return entries.reduce((total, entry) => total + 1 + countEntries(entry.children ?? []), 0);
}

function withEnv(t: test.TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** A place with a file and folder link, a broken link, a loop, and a link out of the place. */
async function linkedPlace(t: test.TestContext): Promise<{ place: string; outside: string }> {
  const root = await sandbox(t, "amplefile-listing-links-");
  const place = join(root, "place");
  const outside = join(root, "outside");
  await mkdir(join(place, "Projects", "Deep"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(place, "notes.txt"), "twelve bytes");
  await writeFile(join(place, "Projects", "plan.md"), "# Plan\n");
  await writeFile(join(place, "Projects", "Deep", "inner.txt"), "inner");
  await writeFile(join(outside, "secret.txt"), "outside the place");
  await symlink("notes.txt", join(place, "notes-link.txt"));
  await symlink("Projects", join(place, "Projects link"));
  await symlink("does-not-exist.txt", join(place, "broken-link"));
  await symlink("loop-b", join(place, "loop-a"));
  await symlink("loop-a", join(place, "loop-b"));
  await symlink(join(outside, "secret.txt"), join(place, "outside-link.txt"));
  await symlink(outside, join(place, "Outside folder"));
  return { place, outside };
}

test("a listing leaves symbolic links out unless it asks for them", async (t) => {
  const { place } = await linkedPlace(t);
  const plain = await scanConnectedFolderTree(place, 0);
  assert.deepEqual(plain.entries.map((entry) => entry.name), ["Projects", "notes.txt"]);
  assert.equal(plain.entries.some((entry) => "link" in entry || "hidden" in entry), false);
});

test("a listing that asks for links shows each one, by what it points to, without following it", async (t) => {
  const { place, outside } = await linkedPlace(t);
  const scan = await scanConnectedFolderTree(place, 0, "", { includeLinks: true });
  assert.equal(scan.truncated, false);
  // Linked folders sort with folders, linked files with files.
  assert.deepEqual(scan.entries.map((entry) => entry.name), [
    "Outside folder", "Projects", "Projects link",
    "broken-link", "loop-a", "loop-b", "notes-link.txt", "notes.txt", "outside-link.txt",
  ]);
  const entries = byName(scan.entries);

  const fileLink = entries.get("notes-link.txt")!;
  assert.equal(fileLink.kind, "file");
  assert.equal(fileLink.sizeBytes, 12, "a link to a file shows its target's size");
  assert.equal(fileLink.updatedAt, entries.get("notes.txt")!.updatedAt, "and its target's date");
  assert.deepEqual(fileLink.link, { target: "file", targetPath: join(place, "notes.txt") });

  const folderLink = entries.get("Projects link")!;
  assert.equal(folderLink.kind, "folder");
  assert.equal(folderLink.sizeBytes, undefined);
  assert.deepEqual(folderLink.link, { target: "folder", targetPath: join(place, "Projects") });
  assert.equal(folderLink.hasChildren, false, "a linked folder is never opened in place");

  const broken = entries.get("broken-link")!;
  assert.equal(broken.kind, "file");
  assert.equal(broken.sizeBytes, undefined);
  assert.ok(broken.updatedAt, "a broken link is dated by the link itself");
  assert.deepEqual(broken.link, { target: "missing", targetPath: join(place, "does-not-exist.txt") });

  assert.deepEqual(entries.get("loop-a")!.link, { target: "missing", targetPath: join(place, "loop-b") });
  assert.deepEqual(entries.get("loop-b")!.link, { target: "missing", targetPath: join(place, "loop-a") });

  assert.deepEqual(entries.get("outside-link.txt")!.link, { target: "file", targetPath: join(outside, "secret.txt") });
  assert.equal(entries.get("outside-link.txt")!.sizeBytes, "outside the place".length);
  assert.deepEqual(entries.get("Outside folder")!.link, { target: "folder", targetPath: outside });

  // Ordinary entries are unchanged by asking for links.
  const plain = byName((await scanConnectedFolderTree(place, 0)).entries);
  assert.deepEqual(entries.get("notes.txt"), plain.get("notes.txt"));
  assert.deepEqual(entries.get("Projects"), plain.get("Projects"));
});

test("a recursive listing never descends into a linked folder, and no path reaches through a link", async (t) => {
  const { place } = await linkedPlace(t);
  const deep = await scanConnectedFolderTree(place, 20, "", { includeLinks: true });
  const entries = byName(deep.entries);
  assert.deepEqual(entries.get("Projects link")!.children, []);
  assert.deepEqual(entries.get("Outside folder")!.children, []);
  assert.equal(countEntries(deep.entries), 9 + 2 + 1, "nine top entries, Projects' two, and Deep's one: nothing through a link");
  const names = (entries: readonly TreeEntry[]): string[] => entries.flatMap((entry) => [entry.name, ...names(entry.children ?? [])]);
  assert.equal(names(deep.entries).includes("secret.txt"), false, "nothing outside the place is listed as an entry");
  assert.equal(names(deep.entries).filter((name) => name === "plan.md").length, 1, "Projects' contents appear once, not again through its link");

  await assert.rejects(scanConnectedFolderTree(place, 0, "Projects link", { includeLinks: true }), /symbolic links/);
  await assert.rejects(scanConnectedFolderTree(place, 0, "Outside folder", { includeLinks: true }), /symbolic links/);
});

test("a folder holding only a link has children only when links are listed", async (t) => {
  const root = await sandbox(t, "amplefile-listing-link-children-");
  await mkdir(join(root, "Only a link"));
  await writeFile(join(root, "target.txt"), "x");
  await symlink(join(root, "target.txt"), join(root, "Only a link", "alias.txt"));
  const folder = (options: { includeLinks?: boolean }) => scanConnectedFolderTree(root, 0, "", options).then((scan) => byName(scan.entries).get("Only a link")!);
  assert.equal((await folder({})).hasChildren, false);
  assert.equal((await folder({ includeLinks: true })).hasChildren, true);
});

test("a listed link keeps the place's ignore rules and its always-hidden names", async (t) => {
  const root = await sandbox(t, "amplefile-listing-link-rules-");
  const state = await sandbox(t, "amplefile-listing-link-rules-state-");
  withEnv(t, "AMPLEFILE_STATE_DIR", state);
  await writeFile(join(root, "target.txt"), "x");
  await symlink("target.txt", join(root, "kept-link.txt"));
  // Ignoring is refused on a link itself (its path policy), so the rule is
  // set while the name is an ordinary file, which a link then replaces.
  await writeFile(join(root, "ignored-link.txt"), "x");
  await setConnectedFolderIgnoreState(root, ["ignored-link.txt"], true);
  await rm(join(root, "ignored-link.txt"));
  await symlink("target.txt", join(root, "ignored-link.txt"));
  await symlink("target.txt", join(root, ".DS_Store"));
  await mkdir(join(root, "real"));
  await symlink("real", join(root, ".pi"));

  const all = await scanConnectedFolderTree(root, 0, "", { includeLinks: true });
  assert.deepEqual(all.entries.map((entry) => [entry.name, entry.ignored ?? false]), [
    ["real", false], ["ignored-link.txt", true], ["kept-link.txt", false], ["target.txt", false],
  ]);
  const visible = await scanConnectedFolderTree(root, 0, "", { includeLinks: true, includeIgnored: false });
  assert.deepEqual(visible.entries.map((entry) => entry.name), ["real", "kept-link.txt", "target.txt"]);
});

test("the desktop resolves a listed link's target only for the link itself", async (t) => {
  const { place, outside } = await linkedPlace(t);
  assert.deepEqual(await resolveListedSymbolicLink(place, "notes-link.txt"), {
    linkPath: join(place, "notes-link.txt"), targetPath: join(place, "notes.txt"), target: "file",
  });
  assert.deepEqual(await resolveListedSymbolicLink(place, "outside-link.txt"), {
    linkPath: join(place, "outside-link.txt"), targetPath: join(outside, "secret.txt"), target: "file",
  });
  assert.deepEqual(await resolveListedSymbolicLink(place, "Projects link"), {
    linkPath: join(place, "Projects link"), targetPath: join(place, "Projects"), target: "folder",
  });
  await assert.rejects(resolveListedSymbolicLink(place, "broken-link"), (error: Error & { statusCode?: number }) => error.statusCode === 404);
  await assert.rejects(resolveListedSymbolicLink(place, "loop-a"), (error: Error & { statusCode?: number }) => error.statusCode === 404);
  await assert.rejects(resolveListedSymbolicLink(place, "notes.txt"), /isn’t a symbolic link/);
  await assert.rejects(resolveListedSymbolicLink(place, "gone"), (error: Error & { statusCode?: number }) => error.statusCode === 404);
  // Only the last segment may be a link: the folder holding it obeys the path policy.
  await assert.rejects(resolveListedSymbolicLink(place, "Projects link/plan.md"), /symbolic links/);
  await assert.rejects(resolveListedSymbolicLink(place, "../outside/secret.txt"), /escapes/);
  await assert.rejects(resolveListedSymbolicLink(place, ".pi"), /reserved/);
  await assert.rejects(resolveListedSymbolicLink(place, ""), /Choose a link/);
});

test("a Connected Folder lists dotfiles today, and marks them hidden only when asked", async (t) => {
  const root = await sandbox(t, "amplefile-listing-hidden-connected-");
  for (const name of [".env", ".gitignore", "notes.txt", ".DS_Store", "Thumbs.db", "~$report.docx", ".~lock.sheet.ods#", "Icon\r"]) {
    await writeFile(join(root, name), "x");
  }
  for (const name of [".git", ".amplefile", ".pi", ".work-fold", "Library", "Documents"]) await mkdir(join(root, name));

  const plain = await scanConnectedFolderTree(root, 0);
  // Today's default: dotfiles and Icon\r are listed, unmarked; the built-in entries never are.
  assert.deepEqual(plain.entries.map((entry) => entry.name), [".git", "Documents", "Library", ".env", ".gitignore", "Icon\r", "notes.txt"]);
  assert.equal(plain.entries.some((entry) => "hidden" in entry), false);

  const linux = await scanConnectedFolderTree(root, 0, "", { markHidden: { platform: "linux", home: root } });
  assert.deepEqual(linux.entries.map((entry) => entry.name), plain.entries.map((entry) => entry.name), "marking adds no entries");
  assert.deepEqual(linux.entries.filter((entry) => entry.hidden).map((entry) => entry.name), [".git", ".env", ".gitignore", "Icon\r"]);
  assert.deepEqual(linux.entries.map(({ hidden: _hidden, ...entry }) => entry), plain.entries, "and changes nothing else");

  // On macOS the home folder's Library is hidden too, and only there.
  const macHome = await scanConnectedFolderTree(root, 0, "", { markHidden: { platform: "darwin", home: root } });
  assert.deepEqual(macHome.entries.filter((entry) => entry.hidden).map((entry) => entry.name), [".git", "Library", ".env", ".gitignore", "Icon\r"]);
  const macElsewhere = await scanConnectedFolderTree(root, 0, "", { markHidden: { platform: "darwin", home: join(root, "Documents") } });
  assert.equal(byName(macElsewhere.entries).get("Library")!.hidden, undefined);
});

test("a deeper Connected Folder listing marks hidden entries at every level", async (t) => {
  const root = await sandbox(t, "amplefile-listing-hidden-deep-");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", ".eslintrc"), "{}");
  await writeFile(join(root, "src", "index.ts"), "");
  const scan = await scanConnectedFolderTree(root, 3, "", { markHidden: { platform: "linux", home: "/nonexistent-home" } });
  const children = byName(byName(scan.entries).get("src")!.children!);
  assert.equal(children.get(".eslintrc")!.hidden, true);
  assert.equal(children.get("index.ts")!.hidden, undefined);
});

async function standardHome(t: test.TestContext): Promise<string> {
  const home = await sandbox(t, "amplefile-listing-hidden-standard-");
  await mkdir(join(home, "Downloads"));
  for (const name of [".bashrc", "notes.txt", ".DS_Store", "Thumbs.db", "~$report.docx", "Icon\r"]) await writeFile(join(home, name), "x");
  for (const name of [".config", ".amplefile", ".pi", "Library"]) await mkdir(join(home, name));
  await writeFile(join(home, "Downloads", ".partial"), "x");
  await writeFile(join(home, "Downloads", "receipt.pdf"), "x");
  await mkdir(join(home, "Downloads", "Library"));
  return home;
}

test("a Standard Folder hides what the system file manager hides, and lists it marked when asked", async (t) => {
  const home = await standardHome(t);
  const names = (tree: readonly TreeEntry[]) => tree.map((entry) => entry.name);

  // Default listings: as before, on both platforms.
  assert.deepEqual(names((await scanStandardFolder("home", "", home, "darwin")).tree), ["Downloads", "notes.txt"]);
  assert.deepEqual(names((await scanStandardFolder("home", "", home, "linux")).tree), ["Downloads", "Library", "notes.txt"]);
  assert.deepEqual(names((await scanStandardFolder("downloads", "", home, "darwin")).tree), ["Library", "receipt.pdf"], "only the home folder's Library is hidden");

  const mac = (await scanStandardFolder("home", "", home, "darwin", { includeHidden: true })).tree;
  assert.deepEqual(names(mac), [".config", "Downloads", "Library", ".bashrc", "Icon\r", "notes.txt"]);
  assert.deepEqual(names(mac.filter((entry) => entry.hidden)), [".config", "Library", ".bashrc", "Icon\r"]);

  const linux = (await scanStandardFolder("home", "", home, "linux", { includeHidden: true })).tree;
  assert.deepEqual(names(linux.filter((entry) => entry.hidden)), [".config", ".bashrc", "Icon\r"]);
  assert.equal(byName(linux).get("Library")!.hidden, undefined);

  const downloads = (await scanStandardFolder("downloads", "", home, "darwin", { includeHidden: true })).tree;
  assert.deepEqual(downloads.map((entry) => [entry.name, entry.hidden ?? false]), [["Library", false], [".partial", true], ["receipt.pdf", false]]);

  // Showing hidden entries only ever adds marked rows: the rest is the default listing, byte for byte.
  for (const platform of ["darwin", "linux"] as const) {
    const plain = await scanStandardFolder("home", "", home, platform);
    const shown = await scanStandardFolder("home", "", home, platform, { includeHidden: true });
    assert.deepEqual(JSON.stringify({ ...shown, tree: shown.tree.filter((entry) => !entry.hidden) }), JSON.stringify(plain), platform);
  }
});

test("a Standard Folder lists links when asked, under its hidden rules", async (t) => {
  const home = await standardHome(t);
  await symlink(join(home, "notes.txt"), join(home, "Downloads", "notes alias"));
  await symlink(join(home, "notes.txt"), join(home, "Downloads", ".dot-alias"));
  const plain = await scanStandardFolder("downloads", "", home, "linux");
  assert.equal(plain.tree.some((entry) => entry.link), false);
  const linked = await scanStandardFolder("downloads", "", home, "linux", { includeLinks: true });
  assert.deepEqual(linked.tree.map((entry) => entry.name), ["Library", "notes alias", "receipt.pdf"]);
  assert.deepEqual(byName(linked.tree).get("notes alias")!.link, { target: "file", targetPath: join(home, "notes.txt") });
  const everything = await scanStandardFolder("downloads", "", home, "linux", { includeLinks: true, includeHidden: true });
  assert.deepEqual(everything.tree.map((entry) => [entry.name, entry.hidden ?? false, entry.link?.target ?? null]), [
    ["Library", false, null], [".dot-alias", true, "file"], [".partial", true, null], ["notes alias", false, "file"], ["receipt.pdf", false, null],
  ]);
});

test("a one-level listing can ask for more than the usual bound, and says truthfully when it holds less", async (t) => {
  const root = await sandbox(t, "amplefile-listing-bound-");
  withEnv(t, "AMPLEFILE_TREE_MAX_ENTRIES", "50");
  await mkdir(join(root, "folder"));
  await Promise.all(Array.from({ length: 120 }, (_, index) => writeFile(join(root, `file-${String(index).padStart(3, "0")}.txt`), "x")));
  await Promise.all(Array.from({ length: 30 }, (_, index) => writeFile(join(root, "folder", `inner-${index}.txt`), "x")));

  const usual = await scanConnectedFolderTree(root, 0);
  assert.equal(usual.entries.length, 50);
  assert.equal(usual.truncated, true);

  const all = await scanConnectedFolderTree(root, 0, "", { maxEntries: 1_000 });
  assert.equal(all.entries.length, 121);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.entries.slice(0, 50), usual.entries, "the same order: a higher bound only adds the rest");

  const exact = await scanConnectedFolderTree(root, 0, "", { maxEntries: 121 });
  assert.equal(exact.truncated, false);
  const short = await scanConnectedFolderTree(root, 0, "", { maxEntries: 100 });
  assert.equal(short.entries.length, 100);
  assert.equal(short.truncated, true);

  // A recursive listing keeps the walk's bound; maxEntries is for one level.
  await assert.rejects(scanConnectedFolderTree(root, 2, "", { maxEntries: 1_000 }), /one-level/);
  await assert.rejects(scanConnectedFolderTree(root, 0, "", { maxEntries: 0 }), /whole number/);
  assert.equal((await scanConnectedFolderTree(root, 2)).truncated, true);

  const standard = await scanStandardFolder("home", "", root, "linux", { maxEntries: 1_000 });
  assert.equal(standard.tree.length, 121);
  assert.equal(standard.truncated, false);
});

test("the listing parameters are off unless asked for, and the bound is capped", () => {
  const query = (search: string, oneLevel = true) => treeListingQuery(new URLSearchParams(search), oneLevel);
  assert.deepEqual(query(""), {});
  assert.deepEqual(query("includeLinks=0&includeHidden=true"), {}, "only 1 turns a parameter on");
  assert.deepEqual(query("includeLinks=1&includeHidden=1&maxEntries=50000"), { includeLinks: true, includeHidden: true, maxEntries: 50_000 });
  assert.deepEqual(query("maxEntries=900000000"), { maxEntries: maxOneLevelTreeEntries });
  assert.throws(() => query("maxEntries=10", false), /one-level/);
  for (const bad of ["0", "-1", "1.5", "lots", ""]) assert.throws(() => query(`maxEntries=${bad}`), /whole number/, bad);
});

test("the /tree routes take the listing parameters, and answer as before without them", async (t) => {
  const root = await sandbox(t, "amplefile-listing-routes-");
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "content"), loadEnv: false });
  t.after(async () => { await api.close(); configureAmpleFileStateRoot(undefined); });
  const get = async (path: string) => {
    const response = await fetch(`${api.origin}${path}`);
    return { status: response.status, body: await response.json() as { tree: TreeEntry[]; truncated: boolean; error?: string } };
  };

  const folder = join(root, "Folder");
  await mkdir(folder);
  await writeFile(join(folder, "notes.txt"), "notes");
  await writeFile(join(folder, ".env"), "KEY=1");
  await symlink("notes.txt", join(folder, "notes link"));
  const registered = await fetch(`${api.origin}/api/connected-folders/local-folder`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectedFolderRoot: folder }),
  });
  assert.equal(registered.status, 201);
  const { connectedFolder } = await registered.json() as { connectedFolder: { id: string } };
  const base = `/api/connected-folders/${connectedFolder.id}/tree`;

  const plain = await get(`${base}?maxDepth=0`);
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.body.tree.map((entry) => entry.name), [".env", "notes.txt"]);
  assert.equal(JSON.stringify(plain.body).includes("hidden"), false);
  const asked = await get(`${base}?maxDepth=0&includeLinks=1&includeHidden=1&maxEntries=500`);
  assert.deepEqual(asked.body.tree.map((entry) => [entry.name, entry.hidden ?? false, entry.link?.target ?? null]), [
    [".env", true, null], ["notes link", false, "file"], ["notes.txt", false, null],
  ]);
  assert.equal((await get(`${base}?maxDepth=2&maxEntries=500`)).status, 400);
  assert.equal((await get(`${base}?maxDepth=0&maxEntries=many`)).status, 400);

  // Recents reads the Connected Folder's default listing: a link never appears there.
  const recents = await (await fetch(`${api.origin}/api/recents`)).json() as { recents: Array<{ path: string }> };
  assert.equal(recents.recents.some((entry) => entry.path === "notes link"), false);
  assert.equal(recents.recents.some((entry) => entry.path === "notes.txt"), true);

  const added = join(root, "Added");
  await mkdir(added);
  await writeFile(join(added, "plain.txt"), "x");
  await writeFile(join(added, ".hidden-file"), "x");
  await symlink("plain.txt", join(added, "plain link"));
  const sidebar = addSidebarFolder(added, root);
  const standard = `/api/standard-folders/${sidebar.id}/tree`;
  assert.deepEqual((await get(standard)).body, { tree: [{ name: "plain.txt", path: "plain.txt", kind: "file", sizeBytes: 1, updatedAt: (await get(standard)).body.tree[0]!.updatedAt }], truncated: false });
  assert.deepEqual((await get(`${standard}?includeHidden=1&includeLinks=1`)).body.tree.map((entry) => [entry.name, entry.hidden ?? false, entry.link?.target ?? null]), [
    [".hidden-file", true, null], ["plain link", false, "file"], ["plain.txt", false, null],
  ]);
  assert.equal((await get(`${standard}?maxEntries=0`)).status, 400);
});
