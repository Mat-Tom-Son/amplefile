import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendMessage } from "../src/local/agent/chat-store.js";
import { searchConnectedFolder } from "../src/local/search.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";
import { setConnectedFolderIgnoreState } from "../src/local/connected-folder-ignore.js";

async function connectedFolder(name: string): Promise<{ root: string; dispose: () => Promise<void> }> {
  const sandbox = await mkdtemp(join(tmpdir(), `connected-folder-search-${name}-`));
  const root = join(sandbox, "connected-folder");
  configureAmpleFileStateRoot(join(sandbox, "state"));
  await mkdir(root, { recursive: true });
  return {
    root,
    dispose: async () => {
      configureAmpleFileStateRoot(undefined);
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

test("search finds file contents and Chat messages with locating detail", async (t) => {
  const { root, dispose } = await connectedFolder("basic");
  t.after(dispose);
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "plan.md"), "intro\nthe Quarterly budget is due\ntail", "utf8");
  await writeFile(join(root, "other.txt"), "nothing relevant here", "utf8");
  await appendMessage(root, "chat-1", {
    id: "m1",
    role: "user",
    content: "can you check the quarterly budget spreadsheet",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  await appendMessage(root, "chat-1", {
    id: "m2",
    role: "assistant",
    content: `${"context\n".repeat(40)}the quarterly budget is ready`,
    createdAt: "2026-07-01T00:01:00.000Z",
  });

  const result = await searchConnectedFolder(root, "quarterly budget");
  assert.deepEqual(result.files, [{
    path: "notes/plan.md",
    line: 2,
    preview: "the Quarterly budget is due",
  }], "a file match carries the path and line needed to open it");
  assert.equal(result.files.length, 1, "unrelated files do not match");
  assert.equal(result.chats.length, 2);
  assert.equal(result.chats[0]?.conversationId, "chat-1");
  assert.equal(result.chats[0]?.role, "user");
  assert.match(result.chats[0]?.preview ?? "", /quarterly budget spreadsheet/);
  assert.match(result.chats[1]?.preview ?? "", /quarterly budget is ready/, "preview indices are computed after whitespace normalization");
  assert.equal(result.truncated, false);
});

test("search honours ignore rules and identifies binary files without skipping large text", async (t) => {
  const { root, dispose } = await connectedFolder("bounds");
  t.after(dispose);
  await mkdir(join(root, "vendor"), { recursive: true });
  await writeFile(join(root, "vendor", "bundled.js"), "needle in ignored dependency", "utf8");
  await writeFile(join(root, "kept.txt"), "needle in ordinary content", "utf8");
  await writeFile(join(root, "image.bin"), Buffer.concat([Buffer.from("needle"), Buffer.alloc(64)]));
  await writeFile(join(root, "huge.txt"), `${"padding\n".repeat(200)}needle\n`, "utf8");

  await setConnectedFolderIgnoreState(root, ["vendor"], true);
  const result = await searchConnectedFolder(root, "needle");

  assert.deepEqual(result.files.map((match) => match.path), ["huge.txt", "kept.txt"]);
  assert.equal(result.coverage.binary, 1);
  assert.equal(result.coverage.ignored, 1);
  assert.equal(result.truncated, false, "skipping content by policy is not truncation");
});

test("search stops at its bounds and reports that it did", async (t) => {
  const { root, dispose } = await connectedFolder("truncate");
  t.after(dispose);
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(root, `file-${index}.txt`), "needle\nneedle\n", "utf8");
  }

  const capped = await searchConnectedFolder(root, "needle", { maxMatches: 5 });
  assert.equal(capped.files.length, 5);
  assert.equal(capped.truncated, true, "hitting the match cap is disclosed");

  const scanned = await searchConnectedFolder(root, "needle", { maxScannedFiles: 2, maxMatches: 1_000 });
  assert.ok(scanned.scannedFiles <= 2);
  assert.equal(scanned.truncated, true, "hitting the scan cap is disclosed");
});

test("search rejects an empty or oversized query", async (t) => {
  const { root, dispose } = await connectedFolder("invalid");
  t.after(dispose);
  await assert.rejects(() => searchConnectedFolder(root, "   "), /Enter something to search for/);
  await assert.rejects(() => searchConnectedFolder(root, "x".repeat(64 * 1024 + 1)), /Search text is too long/);
});

test("search stops immediately when its caller is cancelled", async (t) => {
  const { root, dispose } = await connectedFolder("cancelled");
  t.after(dispose);
  await writeFile(join(root, "note.txt"), "needle", "utf8");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => searchConnectedFolder(root, "needle", { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("search pages through byte, match and traversal budgets with a match beyond 1 MiB in one line", async (t) => {
  const { root, dispose } = await connectedFolder("continuation"); t.after(dispose);
  await writeFile(join(root, "large.txt"), `${"x".repeat(1024 * 1024 + 7)}NEEDLE😀\nneedle\nneedle\n`);
  await writeFile(join(root, "last.txt"), "needle\n");
  const matches = []; let cursor: string | undefined; let pages = 0;
  do {
    const page = await searchConnectedFolder(root, "needle", { includeChats: false, maxMatches: 1, maxScannedFiles: 2, maxScannedBytes: 32768, cursor });
    assert.ok(page.coverage.scannedBytes <= 32771, "at most a UTF-8 character crosses the byte budget");
    matches.push(...page.files); cursor = page.nextCursor ?? undefined; pages++;
    assert.ok(pages < 100);
  } while (cursor);
  assert.deepEqual(matches.map(({path,line}) => [path,line]), [["large.txt",1],["large.txt",2],["large.txt",3],["last.txt",1]]);
  assert.ok(pages > 32);
});

test("search narrows a subtree, goes on past a file changed partway, and rejects a cursor from another selection", async (t) => {
  const { root, dispose } = await connectedFolder("source"); t.after(dispose);
  await mkdir(join(root,"selected"));
  await writeFile(join(root,"selected","one.txt"), "needle\nneedle\n");
  await writeFile(join(root,"selected","two.txt"), "needle\n");
  await writeFile(join(root,"elsewhere.txt"), "needle");
  const page = await searchConnectedFolder(root,"needle", {path:"selected",includeChats:false,maxMatches:1});
  assert.equal(page.files[0]?.path,"selected/one.txt"); assert.ok(page.nextCursor);
  await assert.rejects(searchConnectedFolder(root,"other", {path:"selected",includeChats:false,cursor:page.nextCursor!}),/selection/);
  // The file being scanned changes between pages: the rest of it is skipped and counted, and the search goes on.
  await writeFile(join(root,"selected","one.txt"), "changed\nneedle\n");
  const next = await searchConnectedFolder(root,"needle", {path:"selected",includeChats:false,cursor:page.nextCursor!});
  assert.deepEqual(next.files.map(({path,line}) => [path,line]), [["selected/two.txt",1]]);
  assert.equal(next.coverage.changed, 1);
  assert.equal(next.coverage.textComplete, false);
  assert.equal(next.truncated, true, "a change seen partway leaves coverage incomplete");
  assert.equal(next.nextCursor, null);
});

test("a folder that gains items between pages goes on and finds what comes after", async (t) => {
  const { root, dispose } = await connectedFolder("live"); t.after(dispose);
  await mkdir(join(root,"docs"));
  await writeFile(join(root,"docs","a.txt"), "needle\nneedle\n");
  await writeFile(join(root,"docs","m.txt"), "needle\n");
  await writeFile(join(root,"z.txt"), "needle\n");
  const first = await searchConnectedFolder(root,"needle", {includeChats:false,maxMatches:1});
  assert.deepEqual(first.files.map(({path,line}) => [path,line]), [["docs/a.txt",1]]);
  // A Worker writes into the folder being searched: the search resumes by name, not by the folder's timestamps.
  await writeFile(join(root,"docs","n-new.txt"), "needle\n");
  await writeFile(join(root,"docs","0-earlier.txt"), "needle\n");
  const found: Array<[string, number]> = []; let cursor = first.nextCursor ?? undefined; let last = first;
  while (cursor) {
    last = await searchConnectedFolder(root,"needle", {includeChats:false,maxMatches:1,cursor});
    found.push(...last.files.map(({path,line}): [string, number] => [path,line])); cursor = last.nextCursor ?? undefined;
  }
  // An item added after the walk's place in its folder is found; one added before it is behind the walk, as with any live listing.
  assert.deepEqual(found, [["docs/a.txt",2],["docs/m.txt",1],["docs/n-new.txt",1],["z.txt",1]]);
  assert.equal(last.truncated, false);
});

test("a folder replaced by a link between pages is never entered, by either walk", async (t) => {
  const { root, dispose } = await connectedFolder("replaced"); t.after(dispose);
  const outside = join(root, "..", "outside");
  await mkdir(outside);
  await writeFile(join(outside,"needle-secret.txt"), "needle in the link target\n");
  await mkdir(join(root,"b-dir"));
  await writeFile(join(root,"b-dir","one.txt"), "needle\nneedle\n");
  await writeFile(join(root,"b-dir","two.txt"), "needle\n");
  for (let index = 0; index < 600; index += 1) await writeFile(join(root,"b-dir",`needle-${String(index).padStart(3,"0")}.txt`), "");
  const first = await searchConnectedFolder(root,"needle", {includeChats:false,maxMatches:1});
  assert.equal(first.names.length, 500, "the name walk stopped inside b-dir");
  assert.deepEqual(first.files.map(({path,line}) => [path,line]), [["b-dir/one.txt",1]], "the text walk stopped partway through b-dir/one.txt");
  await rename(join(root,"b-dir"), join(root,"..","b-old"));
  await symlink(outside, join(root,"b-dir"), "dir");
  const names = [...first.names.map(({path}) => path)]; const files: string[] = []; let cursor = first.nextCursor ?? undefined; let changed = 0; let last = first;
  while (cursor) {
    last = await searchConnectedFolder(root,"needle", {includeChats:false,maxMatches:1,cursor});
    names.push(...last.names.map(({path}) => path)); files.push(...last.files.map(({path}) => path)); changed += last.coverage.changed; cursor = last.nextCursor ?? undefined;
  }
  assert.ok(!names.some((path) => path.includes("secret")) && !files.some((path) => path.includes("secret")), "nothing behind the link is named or read");
  assert.equal(new Set(names).size, names.length, "no name is returned twice");
  assert.ok(changed >= 1);
  assert.equal(last.coverage.names?.complete, false);
  assert.equal(last.truncated, true);
});

test("a Chat added between pages does not end the search", async (t) => {
  const { root, dispose } = await connectedFolder("chats-live"); t.after(dispose);
  for (const id of ["chat-a", "chat-b"]) await appendMessage(root, id, { id: `${id}-m`, role: "user", content: "needle", createdAt: "2026-11-27T00:00:00.000Z" });
  const first = await searchConnectedFolder(root, "needle", { includeFiles: false, maxMatches: 1 });
  assert.deepEqual(first.chats.map((chat) => chat.conversationId), ["chat-a"]);
  await appendMessage(root, "chat-c", { id: "chat-c-m", role: "user", content: "needle too", createdAt: "2026-11-27T00:01:00.000Z" });
  await appendMessage(root, "chat-a", { id: "chat-a-later", role: "assistant", content: "nothing here", createdAt: "2026-11-27T00:02:00.000Z" });
  const ids: string[] = []; let cursor = first.nextCursor ?? undefined; let last = first;
  while (cursor) {
    last = await searchConnectedFolder(root, "needle", { includeFiles: false, maxMatches: 1, cursor });
    ids.push(...last.chats.map((chat) => chat.conversationId)); cursor = last.nextCursor ?? undefined;
  }
  assert.deepEqual(ids, ["chat-b", "chat-c"]);
  assert.equal(last.truncated, false);
});

test("directory depth and Chat count are continuation work, while symlinks stay excluded", async (t) => {
  const { root, dispose } = await connectedFolder("depth"); t.after(dispose);
  const deep = Array.from({length:40},()=>"d").join("/");
  await mkdir(join(root,deep),{recursive:true}); await writeFile(join(root,deep,"deep.txt"),"needle");
  await symlink(join(root,deep,"deep.txt"),join(root,"link.txt"));
  let cursor: string | undefined; const files=[]; let links=0;
  do {
    const page=await searchConnectedFolder(root,"needle",{includeChats:false,maxScannedFiles:3,cursor});
    files.push(...page.files); links+=page.coverage.symbolicLink; cursor=page.nextCursor??undefined;
  } while(cursor);
  assert.deepEqual(files.map(file=>file.path),[`${deep}/deep.txt`]); assert.equal(links,1);
  for(let index=0;index<3;index++) await appendMessage(root,`chat-${index}`,{id:`m-${index}`,role:"user",content:"needle",createdAt:"2026-09-27T00:00:00.000Z"});
  const chats=[];
  do { const page=await searchConnectedFolder(root,"needle",{includeFiles:false,maxMatches:1,cursor}); chats.push(...page.chats); cursor=page.nextCursor??undefined; } while(cursor);
  assert.equal(chats.length,3); assert.equal(new Set(chats.map(chat=>chat.conversationId)).size,3);
});

test("registered nested Connected Folders and reserved paths cannot enter a narrowed search", async (t) => {
  const {root,dispose}=await connectedFolder("nested");t.after(dispose);
  const {registerLinkedConnectedFolder}=await import("../src/local/connected-folder.js");
  await registerLinkedConnectedFolder(root);
  await mkdir(join(root,"Child")); await writeFile(join(root,"Child","private.txt"),"needle");
  await registerLinkedConnectedFolder(join(root,"Child"));
  const result=await searchConnectedFolder(root,"needle",{includeChats:false});
  assert.deepEqual(result.files,[]); assert.ok(result.coverage.internal>=1);
  const narrowed=await searchConnectedFolder(root,"needle",{includeChats:false,path:"Child"}); assert.deepEqual(narrowed.files,[]);
  if(process.platform==="darwin") { const alias=await searchConnectedFolder(root,"needle",{includeChats:false,path:"child"}); assert.deepEqual(alias.files,[]); }
  await assert.rejects(searchConnectedFolder(root,"needle",{path:".amplefile"}),/reserved/);
  await assert.rejects(searchConnectedFolder(root,"needle",{path:"../outside"}),/escapes/);
});

test("large match payloads continue before the response budget instead of losing results", async (t) => {
  const {root,dispose}=await connectedFolder("response-budget");t.after(dispose);
  const parent=Array.from({length:6},(_,index)=>`${index}${"x".repeat(99)}`).join("/");
  await mkdir(join(root,parent),{recursive:true});
  await writeFile(join(root,parent,"matches.txt"),`${"x".repeat(100)}needle${"x".repeat(100)}\n`.repeat(1000));
  let cursor: string|undefined; const lines=[]; let pages=0;
  do { const page=await searchConnectedFolder(root,"needle",{includeChats:false,maxMatches:1000,cursor});
    assert.ok(Buffer.byteLength(JSON.stringify(page.files))<530000); lines.push(...page.files.map(match=>match.line));cursor=page.nextCursor??undefined;pages++;
  } while(cursor);
  assert.deepEqual(lines,Array.from({length:1000},(_,index)=>index+1)); assert.ok(pages>1);
});

test("the first page finds a deep name beyond either text scan budget", async (t) => {
  const { root, dispose } = await connectedFolder("large-name-walk");
  t.after(dispose);
  await writeFile(join(root, "000-large.txt"), "Ordinary text padding.\n".repeat(420_000));
  for (let start = 0; start < 5_100; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      writeFile(join(root, `a${String(start + index).padStart(4, "0")}.txt`), "")));
  }
  const parent = "zed/2026/November";
  await mkdir(join(root, parent), { recursive: true });
  const path = `${parent}/ sales & ops.txt `;
  await writeFile(join(root, path), "unrelated");

  const first = await searchConnectedFolder(root, "Sales & Ops", { includeChats: false });
  assert.deepEqual(first.names.map((match) => match.path), [path]);
  assert.equal(first.coverage.names?.complete, true);
  assert.equal(first.coverage.textComplete, false);
  assert.ok(first.nextCursor);
  assert.ok(first.coverage.scannedBytes >= 8 * 1024 * 1024, "the first text page reached the byte budget");

  const fileLimited = await searchConnectedFolder(root, "Sales & Ops", { includeChats: false, maxScannedBytes: 16 * 1024 * 1024 });
  assert.deepEqual(fileLimited.names.map((match) => match.path), [path]);
  assert.equal(fileLimited.coverage.names?.complete, true);
  assert.equal(fileLimited.coverage.textComplete, false);
  assert.ok(fileLimited.scannedFiles >= 4_999 && fileLimited.scannedFiles <= 5_000);
  assert.ok(fileLimited.coverage.scannedBytes < 16 * 1024 * 1024);
  assert.ok(fileLimited.nextCursor);
});

test("an entry beyond a page's 20,000-name budget arrives on the next page", async (t) => {
  const { root, dispose } = await connectedFolder("name-limit");
  t.after(dispose);
  for (let start = 0; start < 20_000; start += 200) {
    await Promise.all(Array.from({ length: 200 }, (_, index) =>
      writeFile(join(root, `a${String(start + index).padStart(5, "0")}`), "")));
  }
  const exact = await searchConnectedFolder(root, "late", { includeChats: false, maxScannedFiles: 1 });
  assert.deepEqual(exact.coverage.names, { visitedEntries: 20_000, complete: true });
  await writeFile(join(root, "late.txt"), "");
  const limited = await searchConnectedFolder(root, "late", { includeChats: false, maxScannedFiles: 1 });
  assert.deepEqual(limited.names, []);
  assert.deepEqual(limited.coverage.names, { visitedEntries: 20_000, complete: false });
  assert.ok(limited.nextCursor);
  const next = await searchConnectedFolder(root, "late", { includeChats: false, maxScannedFiles: 1, cursor: limited.nextCursor! });
  assert.deepEqual(next.names.map(({ path }) => path), ["late.txt"]);
  assert.deepEqual(next.coverage.names, { visitedEntries: 1, complete: true });
});

test("the name walk returns 500 names a page and the rest on later pages, each once", async (t) => {
  const { root, dispose } = await connectedFolder("name-match-limit");
  t.after(dispose);
  for (let start = 0; start < 1_200; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      writeFile(join(root, `report-${String(start + index).padStart(4, "0")}.txt`), "")));
  }

  const page = await searchConnectedFolder(root, "report", { includeChats: false });
  assert.equal(page.names.length, 500);
  assert.equal(page.names.at(-1)?.path, "report-0499.txt");
  assert.deepEqual(page.coverage.names, { visitedEntries: 500, complete: false });
  assert.equal(page.coverage.textComplete, true);
  assert.equal(page.coverage.complete, false);
  assert.ok(page.nextCursor, "the cursor carries the name walk on");
  const names = page.names.map(({ path }) => path); const sizes = [page.names.length]; let cursor = page.nextCursor ?? undefined; let last = page;
  while (cursor) {
    last = await searchConnectedFolder(root, "report", { includeChats: false, cursor });
    names.push(...last.names.map(({ path }) => path)); sizes.push(last.names.length); cursor = last.nextCursor ?? undefined;
  }
  assert.deepEqual(sizes, [500, 500, 200]);
  assert.deepEqual(names, Array.from({ length: 1_200 }, (_, index) => `report-${String(index).padStart(4, "0")}.txt`));
  assert.deepEqual(last.coverage.names, { visitedEntries: 200, complete: true });
  assert.equal(last.truncated, false);
});

test("name matches arrive once, outside the text match cap", async (t) => {
  const { root, dispose } = await connectedFolder("name-pages");
  t.after(dispose);
  await mkdir(join(root, "Sales archive"));
  await writeFile(join(root, "Sales archive", " sales & ops.txt "), "unrelated");
  await writeFile(join(root, "Sales.dat"), Buffer.alloc(32));
  await writeFile(join(root, "report.txt"), "SALES are up\nSales stayed up\n");

  const first = await searchConnectedFolder(root, "SaLeS", { includeChats: false, maxMatches: 1 });
  assert.deepEqual(first.names.map(({ path, name, kind }) => [path, name, kind]), [
    ["Sales archive", "Sales archive", "folder"],
    ["Sales archive/ sales & ops.txt ", " sales & ops.txt ", "file"],
    ["Sales.dat", "Sales.dat", "file"],
  ]);
  assert.deepEqual(first.files, [{ path: "report.txt", line: 1, preview: "SALES are up" }]);
  assert.ok(first.nextCursor);
  const next = await searchConnectedFolder(root, "SaLeS", { includeChats: false, maxMatches: 1, cursor: first.nextCursor! });
  assert.deepEqual(next.names, []);
  assert.deepEqual(next.files, [{ path: "report.txt", line: 2, preview: "Sales stayed up" }]);
  const file = await searchConnectedFolder(root, "sales & ops.txt", { path: "Sales archive/ sales & ops.txt ", includeChats: false });
  assert.deepEqual(file.names.map(({ name }) => name), [" sales & ops.txt "]);
  assert.deepEqual(file.files, []);
  assert.deepEqual((await searchConnectedFolder(root, "sales", { includeFiles: false })).names, []);
});

test("matching links keep their listing detail and their targets stay out of the search", async (t) => {
  const { root, dispose } = await connectedFolder("name-links");
  t.after(dispose);
  const outside = join(root, "..", "outside");
  await mkdir(outside);
  await writeFile(join(outside, "report-private.txt"), "report in the link target");
  await symlink(outside, join(root, "report-link"), "dir");

  const page = await searchConnectedFolder(root, "report", { includeChats: false });
  assert.deepEqual(page.names.map(({ path, kind, link }) => ({ path, kind, link })), [{
    path: "report-link", kind: "folder", link: { target: "folder", targetPath: await realpath(outside) },
  }]);
  assert.deepEqual(page.files, []);
  assert.equal(page.coverage.symbolicLink, 1);
  const narrowed = await searchConnectedFolder(root, "report", { includeChats: false, path: "report-link" });
  assert.deepEqual(narrowed.names, page.names);
  assert.deepEqual(narrowed.files, []);
  await assert.rejects(searchConnectedFolder(root, "report", { path: "report-link/report-private.txt" }), /symbolic links/);
});

test("name search excludes ignored, nested, reserved, and Office lock items", async (t) => {
  const { root, dispose } = await connectedFolder("name-exclusions");
  t.after(dispose);
  const { registerLinkedConnectedFolder } = await import("../src/local/connected-folder.js");
  await registerLinkedConnectedFolder(root);
  for (const directory of ["report-ignored", "report-nested", ".amplefile", ".pi"]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "report-private.txt"), "report in excluded content");
  }
  await writeFile(join(root, "~$report.docx"), "report in an Office lock file");
  await writeFile(join(root, "report-visible.txt"), "visible");
  await setConnectedFolderIgnoreState(root, ["report-ignored"], true);
  // On a case-insensitive volume, register the nested folder through its other spelling.
  const alias = join(root, "REPORT-NESTED");
  await registerLinkedConnectedFolder(await stat(alias).then(() => alias, () => join(root, "report-nested")));

  const page = await searchConnectedFolder(root, "report", { includeChats: false });
  assert.deepEqual(page.names.map(({ path }) => path), ["report-visible.txt"]);
  assert.deepEqual(page.files, []);
  assert.equal(page.coverage.names?.complete, true);
  assert.equal(page.truncated, false);
});
