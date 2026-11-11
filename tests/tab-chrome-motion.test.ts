import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

// The Browser pane's tab strip in real Chromium, with its real stylesheet:
// tabs share the strip, and the frame behind the tab in front slides to the
// tab chosen (web-local/src/lib/tab-chrome-motion.ts).
test("browser tabs share the strip, and the frame behind the tab in front slides, retargets, and honors reduced motion", { timeout: 60_000 }, async (t) => {
  const candidates = [process.env.AMPLEFILE_CSS_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean) as string[];
  let browser: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); browser = candidate; break; } catch {} }
  if (!browser) { t.skip("A Chromium binary is required; set AMPLEFILE_CSS_BROWSER."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "amplefile-browser-tabs-"));
  try {
    const css = (await Promise.all(["file-manager-tokens.css", "file-manager-browser.css"].map((name) => readFile(resolve("web-local/src/components/file-manager", name), "utf8")))).join("\n");
    const source = await readFile(resolve("web-local/src/lib/tab-chrome-motion.ts"), "utf8");
    const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll("export function", "function");
    const tab = (id: string, title: string) => `<div id="${id}" class="fm-browser-tab" data-browser-tab="${id}"><button class="fm-browser-tab-main" role="tab"><span class="fm-browser-tab-icon"></span><span class="fm-browser-tab-title">${title}</span></button><button class="fm-browser-tab-close"></button></div>`;
    const html = `<!doctype html><html data-theme="light" data-appearance-motion="system"><head><style>
      :root { --amplefile-ease-smooth: cubic-bezier(0.2, 0, 0, 1); --amplefile-ease-pop: cubic-bezier(0.34, 1.4, 0.64, 1); --amplefile-motion-base: 180ms; }
      body { margin: 0; } ${css}
      </style></head><body><div class="app-shell layout-file-manager"><section class="fm-browser" data-layout="collapsed" style="width:900px"><header class="fm-browser-bar">
      <div class="fm-browser-tabs" role="tablist"><span class="fm-browser-tab-chrome" aria-hidden="true"></span>${tab("first", "First")}${tab("second", "A second tab with a long title")}${tab("third", "Third")}</div>
      <button class="fm-browser-tool fm-browser-new"></button><div class="fm-browser-bar-space"></div><div class="fm-capsule fm-browser-layout" style="width:60px"></div>
      </header></section></div><pre id="result">pending</pre><script>${script}
      (async () => {
        const strip=document.querySelector('.fm-browser-tabs'), chrome=document.querySelector('.fm-browser-tab-chrome'), bar=document.querySelector('.fm-browser-bar');
        const tabs=['first','second','third'].map(id=>document.getElementById(id));
        const arrived=document.getAnimations().length;
        for (const animation of document.getAnimations()) animation.finish();
        const motion=createTabChromeMotion(strip,chrome);
        function select(index,animate=true) { tabs.forEach((tab,i)=>tab.classList.toggle('is-on',i===index)); motion.select(tabs[index]??null,animate); }
        const box=el=>{const r=el.getBoundingClientRect();return [r.left,r.top,r.width,r.height];};
        const result={arrived,system:matchMedia('(prefers-reduced-motion: reduce)').matches,widths:tabs.map(tab=>box(tab)[2])};
        select(0,false);
        result.initial=[box(chrome),box(tabs[0])];
        result.pointer=getComputedStyle(chrome).pointerEvents;
        result.ready=strip.dataset.activeChrome;
        select(1);
        let animation=chrome.getAnimations()[0];
        result.selection={count:chrome.getAnimations().length,duration:animation?.effect.getTiming().duration};
        if(animation) { animation.pause(); animation.currentTime=80; }
        const interrupted=box(chrome);
        select(2);
        animation=chrome.getAnimations()[0];
        result.retarget={from:interrupted,target:box(tabs[2]),keyframe:animation?.effect.getKeyframes()[0]};
        animation?.finish();
        result.settled=[box(chrome),box(tabs[2])];
        select(1);
        document.documentElement.dataset.appearanceMotion='reduce';
        await Promise.resolve();
        result.preferenceChange=chrome.getAnimations().length;
        select(0);
        result.reduced={count:chrome.getAnimations().length,boxes:[box(chrome),box(tabs[0])]};
        document.documentElement.dataset.appearanceMotion='system';
        // More tabs than fit at full width: every tab gives way, none leaves the strip.
        for (let index=0; index<9; index+=1) { const extra=tabs[2].cloneNode(true); extra.id='extra'+index; extra.style.animation='none'; strip.append(extra); }
        const all=[...strip.querySelectorAll('.fm-browser-tab')];
        const stripBox=box(strip), newBox=box(document.querySelector('.fm-browser-new')), barBox=box(bar);
        result.crowded={count:all.length,widths:all.map(tab=>Math.round(box(tab)[2]*10)/10),overflow:strip.scrollWidth-strip.clientWidth,stripRight:stripBox[0]+stripBox[2],newLeft:newBox[0],barRight:barBox[0]+barBox[2],layoutRight:(b=>b[0]+b[2])(box(document.querySelector('.fm-browser-layout')))};
        select(0,false);
        result.crowdedChrome=[box(chrome),box(tabs[0])];
        // Far more tabs than fit even at their smallest: the strip scrolls, the tab in front stays inside it,
        // and the strip says which edge holds more.
        for (let index=0; index<18; index+=1) { const extra=tabs[2].cloneNode(true); extra.id='more'+index; extra.style.animation='none'; strip.append(extra); }
        const inside=tab=>{const s=strip.getBoundingClientRect(), r=tab.getBoundingClientRect(); return r.left>=s.left-0.5 && r.right<=s.right+0.5;};
        const last=strip.lastElementChild;
        tabs.forEach(tab=>tab.classList.remove('is-on')); last.classList.add('is-on');
        const before=inside(last);
        settleTabStrip(strip,last);
        result.overflow={scrolls:strip.scrollWidth>strip.clientWidth,before,after:inside(last),more:strip.dataset.more,frontWidth:box(last)[2],mask:getComputedStyle(strip).maskImage!=='none'};
        last.classList.remove('is-on'); tabs[0].classList.add('is-on');
        settleTabStrip(strip,tabs[0]);
        result.overflowBack={after:inside(tabs[0]),more:strip.dataset.more};
        strip.scrollLeft=(strip.scrollWidth-strip.clientWidth)/2; settleTabStrip(strip,null);
        result.overflowMiddle=strip.dataset.more;
        for (const extra of [...strip.querySelectorAll('[id^="more"]')]) extra.remove();
        settleTabStrip(strip,tabs[0]);
        result.overflowGone=strip.dataset.more;
        motion.select(null);
        result.none={visible:getComputedStyle(chrome).visibility,ready:strip.dataset.activeChrome};
        motion.dispose();
        document.getElementById('result').textContent=JSON.stringify(result);
      })().catch(error=>document.getElementById('result').textContent=JSON.stringify({error:String(error),stack:error.stack}));
      </script></body></html>`;
    const path = join(scratch, "fixture.html");
    await writeFile(path, html);
    for (const systemReduce of [false, true]) {
      const { stdout } = await promisify(execFile)(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=2000", "--disable-features=HangWatcher", ...(systemReduce ? ["--force-prefers-reduced-motion"] : []), `--user-data-dir=${join(scratch, systemReduce ? "reduced-profile" : "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 25_000, maxBuffer: 5_000_000 });
      const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
      assert.ok(serialized && serialized !== "pending", "browser must finish the motion fixture");
      const result = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
      assert.equal(result.error, undefined, result.stack);
      const aligned = (boxes: number[][], context: string) => boxes[0]!.forEach((value, index) => assert.ok(Math.abs(value - boxes[1]![index]!) < 0.1, `${context}: frame ${boxes[0]} must align with tab ${boxes[1]}`));
      assert.equal(result.system, systemReduce);
      assert.ok(result.arrived >= 3, "each tab arrives with its own entrance");
      assert.deepEqual(result.widths, [200, 200, 200], "a few tabs take their full width");
      for (const context of ["initial", "settled", "crowdedChrome"]) aligned(result[context], context);
      aligned(result.reduced.boxes, "reduced");
      assert.equal(result.pointer, "none");
      assert.equal(result.ready, "ready");
      assert.equal(result.selection.count, systemReduce ? 0 : 1);
      if (!systemReduce) {
        assert.equal(result.selection.duration, 180);
        const offset = Number(/translateX\(([-\d.]+)px\)/.exec(result.retarget.keyframe.transform)![1]);
        assert.ok(Math.abs(offset - (result.retarget.from[0] - result.retarget.target[0])) < 0.1, "a quick second choice starts from where the frame is");
        assert.ok(Math.abs(Number.parseFloat(result.retarget.keyframe.width) - result.retarget.from[2]) < 0.1, "and from the width it has");
      }
      assert.equal(result.preferenceChange, 0, "turning on Reduce Motion stops a slide in flight");
      assert.equal(result.reduced.count, 0);
      assert.equal(result.crowded.count, 12);
      assert.equal(result.crowded.overflow, 0, "twelve tabs fit the strip without scrolling");
      // The tab in front keeps room for its name; the others share what is left equally.
      const others = result.crowded.widths.slice(1);
      assert.ok(Math.max(...others) - Math.min(...others) < 0.5, `sharing it equally: ${result.crowded.widths}`);
      assert.ok(others[0] >= 38 && others[0] < 200);
      assert.ok(result.crowded.widths[0] >= 132 - 0.5, `the tab in front stays readable: ${result.crowded.widths[0]}`);
      assert.deepEqual(result.overflow, { scrolls: true, before: false, after: true, more: "start", frontWidth: result.overflow.frontWidth, mask: true }, "the tab in front is brought into the strip");
      assert.ok(result.overflow.frontWidth >= 132 - 0.5);
      assert.deepEqual(result.overflowBack, { after: true, more: "end" });
      assert.equal(result.overflowMiddle, "both");
      assert.equal(result.overflowGone, "none");
      assert.ok(result.crowded.newLeft >= result.crowded.stripRight, "New Tab stays after the last tab");
      assert.ok(result.crowded.layoutRight <= result.crowded.barRight + 0.1, `and the layout buttons stay in the bar: ${result.crowded.layoutRight} within ${result.crowded.barRight}`);
      assert.equal(result.none.visible, "hidden", "with no tab in front the frame is not drawn");
      assert.equal(result.none.ready, undefined);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
