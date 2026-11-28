import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dumpCssFixture, findCssBrowser } from "./support/css-browser.js";

test("Latest occupies its own row instead of covering the scrollable transcript", { timeout: 30_000 }, async (t) => {
  const browser = await findCssBrowser();
  if (!browser) { t.skip("Chromium is required for actual Chat layout coverage."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "amplefile-latest-layout-"));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const sheets = ["brand.css", "styles.css", "application-appearance.css"];
  const css = (await Promise.all(sheets.map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
  const script = `const results=[];for(const width of [650,420])for(const reading of [15,22]){
    document.querySelector('.chat-panel').style.width=width+'px';document.querySelector('.message-body').style.fontSize=reading+'px';
    const list=document.querySelector('.message-list');list.scrollTop=(list.scrollHeight-list.clientHeight)/2;
    const button=document.querySelector('.jump-to-latest').getBoundingClientRect(),viewport=list.getBoundingClientRect();
    results.push({width,reading,buttonTop:button.top,viewportBottom:viewport.bottom,scrollable:list.scrollHeight>list.clientHeight});
  }document.documentElement.innerHTML='<head></head><body><pre id="result"></pre></body>';document.querySelector('#result').textContent=JSON.stringify(results);`;
  const html = `<!doctype html><html><head><style>${css}</style></head><body><div class="app-shell" style="display:block"><section class="panel chat-panel" style="height:600px;width:650px"><div class="chat-top-chrome empty"></div><div class="chat-scroll-shell"><div class="message-list"><article class="message assistant"><div class="message-surface"><div class="message-body"><p>${"Visible transcript text stays readable. ".repeat(250)}</p></div></div></article><div class="message-end-sentinel"></div></div><button class="jump-to-latest">↓ Latest</button></div><form class="composer"><div class="composer-input-shell"><textarea rows="2">A draft</textarea></div></form></section></div><script>${script}</script></body></html>`;
  const path = join(scratch, "fixture.html"); await writeFile(path, html);
  const output = await dumpCssFixture(browser, path, { profile: join(scratch, "profile"), timeoutMs: 20_000 });
  const serialized = /<pre id="result">([^<]*)<\/pre>/u.exec(output)?.[1]; assert.ok(serialized);
  const results = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&")) as Array<{width:number;reading:number;buttonTop:number;viewportBottom:number;scrollable:boolean}>;
  assert.equal(results.length, 4);
  for (const result of results) { assert.equal(result.scrollable, true); assert.ok(result.buttonTop >= result.viewportBottom, JSON.stringify(result)); }
});
