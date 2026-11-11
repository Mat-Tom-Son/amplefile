// Builds amplefile.com into site/public: one self-contained index.html, plus its
// icons, share image, and robots.txt copied from desktop/assets/brand.
// Run with `npm run site:build`; docs/website.md covers previewing and deploying.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import feedModule from "../scripts/mac-release-feed.cjs";
import { MN_CSS, mnMarkup } from "./manila.mjs";
import * as VIEWS from "./views.mjs";
import { MENUBAR_ICON, WINDOW_CSS } from "./views.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "public");
const brand = join(root, "desktop", "assets", "brand");

const ORIGIN = "https://www.amplefile.com";
// Download links follow the checked-in Mac update feed stage and ignore the environment: they
// point at the repository whose latest release is always a Mac release.
const RELEASES = feedModule.resolveMacReleaseFeed(
  JSON.parse(readFileSync(join(root, "src", "shared", "product-identity.json"), "utf8")),
  {},
).downloads.slug;
// Download opens the latest release, which is always published. When the page loads, a script
// asks GitHub for that release and points every Download link straight at its DMG.
const DL = `https://github.com/${RELEASES}/releases/latest`;
const SOURCE = "Mat-Tom-Son/amplefile";
const SRC = `https://github.com/${SOURCE}`;
const REL = `https://github.com/${RELEASES}/releases`;
// Linux previews are prereleases in the source repository, so no "latest" address reaches one.
// Linux links open the list of releases; the same script points them at the newest preview's page.
const LINUX_REL = `${SRC}/releases`;
const PRIV = `${SRC}/blob/main/PRIVACY.md`;
const DOCS = `${SRC}/blob/main/docs/README.md`;
const CONTRIB = `${SRC}/blob/main/CONTRIBUTING.md`;
const LICENSE = `${SRC}/blob/main/LICENSE`;
const ext = 'target="_blank" rel="noopener"';
const TITLE = "AmpleFile · A Smart File Explorer for Mac";
const DESC = "Every folder you connect gets its own dedicated AI agent, called a Worker. Free and open source, for Apple silicon Macs, with a Linux preview.";

const MARK = (cls = "mark") => `<svg class="${cls}" viewBox="60 192 904 640" aria-hidden="true"><path class="mk-b" d="M140 192H366C403 192 416 206 434 232L454 260C466 276 480 284 502 284H884C928.183 284 964 319.817 964 364V752C964 796.183 928.183 832 884 832H140C95.817 832 60 796.183 60 752V272C60 227.817 95.817 192 140 192Z"/><path class="mk-f" d="M140 336H884C928.183 336 964 371.817 964 416V752C964 796.183 928.183 832 884 832H140C95.817 832 60 796.183 60 752V416C60 371.817 95.817 336 140 336Z"/><circle class="mk-d" cx="760" cy="656" r="80"/></svg>`;
const APPLE = `<svg class="apple" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`;
const GITHUB = `<svg class="gh" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
// The outlined wordmark from the brand folder; letters take the text color and the i's dot can pulse.
const WORDMARK = readFileSync(join(brand, "amplefile-wordmark.svg"), "utf8")
  .replace(/<\?xml[^>]*>/, "").replace(/ id="[^"]*"/g, "").replace(/ role="img" aria-label="[^"]*"/, ' aria-hidden="true" class="wm"')
  .replace(/ width="[^"]*" height="[^"]*"/, "").replace(/fill="#16202B"/g, 'fill="currentColor"').replace(/<circle fill="#1F63D6"[^>]*>/, '<circle class="wm-dot" fill="#1F63D6" cx="1031.93557" cy="38.8" r="27"/>').trim();
// A penguin drawn for this page at the Apple mark's weight: the belly, eyes, and beak are cut out of one shape.
const LINUX = `<svg class="tux" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M12 1.5C14.6 1.5 16.2 3.4 16.2 6C16.2 7.7 16.8 8.9 17.8 10.3C19.5 12.7 20.8 14.7 20.8 16.6C20.8 17.5 20.4 18.1 19.8 18.5C21.2 18.9 22 19.8 22 20.8C22 21.8 21.1 22.4 19.6 22.4L15.8 22.4C14.8 22.4 14.1 21.9 14 21.1L10 21.1C9.9 21.9 9.2 22.4 8.2 22.4L4.4 22.4C2.9 22.4 2 21.8 2 20.8C2 19.8 2.8 18.9 4.2 18.5C3.6 18.1 3.2 17.5 3.2 16.6C3.2 14.7 4.5 12.7 6.2 10.3C7.2 8.9 7.8 7.7 7.8 6C7.8 3.4 9.4 1.5 12 1.5ZM12 10C13.6 10 14.6 11.6 15.3 13.4C16 15.2 16.3 17.2 15.7 18.3C15.1 19.3 13.6 19.4 12 19.4C10.4 19.4 8.9 19.3 8.3 18.3C7.7 17.2 8 15.2 8.7 13.4C9.4 11.6 10.4 10 12 10ZM9.7 5.2a.8 1.05 0 1 0 1.6 0a.8 1.05 0 1 0 -1.6 0ZM12.7 5.2a.8 1.05 0 1 0 1.6 0a.8 1.05 0 1 0 -1.6 0ZM12 6.8C13.2 6.8 14.2 7.4 14.2 7.9C14.2 8.5 13.2 9 12 9C10.8 9 9.8 8.5 9.8 7.9C9.8 7.4 10.8 6.8 12 6.8Z"/></svg>`;

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
  /* The dialog's near half at a readable size: its header, two included tools, and what's installed everywhere. */
  .shot.p-tools { --cx:88; --cy:12; --cw:552; --ch:480 !important; }
  .shot.p-tools :is(.mw-cursor, .mw-menu) { display:none !important; }
  /* The whole window, so a phone sees what the app is before the close-ups. */
  .shot.p-live, .shot.p-full { overflow:visible; border-radius:0; }
}
`;

// ---------- Markup ----------

const shot = (_name, cls, inner, extra = "") => `<div class="shot ${cls}${/\bnofx\b/.test(cls) ? "" : " fx"}"${extra}>${inner}</div>`;
// data-dl names what a link downloads, "mac" or "linux", so the script can point it at the newest build.
const macBtn = (cls) => `<a class="${cls}" href="${DL}" ${ext} data-dl="mac">${APPLE}<span>Download for Mac</span></a>`;
const linuxBtn = (cls) => `<a class="${cls}" href="${LINUX_REL}" ${ext} data-dl="linux" aria-label="Linux Preview" title="Linux Preview">${LINUX}<span>Linux Preview</span></a>`;
const PAGE = mnMarkup({ shot, macBtn, linuxBtn, MENUBAR_ICON, SRC, DL, REL, LINUX_REL, PRIV, DOCS, CONTRIB, LICENSE, ext, GITHUB, APPLE, LINUX, WORDMARK, MARK, views: VIEWS });

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
    const scenes = [...page.querySelectorAll(".mw[data-steps], .mb-pop[data-steps]")].filter((mw) => !mw.closest("[data-mirror]")).map((mw) => {
      const delays = mw.dataset.steps.split(",").map(Number);
      const n = delays.length;
      // On a phone a section draws its view twice, the whole window above its close-up. Both are one scene: every step lands on both together.
      const pair = mw.closest(".shots");
      const roots = [mw, ...(pair ? pair.querySelectorAll("[data-mirror] .mw[data-steps]") : [])];
      const cursorOf = (root) => root.querySelector(".mw-cursor");
      const cursors = roots.map(cursorOf).filter(Boolean);
      const box = pair || mw.closest(".shot") || mw;
      // A view in the folder's pinned top stays on screen while the front slides over it, so only the uncovered part counts.
      const under = !!mw.closest(".mn-head");
      const area = (under && mw.closest(".mn-paper")) || box;
      // state: idle (at the start), playing, or done (resting on the finished state)
      const st = { token: 0, vis: false, state: "idle", wait: 0, ticks: [] };
      const home = (root) => { const cur = cursorOf(root); if (!cur) return; const [x, y] = (root.dataset.cursor || "50,90").split(",").map(Number); cur.style.left = x + "%"; cur.style.top = y + "%"; };
      function reset() {
        st.token++; st.state = "idle"; clearTimeout(st.wait);
        st.ticks.forEach(clearInterval); st.ticks = [];
        for (const root of roots) {
          root.classList.add("no-anim");
          for (let i = 1; i <= n; i++) root.classList.remove("s" + i);
          root.querySelectorAll(".is-press").forEach((el) => el.classList.remove("is-press"));
          root.querySelectorAll("[data-type]").forEach((t) => { t.textContent = ""; });
          root.querySelectorAll("[data-tick]").forEach((t) => { t.textContent = t.dataset.tick0 ?? (t.dataset.tick0 = t.textContent === "0s" ? "0s" : ""); });
          root.querySelectorAll("[data-stream]").forEach((el) => { el.classList.add("streaming"); el.querySelectorAll(".on").forEach((x) => x.classList.remove("on")); });
          const cur = cursorOf(root);
          if (cur) { cur.classList.remove("on", "down"); home(root); }
          void root.offsetWidth;
          root.classList.remove("no-anim");
        }
      }
      function aim(root, el) {
        const cur = cursorOf(root);
        if (!cur) return;
        const r = el.getBoundingClientRect(), m = root.getBoundingClientRect();
        if (!r.width || !m.width) return;
        cur.style.left = ((r.left + Math.min(r.width / 2, 60) - m.left) / m.width * 100) + "%";
        cur.style.top = ((r.top + r.height / 2 - m.top) / m.height * 100) + "%";
        cur.classList.add("on");
      }
      const presses = [...mw.querySelectorAll("[data-press]")].map((el) => +el.dataset.press);
      const lastPress = presses.length ? Math.max(...presses) : 0;
      const find = (selector) => roots.map((root) => root.querySelector(selector)).filter(Boolean);
      async function play(t) {
        st.state = "playing";
        const live = () => t === st.token;
        for (let k = 1; k <= n; k++) {
          const targets = roots.map((root) => root.querySelector('[data-press="' + k + '"]'));
          roots.forEach((root, i) => { if (targets[i]) aim(root, targets[i]); });
          await sleep(delays[k - 1]); if (!live()) return;
          if (targets[0]) {
            targets.forEach((target) => { if (target) target.classList.add("is-press"); });
            cursors.forEach((cur) => cur.classList.add("down"));
            await sleep(150); if (!live()) return;
            targets.forEach((target) => { if (target) target.classList.remove("is-press"); });
            cursors.forEach((cur) => cur.classList.remove("down"));
            // After its last click the pointer gets out of the way.
            if (k === lastPress) setTimeout(() => { if (live()) cursors.forEach((cur) => cur.classList.remove("on")); }, 650);
          }
          roots.forEach((root) => root.classList.add("s" + k));
          // Elapsed seconds, counted from this step
          find('[data-tick="' + k + '"]').forEach((el) => { let count = 0; st.ticks.push(setInterval(() => { el.textContent = ++count + "s"; }, 1000)); });
          // A reply streams in word groups, as the app batches text per frame
          const flows = find('[data-stream="' + k + '"]');
          if (flows.length) {
            const words = flows.map((flow) => [...flow.querySelectorAll(".w")]);
            for (let i = 0; i < words[0].length;) {
              const g = 1 + ((i * 7) % 4);
              for (let j = 0; j < g && i < words[0].length; j++, i++) words.forEach((ws, f) => { for (let p = ws[i]; p && p !== flows[f]; p = p.parentElement) p.classList.add("on"); });
              await sleep(70 + ((i * 13) % 45)); if (!live()) return;
            }
            flows.forEach((flow) => flow.classList.remove("streaming"));
          }
          const typers = find('[data-type="' + k + '"]');
          if (typers.length) {
            cursors.forEach((cur) => cur.classList.remove("on"));
            await sleep(260); if (!live()) return;
            const text = typers[0].dataset.text || "";
            const per = Math.min(34, 1700 / Math.max(1, text.length));
            for (let i = 0; i < text.length; i++) { typers.forEach((typer) => { typer.textContent = text.slice(0, i + 1); }); await sleep(per + ((i * 37) % 9)); if (!live()) return; }
          }
        }
        if (cursors.length) { await sleep(900); if (!live()) return; cursors.forEach((cur) => cur.classList.remove("on")); }
        st.state = "done";
        await sleep(HOLD); if (!live()) return;
        if (st.vis) replay();
      }
      async function replay() {
        const t = ++st.token;
        roots.forEach((root) => root.classList.add("is-cut"));
        await sleep(240); if (t !== st.token) return;
        reset();
        roots.forEach((root) => root.classList.remove("is-cut"));
        st.wait = setTimeout(() => { if (st.vis && st.state === "idle") start(); }, 520);
      }
      function start() { if (st.state === "idle") play(++st.token); }
      // Two witnesses: the observer (true to the screen) and the scroll measurement (always available); either one is enough.
      const fr = { io: 0, hook: 0 };
      function seen(f) {
        if (f >= 0.4 && !st.vis) { st.vis = true; if (st.state === "idle") start(); else if (st.state === "done") replay(); }
        else if (f < 0.06 && st.vis) { st.vis = false; roots.forEach((root) => root.classList.remove("is-cut")); reset(); }
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
  // The bar's menus: one open at a time, sliding between them once one is open, with the arrow keys inside.
  const menus = [...mnBar.querySelectorAll("[data-menu]")].map((btn) => ({ btn, menu: mnBar.querySelector("#" + btn.getAttribute("aria-controls")) }));
  const setMenu = (m, open) => { m.menu.hidden = !open; m.btn.setAttribute("aria-expanded", String(open)); };
  const closeMenus = (except) => menus.forEach((m) => { if (m !== except) setMenu(m, false); });
  menus.forEach((m) => {
    const items = () => [...m.menu.querySelectorAll('[role="menuitem"]')];
    const open = () => { closeMenus(m); setMnPop(false); setMenu(m, true); };
    m.btn.addEventListener("click", () => { if (m.menu.hidden) open(); else setMenu(m, false); });
    m.btn.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse" && menus.some((o) => o !== m && !o.menu.hidden)) open(); });
    m.btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); open(); items()[0].focus(); } });
    m.menu.addEventListener("keydown", (e) => {
      const list = items(), i = list.indexOf(document.activeElement), to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
      if (to == null) return;
      e.preventDefault();
      list[(to + list.length) % list.length].focus();
    });
    m.menu.addEventListener("click", (e) => { if (e.target.closest('[role="menuitem"]')) setMenu(m, false); });
  });
  addHook((pr) => {
    // In when the top edge of the folder's front reaches the bar; out a little below it, so it never flickers at the line.
    const edge = mnFront.getBoundingClientRect().top - pr.top, h = mnBar.offsetHeight;
    const shown = mnBar.classList.contains("is-shown") ? edge <= h + 12 : edge <= h;
    mnBar.classList.toggle("is-shown", shown);
    mnBar.inert = !shown;
    if (!shown && !mnPop.hidden) setMnPop(false);
    if (!shown) closeMenus();
  });
  const mnNote = page.querySelector(".mn-note"), mnCard = page.querySelector(".mn-card"), mnNest = page.querySelector("[data-note]");
  // The note pops up once the views before the stacking section have cleared the corner it sits in, and tucks away
  // again when one scrolls back under it, so it never covers them. Clicking it, or the icon it points to, puts it away for the visit.
  let mnNoteDone = false, mnNoteUp = false, mnNoteOut = 0;
  const showNote = (on) => {
    if (on === (mnNote.classList.contains("is-on") && !mnNote.classList.contains("is-gone"))) return;
    clearTimeout(mnNoteOut);
    if (on) { mnNote.classList.remove("is-gone"); mnNote.classList.add("is-on"); return; }
    if (reduce) { mnNote.classList.remove("is-on"); return; }
    mnNote.classList.add("is-gone");
    mnNoteOut = setTimeout(() => mnNote.classList.remove("is-on", "is-gone"), 260);
  };
  const putNoteAway = () => { if (mnNoteDone) return; mnNoteDone = true; showNote(false); };
  addHook((pr) => {
    const ir = mnIcon.getBoundingClientRect(), br = mnBar.getBoundingClientRect();
    if (ir.width) mnNote.style.setProperty("--note-r", Math.max(4, br.right - (ir.left + ir.width / 2) - 10) + "px");
    // Where the view before the stacking section ends, against the bottom of the note's corner; a little slack either way keeps it from flickering at the line.
    const clear = mnNest.getBoundingClientRect().top - parseFloat(getComputedStyle(mnNest).marginTop) - mnNote.getBoundingClientRect().bottom;
    mnNoteUp = mnBar.classList.contains("is-shown") && pr.width >= 600 && clear < (mnNoteUp ? 48 : 8);
    if (!mnNoteDone) showNote(mnNoteUp && mnPop.hidden);
  });
  mnCard.addEventListener("click", putNoteAway);
  mnIcon.addEventListener("click", () => { putNoteAway(); closeMenus(); setMnPop(mnPop.hidden); });
  page.querySelectorAll("[data-top]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); page.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }); }));
  page.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!mnPop.hidden) { setMnPop(false); mnIcon.focus(); }
    const m = menus.find((o) => !o.menu.hidden);
    if (m) { setMenu(m, false); m.btn.focus(); }
  });
  page.addEventListener("click", (e) => {
    if (!mnPop.hidden && !mnPop.contains(e.target) && !mnIcon.contains(e.target)) setMnPop(false);
    if (!e.target.closest(".mn-mw")) closeMenus();
  });
  mnBar.inert = true;
  setupScenes();
  // The page scrolls itself, so it takes focus: the keyboard scrolls it from the first key press.
  page.tabIndex = -1;
  page.focus({ preventScroll: true });
  update();
  requestAnimationFrame(update);

  // Downloads. On Linux the Download menu lists the Linux preview first.
  if (root.classList.contains("os-linux")) mnBar.querySelectorAll('.mn-menu [data-dl="linux"]').forEach((el) => el.parentElement.prepend(el));
  const ask = (url) => fetch(url, { headers: { Accept: "application/vnd.github+json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const point = (kind, url, direct) => {
    if (typeof url !== "string" || !url.startsWith("https://github.com/")) return;
    // A file downloads where it was clicked; a page still opens in a new tab.
    page.querySelectorAll('a[data-dl="' + kind + '"]').forEach((el) => { el.href = url; if (direct) el.removeAttribute("target"); });
  };
  // Mac links go straight to the latest release's DMG; without an answer they open that release's page.
  ask("https://api.github.com/repos/${RELEASES}/releases/latest").then((rel) => {
    const asset = ((rel && rel.assets) || []).find((x) => /-mac-arm64\\.dmg$/.test(x.name));
    if (asset) point("mac", asset.browser_download_url, true);
  });
  // Linux links open the newest Linux preview's page, which lists its packages; without an answer they open the list of releases.
  ask("https://api.github.com/repos/${SOURCE}/releases?per_page=30").then((list) => {
    const rel = (Array.isArray(list) ? list : []).find((x) => x.prerelease && !x.draft && /^linux-/.test(x.tag_name));
    if (rel) point("linux", rel.html_url, false);
  });
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
<script>document.documentElement.classList.add("js");if(/Linux|X11/.test(navigator.platform||"")&&!/Android|CrOS/.test(navigator.userAgent))document.documentElement.classList.add("os-linux");</script>
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
console.log(`Built ${out} (index.html ${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
