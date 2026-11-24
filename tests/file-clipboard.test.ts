import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { existsOnDisk, FileClipboard, parseCutItems, type PasteTransfer } from "../desktop/src/file-clipboard.js";
import { pasteboardFileList, pasteboardFileText, readPasteboardFileList, type PasteboardFiles } from "../desktop/src/file-clipboard-paste.js";
import { nativePathEntryPath } from "../web-local/src/lib/platform.js";

/**
 * The Cut across windows (docs/product-model.md, "Finder's file actions"): the
 * desktop host remembers a Cut made in any window by the exact files it put on
 * the pasteboard, so a paste in any window moves them, every window draws them
 * cut, and the Cut is forgotten once the pasteboard holds something else, once
 * it is pasted, once it is cancelled, or once any of its items is no longer
 * where it was cut.
 */

const documents = { kind: "standard" as const, id: "documents" };
const notes = { kind: "connected-folder" as const, id: "space-0123456789abcdef" };
const report = "/Users/ana/Documents/report.pdf";
const photos = "/Users/ana/Documents/Photos";

/** A Mac's general pasteboard as Electron reads and writes it: a file list as text, or other content. */
class FakePasteboard {
  fileList: string | null = null;
  text: string | null = null;
  /** Electron writes the list AmpleFile hands it, byte for byte. */
  writeFiles(paths: readonly string[], token: string | null): void { this.fileList = pasteboardFileList(paths, token); this.text = null; }
  /** Finder's Copy: macOS writes its own file list for the same files, with no token. */
  finderCopies(paths: readonly string[]): void {
    this.fileList = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<array>\n${paths.map((path) => `\t<string>${path}</string>\n`).join("")}</array>\n</plist>\n`;
    this.text = null;
  }
  copiesText(text: string): void { this.fileList = null; this.text = text; }
  clear(): void { this.fileList = null; this.text = null; }
  read(): PasteboardFiles {
    const listed = readPasteboardFileList(this.fileList ?? "");
    return { paths: listed.paths, operation: null, cutToken: listed.cutToken };
  }
}

/**
 * The host and its windows: each window keeps what it last heard is cut, as the file manager draws it. Every
 * file is on disk until the test puts its path in `gone`.
 */
function setUp(options: {
  token?: () => string | null;
  read?: (pasteboard: FakePasteboard) => PasteboardFiles | Promise<PasteboardFiles>;
  exists?: (path: string) => Promise<boolean>;
} = {}) {
  const pasteboard = new FakePasteboard();
  const windows = { one: null as string[] | null, two: null as string[] | null };
  const gone = new Set<string>();
  let tokens = 0;
  const clipboard = new FileClipboard({
    read: () => options.read ? options.read(pasteboard) : pasteboard.read(),
    write: (nativePaths, token) => pasteboard.writeFiles(nativePaths, token),
    clear: () => pasteboard.clear(),
    exists: options.exists ?? (async (nativePath) => !gone.has(nativePath)),
    token: options.token ?? (() => (++tokens).toString(16).padStart(32, "0")),
    changed: (nativePaths) => {
      windows.one = nativePaths ? [...nativePaths] : null;
      windows.two = nativePaths ? [...nativePaths] : null;
    },
  });
  return { pasteboard, windows, gone, clipboard };
}

/** The place transfer as the local API answers: a conflicts-first check, a finished transfer, or a stopped one. */
function transfers(answer: (body: PasteTransfer) => object = (body) => ({ written: body.sources.map(() => "Inbox/x"), restorePoints: [] })) {
  const calls: PasteTransfer[] = [];
  return { calls, transfer: async (body: PasteTransfer) => { calls.push(body); return body.conflicts && typeof body.conflicts === "object" && "check" in body.conflicts ? { conflicts: [] } : answer(body); } };
}

const target = { place: notes, path: "Inbox" };

test("a Cut made in one window pastes as a move in another, and every window draws it cut until then", async () => {
  const { pasteboard, windows, clipboard } = setUp();
  // Window 1: ⌘X on two items in Documents.
  await clipboard.cut({ place: documents, paths: ["report.pdf", "Photos"], nativePaths: [report, photos] });
  assert.deepEqual(windows, { one: [report, photos], two: [report, photos] }, "every window draws them dimmed");
  assert.deepEqual(pasteboard.read().paths, [report, photos], "Finder can paste them too");
  // A window opened or brought to the front later asks, and is told the same.
  assert.deepEqual((await clipboard.current())?.nativePaths, [report, photos]);

  // Window 2 has nothing of its own on the clipboard: ⌘V asks about taken names first, then pastes.
  const { calls, transfer } = transfers();
  const asked = await clipboard.paste({ target, mode: "copy", internal: null, conflicts: { check: true } }, [], transfer);
  assert.equal("moved" in asked && asked.moved, true, "the check already says it moves");
  assert.deepEqual(windows.two, [report, photos], "asking about names keeps the Cut");
  const pasted = await clipboard.paste({ target, mode: "copy", internal: null, operationId: "fm-2" }, [], transfer);
  assert.deepEqual(calls.at(-1), {
    mode: "move",
    sources: [{ place: documents, path: "report.pdf" }, { place: documents, path: "Photos" }],
    target,
    operationId: "fm-2",
  }, "moved by the place it was cut in, under that place's move rules");
  assert.deepEqual(
    { fromHere: "fromHere" in pasted && pasted.fromHere, moved: "moved" in pasted && pasted.moved, cut: "cut" in pasted && pasted.cut, from: "from" in pasted ? pasted.from : undefined },
    { fromHere: true, moved: true, cut: true, from: { place: documents, paths: ["report.pdf", "Photos"] } },
  );

  // Pasted once: forgotten in every window, and gone from the pasteboard so it never moves twice.
  assert.deepEqual(windows, { one: null, two: null });
  assert.equal(pasteboard.fileList, null);
  assert.equal(clipboard.remembered, null);
  assert.deepEqual(await clipboard.paste({ target, mode: "copy", internal: null }, [], transfer), { mode: "copy", written: [], restorePoints: [], nothing: true });
});

test("a paste that failed or was stopped keeps the Cut only while every item is still where it was cut", async () => {
  // Stopped, or refused, before any item left its place: the Cut stays for another try.
  for (const answer of [() => ({ written: [], restorePoints: [], cancelled: true }), () => { throw new Error("busy"); }]) {
    const { pasteboard, windows, clipboard } = setUp();
    await clipboard.cut({ place: documents, paths: ["report.pdf", "Photos"], nativePaths: [report, photos] });
    const { transfer } = transfers(answer);
    await clipboard.paste({ target, mode: "copy", internal: null }, [], transfer).catch(() => undefined);
    assert.deepEqual(windows.one, [report, photos]);
    assert.notEqual(pasteboard.fileList, null);
  }
  // Stopped, or failed, after the first item moved: the rest are no longer cut, and nothing is left to paste.
  for (const stopped of [true, false]) {
    const { pasteboard, windows, gone, clipboard } = setUp();
    await clipboard.cut({ place: documents, paths: ["report.pdf", "Photos"], nativePaths: [report, photos] });
    const { transfer } = transfers(() => {
      gone.add(report);
      if (stopped) return { written: ["Inbox/report.pdf"], restorePoints: [], cancelled: true };
      throw new Error("“Photos” could not be moved.");
    });
    const pasting = clipboard.paste({ target, mode: "copy", internal: null }, [], transfer);
    if (stopped) await pasting;
    else await assert.rejects(pasting, /could not be moved/, "the failure still reaches the window");
    assert.deepEqual(windows, { one: null, two: null });
    assert.equal(pasteboard.fileList, null);
    assert.equal(clipboard.remembered, null);
  }
});

test("a Cut whose items were renamed or deleted since is forgotten in every window and leaves the pasteboard", async () => {
  const { pasteboard, windows, gone, clipboard } = setUp();
  await clipboard.cut({ place: documents, paths: ["report.pdf", "Photos"], nativePaths: [report, photos] });
  gone.add(photos);
  // A window comes to the front and asks: no folder lists the item any more, so Esc could not cancel it.
  assert.equal(await clipboard.current(), null);
  assert.deepEqual(windows, { one: null, two: null });
  assert.equal(pasteboard.fileList, null);
  const { calls, transfer } = transfers();
  assert.deepEqual(await clipboard.paste({ target, mode: "copy", internal: null }, [], transfer), { mode: "copy", written: [], restorePoints: [], nothing: true });
  assert.equal(calls.length, 0);
});

test("a paste that is first to find a cut item gone pastes nothing, never a copy of what was cut", async () => {
  const { pasteboard, windows, gone, clipboard } = setUp();
  await clipboard.cut({ place: documents, paths: ["report.pdf", "Photos"], nativePaths: [report, photos] });
  gone.add(photos);
  // No window has asked since: the paste's own check is the first to look.
  const { calls, transfer } = transfers();
  for (const request of [{ conflicts: { check: true } }, {}]) {
    assert.deepEqual(await clipboard.paste({ target, mode: "copy", internal: null, ...request }, [], transfer), { mode: "copy", written: [], restorePoints: [], nothing: true });
  }
  assert.equal(calls.length, 0, "nothing reaches the transfer");
  assert.deepEqual(windows, { one: null, two: null });
  assert.equal(pasteboard.fileList, null);
});

test("a Cut is kept while its own paste runs, though its items leave as they move", async () => {
  const { windows, gone, clipboard } = setUp();
  await clipboard.cut({ place: documents, paths: ["report.pdf", "Photos"], nativePaths: [report, photos] });
  let finish: (() => void) | null = null;
  const moving = new Promise<void>((resolve) => { finish = resolve; });
  let started: () => void = () => undefined;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const { transfer } = transfers(() => {
    started();
    return moving.then(() => ({ written: ["Inbox/report.pdf", "Inbox/Photos"], restorePoints: [] }));
  });
  const pasting = clipboard.paste({ target, mode: "copy", internal: null }, [], transfer);
  await begun;
  gone.add(report);
  // Another window comes to the front mid-move and asks: still cut, still drawn dimmed.
  assert.equal((await clipboard.current())?.nativePaths.length, 2);
  assert.deepEqual(windows.two, [report, photos]);
  gone.add(photos);
  finish!();
  await pasting;
  assert.deepEqual(windows, { one: null, two: null }, "forgotten once its paste ends");

  // Stopped partway instead: kept while it ran, forgotten once it ends with an item gone.
  const stopped = setUp();
  await stopped.clipboard.cut({ place: documents, paths: ["report.pdf", "Photos"], nativePaths: [report, photos] });
  const { transfer: stopping } = transfers(() => { stopped.gone.add(report); return { written: ["Inbox/report.pdf"], restorePoints: [], cancelled: true }; });
  await stopped.clipboard.paste({ target, mode: "copy", internal: null }, [], stopping);
  assert.equal(stopped.clipboard.remembered, null);
});

test("only a missing item, or a missing folder on its way, counts as gone from disk", async () => {
  const folder = await mkdtemp(join(tmpdir(), "amplefile-cut-"));
  try {
    const file = join(folder, "report.pdf");
    await writeFile(file, "x");
    assert.equal(await existsOnDisk(file), true);
    assert.equal(await existsOnDisk(join(folder, "renamed.pdf")), false, "ENOENT");
    assert.equal(await existsOnDisk(join(file, "inside")), false, "ENOTDIR");
    // A folder that cannot be searched now: its items are not known to be gone, so a Cut of them is kept.
    const locked = join(folder, "Locked");
    await mkdir(locked);
    await writeFile(join(locked, "a.txt"), "x");
    await chmod(locked, 0o000);
    try {
      if (process.getuid?.() !== 0) assert.equal(await existsOnDisk(join(locked, "a.txt")), true, "EACCES");
    } finally {
      await chmod(locked, 0o755);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a paste carries what its conflicts check asked about, and is refused when the pasteboard changed meanwhile", async () => {
  const { pasteboard, clipboard } = setUp();
  await clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  const { calls, transfer } = transfers();
  const asked = await clipboard.paste({ target, mode: "copy", internal: null, conflicts: { check: true } }, [], transfer);
  assert.match(String("plan" in asked && asked.plan), /^[0-9a-f]{64}$/);
  const plan = "plan" in asked ? asked.plan : undefined;
  // While the question is open, Finder copies the same file fresh: the run would copy it, not move it.
  pasteboard.finderCopies([report]);
  await assert.rejects(clipboard.paste({ target, mode: "copy", internal: null, operationId: "fm-3", plan }, [], transfer), /changed before the paste began/);
  assert.equal(calls.length, 1, "only the check reached the transfer");
  assert.notEqual(pasteboard.fileList, null, "the new Copy stays");

  // Unchanged, the run goes ahead with the same plan.
  const again = setUp();
  await again.clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  const checked = await again.clipboard.paste({ target, mode: "copy", internal: null, conflicts: { check: true } }, [], transfer);
  const pasted = await again.clipboard.paste({ target, mode: "copy", internal: null, plan: "plan" in checked ? checked.plan : undefined }, [], transfer);
  assert.equal("moved" in pasted && pasted.moved, true);
});

test("Finder copying the same files fresh does not inherit the Cut", async () => {
  const { pasteboard, windows, clipboard } = setUp();
  await clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  pasteboard.finderCopies([report]);
  // The window comes to the front and asks: the Cut is forgotten everywhere.
  assert.equal(await clipboard.current(), null);
  assert.deepEqual(windows, { one: null, two: null });
  const { calls, transfer } = transfers();
  await clipboard.paste({ target, mode: "copy", internal: null }, [], transfer);
  assert.deepEqual(calls[0], { mode: "copy", sources: [{ nativePath: report }], target }, "Finder's Copy pastes as a copy");
  assert.notEqual(pasteboard.fileList, null, "and stays on the pasteboard");
});

test("the Cut is forgotten when the pasteboard holds something else", async () => {
  // Another app copied text: the next paste or window focus finds no Cut.
  const text = setUp();
  await text.clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  text.pasteboard.copiesText("hello");
  const { transfer } = transfers();
  assert.deepEqual(await text.clipboard.paste({ target, mode: "copy", internal: null }, [], transfer), { mode: "copy", written: [], restorePoints: [], nothing: true });
  assert.deepEqual(text.windows, { one: null, two: null });

  // A Copy (or text) AmpleFile put there: the host knows at once.
  const copy = setUp();
  await copy.clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  copy.pasteboard.writeFiles([photos], null);
  copy.clipboard.replaced();
  assert.deepEqual(copy.windows, { one: null, two: null });

  // A newer Cut replaces the older one, in every window.
  const again = setUp();
  await again.clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  await again.clipboard.cut({ place: notes, paths: ["Ideas/one.md"], nativePaths: ["/Users/ana/Notes/Ideas/one.md"] });
  assert.deepEqual(again.windows.two, ["/Users/ana/Notes/Ideas/one.md"]);
  assert.equal((await again.clipboard.current())?.place, notes);
});

test("cancelling a Cut forgets it everywhere and leaves nothing to paste, but never clears another app's Copy", async () => {
  const { pasteboard, windows, clipboard } = setUp();
  await clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  await clipboard.cancel();
  assert.deepEqual(windows, { one: null, two: null });
  assert.equal(pasteboard.fileList, null);

  await clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  pasteboard.copiesText("kept");
  await clipboard.cancel();
  assert.equal(pasteboard.text, "kept");
  assert.equal(clipboard.remembered, null);
});

test("a slow look at the pasteboard never forgets a newer Cut", async () => {
  let release: (() => void) | null = null;
  let slow = true;
  const { pasteboard, windows, clipboard } = setUp({
    read: (board) => {
      if (!slow) return board.read();
      slow = false;
      const before = board.read();
      return new Promise<PasteboardFiles>((resolve) => { release = () => resolve(before); });
    },
  });
  await clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  pasteboard.copiesText("elsewhere");
  const looking = clipboard.current();
  // Meanwhile another window cuts something else.
  await clipboard.cut({ place: documents, paths: ["Photos"], nativePaths: [photos] });
  release!();
  assert.equal(await looking, null, "the old Cut is gone");
  assert.deepEqual(windows.one, [photos], "the newer one stays drawn");
  assert.equal(clipboard.remembered?.nativePaths[0], photos);
});

test("a Copy during the disk check invalidates an already planned Cut paste", async () => {
  for (const fromAmpleFile of [true, false]) {
    const entered = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let running = false;
    const { pasteboard, clipboard } = setUp({ exists: async () => {
      if (running) {
        entered.resolve();
        await finished.promise;
      }
      return true;
    } });
    await clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
    const { calls, transfer } = transfers();
    const request = { target, mode: "copy" as const, internal: null };
    const preview = await clipboard.paste({ ...request, conflicts: { check: true } }, [], transfer);
    assert.ok("plan" in preview && preview.plan);
    running = true;
    const paste = clipboard.paste({ ...request, plan: preview.plan }, [], transfer);
    await entered.promise;
    pasteboard.finderCopies([report]);
    if (fromAmpleFile) clipboard.replaced();
    finished.resolve();
    await assert.rejects(paste, /The clipboard changed/);
    assert.equal(calls.length, 1, "only the conflict check reached the transfer");
    assert.deepEqual(pasteboard.read().paths, [report], "the newer Copy stays");
  }
});

/** A clipboard the desktop reads no files from (off the Mac): AmpleFile writes files there as their paths, as text. */
function setUpTextClipboard(lineEnding = "\n") {
  const board = { text: "" };
  const windows = { one: null as string[] | null };
  const clipboard = new FileClipboard({
    read: () => ({ paths: [], operation: null, unreadable: true, text: board.text }),
    // The system may give the text back with its own line endings.
    write: (nativePaths) => { board.text = pasteboardFileText(nativePaths).replace(/\n/g, lineEnding); },
    clear: () => { board.text = ""; },
    exists: () => true,
    token: () => null,
    changed: (nativePaths) => { windows.one = nativePaths ? [...nativePaths] : null; },
  });
  return { board, windows, clipboard };
}

test("where the pasteboard reads no files, a Cut holds while the clipboard's text is still its paths", async () => {
  for (const lineEnding of ["\n", "\r\n"]) {
    const { board, clipboard } = setUpTextClipboard(lineEnding);
    await clipboard.cut({ place: documents, paths: ["report.pdf", "Photos"], nativePaths: [report, photos] });
    const { calls, transfer } = transfers();
    await clipboard.paste({ target, mode: "copy", internal: null }, [], transfer);
    assert.equal(calls[0]?.mode, "move");
    assert.equal(clipboard.remembered, null);
    assert.equal(board.text, "", "pasted once, it leaves the clipboard");
  }
});

test("where the pasteboard reads no files, forgetting a Cut never empties text copied since", async () => {
  // Esc after the person copied text in another app.
  const cancelled = setUpTextClipboard();
  await cancelled.clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  cancelled.board.text = "a note copied elsewhere";
  await cancelled.clipboard.cancel();
  assert.equal(cancelled.board.text, "a note copied elsewhere");
  assert.equal(cancelled.windows.one, null);

  // ⌘V after the same: the Cut is gone, so nothing moves and the text stays.
  const pasted = setUpTextClipboard();
  await pasted.clipboard.cut({ place: documents, paths: ["report.pdf"], nativePaths: [report] });
  pasted.board.text = "a note copied elsewhere";
  const { calls, transfer } = transfers();
  assert.deepEqual(await pasted.clipboard.paste({ target, mode: "copy", internal: null }, [], transfer), { mode: "copy", written: [], restorePoints: [], nothing: true });
  assert.equal(calls.length, 0);
  assert.equal(pasted.board.text, "a note copied elsewhere");
  assert.equal(pasted.windows.one, null);
});

test("a window's Cut request names each item by place and on disk, one for one", () => {
  assert.deepEqual(parseCutItems({ paths: [report], operation: "cut", from: { place: documents, paths: ["report.pdf"] } }), { place: documents, paths: ["report.pdf"], nativePaths: [report] });
  assert.throws(() => parseCutItems({ paths: [report], operation: "cut" }), /items to cut/);
  assert.throws(() => parseCutItems({ paths: [report, photos], from: { place: documents, paths: ["report.pdf"] } }), /items to cut/);
  assert.throws(() => parseCutItems({ paths: ["report.pdf"], from: { place: documents, paths: ["report.pdf"] } }), /items to cut/);
  assert.throws(() => parseCutItems({ paths: [report], from: { place: { kind: "elsewhere", id: "x" }, paths: ["report.pdf"] } }), /items to cut/);
  assert.throws(() => parseCutItems({ paths: [], from: { place: documents, paths: [] } }), /items to cut/);
});

test("each window draws the Cut in the place it shows, whatever place it was cut in", () => {
  // Cut in a Connected Folder, shown in another window at the disk's top or in the Connected Folder itself.
  assert.equal(nativePathEntryPath("/", "/Users/ana/Notes/Ideas/one.md", "darwin"), "Users/ana/Notes/Ideas/one.md");
  assert.equal(nativePathEntryPath("/Users/ana/Notes", "/Users/ana/Notes/Ideas/one.md", "darwin"), "Ideas/one.md");
  assert.equal(nativePathEntryPath("/Users/ana/Notes/", "/Users/ana/Notes/Ideas", "darwin"), "Ideas");
  assert.equal(nativePathEntryPath("/Users/ana/Notes", "/Users/ana/Notes-old/x", "darwin"), null);
  assert.equal(nativePathEntryPath("/Users/ana/Notes", "/Users/ana/Notes", "darwin"), null);
  assert.equal(nativePathEntryPath("C:\\Users\\ana", "C:\\Users\\ana\\Notes\\one.md", "win32"), "Notes/one.md");
});
