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

const controls = (side: string, buttons: string[]) => `<div class="desktop-window-controls desktop-window-controls--${side}" role="group" aria-label="Window">${buttons.map((button) => `<button class="desktop-window-control desktop-window-control--${button}" type="button" aria-label="${button}"><svg viewBox="0 0 16 16"><path d="M4 8h8"/></svg></button>`).join("")}</div>`;
const bar = (id: string, linux: boolean, left: string[], right: string[]) => `<div class="app-shell desktop-chrome-shell layout-file-manager" id="${id}" style="position:relative;width:1200px;height:80px"><header class="desktop-titlebar${linux ? " desktop-titlebar--linux" : ""}" style="position:absolute">
  ${left.length ? controls("left", left) : ""}
  <div class="desktop-titlebar-brand"><span class="desktop-titlebar-name">AmpleFile</span></div>
  <nav class="desktop-titlebar-menu"><button class="desktop-titlebar-menu-button">File</button><button class="desktop-titlebar-menu-button">Help</button></nav>
  <div class="desktop-titlebar-drag-spacer"></div>
  ${right.length ? controls("right", right) : ""}
</header></div>`;

test("the Linux title bar lays its own window buttons out where the desktop's layout puts them", { timeout: 45_000 }, async (t) => {
  const browser = await findCssBrowser();
  if (!browser) { t.skip("Chromium is required for the title bar layout test."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "amplefile-titlebar-css-"));
  try {
    const sheets = ["brand.css", "styles.css", "application-appearance.css", "components/file-manager/file-manager.css"];
    const css = (await Promise.all(sheets.map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const html = `<!doctype html><html data-platform="linux"><style>${css}</style><body>
      ${bar("right", true, [], ["minimize", "maximize", "close"])}
      ${bar("left", true, ["close", "minimize"], [])}
      ${bar("none", true, [], [])}
      ${bar("windows", false, [], [])}
      <pre id="result">pending</pre><script>
      const measure = (id) => {
        const root = document.getElementById(id);
        const header = root.querySelector('.desktop-titlebar');
        const box = header.getBoundingClientRect();
        const rect = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left - box.left), right: Math.round(box.right - r.right), width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top - box.top) }; };
        const style = getComputedStyle(header);
        return {
          header: { height: Math.round(box.height), paddingRight: style.paddingRight, paddingLeft: style.paddingLeft, region: style.getPropertyValue('-webkit-app-region') || style.webkitAppRegion },
          brand: rect(root.querySelector('.desktop-titlebar-brand')),
          spacer: rect(root.querySelector('.desktop-titlebar-drag-spacer')),
          buttons: [...root.querySelectorAll('.desktop-window-control')].map((el) => ({ ...rect(el), region: getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).webkitAppRegion, circle: getComputedStyle(el, '::before').borderRadius })),
        };
      };
      document.getElementById('result').textContent = JSON.stringify(Object.fromEntries(['right', 'left', 'none', 'windows'].map((id) => [id, measure(id)])));
    </script></body></html>`;
    const path = join(scratch, "fixture.html");
    await writeFile(path, html);
    const { stdout } = await run(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", "--window-size=1400,900", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 35_000, maxBuffer: 5_000_000 });
    const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(serialized && serialized !== "pending");
    const result = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));

    // Right side: the three buttons end at the bar's right edge, in order, with no space reserved for Electron's overlay.
    const right = result.right;
    assert.equal(right.header.height, 40);
    assert.equal(right.header.region, "drag");
    assert.equal(right.header.paddingRight, "4px");
    assert.equal(right.buttons.length, 3);
    for (const button of right.buttons) {
      assert.equal(button.width, 34, "a 34px target");
      assert.equal(button.height, 34);
      assert.equal(button.top, 3, "centered in the 40px bar");
      assert.equal(button.region, "no-drag", "buttons take clicks instead of dragging the window");
      assert.equal(button.circle, "50%");
    }
    assert.equal(right.buttons[2].right, 4);
    assert.equal(right.buttons[1].right, 38);
    assert.equal(right.brand.left, 10);
    assert.ok(right.spacer.width > 600, "the drag spacer keeps the empty bar draggable");

    // Left side: the buttons come first and the name follows them.
    const left = result.left;
    assert.equal(left.header.paddingLeft, "4px");
    assert.equal(left.buttons[0].left, 4);
    assert.equal(left.buttons[1].left, 38);
    assert.ok(left.brand.left >= 72 + 6, `the name follows the buttons (${left.brand.left})`);

    // No buttons (a tiling desktop's empty layout): the bar is just the name, menus and drag space.
    assert.equal(result.none.buttons.length, 0);
    assert.equal(result.none.brand.left, 10);

    // Windows keeps Electron's overlay and the space reserved for it.
    assert.equal(result.windows.header.paddingRight, "146px");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
