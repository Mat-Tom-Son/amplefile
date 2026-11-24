import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { newestLinuxPreview } from "../site/linux-preview.mjs";

const release = (tag_name: string, published_at: string | null, extra: Record<string, unknown> = {}) =>
  ({ tag_name, published_at, prerelease: tag_name.startsWith("linux-"), draft: false, html_url: `https://github.com/Mat-Tom-Son/amplefile/releases/tag/${tag_name}`, ...extra });

test("the Linux link opens the preview published last, not the first one GitHub lists", () => {
  // GitHub's own order on the day linux-0.2.2 was published, hours after linux-test-0.2.1.
  const listed = [
    release("v0.2.1", "2026-11-24T05:39:40Z"),
    release("v0.2.0", "2026-11-24T00:34:14Z"),
    release("linux-test-0.2.1", "2026-11-24T13:49:49Z"),
    release("linux-0.2.2", "2026-11-24T22:24:45Z"),
    release("v0.1.9", "2026-11-23T13:58:52Z"),
    release("linux-test-0.1.8-2", "2026-11-23T01:53:00Z"),
  ];
  assert.equal(newestLinuxPreview(listed)?.tag_name, "linux-0.2.2");
  assert.equal(newestLinuxPreview([...listed].reverse())?.tag_name, "linux-0.2.2", "whatever order the list comes in");
});

test("only a published Linux prerelease is ever opened", () => {
  assert.equal(newestLinuxPreview([
    release("linux-0.3.0", "2026-12-03T00:00:00Z", { draft: true }),
    release("linux-0.2.9", "2026-12-02T00:00:00Z", { prerelease: false }),
    release("v0.3.0", "2026-12-01T00:00:00Z", { prerelease: true }),
    release("linux-0.2.2", "2026-11-24T22:24:45Z"),
  ])?.tag_name, "linux-0.2.2");
  assert.equal(newestLinuxPreview([release("v0.2.1", "2026-11-24T05:39:40Z")]), null);
  for (const answer of [null, undefined, {}, "rate limited", [null, 7, {}]]) assert.equal(newestLinuxPreview(answer), null);
});

test("previews with no readable publish time keep the list's order", () => {
  assert.equal(newestLinuxPreview([release("linux-0.2.3", null), release("linux-0.2.2", "not a date")])?.tag_name, "linux-0.2.3");
  assert.equal(newestLinuxPreview([release("linux-0.2.2", null), release("linux-0.2.3", "2026-12-01T00:00:00Z")])?.tag_name, "linux-0.2.3");
});

test("the built page carries this function and uses it for its Linux links", () => {
  const page = readFileSync(new URL("../site/public/index.html", import.meta.url), "utf8");
  const squeeze = (text: string) => text.replace(/\s+/g, " ");
  assert.ok(squeeze(page).includes(squeeze(newestLinuxPreview.toString())), "the built site was rebuilt with the current function (npm run site:build)");
  assert.match(page, /const rel = newestLinuxPreview\(list\);/);
});
