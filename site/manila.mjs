// The amplefile.com page: the Manila brand's folder on a dark desk. Imported by build.mjs.
export const MN_CSS = `
/* Manila. Direction: a Mac file manager that gives each folder a Worker; character tidy, warm, matter-of-fact; world a manila folder on a dark desk;
   moments the app sliding out of the folder and organizing itself, and the app views laid on the folder; signature the blue dot, which is the Worker. */
.mn { --mn-desk:#16202B; --mn-back:#D4A14F; --mn-front:#EFCB7E; --mn-ink:#16202B; --mn-ink2:#4a3c21; --mn-ink3:#5c4b2c; --mn-line:rgba(22,32,43,.14);
  --mn-desk-tx:#F4F5F6; --mn-desk-tx2:#a9b1bc; --mn-desk-icon:#D0D5DB; --mn-desk-raise:rgba(244,245,246,.08); --mn-signal:#1F63D6; --mn-signal-hi:#1a56bd; --mn-on:#ffffff; --mn-hi:rgba(255,255,255,.45);
  --mn-bar:rgba(22,32,43,.94); --mn-bar-tx:#F4F5F6; --mn-bar-hl:rgba(244,245,246,.18);
  --mn-font:"Plus Jakarta Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mn-sys:-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", var(--mn-font);
  --ease:cubic-bezier(.22,1,.36,1); --desk:clamp(8px, 2.5cqi, 32px); --top:20px; --tab-h:64px; --band:48px; --r:20px; --mb-h:30px;
  background:var(--mn-desk); color:var(--mn-ink); font-family:var(--mn-font); font-size:17px; line-height:1.6; color-scheme:dark; padding:0 var(--desk) 48px; }
.mn > .mn-folder { margin-top:var(--top); }
.mn ::selection { background:var(--mn-ink); color:var(--mn-front); }
.mn a { color:inherit; }
.mn a:focus-visible, .mn button:focus-visible { outline:2px solid var(--mn-signal); outline-offset:3px; border-radius:8px; }
.mn :where(h1, h2, p) { margin:0; }
.mn h1, .mn h2 { font-weight:500; text-wrap:balance; overflow-wrap:break-word; min-width:0; }
.mn h1 { font-size:clamp(44px, 6.2cqi, 84px); line-height:1.02; letter-spacing:-.03em; max-width:12em; }
.mn h2 { font-size:clamp(28px, 2.8cqi, 40px); line-height:1.1; letter-spacing:-.02em; }
.mn .mw { box-shadow:0 24px 48px rgba(0,0,0,.18), 0 0 0 .5px rgba(0,0,0,.22); }
.mn .mk-b { fill:var(--mn-back); } .mn .mk-f { fill:var(--mn-front); } .mn .mk-d { fill:var(--mn-signal); }
.mn .gh { width:18px; height:18px; display:block; }

/* The menu bar arrives once the folder's tab has scrolled away. */
.mn-mb { position:sticky; top:0; z-index:20; height:var(--mb-h); margin:0 calc(-1 * var(--desk)) calc(-1 * var(--mb-h)); background:var(--mn-bar); color:var(--mn-bar-tx); -webkit-backdrop-filter:blur(20px) saturate(1.4); backdrop-filter:blur(20px) saturate(1.4); font:500 13px/1 var(--mn-sys);
  opacity:0; visibility:hidden; transform:translateY(-100%); will-change:transform, opacity;
  transition:transform 280ms cubic-bezier(.4, 0, .6, 1), opacity 240ms linear, visibility 0s linear 280ms; }
.mn-mb.is-shown { opacity:1; visibility:visible; transform:none; transition:transform 520ms var(--ease), opacity 360ms var(--ease), visibility 0s; }
@media (prefers-reduced-motion: reduce) { .mn-mb, .mn-mb.is-shown { transition:none; } }
.mn-mb-in { height:100%; display:flex; align-items:center; gap:4px; padding-inline:max(8px, env(safe-area-inset-left, 0px)) max(8px, env(safe-area-inset-right, 0px)); }
.mn-mb .mi { display:inline-flex; align-items:center; gap:6px; height:22px; padding:0 8px; border:0; border-radius:6px; background:transparent; color:inherit; font:inherit; text-decoration:none; white-space:nowrap; cursor:pointer; transition:background-color 160ms var(--ease); }
.mn-mb .mi:hover, .mn-mb .mi[aria-expanded="true"] { background:var(--mn-bar-hl); }
.mn-mb .app b { font-weight:600; }
.mn-mb .mark { width:16px; height:auto; display:block; }
.mn-mb .gh { width:15px; height:15px; }
.mn-mb .mbi { width:17px; height:17px; }
.mn-mb .sp { flex:1; }
.mn-mb .clock { padding:0 8px; white-space:nowrap; }
/* The note: an index card under the menu bar, handwritten, with an arrow up to the icon. */
.mn-note { --note-r:120px; position:absolute; top:calc(100% + 2px); right:var(--note-r); width:300px; height:150px; pointer-events:none; color:var(--mn-signal); font-family:"Caveat", "Bradley Hand", "Segoe Print", cursive; visibility:hidden; }
.mn-note.is-on { visibility:visible; }
.mn-card { position:absolute; left:-10px; right:24px; top:52px; height:84px; display:flex; align-items:flex-start; justify-content:center; padding:16px 24px 0; border:0; border-radius:3px; color:inherit; font:inherit; cursor:pointer; pointer-events:none;
  background:linear-gradient(180deg, transparent 0 9px, rgba(217,20,111,.3) 9px 10px, transparent 10px) no-repeat, repeating-linear-gradient(180deg, transparent 0 25px, rgba(31,99,214,.14) 25px 26px) 0 12px / 100% 100% no-repeat, #fffdf7;
  box-shadow:0 1px 1px rgba(22,32,43,.1), 0 14px 30px -8px rgba(22,32,43,.42); transform:rotate(-3deg) skewX(-3deg); transform-origin:72% 0; }
.mn-note.is-on .mn-card { pointer-events:auto; }
.mn-card:hover { box-shadow:0 1px 1px rgba(22,32,43,.1), 0 18px 34px -8px rgba(22,32,43,.46); }
.mn-card .x { position:absolute; top:5px; right:6px; width:16px; height:16px; color:rgba(22,32,43,.38); transition:color 160ms var(--ease); }
.mn-card:hover .x { color:rgba(22,32,43,.7); }
.mn-tape { position:absolute; top:-10px; left:50%; width:62px; height:20px; translate:-50% 0; rotate:5deg; background:rgba(255,255,255,.5); box-shadow:0 0 0 .5px rgba(22,32,43,.1); -webkit-backdrop-filter:blur(1.5px); backdrop-filter:blur(1.5px); }
.mn-note-arrow { position:absolute; inset:0; width:100%; height:100%; overflow:visible; filter:drop-shadow(0 0 2px var(--mn-front)) drop-shadow(0 0 3px var(--mn-front)); }
.mn-note-arrow path { fill:none; stroke:currentColor; stroke-width:2.6; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:1; stroke-dashoffset:1; }
.mn-note-text { display:flex; flex-direction:column; align-items:flex-start; margin:0; font-size:25px; font-weight:600; line-height:26px; letter-spacing:0; white-space:nowrap; text-align:left; }
.mn-note-text span { clip-path:inset(0 100% 0 0); }
.mn-note.is-on .mn-card { animation:mn-card-in 560ms cubic-bezier(.34,1.45,.64,1) both; }
.mn-note.is-on .mn-note-text span:nth-child(1) { animation:mn-write 620ms linear 420ms forwards; }
.mn-note.is-on .mn-note-text span:nth-child(2) { animation:mn-write 760ms linear 1060ms forwards; }
.mn-note.is-on .stem { animation:mn-draw 760ms cubic-bezier(.45,0,.25,1) 1800ms forwards; }
.mn-note.is-on .head { animation:mn-draw 220ms ease-out 2540ms forwards; }
.mn-note.is-gone .mn-card, .mn-note.is-gone .mn-note-arrow { animation:mn-card-out 240ms cubic-bezier(.4,0,1,1) forwards; }
@keyframes mn-card-in { from { opacity:0; transform:translateY(-18px) rotate(-11deg) skewX(-3deg) scale(.7); } to { opacity:1; transform:rotate(-3deg) skewX(-3deg); } }
@keyframes mn-card-out { to { opacity:0; transform:translateY(-10px) rotate(-6deg) skewX(-3deg) scale(.9); } }
@keyframes mn-write { to { clip-path:inset(0 0 0 0); } }
@keyframes mn-draw { to { stroke-dashoffset:0; } }
@media (prefers-reduced-motion: reduce) {
  .mn-note.is-on .mn-card, .mn-note.is-on .mn-note-text span, .mn-note.is-on path { animation:none; clip-path:none; stroke-dashoffset:0; }
}
.mn-pop { position:absolute; top:calc(var(--mb-h) + 4px); right:max(8px, env(safe-area-inset-right, 0px)); width:min(400px, calc(100% - 16px), calc((100svh - var(--mb-h) - 24px) * 400 / 560)); }
@media (prefers-reduced-motion: no-preference) { .mn-pop:not([hidden]) { animation:mn-drop 200ms var(--ease) both; transform-origin:100% 0; } }
@keyframes mn-drop { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }

/* The page folder: the tab carries the wordmark, the window is the paper inside. */
.mn-folder { position:relative; max-width:1320px; margin-inline:auto; padding-top:calc(var(--tab-h) + var(--band)); }
/* The folder's top stays put while the front slides up over it, closing the folder on the window. */
.mn > .mn-folder { padding-top:0; }
.mn-head { position:sticky; top:var(--top); z-index:0; padding-top:calc(var(--tab-h) + var(--band)); }
.mn-head > .mn-back { bottom:calc(-1 * var(--r)); }
.mn-back { position:absolute; inset:var(--tab-h) 0 0 0; background:var(--mn-back); border-radius:0 var(--r) var(--r) var(--r); }
.mn-tab { --pad:clamp(20px, 4.4cqi, 64px); position:absolute; top:0; left:0; width:calc(222px + 2 * var(--pad)); height:calc(var(--tab-h) + 1px); display:flex; align-items:center; justify-content:center; background:var(--mn-back); border-radius:var(--r) 0 0 0; }
.mn-tab::after { content:""; position:absolute; top:0; right:-67px; width:68px; height:100%; background:var(--mn-back); clip-path:path("M0 0 C 23 0 32 7 43 27 L 52 46 C 57 57 62 65 68 65 L 0 65 Z"); }
/* the box is centered; the capitals sit 42% down the wordmark, so a 4px nudge puts them on the tab's middle */
.mn-wm { display:block; color:var(--mn-ink); border-radius:6px; transform:translateY(4px); }
.mn-wm .wm { display:block; height:52px; width:auto; }
@media (prefers-reduced-motion: no-preference) { .mn-wm .wm-dot, .mn-mb .mk-d { animation:mn-pulse 1.6s ease-in-out infinite; } }
.mn .wm-dot.still { animation:none; }
@keyframes mn-pulse { 0%, 100% { opacity:1; } 50% { opacity:.3; } }
.mn-nav { position:absolute; top:8px; right:0; z-index:3; height:40px; display:flex; align-items:center; gap:8px; }
.mn .mn-gh { width:36px; height:36px; display:grid; place-items:center; border-radius:8px; color:var(--mn-desk-icon); transition:color 160ms var(--ease), background-color 160ms var(--ease); }
.mn .mn-gh:hover { color:var(--mn-desk-tx); background:var(--mn-desk-raise); }
.mn-btn { display:inline-flex; align-items:center; gap:8px; height:48px; padding:0 20px; border-radius:10px; background:var(--mn-signal); color:var(--mn-on) !important; font-size:16px; font-weight:500; text-decoration:none; white-space:nowrap; transition:background-color 160ms var(--ease), transform 160ms var(--ease); }
.mn-btn:hover { background:var(--mn-signal-hi); }
.mn-btn:active { transform:scale(.98); }
.mn-btn .dl { width:16px; height:16px; }
.mn-btn.sm { height:36px; padding:0 16px; font-size:14px; }
/* every app view shares one scale: 1120 px for a 1280 px window, so its text stays at 11 px or more */
.mn { --shot-w:1200px; }
.mn-paper { position:relative; width:min(calc(100% - 24px), var(--shot-w)); margin-inline:auto; aspect-ratio:1280 / 304; clip-path:inset(-32px -32px 0 -32px); }
.mn-paper .shot { position:absolute; inset:0 0 auto 0; }
.mn-front { position:relative; z-index:1; background:var(--mn-front); border-radius:var(--r); box-shadow:inset 0 1px 0 var(--mn-hi); padding:clamp(40px, 5cqi, 64px) clamp(20px, 4.4cqi, 64px) clamp(64px, 8cqi, 112px); }
.mn-hero { display:flex; flex-direction:column; align-items:center; text-align:center; }
.mn-hero h1 { max-width:none; }
.mn-lede { margin-top:24px; max-width:50rem; font-size:clamp(18px, 1.6cqi, 21px); line-height:1.5; color:var(--mn-ink2); text-wrap:balance; }
.mn-act { display:flex; flex-direction:column; align-items:flex-end; gap:12px; }
.mn-req { font-size:14px; line-height:20px; color:var(--mn-ink3); white-space:nowrap; }

/* What a Worker does, laid on the folder front. */
.mn-sec { margin-top:clamp(96px, 10cqi, 128px); display:flex; flex-direction:column; align-items:center; gap:40px; text-align:center; }
.mn-sec .copy { display:flex; flex-direction:column; align-items:center; gap:16px; }
.mn-hero + .mn-sec { margin-top:clamp(96px, 8cqi, 112px); }
.mn :where(p) { text-wrap:pretty; letter-spacing:.005em; }
.mn-sec .copy p { max-width:40em; color:var(--mn-ink2); text-wrap:balance; }
.mn .ln { display:block; }
.mn-sec .shot { width:min(100%, var(--shot-w)); }

/* The footer is the mark itself: the folder, and its blue dot is the download. */
/* smaller than the page folder: a shorter tab with its own curve, a smaller heading and dot */
.mn-end { padding-top:clamp(56px, 6cqi, 80px); }
.mn-end-folder { --band:24px; --tab-h:44px; }
.mn-end-folder .mn-tab { width:clamp(160px, 16%, 220px); }
.mn-end-folder .mn-tab::after { right:-46px; width:47px; clip-path:path("M0 0 C 16 0 22 5 30 19 L 36 32 C 39 39 43 45 47 45 L 0 45 Z"); }
.mn-end-wm { color:var(--mn-ink); line-height:0; margin-left:-3px; }
.mn-end-wm .wm { display:block; height:40px; width:auto; }
.mn-end-front { padding:32px clamp(20px, 4.4cqi, 64px) 32px; display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:24px 40px; align-items:center; }
.mn-end h2 { font-size:clamp(28px, 2.8cqi, 40px); line-height:1.1; letter-spacing:-.02em; }
.mn-end .mn-req { display:block; margin-top:12px; font-size:14px; }
.mn-dot { display:inline-flex; align-items:center; gap:16px; color:var(--mn-ink); font-size:16px; font-weight:500; text-decoration:none; white-space:nowrap; }
.mn-dot i { width:clamp(64px, 5.6cqi, 80px); aspect-ratio:1; display:grid; place-items:center; border-radius:50%; background:var(--mn-signal); color:var(--mn-on); transition:background-color 160ms var(--ease), transform 160ms var(--ease); }
.mn-dot i .dl { width:32%; height:32%; }
.mn-dot:hover i { background:var(--mn-signal-hi); }
.mn-dot:active i { transform:scale(.97); }
.mn-dot:focus-visible { outline:none; }
.mn-dot:focus-visible i { outline:2px solid var(--mn-ink); outline-offset:4px; }
.mn-end-acts { display:flex; align-items:center; gap:16px; }
.mn .mn-circ { width:clamp(64px, 5.6cqi, 80px); aspect-ratio:1; display:grid; place-items:center; border-radius:50%; transition:background-color 160ms var(--ease), transform 160ms var(--ease); }
.mn .mn-circ:active { transform:scale(.97); }
.mn .mn-circ:focus-visible { outline:2px solid var(--mn-ink); outline-offset:4px; }
.mn .mn-circ.mac { background:var(--mn-ink); color:var(--mn-front); }
.mn .mn-circ.mac:hover { background:#2a3644; }
.mn .mn-circ.mac .apple { width:38%; height:auto; margin-top:-6%; }
.mn .mn-circ.src { background:var(--mn-signal); color:var(--mn-on); }
.mn .mn-circ.src:hover { background:var(--mn-signal-hi); }
.mn .mn-circ.src .gh { width:42%; height:auto; }
.mn-links { grid-column:1 / -1; display:flex; flex-wrap:wrap; align-items:center; gap:8px 20px; padding-top:16px; border-top:1px solid var(--mn-line); font-size:14px; color:var(--mn-ink3); }
.mn-links a { text-decoration:none; transition:color 160ms var(--ease); }
.mn-links a:hover { color:var(--mn-ink); }
.mn-links .gh { color:var(--mn-ink); }

@container page (max-width: 900px) {
  .mn-sec { gap:32px; }
  .mn-hero + .mn-sec { margin-top:clamp(80px, 18cqi, 96px); }
}
@container page (max-width: 640px) {
  .mn > * { --tab-h:48px; --band:40px; --top:12px; --mb-h:40px; }
  .mn-tab::after { right:-51px; width:52px; clip-path:path("M0 0 C 17 0 24 5 32 20 L 39 35 C 43 43 47 49 52 49 L 0 49 Z"); }
  .mn-tab { width:calc(154px + 2 * var(--pad)); }
  .mn-wm { transform:translateY(3px); }
  .mn-wm .wm { height:36px; }
  .mn > .mn-folder { margin-top:48px; }
  .mn-head { top:48px; }
  .mn-nav { top:-48px; height:40px; }
  .mn-mb .clock, .mn-mb .hide-s { display:none; }
  .mn-paper { width:min(calc(100% - 24px), 400px); aspect-ratio:1280 / 620; }
  .mn-front { padding:28px 20px 64px; }
  .mn-req { white-space:normal; }
  .mn-end-folder { --tab-h:40px; --band:20px; }
  .mn-end-folder .mn-tab { width:44%; }
  .mn-end-folder .mn-tab::after { right:-42px; width:43px; clip-path:path("M0 0 C 14 0 20 4 27 17 L 32 29 C 35 35 39 41 43 41 L 0 41 Z"); }
  .mn-end-front { grid-template-columns:minmax(0, 1fr); padding:24px 20px 24px; }
  .mn .ln { display:inline; }
  .mn-dot { width:100%; justify-content:space-between; }
}

/* Motion: one curve. The paper slides out of the folder, the copy follows, then Organize runs. */
@media (prefers-reduced-motion: no-preference) {
  .page.mn:not([hidden]) .mn-paper { animation:mn-paper 560ms var(--ease) 80ms both; }
  .page.mn:not([hidden]) .mn-hero > * { animation:mn-rise 400ms var(--ease) both; }
  .page.mn:not([hidden]) .mn-hero > :nth-child(1) { animation-delay:240ms; }
  .page.mn:not([hidden]) .mn-hero > :nth-child(2) { animation-delay:300ms; }
}
@keyframes mn-paper { from { transform:translateY(56%); } to { transform:none; } }
@keyframes mn-rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
`;

export function mnMarkup({ shot, dlBtn, MENUBAR_ICON, SRC, DL, REL, PRIV, ext, ARROW, GITHUB, APPLE, WORDMARK, MARK, views }) {
  const { viewOrganizeLive, viewConnect, viewAutomationRun, viewAsk, viewHistory, viewAgent, viewNested } = views;
  const gh = (cls) => `<a class="${cls}" href="${SRC}" ${ext} aria-label="AmpleFile on GitHub" title="GitHub">${GITHUB}</a>`;
  return `<div class="page mn" id="top">
<header class="mn-mb" aria-label="Menu bar"><div class="mn-mb-in">
<button class="mi app" type="button" data-top>${MARK()}<b>AmpleFile</b></button><a class="mi" href="${DL}" ${ext}>Download</a>${gh("mi")}
<span class="sp"></span>
<button class="mi mn-mbi" type="button" aria-expanded="false" aria-controls="mn-pop" aria-label="AmpleFile Agent">${MENUBAR_ICON}</button><span class="clock" data-clock>Sat 9:41 AM</span></div>
<div class="mn-pop" id="mn-pop" hidden>${shot("agent", "v-agent in nofx", viewAgent())}</div>
<div class="mn-note" aria-hidden="true"><svg class="mn-note-arrow" viewBox="0 0 300 150"><path class="stem" pathLength="1" d="M236 50 C 238 37, 250 30, 259 35 C 268 40, 263 50, 255 46 C 247 42, 256 33, 268 31 C 281 29, 287 22, 289 4"/><path class="head" pathLength="1" d="M282.8 12.5 L289 4 L293.2 13.6"/></svg><div class="mn-card" role="button" tabindex="-1" title="Put away"><span class="mn-tape"></span><svg class="x" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 5l6 6M11 5l-6 6"/></svg><span class="mn-note-text"><span>The menu bar Agent</span><span>can reach all your Workers</span></span></div></div></header>
<div class="mn-folder">
<div class="mn-head">
<div class="mn-back" aria-hidden="true"></div>
<div class="mn-tab"><a class="mn-wm" href="#top" data-top aria-label="AmpleFile, back to the top">${WORDMARK}</a></div>
<nav class="mn-nav" aria-label="AmpleFile">${gh("mn-gh")}${dlBtn("mn-btn sm")}</nav>
<div class="mn-paper">${shot("live", "p-live nofx", viewOrganizeLive())}</div>
</div>
<main class="mn-front">
<section class="mn-hero"><h1>A Smart File Explorer</h1><p class="mn-lede">Every folder you connect gets its own dedicated&nbsp;AI&nbsp;agent, called a&nbsp;Worker.</p></section>
<section class="mn-sec"><div class="copy"><h2>Where Your Files Already Live</h2><p><span class="ln">Pick any folder on your Mac.</span> <span class="ln">Nothing&nbsp;moves, and it stays a normal folder in Finder.</span></p></div>${shot("connect", "p-full", viewConnect({ h: 680 }), ' style="--ch:680"')}</section>
<section class="mn-sec"><div class="copy"><h2>Runs on Its Own</h2><p><span class="ln">Turn on a ready-made Automation,</span> <span class="ln">or tell your Worker to set up a custom one for&nbsp;you.</span></p></div>${shot("automation", "p-chat", viewAutomationRun({ h: 720 }), ' style="--ch:720"')}</section>
<section class="mn-sec"><div class="copy"><h2>Or With Your Prompts</h2><p><span class="ln">Workers run on a full AI agent harness.</span> <span class="ln">They organize, research, draft documents, write code,</span> <span class="ln">and take on anything else you can think&nbsp;of.</span></p></div>${shot("ask", "p-chat", viewAsk({ h: 620 }), ' style="--ch:620"')}</section>
<section class="mn-sec"><div class="copy"><h2>Changes Are Tracked</h2><p><span class="ln">Anything you or your Worker change in AmpleFile</span> <span class="ln">can be undone with one&nbsp;click.</span></p></div>${shot("history", "p-chat", viewHistory({ h: 600 }), ' style="--ch:600"')}</section>
<section class="mn-sec" data-note><div class="copy"><h2>And Folders Can Stack</h2><p><span class="ln">Connect folders inside folders, as many as you like,</span> <span class="ln">and their Workers hand work to each&nbsp;other.</span></p></div>${shot("nested", "p-chat", viewNested({ h: 520 }), ' style="--ch:520"')}</section>
</main>
</div>
<footer class="mn-end"><div class="mn-folder mn-end-folder"><div class="mn-back" aria-hidden="true"></div><div class="mn-tab" aria-hidden="true"></div>
<div class="mn-front mn-end-front"><div><h2 class="mn-end-wm" aria-label="AmpleFile">${WORDMARK.replace('class="wm-dot"', 'class="wm-dot still"')}</h2><span class="mn-req">Apple silicon, macOS 12 or later</span></div>
<div class="mn-end-acts"><a class="mn-circ mac" href="${DL}" ${ext} aria-label="Download for Mac" title="Download for Mac">${APPLE}</a><a class="mn-circ src" href="${SRC}" ${ext} aria-label="AmpleFile on GitHub" title="GitHub">${GITHUB}</a></div>
<nav class="mn-links" aria-label="More"><a href="${REL}" ${ext}>Releases</a><a href="${PRIV}" ${ext}>Privacy</a><a href="https://github.com/Mat-Tom-Son/amplefile/blob/main/LICENSE" ${ext}>MIT License</a></nav></div></div></footer>
</div>`;
}
