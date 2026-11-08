import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseUserDirectories } from "../src/local/standard-folder-locations.js";
import { listStandardFolders, scanStandardFolder, standardFolderRoot } from "../src/local/standard-folders.js";

test("XDG directory data expands only HOME and never evaluates shell content", () => {
  assert.deepEqual(parseUserDirectories([
    'XDG_DESKTOP_DIR="$HOME/Bureau"',
    'XDG_DOCUMENTS_DIR="/mnt/data/My Documents" # relocated',
    'XDG_DOWNLOAD_DIR="$HOME"',
    'XDG_PICTURES_DIR="$HOME/Pictures \\"family\\""',
  ].join("\n"), "/home/test"), {
    desktop: "/home/test/Bureau", documents: "/mnt/data/My Documents", downloads: "/home/test", pictures: '/home/test/Pictures "family"',
  });
  for (const value of ['$(touch /tmp/no)', '`touch /tmp/no`', '$OTHER/docs', 'relative/path']) {
    assert.deepEqual(parseUserDirectories(`XDG_DOCUMENTS_DIR="${value}"`, "/home/test"), {});
  }
});

test("Linux sidebar and file operations use relocated XDG folders and omit disabled folders and iCloud", { skip: process.platform !== "linux" }, async t => {
  const home = await mkdtemp(join(tmpdir(), "amplefile-xdg-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".config"));
  await mkdir(join(home, "My Docs"));
  await mkdir(join(home, "Bureau"));
  await mkdir(join(home, "Library/Mobile Documents/com~apple~CloudDocs"), { recursive: true });
  await writeFile(join(home, ".config/user-dirs.dirs"), 'XDG_DESKTOP_DIR="$HOME/Bureau"\nXDG_DOCUMENTS_DIR="$HOME/My Docs"\nXDG_DOWNLOAD_DIR="$HOME"\n');
  await writeFile(join(home, "My Docs/report.txt"), "Linux file");
  assert.equal(standardFolderRoot("documents", home), join(home, "My Docs"));
  const folders = await listStandardFolders([{ id: "docs", connectedFolderRoot: join(home, "My Docs") }], home);
  assert.deepEqual(folders.map(folder => folder.id), ["desktop", "documents", "home"]);
  assert.equal(folders.find(folder => folder.id === "documents")?.connectedFolderId, "docs");
  assert.equal(folders.find(folder => folder.id === "documents")?.name, "My Docs");
  assert.deepEqual((await scanStandardFolder("documents", "", home)).tree.map(file => file.name), ["report.txt"]);
  assert.ok((await scanStandardFolder("home", "", home)).tree.some(file => file.name === "Library"), "Linux does not hide an ordinary Library folder");
});
