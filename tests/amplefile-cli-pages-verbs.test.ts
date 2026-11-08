import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { AmpleFileActPageValidation } from "../src/local/cli/act-facade.js";
import type { AmpleFileCliActReceiptV3 } from "../src/local/cli/act-receipts.js";
import { parseAmpleFileCliActArgv } from "../src/local/cli/act-commands.js";
import { ampleFileCliHelp } from "../src/local/cli/commands.js";
import { createAmpleFileCliActRequest, executeAmpleFileCliActRequest } from "../src/local/cli/index.js";
import { AmpleFileCliError } from "../src/local/cli/protocol.js";
import { startLocalApi } from "../src/local/server.js";

/**
 * `amplefile pages validate` (docs/pages.md, "For the Worker";
 * docs/amplefile-agent-and-cli.md): argv → act executor → the real facade.
 */

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pages", "sign-up-sheet");
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = "p".repeat(64);
type ReceiptEntry = Omit<AmpleFileCliActReceiptV3, "v" | "at">;

async function setup(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-pages-cli-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Events" });
  await cp(fixture, join(connectedFolder.connectedFolderRoot, "Sign up"), { recursive: true });
  const records: ReceiptEntry[] = [];
  const run = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      receipts: {
        hasAccepted: async (requestId) => records.some((record) => record.requestId === requestId && record.outcome === "accepted"),
        append: async (record) => { records.push(structuredClone(record)); return true; },
      },
    },
  );
  return { api, connectedFolder, records, run };
}

function usage(argv: string[]): string {
  try {
    parseAmpleFileCliActArgv(argv);
  } catch (error) {
    assert.ok(error instanceof AmpleFileCliError);
    assert.equal(error.code, "usage");
    return error.message;
  }
  assert.fail(`expected a usage error for ${argv.join(" ")}`);
}

test("pages validate parses an explicit Connected Folder and page folder", () => {
  assert.deepEqual(parseAmpleFileCliActArgv(["pages", "validate", "--connected-folder", "Events", "--page", "Sign up", "--json"]), {
    name: "pages.validate",
    output: "json",
    connectedFolder: "Events",
    page: "Sign up",
  });
  assert.match(usage(["pages", "validate", "--connected-folder", "Events"]), /Provide --page <page-folder-path>/);
  assert.match(usage(["pages", "validate", "--page", "Sign up"]), /--connected-folder/);
  assert.match(usage(["pages", "validate", "--connected-folder", "Events", "--page", "Sign up", "--path", "x"]), /--path cannot be used/);
  assert.match(usage(["pages", "validate", "--connected-folder", "Events", "--page", "Sign up", "--parent-task", "t"]), /--parent-task cannot be used/);
  assert.match(usage(["pages", "share", "--connected-folder", "Events", "--page", "Sign up"]), /Unknown command: pages share/);
  // Pages are not published to the web: the publishing verbs are gone.
  assert.match(usage(["pages", "publish", "--connected-folder", "Events", "--page", "Sign up"]), /Unknown command: pages publish/);
  assert.match(usage(["pages", "unpublish", "--connected-folder", "Events", "--page", "Sign up"]), /Unknown command: pages unpublish/);
  assert.match(usage(["pages", "list"]), /Unknown command: pages list/);
  const pagesHelp = ampleFileCliHelp("AmpleFile", "pages");
  assert.match(pagesHelp, /pages validate --connected-folder <id-or-name> --page <page-folder-path>/);
  assert.doesNotMatch(pagesHelp, /publish|unpublish|pages list/);
  const help = ampleFileCliHelp("AmpleFile");
  assert.match(help, /pages validate\s+Check a page folder/);
  assert.doesNotMatch(help, /pages publish|pages unpublish|pages list|Web Access|pairing/);
  assert.match(help, /Act tokens and provider\s+credentials are local setup: this CLI refuses them\./);
});

test("pages validate reports a stable JSON shape, a readable summary, and a receipt", async (t) => {
  const { run, records, connectedFolder } = await setup(t);
  const result = await run(["pages", "validate", "--connected-folder", connectedFolder.id, "--page", "Sign up", "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout) as { ok: boolean; command: string; data: AmpleFileActPageValidation };
  assert.equal(output.ok, true);
  assert.equal(output.command, "pages.validate");
  assert.deepEqual(output.data, {
    connectedFolder: { id: connectedFolder.id, name: "Events", connectedFolderRoot: connectedFolder.connectedFolderRoot },
    page: "Sign up",
    valid: true,
    summary: {
      title: "Volunteer Sign-up",
      entry: "index.html",
      tables: [{ name: "signups", columns: ["name", "email", "shift", "notes"], visitors: ["add", "see-own"], limit: 3 }],
      files: 9,
      bytes: output.data.summary.bytes,
    },
    problems: [{
      file: "thanks.html",
      message: "Only index.html is the page, so this file isn't used. A page that needs several screens switches them in script.",
      severity: "warning",
    }],
  });
  assert.deepEqual(records.map((record) => [record.command, record.outcome, record.detail]), [
    ["pages.validate", "accepted", `Connected Folder ${connectedFolder.id}`],
    ["pages.validate", "ok", "page Sign up; valid"],
  ]);
  assert.equal(records[1]!.connectedFolderId, connectedFolder.id);

  const human = await run(["pages", "validate", "--connected-folder", "Events", "--page", "Sign up"]);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout, /^Volunteer Sign-up \[Sign up\] in Events \[[^\]]+\]: ready, with 1 warning\./u);
  assert.match(human.stdout, /- warning: thanks\.html: Only index\.html is the page/u);
  assert.match(human.stdout, /Entry index\.html; 9 files, \d+ bytes; tables: signups \(name, email, shift, notes\)\./u);
});

test("a page with problems is a successful check that says what to fix", async (t) => {
  const { run, records, connectedFolder } = await setup(t);
  const pageJson = join(connectedFolder.connectedFolderRoot, "Sign up", "page.json");
  const declaration = JSON.parse(await readFile(pageJson, "utf8")) as Record<string, unknown>;
  await writeFile(pageJson, JSON.stringify({ ...declaration, theme: "dark" }));
  await writeFile(join(connectedFolder.connectedFolderRoot, "Sign up", "index.html"), `<script src="https://cdn.example.com/lib.js"></script>`);
  const result = await run(["pages", "validate", "--connected-folder", connectedFolder.id, "--page", "Sign up", "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const data = (JSON.parse(result.stdout) as { data: AmpleFileActPageValidation }).data;
  assert.equal(data.valid, false);
  assert.equal(data.summary.title, "Volunteer Sign-up");
  assert.deepEqual(data.summary.tables, [], "tables are listed once page.json is valid");
  assert.deepEqual(data.problems.filter((problem) => problem.severity === "error").map((problem) => problem.file), ["page.json", "index.html"]);
  assert.equal(records.at(-1)!.detail, "page Sign up; 2 errors");
  const human = await run(["pages", "validate", "--connected-folder", connectedFolder.id, "--page", "Sign up"]);
  assert.match(human.stdout, /: 2 errors and 1 warning to fix\./u);
  assert.match(human.stdout, /- error: page\.json: theme: isn't a known field\./u);
});

test("a folder that isn't a page, or a path outside the Connected Folder, is refused", async (t) => {
  const { run, connectedFolder } = await setup(t);
  const missing = await run(["pages", "validate", "--connected-folder", connectedFolder.id, "--page", "Nowhere", "--json"]);
  assert.notEqual(missing.exitCode, 0);
  assert.equal((JSON.parse(missing.stderr) as { error: { code: string } }).error.code, "notFound");
  const outside = await run(["pages", "validate", "--connected-folder", connectedFolder.id, "--page", "../elsewhere", "--json"]);
  assert.equal((JSON.parse(outside.stderr) as { error: { code: string } }).error.code, "usage");
  const unknownConnectedFolder = await run(["pages", "validate", "--connected-folder", "No such Connected Folder", "--page", "Sign up", "--json"]);
  assert.notEqual(unknownConnectedFolder.exitCode, 0);
});

test("the macOS shim routes pages validate to the act lane", async () => {
  const jxa = await readFile(join(rootDir, "desktop", "cli", "amplefile-cli.jxa.js"), "utf8");
  assert.match(jxa, /if \(group === "pages"\) return \["validate"\]\.includes\(positional\[1\]\);/u);
});
