import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getConnectedFolderFilePreview } from "../src/local/connected-folder.js";
import { startLocalApi } from "../src/local/server.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";
import { addSidebarFolder, standardFolderFilePreview } from "../src/local/standard-folders.js";
import { filePreviewNotice, fixtureFilePreview, previewSpaceAction } from "../web-local/src/components/file-manager/file-preview-model.js";

// Space's Preview on a desktop without Quick Look (docs/linux-build.md): the
// host decides what kind of preview a file gets and bounds every read; the
// window shows text as text, and images and PDFs from the file's own bytes.

async function folder(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Space opens the Preview only on a selected file, and closes it whatever is selected", () => {
  assert.equal(previewSpaceAction(false, { kind: "file" }), "open");
  assert.equal(previewSpaceAction(false, { kind: "folder" }), null, "a folder alone opens nothing, as with Quick Look");
  assert.equal(previewSpaceAction(false, null), null);
  assert.equal(previewSpaceAction(true, { kind: "file" }), "close");
  assert.equal(previewSpaceAction(true, { kind: "folder" }), "close");
  assert.equal(previewSpaceAction(true, null), "close");
});

test("the Preview says plainly why it shows a card instead of the file", () => {
  const file = { kind: "file" as const };
  assert.equal(filePreviewNotice(file, null, false), null, "still reading");
  assert.equal(filePreviewNotice(file, { kind: "text", content: "hi", sizeBytes: 2 }, false), null);
  assert.equal(filePreviewNotice(file, { kind: "text", content: "", sizeBytes: 0 }, false), "This file is empty.");
  assert.equal(filePreviewNotice(file, { kind: "none", reason: "binary", sizeBytes: 9 }, false), "There’s no preview for this kind of file.");
  assert.equal(filePreviewNotice(file, { kind: "none", reason: "too-large", sizeBytes: 9 }, false), "This file is too large to preview.");
  assert.equal(filePreviewNotice(file, null, true), "This file can’t be previewed.");
  assert.equal(filePreviewNotice({ kind: "folder" }, null, false), null);
  assert.deepEqual(fixtureFilePreview("# Notes\n"), { kind: "text", content: "# Notes\n", truncated: false, sizeBytes: 8 });
  assert.deepEqual(fixtureFilePreview(undefined), { kind: "none", reason: "binary", sizeBytes: 0 });
});

test("the host picks the preview kind from the file and bounds each read", async (t) => {
  const root = await folder(t, "amplefile-file-preview-");
  await writeFile(join(root, "notes.md"), "# Notes\nfirst line\n");
  await writeFile(join(root, "script.sh"), "#!/bin/sh\necho hi\n");
  await writeFile(join(root, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(join(root, "drawing.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  await writeFile(join(root, "report.pdf"), "%PDF-1.4\n");
  await writeFile(join(root, "report.docx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0x08, 0]));
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, "empty.txt"), "");
  await mkdir(join(root, "Inbox"));

  const notes = await getConnectedFolderFilePreview(root, "notes.md");
  assert.deepEqual(notes, { kind: "text", content: "# Notes\nfirst line\n", truncated: false, sizeBytes: 19 });
  assert.equal((await getConnectedFolderFilePreview(root, "script.sh")).kind, "text", "a script is shown as text, never run");
  assert.deepEqual(await getConnectedFolderFilePreview(root, "photo.png"), { kind: "image", sizeBytes: 8 });
  assert.equal((await getConnectedFolderFilePreview(root, "drawing.svg")).kind, "image", "an SVG is drawn as an image, where its script never runs");
  assert.equal((await getConnectedFolderFilePreview(root, "drawing.svg")).content, undefined, "an image's bytes come from the raw-file route, not the preview answer");
  assert.equal((await getConnectedFolderFilePreview(root, "report.pdf")).kind, "pdf");
  assert.deepEqual(await getConnectedFolderFilePreview(root, "report.docx"), { kind: "none", reason: "binary", sizeBytes: 10 });
  assert.deepEqual(await getConnectedFolderFilePreview(root, "blob.bin"), { kind: "none", reason: "binary", sizeBytes: 4 });
  assert.deepEqual(await getConnectedFolderFilePreview(root, "empty.txt"), { kind: "text", content: "", truncated: false, sizeBytes: 0 });
  assert.deepEqual(await getConnectedFolderFilePreview(root, "Inbox"), { kind: "none", reason: "folder", sizeBytes: 0 });

  // Bounds: text stops at 256 KB and says so; images over 12 MB and PDFs over 200 MB are not read at all.
  await writeFile(join(root, "long.txt"), "x".repeat(300 * 1024));
  const long = await getConnectedFolderFilePreview(root, "long.txt");
  assert.equal(long.kind, "text");
  assert.equal(long.truncated, true);
  assert.equal(long.content?.length, 256 * 1024);
  assert.equal(long.sizeBytes, 300 * 1024);
  await writeFile(join(root, "huge.jpg"), "");
  await truncate(join(root, "huge.jpg"), 12 * 1024 * 1024 + 1);
  assert.deepEqual(await getConnectedFolderFilePreview(root, "huge.jpg"), { kind: "none", reason: "too-large", sizeBytes: 12 * 1024 * 1024 + 1 });
  await writeFile(join(root, "huge.pdf"), "");
  await truncate(join(root, "huge.pdf"), 200 * 1024 * 1024 + 1);
  assert.deepEqual(await getConnectedFolderFilePreview(root, "huge.pdf"), { kind: "none", reason: "too-large", sizeBytes: 200 * 1024 * 1024 + 1 });
});

test("the Preview reads nothing outside the selected file: no escapes, links, or hidden metadata", async (t) => {
  const sandbox = await folder(t, "amplefile-file-preview-policy-");
  const root = join(sandbox, "folder");
  await mkdir(join(root, ".amplefile"), { recursive: true });
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".amplefile", "connected-folder.json"), "{}");
  await writeFile(join(root, ".pi", "settings.json"), "{}");
  await writeFile(join(sandbox, "outside.txt"), "secret");
  await symlink(join(sandbox, "outside.txt"), join(root, "link.txt"));

  await assert.rejects(getConnectedFolderFilePreview(root, "../outside.txt"), /escapes/);
  await assert.rejects(getConnectedFolderFilePreview(root, join(sandbox, "outside.txt")), /escapes/);
  await assert.rejects(getConnectedFolderFilePreview(root, ".amplefile/connected-folder.json"), /reserved/);
  await assert.rejects(getConnectedFolderFilePreview(root, ".pi/settings.json"), /reserved/);
  await assert.rejects(getConnectedFolderFilePreview(root, "link.txt"), /link/i);
});

test("a standard folder's file previews through its own file-preview route, under the same rules", async (t) => {
  const sandbox = await folder(t, "amplefile-file-preview-api-");
  const home = join(sandbox, "home");
  await mkdir(join(home, "Downloads"), { recursive: true });
  await writeFile(join(home, "Downloads", "receipt.txt"), "Paid\n");
  assert.deepEqual(await standardFolderFilePreview("downloads", "receipt.txt", home), { kind: "text", content: "Paid\n", truncated: false, sizeBytes: 5 });
  await assert.rejects(standardFolderFilePreview("downloads", "../Desktop/x.txt", home), /escapes/);

  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => { await api.close(); configureAmpleFileStateRoot(undefined); });
  const projects = join(sandbox, "Projects");
  await mkdir(join(projects, ".amplefile"), { recursive: true });
  await writeFile(join(projects, "plan.md"), "# Plan\n");
  await writeFile(join(projects, ".amplefile", "connected-folder.json"), "{}");
  const added = addSidebarFolder(projects, home);
  const base = `${api.origin}/api/standard-folders/${added.id}`;
  const answer = await fetch(`${base}/file-preview?path=plan.md`);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { preview: { kind: "text", content: "# Plan\n", truncated: false, sizeBytes: 7 } });
  assert.equal((await fetch(`${base}/file-preview?path=..%2Fhome%2FDownloads%2Freceipt.txt`)).ok, false);
  assert.equal((await fetch(`${base}/file-preview?path=.amplefile%2Fconnected-folder.json`)).ok, false);
  assert.equal((await fetch(`${base}/file-preview`)).status, 400, "a path is required");
});
