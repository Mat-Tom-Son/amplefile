import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readAmpleFileCliActTokenFile,
  removeAmpleFileCliActTokenFile,
  ampleFileCliActTokenPath,
  writeAmpleFileCliActTokenFile,
} from "../src/local/cli/index.js";

const token = "b".repeat(64);
const rotated = "c".repeat(64);

test("act token file writes atomically, rotates in place, and round-trips", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-token-test-"));
  try {
    await writeAmpleFileCliActTokenFile(sandbox, token, "AmpleFile Test");
    const path = ampleFileCliActTokenPath(sandbox);
    const first = await readAmpleFileCliActTokenFile(sandbox);
    assert.equal(first?.actToken, token);
    assert.equal(first?.product, "AmpleFile Test");
    assert.ok(Number.isFinite(Date.parse(first?.createdAt ?? "")));
    if (process.platform !== "win32") {
      assert.equal(((await stat(path)).mode & 0o777), 0o600, "the token file must be private to this user");
    }

    // Rotation replaces a stale file from a previous app run.
    await writeAmpleFileCliActTokenFile(sandbox, rotated, "AmpleFile Test");
    assert.equal((await readAmpleFileCliActTokenFile(sandbox))?.actToken, rotated);
    assert.equal((await readFile(path, "utf8")).includes(token), false);

    await removeAmpleFileCliActTokenFile(sandbox);
    assert.equal(await readAmpleFileCliActTokenFile(sandbox), null);
    await removeAmpleFileCliActTokenFile(sandbox);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("malformed or oversized token files read as absent", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-act-token-test-"));
  try {
    assert.equal(await readAmpleFileCliActTokenFile(sandbox), null);
    await writeAmpleFileCliActTokenFile(sandbox, token, "AmpleFile Test");
    const path = ampleFileCliActTokenPath(sandbox);
    for (const bad of [
      "{nope",
      JSON.stringify({ version: 2, actToken: token, createdAt: new Date().toISOString(), product: "x" }),
      JSON.stringify({ version: 1, actToken: "short", createdAt: new Date().toISOString(), product: "x" }),
      JSON.stringify({ version: 1, actToken: token, createdAt: "yesterday", product: "x" }),
      JSON.stringify({ version: 1, actToken: token, createdAt: new Date().toISOString(), product: " " }),
      `{"version":1,"actToken":"${token}","createdAt":"${new Date().toISOString()}","product":"${"x".repeat(8 * 1024)}"}`,
    ]) {
      await writeFile(path, bad, "utf8");
      assert.equal(await readAmpleFileCliActTokenFile(sandbox), null, `must reject: ${bad.slice(0, 40)}`);
    }
    await assert.rejects(() => writeAmpleFileCliActTokenFile(sandbox, "short", "AmpleFile Test"), /malformed/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
