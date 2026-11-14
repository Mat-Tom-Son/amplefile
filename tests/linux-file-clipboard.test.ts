import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  fileUriFromPath,
  formatGnomeCopiedFiles,
  formatUriList,
  gnomeCopiedFilesFormat,
  kdeCutSelectionFormat,
  parseGnomeCopiedFiles,
  parseNautilusClipboardText,
  parseUriList,
  pathFromFileUri,
  readLinuxClipboardFiles,
  uriListFormat,
  writeLinuxClipboardFiles,
} from "../desktop/src/linux-file-clipboard.js";

const awkward = [
  "/home/person/My Files/report final.pdf",
  "/home/person/Café/naïve 日本語.txt",
  "/home/person/#1 50% done?.md",
  "/home/person/a+b&c=d;e,[f].txt",
];

test("paths become percent-encoded file URIs and come back unchanged", () => {
  assert.equal(fileUriFromPath("/home/person/My Files/a.txt"), "file:///home/person/My%20Files/a.txt");
  assert.equal(fileUriFromPath("/tmp/Café/x.txt"), "file:///tmp/Caf%C3%A9/x.txt");
  assert.equal(fileUriFromPath("/tmp/#1 50%?.md"), "file:///tmp/%231%2050%25%3F.md");
  for (const path of awkward) assert.equal(pathFromFileUri(fileUriFromPath(path)), path);
  assert.throws(() => fileUriFromPath("relative/file.txt"));
  assert.throws(() => fileUriFromPath("/tmp/a\0b"));
});

test("only local file URIs name paths", () => {
  assert.equal(pathFromFileUri("file:///tmp/a%20b"), "/tmp/a b");
  assert.equal(pathFromFileUri("file://localhost/tmp/a"), "/tmp/a");
  assert.equal(pathFromFileUri("FILE:///tmp/a"), "/tmp/a");
  assert.equal(pathFromFileUri("https://example.com/a"), null);
  assert.equal(pathFromFileUri("smb://server/share/a"), null);
  assert.equal(pathFromFileUri("file://otherhost/tmp/a"), null);
  assert.equal(pathFromFileUri("file:///tmp/a%2Fb"), null, "an encoded slash is refused");
  assert.equal(pathFromFileUri("file:///tmp/a%00b"), null, "an encoded NUL is refused");
  assert.equal(pathFromFileUri("/tmp/plain path"), null);
  assert.equal(pathFromFileUri(""), null);
});

test("text/uri-list is written with CRLF lines and read back, skipping comments, blanks and other schemes", () => {
  const body = formatUriList(awkward);
  assert.equal(body.split("\r\n").length, awkward.length + 1);
  assert.ok(body.endsWith("\r\n"));
  assert.deepEqual(parseUriList(body), awkward);
  assert.deepEqual(parseUriList([
    "# copied by some app",
    "file:///tmp/one",
    "",
    "https://example.com/not-a-file",
    "  file:///tmp/two%20words  ",
    "file:///tmp/one",
    "not a uri at all",
  ].join("\n")), ["/tmp/one", "/tmp/two words"]);
});

test("x-special/gnome-copied-files carries copy or cut, then one URI per line", () => {
  assert.equal(formatGnomeCopiedFiles(["/tmp/a b", "/tmp/#c"]), "copy\nfile:///tmp/a%20b\nfile:///tmp/%23c");
  assert.equal(formatGnomeCopiedFiles(["/tmp/x"], "cut"), "cut\nfile:///tmp/x");
  assert.deepEqual(parseGnomeCopiedFiles(formatGnomeCopiedFiles(awkward)), { operation: "copy", paths: awkward });
  assert.deepEqual(parseGnomeCopiedFiles("cut\nfile:///tmp/x\r\nfile:///tmp/y\n"), { operation: "cut", paths: ["/tmp/x", "/tmp/y"] });
  assert.deepEqual(parseGnomeCopiedFiles("copy\nfile:///tmp/x\0"), { operation: "copy", paths: ["/tmp/x"] }, "a trailing NUL some apps send is ignored");
  assert.equal(parseGnomeCopiedFiles("file:///tmp/x"), null, "the operation line is required");
  assert.equal(parseGnomeCopiedFiles("move\nfile:///tmp/x"), null);
  assert.equal(parseGnomeCopiedFiles(""), null);
});

test("older Nautilus text is recognized only with its own header", () => {
  assert.deepEqual(parseNautilusClipboardText("x-special/nautilus-clipboard\ncut\nfile:///tmp/a%20b\n"), { operation: "cut", paths: ["/tmp/a b"] });
  assert.equal(parseNautilusClipboardText("/tmp/a b"), null);
  assert.equal(parseNautilusClipboardText("file:///tmp/a"), null);
});

function fakeClipboard(formats: Record<string, string>, text = "") {
  const writes: Array<{ format: string; body: string }> = [];
  return {
    writes,
    read: (format: string) => formats[format] ?? "",
    readText: () => text,
    writeBuffer: (format: string, buffer: Buffer) => { writes.push({ format, body: buffer.toString("utf8") }); },
  };
}

test("reading prefers the GNOME format, then text/uri-list with KDE's cut marker, and ignores ordinary text", () => {
  assert.deepEqual(readLinuxClipboardFiles(fakeClipboard({
    [gnomeCopiedFilesFormat]: "cut\nfile:///tmp/from-gnome",
    [uriListFormat]: "file:///tmp/from-uri-list\r\n",
  })), { operation: "cut", paths: ["/tmp/from-gnome"] });
  assert.deepEqual(readLinuxClipboardFiles(fakeClipboard({ [uriListFormat]: "file:///tmp/a\r\nfile:///tmp/b\r\n" })), { operation: null, paths: ["/tmp/a", "/tmp/b"] });
  assert.deepEqual(readLinuxClipboardFiles(fakeClipboard({ [uriListFormat]: "file:///tmp/a\r\n", [kdeCutSelectionFormat]: "1" })), { operation: "cut", paths: ["/tmp/a"] });
  assert.deepEqual(readLinuxClipboardFiles(fakeClipboard({ [gnomeCopiedFilesFormat]: "copy\n", [uriListFormat]: "file:///tmp/a\r\n" })), { operation: null, paths: ["/tmp/a"] }, "an empty GNOME list falls through");
  assert.deepEqual(readLinuxClipboardFiles(fakeClipboard({}, "x-special/nautilus-clipboard\ncopy\nfile:///tmp/old\n")), { operation: "copy", paths: ["/tmp/old"] });
  assert.deepEqual(readLinuxClipboardFiles(fakeClipboard({}, "/home/person/notes.txt")), { operation: null, paths: [] }, "copied text that looks like a path is not files");
  assert.deepEqual(readLinuxClipboardFiles(fakeClipboard({ [uriListFormat]: "\u0000garbage\u0001\nhttps://x\n", [gnomeCopiedFilesFormat]: "ÿþ" })), { operation: null, paths: [] });
  const throwing = { read: () => { throw new Error("no owner"); }, readText: () => { throw new Error("no owner"); } };
  assert.deepEqual(readLinuxClipboardFiles(throwing), { operation: null, paths: [] });
});

test("writing puts one text/uri-list on the clipboard, the format Chromium publishes as a file list", () => {
  const clipboard = fakeClipboard({});
  writeLinuxClipboardFiles(clipboard, ["/tmp/a b", "/tmp/Café #1.txt"]);
  assert.deepEqual(clipboard.writes, [{ format: uriListFormat, body: "file:///tmp/a%20b\r\nfile:///tmp/Caf%C3%A9%20%231.txt\r\n" }]);
  assert.throws(() => writeLinuxClipboardFiles(clipboard, []));
  assert.throws(() => writeLinuxClipboardFiles(clipboard, ["relative.txt"]));
});

test("the Linux desktop host uses these helpers for the file clipboard", async () => {
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  // The clipboard helper reads first; Electron's read is the fallback wherever it cannot.
  assert.match(main, /return \(files \?\? readLinuxClipboardFiles\(clipboard\)\)\.paths;/);
  // Electron's single-format write remains the fallback wherever the clipboard helper cannot own the selection.
  assert.match(main, /writeLinuxClipboardFiles\(clipboard, paths\);\n\s*return;/);
});
