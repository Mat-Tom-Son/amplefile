// Builds amplefile.com into site/public: one self-contained index.html, plus its
// icons, share image, and robots.txt copied from desktop/assets/brand.
// Run with `npm run site:build`; docs/website.md covers previewing and deploying.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MN_CSS, mnMarkup } from "./manila.mjs";
import * as VIEWS from "./views.mjs";
import { MENUBAR_ICON, WINDOW_CSS } from "./views.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "public");
const brand = join(root, "desktop", "assets", "brand");

const ORIGIN = "https://www.amplefile.com";
const RELEASES = "Mat-Tom-Son/amplefile-mac-releases";
// The DMG of the version in package.json. When the page loads, a script asks GitHub
// for the latest release and points every Download link at that release's DMG instead.
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const DL = `https://github.com/${RELEASES}/releases/download/v${version}/AmpleFile-${version}-mac-arm64.dmg`;
const SRC = "https://github.com/Mat-Tom-Son/amplefile";
const REL = `https://github.com/${RELEASES}/releases`;
const PRIV = `${SRC}/blob/main/PRIVACY.md`;
const ext = 'target="_blank" rel="noopener"';
const TITLE = "AmpleFile · A Smart File Explorer for Mac";
const DESC = "Every folder you connect gets its own dedicated AI agent, called a Worker. Free and open source, for Apple silicon Macs.";

const MARK = (cls = "mark") => `<svg class="${cls}" viewBox="60 192 904 640" aria-hidden="true"><path class="mk-b" d="M140 192H366C403 192 416 206 434 232L454 260C466 276 480 284 502 284H884C928.183 284 964 319.817 964 364V752C964 796.183 928.183 832 884 832H140C95.817 832 60 796.183 60 752V272C60 227.817 95.817 192 140 192Z"/><path class="mk-f" d="M140 336H884C928.183 336 964 371.817 964 416V752C964 796.183 928.183 832 884 832H140C95.817 832 60 796.183 60 752V416C60 371.817 95.817 336 140 336Z"/><circle class="mk-d" cx="760" cy="656" r="80"/></svg>`;
const APPLE = `<svg class="apple" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`;
const GITHUB = `<svg class="gh" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
// The outlined wordmark from the brand folder; letters take the text color and the i's dot can pulse.
const WORDMARK = readFileSync(join(brand, "amplefile-wordmark.svg"), "utf8")
  .replace(/<\?xml[^>]*>/, "").replace(/ id="[^"]*"/g, "").replace(/ role="img" aria-label="[^"]*"/, ' aria-hidden="true" class="wm"')
  .replace(/ width="[^"]*" height="[^"]*"/, "").replace(/fill="#16202B"/g, 'fill="currentColor"').replace(/<circle fill="#1F63D6"[^>]*>/, '<circle class="wm-dot" fill="#1F63D6" cx="1031.93557" cy="38.8" r="27"/>').trim();
const ARROW = `<svg class="dl" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v8.5M4.25 7.5 8 11.25l3.75-3.75M3 13.5h10"/></svg>`;

// ---------- CSS ----------

const SHELL_CSS = `
/* The page fills the window and scrolls itself, so the menu bar and note can track it. */
:root { --ease:cubic-bezier(.22,1,.36,1); }
@property --u { syntax:"<length>"; inherits:true; initial-value:1px; }
@property --gut { syntax:"<length>"; inherits:true; initial-value:16px; }
html, body { overflow-x: clip; }
body { margin:0; background:#16202B; font-family:"Plus Jakarta Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
html.js, html.js body { height:100%; }
html.js body { display:flex; flex-direction:column; overflow:clip; }
*, *::before, *::after { box-sizing:border-box; }
.page { container:page / inline-size; position:relative; }
.page > * { --gut: max(clamp(16px, 5cqi, 56px), env(safe-area-inset-left, 0px)); }
html.js .page { flex:1; min-height:0; width:100%; overflow-y:auto; overflow-x:clip; scroll-behavior:smooth; }
.page:focus { outline:none; }
.vh { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
@media (prefers-reduced-motion: reduce) { html.js .page { scroll-behavior:auto; } }

/* Shots: an app view drawn at 1280 x 760 design pixels, scaled to the box with container units. */
.shot { --cx:0; --cy:0; --cw:1280; --ch:760; position:relative; width:100%; aspect-ratio:var(--cw) / var(--ch); container:shot / inline-size; }
.shot > * { position:absolute; left:0; top:0; --u:calc(100cqi / var(--cw)); transform:translate(calc(var(--cx) * -1 * var(--u)), calc(var(--cy) * -1 * var(--u))); transform-origin:0 0; }
.shot.v-agent { --cw:400; --ch:560; }
.shot.k-panel { --cx:960; --cy:0; --cw:320; --ch:600; }
.shot.k-panel, .shot.is-crop { overflow:clip; border-radius:16px; }
@container page (max-width: 640px) {
  .shot[class*="p-"] { overflow:clip; border-radius:14px; max-width:400px; margin-inline:auto; }
  .shot.p-list { --cx:220; --cy:0; --cw:560; --ch:330; }
  .shot.p-side { --cx:960; --cy:0; --cw:320; --ch:344 !important; max-width:320px; }
  .shot.p-panel { --cx:960; --cy:0; --cw:320; --ch:620; }
  .shot.p-chat { --cx:960; --cy:0; --cw:320; --ch:540; }
  .shot.p-chat, .shot.p-panel { max-width:320px; }
  /* The whole window, so a phone sees what the app is before the close-ups. */
  .shot.p-live, .shot.p-full { overflow:visible; border-radius:0; }
}
`;

// ---------- Markup ----------

const shot = (_name, cls, inner, extra = "") => `<div class="shot ${cls}${/\bnofx\b/.test(cls) ? "" : " fx"}"${extra}>${inner}</div>`;
const dlBtn = (cls, label = "Download for Mac") => `<a class="${cls}" href="${DL}" ${ext}>${ARROW}<span>${label}</span></a>`;
const PAGE = mnMarkup({ shot, dlBtn, MENUBAR_ICON, SRC, DL, REL, PRIV, ext, ARROW, GITHUB, APPLE, WORDMARK, MARK, views: VIEWS });

// ---------- Script ----------

const SCRIPT = `
(() => {
  const root = document.documentElement;
  root.classList.add("js");
  const page = document.getElementById("top");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Reveal once per visit, read from scroll position so a jump anywhere lands right.
  const REVEAL = ".shot.fx, .shot.rv:not(.nofx), [data-reveal]";
  const hooks = [];
  const addHook = (fn) => hooks.push(fn);
  function update() {
    const pr = page.getBoundingClientRect();
    const due = [];
    for (const t of page.querySelectorAll(".shot.fx:not(.in), .shot.rv:not(.nofx):not(.in), [data-reveal]:not(.in)")) {
      const r = t.getBoundingClientRect();
      if (!r.height) continue;
      const seen = Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top);
      if (seen > Math.min(r.height, pr.height) * 0.2) due.push(t);
    }
    for (const fn of hooks) fn(pr);
    for (const t of due) t.classList.add("in");
  }
  page.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  const targets = [...page.querySelectorAll(REVEAL)];
  if (reduce) targets.forEach((t) => t.classList.add("in"));
  else {
    targets.forEach((t) => t.classList.remove("in"));
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add("in"); }), { root: page, threshold: 0.2 });
      targets.forEach((t) => io.observe(t));
    }
  }

  const clocks = [...document.querySelectorAll("[data-clock]")];
  const tick = () => { const t = new Date().toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }).replace(",", ""); clocks.forEach((c) => { c.textContent = t; }); };
  tick(); setInterval(tick, 30000);

  // Scenes: each view plays step by step while it's on screen, rests on the finished state, then plays again.
  // Visibility comes from an IntersectionObserver on the real screen, so it holds however the page is framed.
  function setupScenes() {
    if (reduce) return;
    const HOLD = 4800;
    const scenes = [...page.querySelectorAll(".mw[data-steps], .mb-pop[data-steps]")].map((mw) => {
      const delays = mw.dataset.steps.split(",").map(Number);
      const n = delays.length;
      const cur = mw.querySelector(".mw-cursor");
      const box = mw.closest(".shot") || mw;
      // A view in the folder's pinned top stays on screen while the front slides over it, so only the uncovered part counts.
      const under = !!mw.closest(".mn-head");
      const area = (under && mw.closest(".mn-paper")) || box;
      // state: idle (at the start), playing, or done (resting on the finished state)
      const st = { token: 0, vis: false, state: "idle", wait: 0, ticks: [] };
      const home = () => { if (!cur) return; const [x, y] = (mw.dataset.cursor || "50,90").split(",").map(Number); cur.style.left = x + "%"; cur.style.top = y + "%"; };
      function reset() {
        st.token++; st.state = "idle"; clearTimeout(st.wait);
        mw.classList.add("no-anim");
        for (let i = 1; i <= n; i++) mw.classList.remove("s" + i);
        mw.querySelectorAll(".is-press").forEach((el) => el.classList.remove("is-press"));
        mw.querySelectorAll("[data-type]").forEach((t) => { t.textContent = ""; });
        st.ticks.forEach(clearInterval); st.ticks = [];
        mw.querySelectorAll("[data-tick]").forEach((t) => { t.textContent = t.dataset.tick0 ?? (t.dataset.tick0 = t.textContent === "0s" ? "0s" : ""); });
        mw.querySelectorAll("[data-stream]").forEach((el) => { el.classList.add("streaming"); el.querySelectorAll(".on").forEach((x) => x.classList.remove("on")); });
        if (cur) { cur.classList.remove("on", "down"); home(); }
        void mw.offsetWidth;
        mw.classList.remove("no-anim");
      }
      function aim(el) {
        const r = el.getBoundingClientRect(), m = mw.getBoundingClientRect();
        if (!r.width || !m.width) return;
        cur.style.left = ((r.left + Math.min(r.width / 2, 60) - m.left) / m.width * 100) + "%";
        cur.style.top = ((r.top + r.height / 2 - m.top) / m.height * 100) + "%";
        cur.classList.add("on");
      }
      const presses = [...mw.querySelectorAll("[data-press]")].map((el) => +el.dataset.press);
      const lastPress = presses.length ? Math.max(...presses) : 0;
      async function play(t) {
        st.state = "playing";
        const live = () => t === st.token;
        for (let k = 1; k <= n; k++) {
          const target = mw.querySelector('[data-press="' + k + '"]');
          if (target && cur) aim(target);
          await sleep(delays[k - 1]); if (!live()) return;
          if (target) {
            target.classList.add("is-press"); if (cur) cur.classList.add("down");
            await sleep(150); if (!live()) return;
            target.classList.remove("is-press"); if (cur) cur.classList.remove("down");
            // After its last click the pointer gets out of the way.
            if (cur && k === lastPress) setTimeout(() => { if (live()) cur.classList.remove("on"); }, 650);
          }
          mw.classList.add("s" + k);
          // Elapsed seconds, counted from this step
          mw.querySelectorAll('[data-tick="' + k + '"]').forEach((el) => { let n = 0; st.ticks.push(setInterval(() => { el.textContent = ++n + "s"; }, 1000)); });
          // A reply streams in word groups, as the app batches text per frame
          const flow = mw.querySelector('[data-stream="' + k + '"]');
          if (flow) {
            const ws = [...flow.querySelectorAll(".w")];
            for (let i = 0; i < ws.length;) {
              const g = 1 + ((i * 7) % 4);
              for (let j = 0; j < g && i < ws.length; j++, i++) for (let p = ws[i]; p && p !== flow; p = p.parentElement) p.classList.add("on");
              await sleep(70 + ((i * 13) % 45)); if (!live()) return;
            }
            flow.classList.remove("streaming");
          }
          const typer = mw.querySelector('[data-type="' + k + '"]');
          if (typer) {
            if (cur) cur.classList.remove("on");
            await sleep(260); if (!live()) return;
            const text = typer.dataset.text || "";
            const per = Math.min(34, 1700 / Math.max(1, text.length));
            for (let i = 0; i < text.length; i++) { typer.textContent = text.slice(0, i + 1); await sleep(per + ((i * 37) % 9)); if (!live()) return; }
          }
        }
        if (cur) { await sleep(900); if (!live()) return; cur.classList.remove("on"); }
        st.state = "done";
        await sleep(HOLD); if (!live()) return;
        if (st.vis) replay();
      }
      async function replay() {
        const t = ++st.token;
        mw.classList.add("is-cut");
        await sleep(240); if (t !== st.token) return;
        reset();
        mw.classList.remove("is-cut");
        st.wait = setTimeout(() => { if (st.vis && st.state === "idle") start(); }, 520);
      }
      function start() { if (st.state === "idle") play(++st.token); }
      // Two witnesses: the observer (true to the screen) and the scroll measurement (always available); either one is enough.
      const fr = { io: 0, hook: 0 };
      function seen(f) {
        if (f >= 0.4 && !st.vis) { st.vis = true; if (st.state === "idle") start(); else if (st.state === "done") replay(); }
        else if (f < 0.06 && st.vis) { st.vis = false; mw.classList.remove("is-cut"); reset(); }
      }
      reset();
      const feel = (src, f) => { fr[src] = f; seen(Math.max(fr.io, fr.hook)); };
      return { box, feel, under, area };
    });
    const byBox = new Map(scenes.map((s) => [s.box, s]));
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => es.forEach((e) => {
        const s = byBox.get(e.target); if (!s) return;
        const vh = (e.rootBounds && e.rootBounds.height) || innerHeight;
        const h = Math.min(e.boundingClientRect.height, vh);
        s.feel("io", e.isIntersecting && h > 0 ? e.intersectionRect.height / h : 0);
      }), { threshold: [0, 0.03, 0.06, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1] });
      scenes.forEach((s) => { if (!s.under) io.observe(s.box); });
    }
    const front = page.querySelector(".mn-front");
    addHook((pr) => {
      const cover = front.getBoundingClientRect().top;
      scenes.forEach((s) => {
        const r = s.area.getBoundingClientRect();
        const top = Math.max(r.top, pr.top, 0), bot = Math.min(r.bottom, pr.bottom, innerHeight, s.under ? cover : Infinity);
        const h = Math.min(r.height, pr.height, innerHeight);
        s.feel("hook", h > 0 ? Math.max(0, bot - top) / h : 0);
      });
    });
  }

  // The menu bar arrives when the folder's front reaches the top; its icon opens the AmpleFile Agent popover.
  const mnBar = page.querySelector(".mn-mb"), mnFront = page.querySelector(".mn-front");
  const mnIcon = page.querySelector(".mn-mbi"), mnPop = page.querySelector("#mn-pop");
  const setMnPop = (open) => { mnPop.hidden = !open; mnIcon.setAttribute("aria-expanded", String(open)); };
  addHook((pr) => {
    // In when the top edge of the folder's front reaches the bar; out a little below it, so it never flickers at the line.
    const edge = mnFront.getBoundingClientRect().top - pr.top, h = mnBar.offsetHeight;
    const shown = mnBar.classList.contains("is-shown") ? edge <= h + 12 : edge <= h;
    mnBar.classList.toggle("is-shown", shown);
    mnBar.inert = !shown;
    if (!shown && !mnPop.hidden) setMnPop(false);
  });
  const mnNote = page.querySelector(".mn-note"), mnCard = page.querySelector(".mn-card"), mnNest = page.querySelector("[data-note]");
  // The note pops up once the stacking section comes up, then stays wherever you scroll.
  // Back at the top it goes away (and comes back next time); clicking it, or the icon it points to, puts it away for the visit.
  let mnNoteDone = false, mnNoteUp = false;
  const putNoteAway = () => {
    if (mnNoteDone) return;
    mnNoteDone = true;
    if (!mnNote.classList.contains("is-on") || reduce) { mnNote.classList.remove("is-on"); return; }
    mnNote.classList.add("is-gone");
    setTimeout(() => mnNote.classList.remove("is-on", "is-gone"), 260);
  };
  addHook((pr) => {
    const ir = mnIcon.getBoundingClientRect(), br = mnBar.getBoundingClientRect();
    if (ir.width) mnNote.style.setProperty("--note-r", Math.max(4, br.right - (ir.left + ir.width / 2) - 10) + "px");
    if (!mnBar.classList.contains("is-shown")) mnNoteUp = false;
    else if (!mnNoteUp && pr.width >= 600 && mnNest.getBoundingClientRect().top < pr.top + pr.height * 0.7) mnNoteUp = true;
    if (!mnNoteDone) mnNote.classList.toggle("is-on", mnNoteUp && mnPop.hidden);
  });
  mnCard.addEventListener("click", putNoteAway);
  mnIcon.addEventListener("click", () => { putNoteAway(); setMnPop(mnPop.hidden); });
  page.querySelectorAll("[data-top]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); page.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }); }));
  page.addEventListener("keydown", (e) => { if (e.key === "Escape" && !mnPop.hidden) { setMnPop(false); mnIcon.focus(); } });
  page.addEventListener("click", (e) => { if (!mnPop.hidden && !mnPop.contains(e.target) && !mnIcon.contains(e.target)) setMnPop(false); });
  mnBar.inert = true;
  setupScenes();
  // The page scrolls itself, so it takes focus: the keyboard scrolls it from the first key press.
  page.tabIndex = -1;
  page.focus({ preventScroll: true });
  update();
  requestAnimationFrame(update);

  // Download links follow the latest release; without an answer they keep the DMG they were built with.
  (async () => {
    try {
      const r = await fetch("https://api.github.com/repos/${RELEASES}/releases/latest", { headers: { Accept: "application/vnd.github+json" } });
      if (!r.ok) return;
      const asset = ((await r.json()).assets || []).find((x) => /-mac-arm64\\.dmg$/.test(x.name));
      if (!asset) return;
      document.querySelectorAll('a[href$="-mac-arm64.dmg"]').forEach((el) => { el.href = asset.browser_download_url; });
    } catch {}
  })();
})();
`;

// ---------- Page ----------

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${TITLE}</title>
<meta name="description" content="${DESC}">
<link rel="canonical" href="${ORIGIN}/">
<meta name="theme-color" content="#EFCB7E">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="AmpleFile">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta property="og:url" content="${ORIGIN}/">
<meta property="og:image" content="${ORIGIN}/share.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="AmpleFile: a smart file explorer">
<meta name="twitter:card" content="summary_large_image">
<script>document.documentElement.classList.add("js");</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Inter:wght@400;600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>
${SHELL_CSS}
${WINDOW_CSS}
${MN_CSS}
</style>
</head>
<body>
${PAGE}
<script>${SCRIPT}</script>
</body>
</html>
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), html);
copyFileSync(join(brand, "amplefile-share-1200x630.png"), join(out, "share.png"));
copyFileSync(join(brand, "amplefile-mark-small.svg"), join(out, "favicon.svg"));
copyFileSync(join(brand, "png", "amplefile-mark-32.png"), join(out, "favicon-32.png"));
copyFileSync(join(brand, "AmpleFile.iconset", "icon_128x128@2x.png"), join(out, "apple-touch-icon.png"));
writeFileSync(join(out, "robots.txt"), "User-agent: *\nAllow: /\n");
console.log(`Built ${out} (index.html ${Math.round(Buffer.byteLength(html) / 1024)} KB, Download v${version})`);
