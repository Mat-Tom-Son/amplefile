import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { registerLinkedConnectedFolder } from "../src/local/connected-folder.js";
import { maxSearchedFileBytes, searchStandardFolder, type FolderSearchResult } from "../src/local/folder-search.js";
import { startLocalApi } from "../src/local/server.js";
import { addSidebarFolder } from "../src/local/standard-folders.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";

/**
 * Search in a Standard Folder or a folder in the computer place: names and
 * text beneath the folder shown, without an index, within budgets, and never
 * through a link or into AmpleFile's own data.
 */

async function sandbox(t: test.TestContext): Promise<{ home: string; state: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amplefile-folder-search-")));
  const state = join(root, "state");
  const previous = process.env.AMPLEFILE_STATE_DIR;
  process.env.AMPLEFILE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AMPLEFILE_STATE_DIR;
    else process.env.AMPLEFILE_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { home, state };
}

async function put(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const paths = (result: FolderSearchResult) => ({
  names: result.names.map((match) => match.path).sort(),
  files: result.files.map((match) => match.path).sort(),
});

test("a Standard Folder search finds names and text beneath the folder shown, in the Connected Folder search's shape", async (t) => {
  const { home } = await sandbox(t);
  await put(join(home, "Documents", "Taxes", "Ledger 2026.csv"), "date,amount\n");
  await put(join(home, "Documents", "Taxes", "notes.md"), "# Notes\n\nfirst line\nThe LEDGER is due Friday\nledger again\n");
  await put(join(home, "Documents", "plan.txt"), "nothing here");
  await put(join(home, "Desktop", "ledger.txt"), "outside the searched folder");

  const result = await searchStandardFolder("home", "ledger", { home, path: "Documents" });
  assert.deepEqual(paths(result), { names: ["Documents/Taxes/Ledger 2026.csv"], files: ["Documents/Taxes/notes.md"] });
  const file = result.files[0]!;
  assert.equal(file.line, 4, "the first matching line, counted from 1");
  assert.equal(file.preview, "The LEDGER is due Friday");
  assert.equal(file.sizeBytes, Buffer.byteLength("# Notes\n\nfirst line\nThe LEDGER is due Friday\nledger again\n"));
  assert.ok(file.updatedAt);
  assert.equal(result.names[0]!.kind, "file");
  assert.deepEqual(result.chats, []);
  assert.equal(result.truncated, false);
  assert.equal(result.nextCursor, null);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.stoppedBy, null);

  // A matching folder is a name match, and is searched too.
  await mkdir(join(home, "Documents", "Ledgers"));
  await put(join(home, "Documents", "Ledgers", "march.txt"), "the ledger for march");
  const again = await searchStandardFolder("home", "ledger", { home, path: "Documents" });
  assert.deepEqual(paths(again).names, ["Documents/Ledgers", "Documents/Taxes/Ledger 2026.csv"]);
  assert.equal(again.names.find((match) => match.path === "Documents/Ledgers")!.kind, "folder");
  assert.deepEqual(paths(again).files, ["Documents/Ledgers/march.txt", "Documents/Taxes/notes.md"]);
});

test("search never follows a symbolic link and never reads AmpleFile's or Pi's data", async (t) => {
  const { home, state } = await sandbox(t);
  const outside = join(dirname(home), "outside");
  await put(join(outside, "secret.txt"), "ledger outside the place");
  await put(join(home, "Work", "real.txt"), "ledger inside");
  await symlink(join(outside, "secret.txt"), join(home, "Work", "ledger-link.txt"));
  await symlink(outside, join(home, "Work", "Linked folder"));
  await put(join(home, "Work", ".amplefile", "connected-folder.json"), "{\"ledger\":1}");
  await put(join(home, "Work", ".pi", "settings.json"), "ledger");
  await put(join(home, "Work", "~$ledger.docx"), "lock");
  // AmpleFile's application data inside the searched folder is never read, hidden or not.
  configureAmpleFileStateRoot(join(home, "Work", "AmpleFile state"));
  t.after(() => configureAmpleFileStateRoot(undefined));
  await put(join(home, "Work", "AmpleFile state", "requests", "r.json"), "ledger");

  const result = await searchStandardFolder("home", "ledger", { home, path: "Work", includeHidden: true });
  assert.deepEqual(paths(result), { names: [], files: ["Work/real.txt"] });
  assert.equal(result.coverage.symbolicLink, 2);
  assert.ok(result.coverage.internal >= 4, `internal ${result.coverage.internal}`);
  assert.equal(state.length > 0, true);
  await assert.rejects(searchStandardFolder("home", "ledger", { home, path: "Work/Linked folder" }), /symbolic links/);
  await assert.rejects(searchStandardFolder("home", "ledger", { home, path: "Work/.pi" }), /reserved/);
  await assert.rejects(searchStandardFolder("home", "ledger", { home, path: "../outside" }), /escapes/);
});

test("binary and oversized files are matched by name only", async (t) => {
  const { home } = await sandbox(t);
  await put(join(home, "Files", "photo-ledger.jpg"), "ledger as text in a picture's bytes");
  await put(join(home, "Files", "dump.dat"), Buffer.concat([Buffer.from("ledger"), Buffer.alloc(64)]));
  await put(join(home, "Files", "latin1.txt"), Buffer.from([0x6c, 0x65, 0x64, 0x67, 0x65, 0x72, 0xff, 0xfe, 0x0a]));
  await put(join(home, "Files", "huge-ledger.log"), "");
  await truncate(join(home, "Files", "huge-ledger.log"), maxSearchedFileBytes + 1);
  await put(join(home, "Files", "small.txt"), "a ledger line");

  const result = await searchStandardFolder("home", "ledger", { home, path: "Files" });
  assert.deepEqual(paths(result), { names: ["Files/huge-ledger.log", "Files/photo-ledger.jpg"], files: ["Files/small.txt"] });
  assert.equal(result.coverage.oversized, 1);
  assert.equal(result.coverage.binary, 3, "a picture by its kind, NUL bytes, and text that is not UTF-8");
});

test("folders History skips are not searched, unless one is the folder searched", async (t) => {
  const { home } = await sandbox(t);
  await put(join(home, "Code", "app", "src", "main.ts"), "const ledger = 1;");
  await put(join(home, "Code", "app", "node_modules", "pkg", "index.js"), "ledger in a dependency");
  await put(join(home, "Code", "app", "__pycache__", "x.txt"), "ledger cache");
  await put(join(home, "Code", "app", "build-cache", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55");
  await put(join(home, "Code", "app", "build-cache", "y.txt"), "ledger cache");
  await put(join(home, "Code", "app", "venv", "pyvenv.cfg"), "home = /usr");
  await put(join(home, "Code", "app", "venv", "z.txt"), "ledger venv");
  await put(join(home, "Code", "app", ".git", "HEAD"), "ledger");

  const result = await searchStandardFolder("home", "ledger", { home, path: "Code", includeHidden: true });
  assert.deepEqual(paths(result).files, ["Code/app/src/main.ts"]);
  assert.equal(result.coverage.generated, 5);
  const inside = await searchStandardFolder("home", "ledger", { home, path: "Code/app/node_modules" });
  assert.deepEqual(paths(inside).files, ["Code/app/node_modules/pkg/index.js"]);
});

test("hidden entries are searched only when asked for, by the listing's rule", async (t) => {
  const { home } = await sandbox(t);
  await put(join(home, ".bashrc"), "export LEDGER=1");
  await put(join(home, ".config", "app", "settings.json"), "{\"ledger\": true}");
  await put(join(home, "Library", "Preferences", "app.plist"), "ledger");
  await put(join(home, "Notes", "ledger.md"), "ledger");

  const linux = await searchStandardFolder("home", "ledger", { home, platform: "linux" });
  assert.deepEqual(paths(linux), { names: ["Notes/ledger.md"], files: ["Library/Preferences/app.plist", "Notes/ledger.md"] });
  assert.equal(linux.coverage.hidden, 2);

  const mac = await searchStandardFolder("home", "ledger", { home, platform: "darwin" });
  assert.deepEqual(paths(mac).files, ["Notes/ledger.md"], "on macOS the home folder's Library is hidden");

  const shown = await searchStandardFolder("home", "ledger", { home, platform: "darwin", includeHidden: true });
  assert.deepEqual(paths(shown).files, [".bashrc", ".config/app/settings.json", "Library/Preferences/app.plist", "Notes/ledger.md"]);
  assert.equal(shown.files.find((match) => match.path === ".bashrc")!.hidden, true);
  assert.equal(shown.files.find((match) => match.path === "Library/Preferences/app.plist")!.hidden, undefined, "only the hidden entry itself is marked");

  // A hidden folder the person opened is searched as the folder shown.
  const opened = await searchStandardFolder("home", "ledger", { home, path: ".config" });
  assert.deepEqual(paths(opened).files, [".config/app/settings.json"]);
});

test("a bounded page says what stopped it, and its cursor continues without repeating a match", async (t) => {
  const { home } = await sandbox(t);
  for (let folder = 0; folder < 3; folder += 1) {
    for (let index = 0; index < 4; index += 1) await put(join(home, "Many", `f${folder}`, `n${index}.txt`), `line\nledger ${folder}-${index}\n`);
  }
  await put(join(home, "Many", "ledger-name.txt"), "no match inside");

  const whole = await searchStandardFolder("home", "ledger", { home, path: "Many" });
  assert.equal(whole.files.length, 12);
  assert.equal(whole.names.length, 1);

  for (const [budget, stop] of [[{ maxScannedFiles: 3 }, "files"], [{ maxMatches: 2 }, "matches"], [{ maxEntries: 4 }, "entries"], [{ maxScannedBytes: 20 }, "bytes"]] as const) {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await searchStandardFolder("home", "ledger", { home, path: "Many", cursor, ...budget });
      pages += 1;
      if (page.nextCursor) {
        assert.equal(page.truncated, true);
        assert.equal(page.coverage.stoppedBy, stop, JSON.stringify(budget));
        assert.equal(page.coverage.complete, false);
      } else {
        assert.equal(page.coverage.stoppedBy, null);
      }
      seen.push(...page.names.map((match) => `name:${match.path}`), ...page.files.map((match) => `file:${match.path}`));
      cursor = page.nextCursor ?? undefined;
      assert.ok(pages < 50, "the pages end");
    } while (cursor);
    assert.ok(pages > 1, `${JSON.stringify(budget)} took more than one page`);
    assert.deepEqual(seen.sort(), [...whole.names.map((match) => `name:${match.path}`), ...whole.files.map((match) => `file:${match.path}`)].sort(), JSON.stringify(budget));
  }

  const first = await searchStandardFolder("home", "ledger", { home, path: "Many", maxScannedFiles: 3 });
  await assert.rejects(searchStandardFolder("home", "other", { home, path: "Many", cursor: first.nextCursor! }), /different search/);
  await assert.rejects(searchStandardFolder("home", "ledger", { home, path: "Many", maxScannedFiles: 0 }), /between 1/);
  await assert.rejects(searchStandardFolder("home", "  ", { home }), /Enter something/);
});

test("a page stops at its time budget and still moves forward", async (t) => {
  const { home } = await sandbox(t);
  await Promise.all(Array.from({ length: 600 }, (_, index) => put(join(home, "Wide", `n${String(index).padStart(3, "0")}.txt`), `ledger ${index}\n`)));
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await searchStandardFolder("home", "ledger", { home, path: "Wide", maxMilliseconds: 1, cursor, maxMatches: 1_000 });
    pages += 1;
    if (page.nextCursor) assert.equal(page.coverage.stoppedBy, "time");
    for (const match of page.files) {
      assert.equal(seen.has(match.path), false, `no match twice: ${match.path}`);
      seen.add(match.path);
    }
    cursor = page.nextCursor ?? undefined;
    assert.ok(pages <= 600, "every page makes progress");
  } while (cursor);
  assert.equal(seen.size, 600);
});

test("a search stops when its request goes away", async (t) => {
  const { home } = await sandbox(t);
  await put(join(home, "a.txt"), "ledger");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchStandardFolder("home", "ledger", { home, signal: controller.signal }), { name: "AbortError" });
});

test("a Connected Folder inside the searched folder is left to its own search", async (t) => {
  const { home } = await sandbox(t);
  await put(join(home, "Documents", "loose.txt"), "ledger loose");
  await put(join(home, "Documents", "Client", "inside.txt"), "ledger inside the Connected Folder");
  const connectedFolder = await registerLinkedConnectedFolder(join(home, "Documents", "Client"));

  const result = await searchStandardFolder("home", "ledger", { home, path: "Documents" });
  assert.deepEqual(paths(result).files, ["Documents/loose.txt"]);
  assert.deepEqual(result.connectedFolders, [{ connectedFolderId: connectedFolder.id, path: "Documents/Client" }]);

  const within = await searchStandardFolder("home", "ledger", { home, path: "Documents/Client" });
  assert.deepEqual(paths(within), { names: [], files: [] });
  assert.deepEqual(within.connectedFolders, [{ connectedFolderId: connectedFolder.id, path: "Documents/Client" }]);
  assert.equal(within.coverage.complete, true);
});

test("the computer place searches a folder by its path from the disk's top", async (t) => {
  const { home } = await sandbox(t);
  await put(join(home, "Projects", "readme.md"), "the ledger");
  const placePath = join(home, "Projects").split("/").filter(Boolean).join("/");
  const result = await searchStandardFolder("computer", "ledger", { home, path: placePath });
  assert.deepEqual(paths(result).files, [`${placePath}/readme.md`]);
});

test("the Standard Folder search route takes the query, folder, budgets, and cursor", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amplefile-folder-search-api-")));
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "content"), loadEnv: false });
  t.after(async () => { await api.close(); configureAmpleFileStateRoot(undefined); await rm(root, { recursive: true, force: true }); });
  const folder = join(root, "Added");
  await put(join(folder, "Sub", "a.txt"), "ledger a");
  await put(join(folder, "Sub", "b.txt"), "ledger b");
  await put(join(folder, ".hidden.txt"), "ledger hidden");
  const added = addSidebarFolder(folder, root);
  const get = async (query: string) => {
    const response = await fetch(`${api.origin}/api/standard-folders/${added.id}/search?${query}`);
    return { status: response.status, body: await response.json() as FolderSearchResult & { error?: string } };
  };

  const plain = await get("q=ledger");
  assert.equal(plain.status, 200);
  assert.deepEqual(paths(plain.body).files, ["Sub/a.txt", "Sub/b.txt"]);
  assert.deepEqual(paths((await get("q=ledger&includeHidden=1")).body).files, [".hidden.txt", "Sub/a.txt", "Sub/b.txt"]);
  assert.deepEqual(paths((await get("q=ledger&path=Sub")).body).files, ["Sub/a.txt", "Sub/b.txt"]);

  const first = await get("q=ledger&limit=1");
  assert.equal(first.body.files.length, 1);
  assert.ok(first.body.nextCursor);
  const second = await get(`q=ledger&limit=1&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
  assert.notEqual(second.body.files[0]!.path, first.body.files[0]!.path);

  assert.equal((await get("q=ledger&maxFiles=lots")).status, 400);
  assert.equal((await get("q=ledger&maxMilliseconds=999999")).status, 400);
  assert.equal((await get("q=")).status, 400);
  assert.equal((await fetch(`${api.origin}/api/standard-folders/added-0000000000000000/search?q=x`)).status, 404);
});
