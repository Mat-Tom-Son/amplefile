import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerLinkedConnectedFolder } from "../src/local/connected-folder.js";
import { resolveFolderLocation, resolvePlaceSymbolicLink, scanComputerFolder } from "../src/local/folder-locations.js";
import { startLocalApi } from "../src/local/server.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";
import {
  accessError,
  addSidebarFolder,
  assertStandardFolderPathUnowned,
  computerFolderId,
  createStandardFolderFolder,
  isStandardFolderId,
  listStandardFolders,
  renameStandardFolderEntry,
  resolveStandardFolderPath,
  standardFolderEntryInfo,
  standardFolderRegistrationTarget,
  standardFolderRoot,
} from "../src/local/standard-folders.js";

// Any folder on the computer opens in the window (docs/product-model.md,
// "Other folders"): the host resolves a path to the place holding it, and the
// computer place holds every folder no Connected Folder or Standard Folder
// does, under the Standard Folder rules and the shared path policy.

/** A sandbox by its real path: the computer place names folders by where they really are (macOS's /var is a link). */
async function sandbox(t: test.TestContext, prefix = "folder-locations-"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A folder's path in the computer place: relative to the disk's root. */
const onDisk = (path: string) => path.slice(1);
const computer = { kind: "standard", id: computerFolderId } as const;

test("a path opens in the deepest Connected Folder, else the most specific Standard Folder, else the computer place", async (t) => {
  const root = await sandbox(t);
  const home = join(root, "home");
  await mkdir(join(home, "Documents", "Taxes", "2026"), { recursive: true });
  await mkdir(join(home, "Documents", "Taxes", "Receipts", "March"), { recursive: true });
  await writeFile(join(home, "Documents", "Taxes", "Receipts", "March", "rent.pdf"), "pdf");
  await mkdir(join(root, "srv", "projects", "site"), { recursive: true });
  await writeFile(join(root, "srv", "projects", "site", "index.html"), "<p>");
  const connectedFolders = [
    { id: "space-taxes", connectedFolderRoot: join(home, "Documents", "Taxes") },
    { id: "space-receipts", connectedFolderRoot: join(home, "Documents", "Taxes", "Receipts") },
  ];

  // The deepest Connected Folder, at the right folder; a file selects itself there.
  assert.deepEqual(await resolveFolderLocation(join(home, "Documents", "Taxes", "Receipts", "March"), connectedFolders, home),
    { place: { kind: "connected-folder", id: "space-receipts" }, path: "March", select: null });
  assert.deepEqual(await resolveFolderLocation(join(home, "Documents", "Taxes", "Receipts", "March", "rent.pdf"), connectedFolders, home),
    { place: { kind: "connected-folder", id: "space-receipts" }, path: "March", select: "March/rent.pdf" });
  assert.deepEqual(await resolveFolderLocation(join(home, "Documents", "Taxes", "2026"), connectedFolders, home),
    { place: { kind: "connected-folder", id: "space-taxes" }, path: "2026", select: null });
  // A Standard Folder, the most specific one; the home folder holds only what nothing else does.
  assert.deepEqual(await resolveFolderLocation(join(home, "Documents"), connectedFolders, home), { place: { kind: "standard", id: "documents" }, path: "", select: null });
  assert.deepEqual(await resolveFolderLocation(home, connectedFolders, home), { place: { kind: "standard", id: "home" }, path: "", select: null });
  // Everything else is in the computer place, by its path from the disk's root.
  assert.deepEqual(await resolveFolderLocation(join(root, "srv", "projects", "site", "index.html"), connectedFolders, home),
    { place: computer, path: onDisk(join(root, "srv", "projects", "site")), select: onDisk(join(root, "srv", "projects", "site", "index.html")) });
  assert.deepEqual(await resolveFolderLocation("/", connectedFolders, home), { place: computer, path: "", select: null });
  assert.equal(await resolveFolderLocation(join(root, "missing"), connectedFolders, home), null, "nothing there opens nothing");
});

test("Command-Up from a place's top shows that folder selected where it lives, down to the disk", async (t) => {
  const root = await sandbox(t);
  const home = join(root, "home");
  await mkdir(join(home, "Documents", "Taxes"), { recursive: true });
  const connectedFolders = [{ id: "space-taxes", connectedFolderRoot: join(home, "Documents", "Taxes") }];
  assert.deepEqual(await resolveFolderLocation(join(home, "Documents", "Taxes"), connectedFolders, home, { reveal: true }),
    { place: { kind: "standard", id: "documents" }, path: "", select: "Taxes" });
  assert.deepEqual(await resolveFolderLocation(home, connectedFolders, home, { reveal: true }),
    { place: computer, path: onDisk(root), select: onDisk(home) });
  assert.deepEqual(await resolveFolderLocation("/", connectedFolders, home, { reveal: true }), { place: computer, path: "", select: null }, "the disk has nothing above it");
});

test("a path is resolved to where it really is, and hidden AmpleFile and Pi data never opens", async (t) => {
  const root = await sandbox(t);
  const home = join(root, "home");
  await mkdir(join(root, "real", "Notes"), { recursive: true });
  await mkdir(join(root, "real", ".amplefile"), { recursive: true });
  await mkdir(home);
  await symlink(join(root, "real"), join(root, "shortcut"));
  assert.deepEqual(await resolveFolderLocation(join(root, "shortcut", "Notes"), [], home), { place: computer, path: onDisk(join(root, "real", "Notes")), select: null },
    "the place's routes never traverse the link");
  await assert.rejects(resolveFolderLocation(join(root, "real", ".amplefile"), [], home), /hidden AmpleFile or Pi data/);
});

test("the computer place resolves every path under the shared path policy", async (t) => {
  const root = await sandbox(t);
  await mkdir(join(root, "Projects", "Site"), { recursive: true });
  await mkdir(join(root, "Projects", ".pi"));
  await writeFile(join(root, "outside.txt"), "x");
  await symlink(join(root, "Projects"), join(root, "Linked"));

  assert.equal(isStandardFolderId(computerFolderId), true);
  assert.equal(standardFolderRoot(computerFolderId), "/");
  assert.equal(resolveStandardFolderPath(computerFolderId, ""), "/");
  assert.equal(resolveStandardFolderPath(computerFolderId, onDisk(join(root, "Projects", "Site"))), join(root, "Projects", "Site"));
  assert.throws(() => resolveStandardFolderPath(computerFolderId, `${onDisk(root)}/Projects/../../etc`), /escapes/);
  assert.throws(() => resolveStandardFolderPath(computerFolderId, "../etc"), /escapes/);
  assert.throws(() => resolveStandardFolderPath(computerFolderId, onDisk(join(root, "Linked", "Site"))), /symbolic link/);
  assert.throws(() => resolveStandardFolderPath(computerFolderId, onDisk(join(root, "Projects", ".pi"))), /reserved/);
  assert.throws(() => resolveStandardFolderPath(computerFolderId, ".amplefile/x"), /reserved/);
  // It is not a sidebar row.
  assert.ok(!(await listStandardFolders([], join(root, "home"))).some((folder) => folder.id === computerFolderId));
});

test("a folder in the computer place lists one level, as a Standard Folder does", async (t) => {
  const root = await sandbox(t);
  const projects = join(root, "Projects");
  await mkdir(join(projects, "Site", "pages"), { recursive: true });
  await mkdir(join(projects, ".amplefile"));
  await writeFile(join(projects, "notes.md"), "# Notes");
  await writeFile(join(projects, ".env"), "x");
  await symlink(join(projects, "notes.md"), join(projects, "link.md"));
  const listing = await scanComputerFolder(onDisk(projects));
  assert.deepEqual(listing.tree.map((entry) => [entry.name, entry.path, entry.kind]), [
    ["Site", `${onDisk(projects)}/Site`, "folder"],
    ["notes.md", `${onDisk(projects)}/notes.md`, "file"],
  ]);
  assert.equal(listing.tree[0]?.children, undefined, "one level only");
  await assert.rejects(scanComputerFolder(`${onDisk(projects)}/../..`), /escapes/);
  // The disk's own top is listed too, without dotfiles or links.
  const top = await scanComputerFolder("");
  assert.ok(top.tree.length > 0);
  assert.ok(top.tree.every((entry) => !entry.name.startsWith(".") && entry.path === entry.name));
  assert.ok(top.tree.some((entry) => entry.name === onDisk(root).split("/")[0] && entry.kind === "folder"));
});

test("a folder in the computer place lists links and hidden entries on request, as a Standard Folder does", async (t) => {
  const root = await sandbox(t);
  const projects = join(root, "Projects");
  await mkdir(join(projects, ".amplefile"), { recursive: true });
  await writeFile(join(projects, "notes.md"), "# Notes");
  await writeFile(join(projects, ".env"), "x");
  await symlink(join(projects, "notes.md"), join(projects, "link.md"));
  const listing = await scanComputerFolder(onDisk(projects), undefined, { includeHidden: true, includeLinks: true });
  const byName = new Map(listing.tree.map((entry) => [entry.name, entry]));
  assert.deepEqual([...byName.keys()].sort(), [".env", "link.md", "notes.md"], "hidden AmpleFile data never lists");
  assert.equal(byName.get(".env")?.hidden, true);
  assert.equal(byName.get("notes.md")?.hidden, undefined);
  assert.deepEqual(byName.get("link.md")?.link, { target: "file", targetPath: join(projects, "notes.md") });
  assert.equal(byName.get("link.md")?.path, `${onDisk(projects)}/link.md`);
  // Without the options the listing is what it always was.
  assert.deepEqual((await scanComputerFolder(onDisk(projects))).tree.map((entry) => entry.name), ["notes.md"]);
});

test("anything a Connected Folder owns is changed from that Connected Folder, and the disk itself never connects", async (t) => {
  const root = await sandbox(t);
  const projects = join(root, "Projects");
  await mkdir(join(projects, "Taxes"), { recursive: true });
  await writeFile(join(projects, "Taxes", "w2.pdf"), "w2");
  await writeFile(join(projects, "loose.txt"), "x");
  await registerLinkedConnectedFolder(join(projects, "Taxes"));
  const at = (path: string) => onDisk(join(projects, path));

  await assert.doesNotReject(assertStandardFolderPathUnowned(computerFolderId, at("loose.txt")));
  await assert.rejects(assertStandardFolderPathUnowned(computerFolderId, at("Taxes/w2.pdf")), /is a Connected Folder/);
  await assert.rejects(renameStandardFolderEntry(computerFolderId, at("Taxes"), "Old Taxes"), /is a Connected Folder/);
  await assert.rejects(createStandardFolderFolder(computerFolderId, at("Taxes"), "New"), /is a Connected Folder/);
  assert.equal((await scanComputerFolder(onDisk(projects))).tree.find((entry) => entry.name === "Taxes")?.nestedFolder, true);
  // Rename and New Folder work as in a Standard Folder, by paths from the disk's root.
  assert.deepEqual(await renameStandardFolderEntry(computerFolderId, at("loose.txt"), "kept.txt"), { path: at("kept.txt") });
  assert.deepEqual(await createStandardFolderFolder(computerFolderId, onDisk(projects), "Drafts"), { path: at("Drafts") });
  assert.equal((await standardFolderEntryInfo(computerFolderId, at("kept.txt"))).path, at("kept.txt"));

  await assert.rejects(standardFolderRegistrationTarget(computerFolderId, ""), /whole disk/);
  await assert.rejects(standardFolderRegistrationTarget(computerFolderId, at("Taxes")), /already has its own Worker/);
  assert.equal(await standardFolderRegistrationTarget(computerFolderId, at("Drafts")), join(projects, "Drafts"));
  assert.equal(await standardFolderRegistrationTarget(computerFolderId, onDisk(root).split("/")[0]!), `/${onDisk(root).split("/")[0]}`);
});

test("a refusal in the computer place names the folder refused", () => {
  const refusal = accessError(Object.assign(new Error("EACCES"), { code: "EACCES", path: "/srv/private" }), computerFolderId) as Error & { status?: number };
  assert.equal(refusal.status, 403);
  assert.match(refusal.message, /“private”/);
});

test("the window's routes work in the computer place as in a Standard Folder", async (t) => {
  const root = await sandbox(t, "folder-locations-api-");
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "content"), loadEnv: false });
  t.after(async () => { await api.close(); configureAmpleFileStateRoot(undefined); });
  const work = join(root, "work");
  await mkdir(join(work, "Inbox"), { recursive: true });
  await mkdir(join(work, ".pi"));
  await writeFile(join(work, "plan.md"), "# Plan\n");
  await writeFile(join(work, ".pi", "settings.json"), "{}");
  const at = (path = "") => onDisk(path ? join(work, path) : work);
  const base = `${api.origin}/api/standard-folders/${computerFolderId}`;
  const json = async (path: string, init?: RequestInit) => {
    const answer = await fetch(`${api.origin}${path}`, init);
    return { status: answer.status, body: await answer.json() as Record<string, unknown> };
  };
  const post = (path: string, body: unknown) => json(path, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" }, body: JSON.stringify(body) });

  // Where a folder lives, for Command-Up and the path bar.
  const located = await json(`/api/folder-location?path=${encodeURIComponent(join(work, "plan.md"))}`);
  assert.equal(located.status, 200);
  const location = located.body.location as { path: string; select: string };
  assert.ok(location.path.endsWith("work") && location.select.endsWith("work/plan.md"));
  if (!work.startsWith(homedir())) assert.deepEqual((located.body.location as { place: unknown }).place, computer);
  assert.equal((await json(`/api/folder-location?path=${encodeURIComponent(join(work, "missing"))}`)).status, 404);
  assert.equal((await json("/api/folder-location?path=relative%2Fname")).status, 400);

  const tree = await json(`/api/standard-folders/${computerFolderId}/tree?maxDepth=0&path=${encodeURIComponent(at())}`);
  assert.deepEqual((tree.body.tree as Array<{ name: string }>).map((entry) => entry.name), ["Inbox", "plan.md"]);
  assert.equal((await fetch(`${base}/raw-file?path=${encodeURIComponent(at("plan.md"))}`).then((answer) => answer.text())), "# Plan\n");
  assert.equal((await fetch(`${base}/raw-file?path=${encodeURIComponent(at(".pi/settings.json"))}`)).ok, false);
  assert.deepEqual((await json(`/api/standard-folders/${computerFolderId}/file-preview?path=${encodeURIComponent(at("plan.md"))}`)).body,
    { preview: { kind: "text", content: "# Plan\n", truncated: false, sizeBytes: 7 } });
  assert.equal(((await json(`/api/standard-folders/${computerFolderId}/file-info?path=${encodeURIComponent(at("Inbox"))}`)).body as { kind: string }).kind, "folder");

  // New folder, copy, move, duplicate, and compress, through the same place resolver as a Standard Folder.
  assert.equal((await post(`/api/standard-folders/${computerFolderId}/folders`, { parentPath: at(), name: "Archive" })).status, 201);
  const copied = await post("/api/file-transfer", { mode: "copy", sources: [{ place: computer, path: at("plan.md") }], target: { place: computer, path: at("Archive") } });
  assert.deepEqual(copied.body.written, [at("Archive/plan.md")]);
  const duplicated = await post("/api/file-transfer", { mode: "duplicate", sources: [{ place: computer, path: at("plan.md") }], target: { place: computer, path: at() } });
  assert.deepEqual(duplicated.body.written, [at("plan copy.md")]);
  const moved = await post("/api/file-transfer", { mode: "move", sources: [{ place: computer, path: at("plan copy.md") }], target: { place: computer, path: at("Inbox") } });
  assert.deepEqual(moved.body.written, [at("Inbox/plan copy.md")]);
  assert.ok(!existsSync(join(work, "plan copy.md")));
  const compressed = await post("/api/file-transfer/compress", { place: computer, paths: [at("Inbox")] });
  assert.equal(compressed.status, 201);
  assert.equal(compressed.body.path, at("Inbox.zip"));
  assert.equal((await post(`/api/standard-folders/${computerFolderId}/rename-local-entry`, { path: at("Archive/plan.md"), newName: "old plan.md" })).body.path, at("Archive/old plan.md"));
  assert.equal(await readFile(join(work, "Archive", "old plan.md"), "utf8"), "# Plan\n");

  // Connect This Folder registers the folder shown, and nothing moves.
  const connected = await post(`/api/standard-folders/${computerFolderId}/connected-folders`, { path: at("Archive") });
  assert.equal(connected.status, 201);
  assert.equal((connected.body.connectedFolder as { connectedFolderRoot: string }).connectedFolderRoot, join(work, "Archive"));
  assert.ok(existsSync(join(work, "Archive", "old plan.md")));
  assert.equal((await post(`/api/standard-folders/${computerFolderId}/rename-local-entry`, { path: at("Archive/old plan.md"), newName: "x.md" })).status, 409);
  // Now it opens as that Connected Folder.
  const reopened = await json(`/api/folder-location?path=${encodeURIComponent(join(work, "Archive"))}`);
  assert.equal((reopened.body.location as { place: { kind: string } }).place.kind, "connected-folder");

  // Go to Folder opens any folder and completes names outside the places too.
  const goTo = await json(`/api/go-to-folder?path=${encodeURIComponent(`${work}/In`)}`);
  assert.deepEqual((goTo.body.suggestions as Array<{ name: string }>).map((item) => item.name), ["Inbox", "Inbox.zip"]);
});

test("the disk's top lists its links and hidden entries on request, as every other listing does", async () => {
  const top = await scanComputerFolder("", undefined, { includeLinks: true, includeHidden: true });
  const plain = await scanComputerFolder("");
  assert.ok(top.tree.every((entry) => entry.path === entry.name));
  assert.ok(!top.tree.some((entry) => entry.name === ".amplefile" || entry.name === ".pi"));
  for (const entry of top.tree) {
    assert.equal(Boolean(entry.hidden), entry.name.startsWith("."), entry.name);
    if (entry.link) assert.ok(!plain.tree.some((item) => item.name === entry.name), `${entry.name} is a link, left out unless asked for`);
  }
  // Linux keeps /bin and the like as links into /usr; where the disk does, the window shows them.
  const bin = await lstat("/bin").catch(() => null);
  if (bin?.isSymbolicLink()) {
    const listed = top.tree.find((entry) => entry.name === "bin");
    assert.equal(listed?.kind, "folder");
    assert.deepEqual(listed?.link, { target: "folder", targetPath: await realpath("/bin") });
    assert.equal(listed?.hasChildren, false, "a linked folder is never opened in place");
  }
});

test("a listed link resolves to where it points, in a Standard Folder and in the computer place, and a broken one says so", async (t) => {
  const root = await sandbox(t);
  const added = join(root, "Added");
  await mkdir(join(added, "Projects"), { recursive: true });
  await writeFile(join(added, "notes.txt"), "notes");
  await symlink("notes.txt", join(added, "notes link"));
  await symlink("Projects", join(added, "Projects link"));
  await symlink("gone.txt", join(added, "broken link"));
  const sidebar = addSidebarFolder(added, root);
  const place = { kind: "standard", id: sidebar.id } as const;
  assert.deepEqual(await resolvePlaceSymbolicLink(place, "notes link", root), { linkPath: join(added, "notes link"), targetPath: join(added, "notes.txt"), target: "file" });
  assert.deepEqual(await resolvePlaceSymbolicLink(computer, onDisk(join(added, "Projects link")), root), { linkPath: join(added, "Projects link"), targetPath: join(added, "Projects"), target: "folder" });
  await assert.rejects(resolvePlaceSymbolicLink(place, "broken link", root), /isn’t there/);
  await assert.rejects(resolvePlaceSymbolicLink(place, "notes.txt", root), /isn’t a symbolic link/);
  await assert.rejects(resolvePlaceSymbolicLink(place, "Projects link/inner", root), /symbolic links/, "never through a link");
  await assert.rejects(resolvePlaceSymbolicLink(computer, "", root), /link inside/);
  await assert.rejects(resolvePlaceSymbolicLink(computer, ".amplefile", root), /link inside|reserved/);
  await assert.rejects(resolvePlaceSymbolicLink({ kind: "standard", id: "nowhere" }, "notes link", root), /sidebar/);
  // A link at the disk's top is the computer place's first folder.
  const bin = await lstat("/bin").catch(() => null);
  if (bin?.isSymbolicLink()) assert.deepEqual(await resolvePlaceSymbolicLink(computer, "bin", root), { linkPath: "/bin", targetPath: await realpath("/bin"), target: "folder" });
});

test("a drop in a Standard Folder or an other folder copies items in or moves them, except into what a Connected Folder owns", async (t) => {
  const root = await sandbox(t, "folder-locations-drop-");
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "content"), loadEnv: false });
  t.after(async () => { await api.close(); configureAmpleFileStateRoot(undefined); });
  const post = async (body: unknown) => {
    const answer = await fetch(`${api.origin}/api/file-transfer`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json() as { written?: string[]; error?: string } };
  };
  const elsewhere = join(root, "Elsewhere");
  const work = join(root, "Work");
  await mkdir(elsewhere, { recursive: true });
  await mkdir(join(work, "Inbox"), { recursive: true });
  await mkdir(join(work, "Client"), { recursive: true });
  await writeFile(join(elsewhere, "photo.jpg"), "jpg");
  await writeFile(join(work, "plan.md"), "# Plan");
  const sidebar = addSidebarFolder(work, root);
  const added = { kind: "standard", id: sidebar.id } as const;
  const at = (path = "") => onDisk(path ? join(work, path) : work);

  // From another app (the desktop hands the window each item's path): copied into the folder shown or the row dropped on.
  assert.deepEqual((await post({ mode: "copy", sources: [{ nativePath: join(elsewhere, "photo.jpg") }], target: { place: added, path: "" } })).body.written, ["photo.jpg"]);
  assert.deepEqual((await post({ mode: "copy", sources: [{ nativePath: join(elsewhere, "photo.jpg") }], target: { place: computer, path: at("Inbox") } })).body.written, [at("Inbox/photo.jpg")]);
  assert.ok(existsSync(join(elsewhere, "photo.jpg")), "the original stays where it was");
  // Dragged inside the window onto a folder row: moved there.
  assert.deepEqual((await post({ mode: "move", sources: [{ place: added, path: "plan.md" }, { place: added, path: "photo.jpg" }], target: { place: added, path: "Inbox" } })).body.written, ["Inbox/plan.md", "Inbox/photo copy.jpg"], "a name already taken there gets “ copy”");
  assert.ok(!existsSync(join(work, "plan.md")));
  assert.deepEqual((await post({ mode: "move", sources: [{ place: computer, path: at("Inbox/plan.md") }], target: { place: computer, path: at() } })).body.written, [at("plan.md")]);

  // Once a folder inside is a Connected Folder, it is changed only through that Connected Folder.
  const registered = await fetch(`${api.origin}/api/connected-folders/local-folder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectedFolderRoot: join(work, "Client") }) });
  assert.equal(registered.status, 201);
  for (const [label, body] of [
    ["copy in", { mode: "copy", sources: [{ nativePath: join(elsewhere, "photo.jpg") }], target: { place: added, path: "Client" } }],
    ["move in", { mode: "move", sources: [{ place: added, path: "plan.md" }], target: { place: computer, path: at("Client") } }],
    ["move it away", { mode: "move", sources: [{ place: added, path: "Client" }], target: { place: added, path: "Inbox" } }],
  ] as const) {
    const refused = await post(body);
    assert.ok(refused.status >= 400, `${label} answered ${refused.status}`);
  }
  assert.ok(!existsSync(join(work, "Client", "photo.jpg")));
  assert.ok(!existsSync(join(work, "Client", "plan.md")));
  assert.ok(existsSync(join(work, "Client")));
});
