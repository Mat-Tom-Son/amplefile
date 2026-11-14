import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { findCssBrowser } from "./support/css-browser.js";

const run = promisify(execFile);

// The Preview's real layout in Chromium, from the shipped style sheets: it
// floats inside the window at any size, a long line wraps instead of
// scrolling sideways, a big picture fits, and dialogs still draw above it.
test("the Preview fits the window, wraps long lines, fits pictures, and stays under dialogs", { timeout: 60_000 }, async (t) => {
  const browser = await findCssBrowser();
  if (!browser) { t.skip("Chromium is required for the Preview layout test."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "amplefile-preview-css-"));
  try {
    const sheets = ["brand.css", "styles.css", "components/file-manager/file-manager-tokens.css", "components/file-manager/file-manager.css", "components/file-manager/file-manager-preview.css"];
    const css = (await Promise.all(sheets.map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    // A 4000×3000 picture, drawn without any load.
    const picture = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='4000' height='3000'><rect width='4000' height='3000' fill='teal'/></svg>")}`;
    const panel = (body: string, kind: string) => `<div class="fm-preview" role="dialog" aria-label="Preview of x"><div class="fm-preview-bar"><span class="fm-preview-name">${"very-long-file-name-".repeat(12)}.txt</span><button class="fm-btn is-small">Open</button><button class="fm-capbtn fm-preview-close">×</button></div><div class="fm-preview-body ${kind}">${body}</div></div>`;
    const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><body style="margin:0"><main class="app-shell layout-file-manager"><div id="stage"></div></main><pre id="result">pending</pre><script>
      const stage = document.getElementById('stage');
      const text = ${JSON.stringify(panel(`<pre class="fm-preview-text">${"x".repeat(5000)}\n${"line\n".repeat(400)}</pre>`, "is-text"))};
      const image = ${JSON.stringify(panel(`<img class="fm-preview-image" src="${picture}">`, "is-image"))};
      const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const results = {};
      stage.innerHTML = text;
      const shell = document.querySelector('.fm-preview');
      const body = document.querySelector('.fm-preview-body');
      results.viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, innerWidth, innerHeight };
      results.text = { panel: box(shell), bodyScrollWidth: body.scrollWidth, bodyClientWidth: body.clientWidth, bodyScrolls: body.scrollHeight > body.clientHeight, overflowY: getComputedStyle(body).overflowY, name: box(document.querySelector('.fm-preview-name')), bar: box(document.querySelector('.fm-preview-bar')), close: box(document.querySelector('.fm-preview-close')), z: getComputedStyle(shell).zIndex };
      stage.innerHTML = image;
      const img = document.querySelector('.fm-preview-image');
      img.decode().catch(() => {}).finally(() => {
        results.image = { panel: box(document.querySelector('.fm-preview')), body: box(document.querySelector('.fm-preview-body')), img: box(img) };
        const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop'; document.querySelector('.app-shell').append(backdrop);
        results.dialogZ = getComputedStyle(backdrop).zIndex;
        document.getElementById('result').textContent = JSON.stringify(results);
      });
    </script>`;
    const path = join(scratch, "fixture.html");
    await writeFile(path, html);
    for (const [width, height] of [[1280, 800], [520, 420]] as const) {
      const { stdout } = await run(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=2000", "--disable-features=HangWatcher", `--window-size=${width},${height}`, `--user-data-dir=${join(scratch, `profile-${width}`)}`, "--dump-dom", pathToFileURL(path).href], { timeout: 45_000, maxBuffer: 20_000_000 });
      const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
      assert.ok(serialized && serialized !== "pending", `${width}×${height} produced a result`);
      const result = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
      const { viewport, text, image } = result;
      const at = `${width}×${height}`;
      for (const panel of [text.panel, image.panel]) {
        assert.ok(panel.left >= 0 && panel.top >= 0 && panel.right <= viewport.width && panel.bottom <= viewport.height, `${at}: the Preview stays inside the window`);
        assert.ok(Math.abs((panel.left + panel.right) / 2 - viewport.width / 2) <= 1, `${at}: centered across ${JSON.stringify({ panel, viewport })}`);
      }
      assert.ok(text.panel.width <= 760 && text.panel.height <= 620, `${at}: never larger than its design size`);
      assert.ok(text.bodyScrollWidth <= text.bodyClientWidth, `${at}: a long line wraps instead of scrolling sideways`);
      assert.equal(text.overflowY, "auto");
      assert.ok(text.bodyScrolls, `${at}: long text scrolls inside the Preview`);
      assert.ok(text.name.right <= text.close.left, `${at}: a long name is cut short before Close`);
      assert.ok(text.close.right <= text.bar.right, `${at}: Close stays in the bar`);
      assert.ok(image.img.width > 0 && image.img.left >= image.body.left && image.img.right <= image.body.right && image.img.top >= image.body.top && image.img.bottom <= image.body.bottom, `${at}: a big picture fits the Preview`);
      assert.ok(Math.abs(image.img.width / image.img.height - 4 / 3) < 0.02, `${at}: and keeps its proportions`);
      assert.ok(Number(text.z) < Number(result.dialogZ), `${at}: dialogs draw above the Preview`);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
