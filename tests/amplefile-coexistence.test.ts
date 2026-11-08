import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  connectedFolderSessionDir,
  connectedFolderStorageKey,
} from "../src/local/agent/agent-data-dir.js";
import { reservedSearchSegments } from "../src/local/agent/reserved-path-search.js";
import { isAlwaysHiddenConnectedFolderEntry } from "../src/local/connected-folder-ignore.js";
import { isReservedConnectedFolderPathSegment } from "../src/local/connected-folder-path-policy.js";
import { isHistoryAlwaysSkippedSegment } from "../src/local/history-capture-policy.js";

let sandbox = "";

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "amplefile-coexistence-"));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test("other Pi sessions remain intact beside the AmpleFile session namespace", async () => {
  const connectedFolderRoot = join(sandbox, "session-connected-folder");
  const agentRoot = join(sandbox, "pi-agent");
  const connectedFolderKey = connectedFolderStorageKey(connectedFolderRoot);
  const otherSessionRoot = join(agentRoot, "sessions", connectedFolderKey);
  const otherSessionPath = join(otherSessionRoot, "session.jsonl");
  await mkdir(otherSessionRoot, { recursive: true });
  const otherBytes = Buffer.from([0, 255, 17, 34, 51, 68, 85]);
  await writeFile(otherSessionPath, otherBytes);
  const before = await snapshots([otherSessionPath]);

  const newSessionRoot = connectedFolderSessionDir(connectedFolderRoot, agentRoot);
  assert.equal(newSessionRoot, join(agentRoot, "sessions", "amplefile", connectedFolderKey));
  assert.notEqual(newSessionRoot, otherSessionRoot);
  await mkdir(newSessionRoot, { recursive: true });
  await writeFile(join(newSessionRoot, "session.jsonl"), "new AmpleFile session\n", "utf8");

  assert.deepEqual(await snapshots([otherSessionPath]), before);
  assert.deepEqual(await readFile(otherSessionPath), otherBytes);
});

async function snapshots(paths: string[]): Promise<Array<{ path: string; bytes: Buffer; mtimeMs: number }>> {
  return Promise.all(paths.map(async (path) => ({
    path,
    bytes: await readFile(path),
    mtimeMs: (await stat(path)).mtimeMs,
  })));
}

test("a .work-fold folder stays hidden from Files, History, and search", () => {
  // A folder once used with an earlier app keeps its .work-fold/ folder.
  // AmpleFile never reads it, and it never shows it.
  for (const name of [".work-fold", ".amplefile", ".pi"]) {
    assert.equal(isReservedConnectedFolderPathSegment(name), true, `${name} is reserved`);
    assert.equal(isAlwaysHiddenConnectedFolderEntry(name), true, `${name} is hidden in Files`);
  }
  assert.equal(isReservedConnectedFolderPathSegment(".Work-Fold"), true, "matching ignores case");
  for (const name of [".work-fold", ".amplefile"]) {
    assert.equal(isHistoryAlwaysSkippedSegment(name), true, `${name} is left out of History`);
    assert.ok((reservedSearchSegments as readonly string[]).includes(name), `${name} is left out of search`);
  }
  assert.equal(isAlwaysHiddenConnectedFolderEntry("Fold notes"), false, "ordinary names stay visible");
});
