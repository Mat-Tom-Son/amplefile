import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyAmpleFileAgentAttachments,
  loadAmpleFileAgentAttachmentsForTurn,
  ampleFileAgentAttachmentDispositions,
  ampleFileAgentAttachmentLinks,
  maxAmpleFileAgentAttachments,
} from "../src/local/amplefile-agent-attachments.js";

test("management attachments classify files, folders, and links as typed references", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-agent-attachments-test-"));
  try {
    await writeFile(join(sandbox, "report.txt"), "external report", "utf8");
    await mkdir(join(sandbox, "incoming"), { recursive: true });
    for (const reserved of [".amplefile", ".WORK-FOLD", ".Pi"]) {
      await mkdir(join(sandbox, "nested", reserved), { recursive: true });
      await writeFile(join(sandbox, "nested", reserved, "private.txt"), "private", "utf8");
    }

    const refs = await classifyAmpleFileAgentAttachments(
      [join(sandbox, "report.txt"), "incoming", "https://example.com/owner/project"],
      sandbox,
    );
    assert.deepEqual(refs.map((ref) => ref.kind), ["file", "folder", "url"]);
    assert.equal(refs[0]!.target, join(sandbox, "report.txt"));
    assert.equal(refs[0]!.name, "report.txt");
    assert.equal(refs[1]!.target, join(sandbox, "incoming"), "relative paths resolve against the caller's cwd");
    assert.equal(refs[2]!.target, "https://example.com/owner/project");
    assert.equal(refs[2]!.name, "example.com/owner/project");
    assert.deepEqual(ampleFileAgentAttachmentLinks(refs), ["https://example.com/owner/project"]);

    // Duplicates collapse to one reference.
    const deduped = await classifyAmpleFileAgentAttachments(
      [join(sandbox, "report.txt"), join(sandbox, "report.txt")],
      sandbox,
    );
    assert.equal(deduped.length, 1);

    await assert.rejects(() => classifyAmpleFileAgentAttachments(["missing.txt"], sandbox), /not found/);
    await assert.rejects(() => classifyAmpleFileAgentAttachments(["ftp://example.com/file"], sandbox), /Only http\(s\) links/);
    await assert.rejects(() => classifyAmpleFileAgentAttachments(["https://[broken"], sandbox), /Invalid link/);
    await assert.rejects(() => classifyAmpleFileAgentAttachments(["https://user:secret@example.com/file"], sandbox), /embedded credentials/);
    await assert.rejects(() => classifyAmpleFileAgentAttachments([""], sandbox), /cannot be empty/);
    for (const reserved of [".amplefile", ".WORK-FOLD", ".Pi"]) {
      await assert.rejects(
        () => classifyAmpleFileAgentAttachments([join(sandbox, "nested", reserved, "private.txt")], sandbox),
        /reserved/i,
      );
    }
    await assert.rejects(
      () => classifyAmpleFileAgentAttachments(Array.from({ length: maxAmpleFileAgentAttachments + 1 }, () => join(sandbox, "report.txt")), sandbox),
      /At most/,
    );
    if (process.platform !== "win32") {
      await symlink(join(sandbox, "report.txt"), join(sandbox, "linked.txt"));
      await assert.rejects(() => classifyAmpleFileAgentAttachments([join(sandbox, "linked.txt")], sandbox), /Symbolic links/);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("management attachment loading inlines readable files and keeps folders and binaries path-only", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-agent-attachments-load-test-"));
  try {
    await writeFile(join(sandbox, "notes.md"), "# Notes\nplain readable text\n", "utf8");
    await writeFile(join(sandbox, "binary.bin"), Buffer.from([0, 1, 2, 0, 3, 4, 0, 5]));
    await mkdir(join(sandbox, "material"), { recursive: true });

    const refs = await classifyAmpleFileAgentAttachments(
      [join(sandbox, "notes.md"), join(sandbox, "binary.bin"), join(sandbox, "material"), "https://example.com"],
      sandbox,
    );
    const loaded = await loadAmpleFileAgentAttachmentsForTurn(refs);

    // Links never masquerade as files: three filesystem references load.
    assert.equal(loaded.length, 3);

    const notes = loaded.find((item) => item.sourceFileName === "notes.md")!;
    assert.equal(notes.mode, "full_original_text");
    assert.equal(notes.includedInPrompt, true);
    assert.match(notes.text ?? "", /plain readable text/);
    assert.equal(notes.sourcePath, join(sandbox, "notes.md"), "management attachments carry absolute paths");

    const binary = loaded.find((item) => item.sourceFileName === "binary.bin")!;
    assert.equal(binary.mode, "path_only_reference");
    assert.equal(binary.includedInPrompt, false);
    assert.equal(binary.text, null);

    const folder = loaded.find((item) => item.sourceFileName === "material")!;
    assert.equal(folder.mode, "path_only_reference");
    assert.match(folder.reason ?? "", /Folders are attached by path/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("attachment dispositions account for every attachment and never guess", () => {
  // The accounting reads the attachment references and the recorded action
  // trail of a request; it does not depend on the durable store that holds
  // them.
  const dispositions = ampleFileAgentAttachmentDispositions({
    attachments: [
      { kind: "file", target: "/tmp/report.pdf", name: "report.pdf" },
      { kind: "folder", target: "/tmp/project", name: "project" },
      { kind: "url", target: "https://example.com/repo", name: "example.com/repo" },
    ],
    actions: [
      {
        command: "files.add",
        connectedFolderId: "connected-folder-1",
        connectedFolderName: "Vendor Audits",
        sources: ["/tmp/report.pdf"],
        copied: ["Inbox/report.pdf"],
        checkpointId: "cp-1",
      },
      {
        command: "connected-folders.register",
        connectedFolderId: "connected-folder-2",
        connectedFolderName: "Project",
        connectedFolderRoot: "/tmp/project",
      },
    ],
  });
  assert.equal(dispositions.length, 3, "every attachment appears in the story");
  assert.equal(dispositions[0]!.status, "placed");
  assert.equal(dispositions[0]!.connectedFolderName, "Vendor Audits");
  assert.deepEqual(dispositions[0]!.copied, ["Inbox/report.pdf"]);
  assert.equal(dispositions[0]!.checkpointId, "cp-1");
  assert.equal(dispositions[1]!.status, "registered");
  assert.equal(dispositions[1]!.connectedFolderName, "Project");
  assert.equal(dispositions[2]!.status, "unrecorded", "a link with no mechanical match stays honestly unrecorded");
});
