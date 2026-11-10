// AmpleFile app views for amplefile.com, drawn as HTML at the sizes and words of
// the file manager's own CSS (web-local/src/components/file-manager/) and the
// AmpleFile Agent popover, and checked against captures of the app. Each view is static
// HTML in its finished state; a view with data-steps plays a short scene that
// is true to the app: the script removes the step classes s1..sN, then adds
// them back one at a time. Elements say when they arrive or leave with
// data-in / data-out / data-fade, a cursor glides to [data-press], and
// [data-type] fills in a typed request.

export const W = 1280;
export const H = 760;

// ---------- Glyphs, drawn as the app draws them ----------

const sv = (body, sw = 1.5, vb = "0 0 16 16") => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const glyph = {
  chevL: sv('<path d="M10 3.5 5.5 8l4.5 4.5"/>', 1.7),
  chevR: sv('<path d="M6 3.5 10.5 8 6 12.5"/>', 1.7),
  chevD: sv('<path d="M3.5 6 8 10.5 12.5 6"/>', 1.5),
  sortUp: sv('<path d="M4 10 8 6l4 4"/>', 1.5),
  grid: sv('<rect x="2.5" y="2.5" width="4.25" height="4.25" rx="1.1"/><rect x="9.25" y="2.5" width="4.25" height="4.25" rx="1.1"/><rect x="2.5" y="9.25" width="4.25" height="4.25" rx="1.1"/><rect x="9.25" y="9.25" width="4.25" height="4.25" rx="1.1"/>', 1.1),
  list: sv('<path d="M6 4.25h7.5M6 8h7.5M6 11.75h7.5"/><circle cx="3" cy="4.25" r=".55"/><circle cx="3" cy="8" r=".55"/><circle cx="3" cy="11.75" r=".55"/>', 1.15),
  more: sv('<circle cx="3.75" cy="8" r=".55"/><circle cx="8" cy="8" r=".55"/><circle cx="12.25" cy="8" r=".55"/>', 1.3),
  panel: sv('<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>', 1.1),
  search: sv('<circle cx="7" cy="7" r="4.5"/><path d="m10.4 10.4 3.1 3.1"/>', 1.5),
  plus: sv('<path d="M8 2.75v10.5M2.75 8h10.5"/>', 1.1),
  recents: sv('<circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.5 1.5"/>'),
  desktop: sv('<rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5"/><path d="M6 13.75h4M8 11.25v2.5"/>'),
  documents: sv('<path d="M4 1.75h5l3.25 3.25v9.25H4z"/><path d="M9 1.75V5h3.25"/>'),
  pictures: sv('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><circle cx="5.5" cy="6.25" r="1.25"/><path d="m2 11.5 3.5-3 2.5 2 2.5-2.5 3.75 3.5"/>'),
  home: sv('<path d="M2.25 7.25 8 2.25l5.75 5"/><path d="M3.75 6.25v7.5h8.5v-7.5"/><path d="M6.75 13.75v-3.5h2.5v3.5"/>'),
  icloud: sv('<path d="M4.75 12.75h7a3 3 0 0 0 .25-6A4.25 4.25 0 0 0 4 6.25a3.25 3.25 0 0 0 .75 6.5z"/>'),
  suggest: sv('<path d="M2.5 3.25h11v7.5H6.5l-3 2.5v-2.5h-1z"/>', 1.4),
  history: sv('<path d="M2.6 8.2A5.4 5.4 0 1 0 4.2 4.2"/><path d="M2.4 2.6v2.6H5"/><path d="M8 5.2v3l2 1.3"/>', 1.4),
  chat: sv('<path d="M8 2.6c3.2 0 5.6 2.1 5.6 4.8S11.2 12.2 8 12.2c-.7 0-1.3-.1-1.9-.3L3 13.3l.9-2.4C3 10 2.4 8.8 2.4 7.4 2.4 4.7 4.8 2.6 8 2.6z"/><path d="M5.6 6.6h4.8M5.6 8.6h3.2"/>', 1.3),
  compose: sv('<path d="M7.5 2.75H4a1.25 1.25 0 0 0-1.25 1.25v8A1.25 1.25 0 0 0 4 13.25h8A1.25 1.25 0 0 0 13.25 12V8.5"/><path d="m11.25 2.25 2.5 2.5L8 10.5H5.5V8z"/>', 1.3),
  send: sv('<path d="M8 12.5v-9M4.25 7.25 8 3.5l3.75 3.75"/>', 1.8),
  x: sv('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>', 1.6),
  docLink: sv('<path d="M4.5 1.75h4.5l2.75 2.75v9.75h-7.25z"/><path d="M9 1.75V4.5h2.75"/>', 1.3),
  thought: sv('<path d="M5 12.5h6.5a2.75 2.75 0 0 0 .3-5.5A3.9 3.9 0 0 0 4.3 6.4 3 3 0 0 0 5 12.5z"/><circle cx="3" cy="14" r=".6"/>', 1.25),
  listed: sv('<path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.75l1.5 1.75h5.25a1.5 1.5 0 0 1 1.5 1.5v6.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z"/>', 1.25),
  read: sv('<path d="M1.75 3.5h4a2 2 0 0 1 2 2v7.5a1.5 1.5 0 0 0-1.5-1.5h-4.5z"/><path d="M14.25 3.5h-4a2 2 0 0 0-2 2v7.5a1.5 1.5 0 0 1 1.5-1.5h4.5z"/>', 1.25),
  ran: sv('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3.25"/>', 1.25),
  goto: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4a1.25 1.25 0 0 1 1.25-1.25h2.6l1.3 1.4h5.1A1.25 1.25 0 0 1 13.25 5.4V7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M1.75 4v7.25A1.25 1.25 0 0 0 3 12.5h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="11.5" cy="11.5" r="3.6" fill="currentColor"/><path d="M9.9 11.5h3M11.9 10.3l1.1 1.2-1.1 1.2" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  caret: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3.5 3-3.5 3z" fill="currentColor"/></svg>',
  ring: '<svg class="mw-ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="1.5"/><path d="M8 1.75A6.25 6.25 0 0 1 12.4 3.6L8 8z" fill="var(--fm-accent)"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.75" y="4.75" width="6.5" height="6.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  globe: sv('<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5"/><path d="M8 1.75c1.9 1.8 2.75 3.9 2.75 6.25S9.9 12.45 8 14.25C6.1 12.45 5.25 10.35 5.25 8S6.1 3.55 8 1.75z"/>', 1.2),
  pages: sv('<path d="M4 1.75h5l3.25 3.25v9.25H4z"/><path d="M9 1.75V5h3.25"/><path d="M6.25 8.25h4M6.25 10.75h4"/>', 1.2),
  connect: sv('<circle cx="4" cy="8" r="1.9"/><circle cx="12" cy="3.9" r="1.9"/><circle cx="12" cy="12.1" r="1.9"/><path d="M5.7 7.15 10.3 4.8M5.7 8.85l4.6 2.35"/>', 1.2),
  skill: sv('<path d="M3.25 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9.5h-7.5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.25 12a1.5 1.5 0 0 1 1.5-1.5h7.5"/><path d="M6 5.25h3.5"/>', 1.2),
  plug: sv('<path d="M6 2.25v3M10 2.25v3"/><path d="M4.25 5.25h7.5V8a3.75 3.75 0 0 1-7.5 0z"/><path d="M8 11.75v2"/>', 1.2),
  code: sv('<path d="m5.25 5-3 3 3 3M10.75 5l3 3-3 3M9 3.5l-2 9"/>', 1.2),
  box: sv('<path d="M2.5 5 8 2.25 13.5 5v6L8 13.75 2.5 11z"/><path d="M2.5 5 8 7.75 13.5 5M8 7.75v6"/>', 1.2),
};

const CURSOR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 2.8v16.6l4-3.9 2.7 6.2 2.9-1.25-2.7-6.1h5.6z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';

export const MENUBAR_ICON = `<svg class="mbi" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.25 3.75H6.25C6.7 3.75 6.95 3.9 7.25 4.3L8.05 5.35C8.25 5.65 8.5 5.75 8.9 5.75H14.75C15.5784 5.75 16.25 6.4216 16.25 7.25V13.25C16.25 14.0784 15.5784 14.75 14.75 14.75H3.25C2.4216 14.75 1.75 14.0784 1.75 13.25V5.25C1.75 4.4216 2.4216 3.75 3.25 3.75Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 7.25H16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle fill="currentColor" cx="12.5" cy="11.25" r="1.25"/></svg>`;

// ---------- Scene attributes ----------

/** {in, out, fade, press, type, sel, focusIn, focusOut, d} → data attributes (d is a delay in ms). */
function at(a = {}) {
  let s = "";
  if (a.in != null) s += ` data-in="${a.in}"`;
  if (a.out != null) s += ` data-out="${a.out}"`;
  if (a.fade != null) s += ` data-fade="${a.fade}"`;
  if (a.press != null) s += ` data-press="${a.press}"`;
  if (a.sel != null) s += ` data-sel="${a.sel}"`;
  if (a.focusIn != null) s += ` data-focus-in="${a.focusIn}"`;
  if (a.focusOut != null) s += ` data-focus-out="${a.focusOut}"`;
  if (a.on != null) s += ` data-on="${a.on}"`;
  if (a.flash != null) s += ` data-flash="${a.flash}"`;
  if (a.d) s += ` style="--d:${a.d}ms"`;
  return s;
}
/** Text that changes at steps: [[text, {in, out}], ...]. */
const swap = (parts) => parts.map(([t, a]) => `<span class="sw"${at(a)}>${t}</span>`).join("");

// ---------- Icons: the app's Finder-shaped drawings, sized by font-size ----------

function fi(kind, tint) {
  if (kind === "folder") return tint ? `<span class="fi fi-folder tint" style="--fold-base:var(${tint})"></span>` : '<span class="fi fi-folder"></span>';
  if (kind === "img") return '<span class="fi fi-img"></span>';
  if (kind === "dmg" || kind === "pkg") return '<span class="fi fi-box"></span>';
  return `<span class="fi fi-doc t-${kind}"></span>`;
}

// ---------- Window parts ----------

const STD = { desktop: "Desktop", documents: "Documents", pictures: "Pictures", home: "you", icloud: "iCloud Drive" };
const COLORS = { "Client Work": "--cf-4", Desktop: "--cf-5", Downloads: "--cf-1", "Home Renovation": "--cf-2", "Taxes 2026": "--cf-3", Garden: "--cf-2", Kitchen: "--cf-2", Permits: "--cf-2" };

function dot(kind, a) { return `<i class="mw-dot ${kind}${a && a.in != null ? " a-pop" : ""}"${at(a)}></i>`; }

/**
 * The sidebar. std: [{id, cur, at}], con: [{name, cur, depth, open, dots: [[kind, at]], at}].
 */
function sidebar({ std, con }) {
  const s = std.map(({ id, cur, at: a }) => `<li class="mw-si${cur ? " cur" : ""}${a && a.in != null ? " a-row" : ""}"${at(a)}><span class="ic">${glyph[id]}</span><span class="nm">${STD[id]}</span></li>`).join("");
  const c = con.map(({ name, cur, depth = 0, open, dots = [], at: a, curAt }) => {
    const pad = depth ? ` style="--depth:${depth}"` : "";
    const caret = open ? `<span class="mw-caret open">${glyph.caret}</span>` : "";
    const cls = `mw-si${cur ? " cur" : ""}${a && a.in != null ? " a-row" : ""}`;
    return `<li class="${cls}"${at(a)}${pad}>${caret}<span class="ic">${fi("folder", COLORS[name])}</span><span class="nm">${name}</span>${dots.map(([k, da]) => dot(k, da)).join("")}</li>`;
  }).join("");
  return `<aside class="mw-side"><div class="mw-inset"><div class="mw-lights" aria-hidden="true"><i></i><i></i><i></i></div></div>
<ul class="mw-sl top"><li class="mw-si"><span class="ic">${glyph.recents}</span><span class="nm">Recents</span></li></ul>
<div class="mw-sh"><span>Standard Folders</span>${glyph.plus}</div><ul class="mw-sl">${s}</ul>
<div class="mw-sh"><span>Connected Folders</span>${glyph.plus}</div><ul class="mw-sl">${c}</ul></aside>`;
}

/** The Action menu's items for a Connected Folder; null is the separator. */
const ACTIONS = ["Customize Connected Folder", "Organize", "Skills & Extensions…", null, "Disconnect…", "Settings…"];
/** The Action menu, open from step `open` until `choose`, when the pointer chooses `item`. */
const actionMenu = ({ open, choose, item }) => `<div class="mw-menu a-menu"${at({ in: open, out: choose })}>${ACTIONS.map((t) => (t == null ? '<i class="sep"></i>' : `<span class="mi"${t === item ? at({ press: choose }) : ""}>${t.replace("&", "&amp;")}</span>`)).join("")}</div>`;

/** The toolbar. title: name; icon: HTML (or swap parts); more: when Action is pressed; menu: the Action menu's HTML. */
function toolbar({ title, icon, more, menu = "" }) {
  return `<header class="mw-tb"><span class="mw-cap"><span class="mw-tool dis">${glyph.chevL}</span><span class="mw-tool dis">${glyph.chevR}</span></span>
<span class="mw-title">${icon}<span class="tt">${title}</span></span><span class="mw-space"></span>
<span class="mw-cap"><span class="mw-tool">${glyph.grid}</span><span class="mw-tool on">${glyph.list}</span></span>
<span class="mw-cap${menu ? " mw-anchor" : ""}"><span class="mw-tool"${at(more)}>${glyph.more}</span>${menu}</span><span class="mw-cap"><span class="mw-tool">${glyph.globe}</span></span>
<span class="mw-search">${glyph.search}<span>Search names and contents</span></span><span class="mw-cap"><span class="mw-tool on">${glyph.panel}</span></span></header>`;
}

const head = `<div class="mw-cols"><span class="mw-col on">Name ${glyph.sortUp}</span><span class="mw-col">Date Modified</span><span class="mw-col s">Size</span></div>`;

/** One list row: {n, k, d, s, tint, dot: true | at, at, sel, press}. */
function row(r) {
  const cls = `mw-row${r.at && r.at.in != null ? " a-row" : ""}${r.sel === true ? " sel" : ""}`;
  const a = { ...(r.at || {}), ...(r.sel != null && r.sel !== true ? { sel: r.sel } : {}), ...(r.press != null ? { press: r.press } : {}) };
  const d = r.dot === true ? '<i class="mw-cdot"></i>' : r.dot ? `<i class="mw-cdot a-pop"${at(r.dot)}></i>` : "";
  return `<div class="${cls}"${at(a)}><span class="c n"><span class="ri">${fi(r.k, r.tint)}</span><span class="rn">${r.n}</span>${d}</span><span class="c">${r.d}</span><span class="c s">${r.s}</span></div>`;
}

function rows(list, { focus = false, focusOut, cls = "", a } = {}) {
  return `<div class="mw-rlist${focus ? " focus" : ""}${cls ? ` ${cls}` : ""}"${at({ ...(a || {}), ...(focusOut != null ? { focusOut } : {}) })}>${list.map(row).join("")}</div>`;
}

function pathbar(parts, count) {
  return `<footer class="mw-path"><span class="mw-goto">${glyph.goto}</span><span class="mw-crumbs">${parts.map((p) => `<span class="cr">${p}</span>`).join(`<span class="sep">${glyph.chevR}</span>`)}</span><span class="ct">${count}</span></footer>`;
}

function main({ title, icon, more, menu, lists, path, count }) {
  return `<section class="mw-main">${toolbar({ title, icon, more, menu })}${head}<div class="mw-rows">${lists}</div>${pathbar(path, count)}</section>`;
}

const folderTitle = (name) => fi("folder", COLORS[name]);

function tabs(on, historyDot = false) {
  return `<div class="mw-tabs"><span class="mw-seg"><span class="mw-seg-b${on === "Info" ? " on" : ""}">Info</span><span class="mw-seg-b${on === "History" ? " on" : ""}">History${historyDot ? '<i class="mw-dot done"></i>' : ""}</span></span></div>`;
}

const pv = (name, meta, tint) => `<div class="mw-hd"><div class="mw-pv">${fi("folder", tint)}</div><div class="mw-pv-name">${name}</div><div class="mw-pv-meta">${meta}</div></div>`;

const card = (inner) => `<div class="mw-card">${inner}</div>`;
const autoRow = (title, on) => on && typeof on === "object" ? `<div class="mw-crow"><span class="tn">${title}</span><span class="mw-sw"${at(on)} role="img" aria-label="On"></span></div>` : `<div class="mw-crow"><span class="tn">${title}</span><span class="mw-sw${on ? " on" : ""}" role="img" aria-label="${on ? "On" : "Off"}"></span></div>`;
const READY = ["Organize New Files", "Give New Files Clear Names", "Keep Screenshots Together", "Weekly Tidy-Up"];
const automations = (own = []) => `<section class="mw-sec"><div class="mw-sec-h">Automations</div>${card([...own.map(([t, on]) => autoRow(t, on)), ...READY.map((t) => autoRow(t, false))].join(""))}</section>`;

const SUGGEST_ALL = ["What’s in here?", "What changed this week?", "Organize this folder", "Find duplicate files"];

const meta = (ring = false) => `<div class="mw-meta"><span class="mw-model">Claude Sonnet<span>Medium</span>${glyph.chevD}</span>${ring ? glyph.ring : ""}</div>`;

/**
 * The Info tab's message box: suggestions, the selection chip, the field.
 * sugA: when the suggestions leave; chip: [{text, in, out}]; type: step that types `text`; focusIn: step that focuses the field.
 */
function infoComp({ placeholder, suggests = SUGGEST_ALL, sugA, sugRise = false, chips = [], ctxIn, type, text = "", focusIn, sendAt }) {
  const sug = suggests.length ? `<div class="mw-sugs"${at(sugA)}>${suggests.map((s, i) => `<span class="mw-btn mw-sug${sugRise ? " a-rise" : ""}"${sugRise ? ` style="--d:${i * 40}ms"` : ""}>${glyph.suggest}<span>${s}</span></span>`).join("")}</div>` : "";
  const ch = chips.length ? `<div class="mw-ctx"${at({ in: ctxIn })}>${chips.join("")}</div>` : "";
  const ty = type != null ? `<span class="ty" data-type="${type}" data-text="${text}"></span>` : "";
  const fa = focusIn != null ? at({ focusIn, press: focusIn }) : "";
  return `<div class="mw-comp">${sug}${ch}<div class="mw-field"${fa}><span class="tx">${ty}<span class="caret"></span><span class="ph">${placeholder}</span></span><span class="mw-send"${sendAt != null ? at({ press: sendAt }) : ""}>${glyph.send}</span></div>${meta()}</div>`;
}

/** The Chat's message box: while the Worker runs it reads Steer / Queue with a stop button, then Reply. */
function chatComp(doneAt) {
  if (doneAt == null) return `<div class="mw-comp chat"><div class="mw-field focus"><span class="tx"><span class="caret"></span><span class="ph">Reply</span></span><span class="mw-send">${glyph.send}</span></div>${meta(true)}</div>`;
  return `<div class="mw-comp chat"><div class="mw-field focus"><span class="tx"><span class="caret"></span><span class="ph">${swap([["Steer (Enter) · Queue (⌘Enter)", { out: doneAt }], ["Reply", { in: doneAt }]])}</span></span><span class="mw-send run"${at({ out: doneAt })}>${glyph.stop}</span><span class="mw-send"${at({ in: doneAt })}>${glyph.send}</span></div>${meta(true)}</div>`;
}

/** A Worker step: running verb (shimmering) until `doneAt`, then the past tense. */
function step({ icon, run, done, target, cmd = false, inAt, doneAt }) {
  const verb = doneAt == null ? `<b>${done}</b>` : `<b class="shim"${at({ out: doneAt })}>${run}</b><b${at({ in: doneAt })}>${done}</b>`;
  return `<div class="mw-step${inAt != null ? " a-step" : ""}"${at({ in: inAt })}><span class="si">${glyph[icon]}</span><span class="sl">${verb}${target ? `<span class="st${cmd ? " cmd" : ""}">${target}</span>` : ""}</span></div>`;
}

const fileLink = (name) => `<span class="mw-link">${glyph.docLink}${name}</span>`;

function chatPane({ title, a, msgs, comp }) {
  return `<div class="mw-pane chat${a && a.in != null ? " a-push" : ""}"${at(a)}><div class="mw-ph"><span class="mw-capbtn">${glyph.chevL}</span><span class="mw-ph-t">${title}</span></div><div class="mw-msgs">${msgs}</div>${comp}</div>`;
}

function toast(text, a, tone = "ok", action = "") {
  return `<div class="mw-toast ${tone} a-toast"${at(a)}><span class="tt">${text}</span>${action ? `<span class="ta">${action}</span>` : ""}<span class="tx">${glyph.x}</span></div>`;
}

const cursor = '<div class="mw-cursor" aria-hidden="true">' + CURSOR + "</div>";

function win({ label, h = H, steps, start, body, extra = "" }) {
  const n = steps ? steps.length : 0;
  const sc = steps ? ` data-steps="${steps.join(",")}"${start ? ` data-cursor="${start}"` : ""}` : "";
  const cls = Array.from({ length: n }, (_, i) => ` s${i + 1}`).join("");
  return `<div class="mw${cls}"${sc} style="height:calc(${h} * var(--u))" role="img" aria-label="${label}">${body}${extra}${steps && start ? cursor : ""}</div>`;
}

// ---------- Downloads: the hero's Organize run ----------

const DL_BEFORE = [
  ["document (3).pdf", "pdf", "Nov 4, 2026 at 2:18 PM", "86 KB"],
  ["garden-plan.jpg", "img", "Oct 28, 2026 at 7:12 PM", "3.4 MB"],
  ["IMG_4471.HEIC", "img", "Nov 1, 2026 at 11:03 AM", "2.8 MB"],
  ["invoice-2026-10-internet.pdf", "pdf", "Nov 1, 2026 at 9:30 AM", "90 KB"],
  ["kickoff-notes.docx", "docx", "Nov 5, 2026 at 4:40 PM", "47 KB"],
  ["lease-renewal-412-maple.pdf", "pdf", "Nov 2, 2026 at 6:15 PM", "2.0 MB"],
  ["order-113-4492.pdf", "pdf", "Nov 3, 2026 at 10:22 AM", "63 KB"],
  ["PhotoTool-Installer.dmg", "dmg", "Oct 31, 2026 at 8:47 PM", "463.5 MB"],
  ["printer-driver-5.2.pkg", "pkg", "Oct 29, 2026 at 1:05 PM", "202.2 MB"],
  ["receipt-0931.pdf", "pdf", "Nov 4, 2026 at 9:12 AM", "40 KB"],
  ["Screenshot 2026-11-06 at 8.02.51 AM.png", "img", "Yesterday at 8:02 AM", "1.3 MB"],
  ["slides-final-v3.pptx", "pptx", "Yesterday at 3:31 PM", "8.0 MB"],
].map(([n, k, d, s]) => ({ n, k, d, s }));
const DL_FOLDERS = ["Home", "Installers", "Photos", "Receipts", "Work"];
const DL_PATH = ["Macintosh HD", "Users", "you", "Downloads"];
const CON = ["Client Work", "Downloads", "Home Renovation", "Taxes 2026"];
const STD_ALL = ["desktop", "documents", "pictures", "home", "icloud"];

/** Downloads: choose Organize from the Action menu; the Worker makes five folders and moves the loose files in three batches, as the list shows them; the dots come when the turn ends. */
export function viewOrganizeLive() {
  // 1 press Action; 2 choose Organize; 3 thought; 4 listed; 5 reading; 6 mkdir running; 7 folders appear, first mv; 8–10 a batch leaves per mv; 11 the turn ends.
  const steps = [1100, 900, 800, 550, 600, 1000, 850, 700, 700, 700, 650];
  const batch = { "document (3).pdf": 8, "invoice-2026-10-internet.pdf": 8, "order-113-4492.pdf": 8, "receipt-0931.pdf": 8, "IMG_4471.HEIC": 9, "Screenshot 2026-11-06 at 8.02.51 AM.png": 9, "garden-plan.jpg": 9, "lease-renewal-412-maple.pdf": 9, "PhotoTool-Installer.dmg": 10, "printer-driver-5.2.pkg": 10, "kickoff-notes.docx": 10, "slides-final-v3.pptx": 10 };
  const folders = DL_FOLDERS.map((n, i) => ({ n, k: "folder", d: "Today at 9:41 AM", s: "--", at: { in: 7, d: i * 28 }, dot: { in: 11, d: 80 + i * 45 } }));
  // The listing sorts by name alone, so the new folders land among the files.
  const all = [...DL_BEFORE.map((r) => ({ ...r, gone: batch[r.n] })), ...folders].sort((a, b) => a.n.localeCompare(b.n, "en", { sensitivity: "base" }));
  const list = `<div class="mw-rlist">${all.map((r) => row(r).replace(/^<div class="mw-row"/, r.gone ? `<div class="mw-row" data-gone="${r.gone}"` : '<div class="mw-row"')).join("")}</div>`;
  const sidebarHtml = sidebar({ std: STD_ALL.map((id) => ({ id })), con: CON.map((name) => ({ name, cur: name === "Downloads", dots: name === "Downloads" ? [["run", { in: 2, out: 11 }]] : [] })) });
  const info = `<div class="mw-pane info"${at({ out: 2 })}>${tabs("Info")}<div class="mw-pscroll">${pv("Downloads", "12 items", "--cf-1")}${automations()}</div>${infoComp({ placeholder: "Work in Downloads" })}</div>`;
  const msgs = `<div class="mw-ub a-send">Organize this folder.</div>
<div class="mw-working shim"${at({ in: 2, out: 3 })}>Working…</div>
<div class="mw-steps"${at({ in: 3, out: 11 })}>${step({ icon: "thought", done: "Thought for 2s", inAt: 3 })}${step({ icon: "listed", done: "Listed", target: ".", inAt: 4 })}${step({ icon: "read", run: "Reading", done: "Read", target: "document (3).pdf", inAt: 5, doneAt: 6 })}${step({ icon: "ran", run: "Running", done: "Ran", target: "mkdir Home Installers Photos Receipts Work", cmd: true, inAt: 6, doneAt: 7 })}${step({ icon: "ran", run: "Running", done: "Ran", target: "mv 'document (3).pdf' invoice-2026-10-internet.pdf order-113-4492.pdf receipt-0931.pdf Receipts/", cmd: true, inAt: 7, doneAt: 8 })}${step({ icon: "ran", run: "Running", done: "Ran", target: "mv IMG_4471.HEIC 'Screenshot 2026-11-06 at 8.02.51 AM.png' Photos/; mv garden-plan.jpg lease-renewal-412-maple.pdf Home/", cmd: true, inAt: 8, doneAt: 9 })}${step({ icon: "ran", run: "Running", done: "Ran", target: "mv PhotoTool-Installer.dmg printer-driver-5.2.pkg Installers/; mv kickoff-notes.docx slides-final-v3.pptx Work/", cmd: true, inAt: 9, doneAt: 10 })}</div>
<span class="mw-pill a-fade"${at({ in: 11 })}>${glyph.listed}<span>Listed files, read a file, ran commands</span>${glyph.chevR}</span>
<div class="mw-as a-rise"${at({ in: 11, d: 120 })}><p>I sorted the 12 loose files into five new folders:</p><ul><li><b>Home</b>: the lease renewal and the garden plan</li><li><b>Installers</b>: PhotoTool and the printer driver</li><li><b>Photos</b>: IMG_4471.HEIC and yesterday’s screenshot</li><li><b>Receipts</b>: three receipts and the October internet invoice</li><li><b>Work</b>: the kickoff notes and the slides</li></ul><p>Nothing was renamed or deleted. ${fileLink("document (3).pdf")} turned out to be a receipt from Barrow Tile, so it’s in Receipts.</p></div>`;
  const chat = chatPane({ title: "Organize this folder", a: { in: 2 }, msgs, comp: chatComp(11) });
  const count = swap([["12 items", { out: 7 }], ["17 items", { in: 7, out: 8 }], ["13 items", { in: 8, out: 9 }], ["9 items", { in: 9, out: 10 }], ["5 items", { in: 10 }]]);
  const body = `${sidebarHtml}${main({ title: "Downloads", icon: folderTitle("Downloads"), more: { press: 1 }, menu: actionMenu({ open: 1, choose: 2, item: "Organize" }), lists: list, path: DL_PATH, count })}<aside class="mw-panel">${info}${chat}</aside>`;
  return win({ label: "AmpleFile organizing Downloads: Organize is chosen from the Action menu, the Worker makes five folders and moves the twelve loose files into them, and the list follows along", steps, start: "58,60", body });
}

// ---------- Desktop: connect it ----------

const DESK = [
  ["Hardware Store Receipt.png", "img", "Yesterday at 5:48 PM", "371 KB"],
  ["Kitchen Tile Options.png", "img", "Yesterday at 2:03 PM", "1.0 MB"],
  ["Project Notes.docx", "docx", "Nov 5, 2026 at 4:10 PM", "35 KB"],
  ["Q4 Budget Draft.xlsx", "xlsx", "Nov 4, 2026 at 11:22 AM", "47 KB"],
  ["Sync Error Message.png", "img", "Today at 8:41 AM", "94 KB"],
  ["Team Offsite Agenda.png", "img", "Nov 6, 2026 at 3:15 PM", "625 KB"],
  ["to-do.txt", "txt", "Nov 3, 2026 at 7:30 AM", "1000 B"],
].map(([n, k, d, s]) => ({ n, k, d, s }));
const DESK_PATH = ["Macintosh HD", "Users", "you", "Desktop"];

/** Desktop is a Standard Folder; Connect This Folder makes it a Connected Folder with a Worker. */
export function viewConnect({ h = 680 } = {}) {
  const steps = [1100, 3400];
  const side = sidebar({
    std: STD_ALL.map((id) => (id === "desktop" ? { id, cur: true, at: { out: 1 } } : { id })),
    con: ["Client Work", "Desktop", "Downloads", "Home Renovation", "Taxes 2026"].map((name) => (name === "Desktop" ? { name, cur: true, at: { in: 1 } } : { name })),
  });
  const icon = `<span class="sw"${at({ out: 1 })}>${fi("folder")}</span><span class="sw"${at({ in: 1 })}>${folderTitle("Desktop")}</span>`;
  const before = `<div class="mw-pane info"${at({ out: 1 })}><div class="mw-pscroll untabbed">${pv("Desktop", "7 items")}<section class="mw-sec"><div class="mw-cta"><div class="t">No Worker here yet</div><div class="s">Adds a Worker and History. Nothing moves.</div><span class="mw-btn primary"${at({ press: 1 })}>Connect This Folder</span></div></section></div></div>`;
  const after = `<div class="mw-pane info a-fade"${at({ in: 1 })}>${tabs("Info")}<div class="mw-pscroll">${pv("Desktop", "7 items", "--cf-5")}${automations()}</div>${infoComp({ placeholder: "Work in Desktop", sugRise: true })}</div>`;
  const body = `${side}${main({ title: "Desktop", icon, lists: rows(DESK), path: DESK_PATH, count: "7 items" })}<aside class="mw-panel">${before}${after}</aside>`;
  return win({ label: "AmpleFile connecting Desktop: Connect This Folder turns it into a Connected Folder with a Worker, and nothing moves", h, steps, start: "52,86", body, extra: toast("Desktop is now a Connected Folder.", { in: 1, fade: 2 }) });
}

// ---------- Desktop: an Automation renames a new screenshot ----------

/** Give Screenshots Friendly Names is switched on; a screenshot lands with the name macOS gives it, and the Worker renames it in place. */
export function viewAutomationRun({ h = 760 } = {}) {
  // 1 the switch is clicked on; 2 the screenshot lands; 3 the Automation's Worker starts; 4 it's renamed, with the receipt.
  const steps = [900, 1500, 900, 2300];
  const OLD = "Screenshot 2026-11-08 at 9.12.04 AM.png", NEW = "Seattle Flight Confirmation.png";
  const shotRow = `<div class="mw-row a-row"${at({ in: 2, flash: 4 })}><span class="c n"><span class="ri">${fi("img")}</span><span class="rn">${swap([[OLD, { out: 4 }], [NEW, { in: 4 }]]).replace(/class="sw"/g, 'class="sw nm-swap"')}</span><i class="mw-cdot a-pop"${at({ in: 4, d: 260 })}></i></span><span class="c">Today at 9:12 AM</span><span class="c s">402 KB</span></div>`;
  // Sorted by name, the friendly name lands in the same place the screenshot was.
  const list = `<div class="mw-rlist">${DESK.slice(0, 4).map(row).join("")}${shotRow}${DESK.slice(4).map(row).join("")}</div>`;
  const side = sidebar({ std: STD_ALL.filter((id) => id !== "desktop").map((id) => ({ id })), con: ["Client Work", "Desktop", "Downloads", "Home Renovation", "Taxes 2026"].map((name) => ({ name, cur: name === "Desktop", dots: name === "Desktop" ? [["run", { in: 3, out: 4 }]] : [] })) });
  const receipt = `<div class="mw-rcpt a-rise"${at({ in: 4, d: 360 })}><div class="mw-rhead"><i class="mw-dot done"></i><span class="t">The Worker changed 1 item</span><span class="tm">Today at 9:12 AM</span></div><div class="mw-rsum">1 moved</div><div class="mw-rlist2"><div class="mw-rrow"><span class="n">${NEW}</span><span class="v">Moved</span></div></div><div class="mw-ract"><span class="mw-btn small">Undo</span><span class="mw-btn small">Done</span></div></div>`;
  const items = swap([["7 items", { out: 2 }], ["8 items", { in: 2 }]]);
  const info = `<div class="mw-pane info">${tabs("Info")}<div class="mw-pscroll">${receipt}${pv("Desktop", items, "--cf-5")}${automations([["Give Screenshots Friendly Names", { press: 1, on: 1 }]])}</div>${infoComp({ placeholder: "Work in Desktop", suggests: SUGGEST_ALL.slice(0, 2) })}</div>`;
  const body = `${side}${main({ title: "Desktop", icon: folderTitle("Desktop"), lists: list, path: DESK_PATH, count: items })}<aside class="mw-panel">${info}</aside>`;
  return win({ label: "Give Screenshots Friendly Names is switched on; a screenshot lands on Desktop and the Worker renames it Seattle Flight Confirmation.png", h, steps, start: "70,96", body });
}

// ---------- Home Renovation: select three quotes and ask ----------

const HR_PATH = ["Macintosh HD", "Users", "you", "Documents", "Home Renovation"];
const ACRO = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6.2l2.8 2.8v10.2h-9z" fill="#fff" stroke="#b9b9c0" stroke-width=".8" stroke-linejoin="round"/><path d="M9.7 1.5v2.8h2.8" fill="none" stroke="#b9b9c0" stroke-width=".8"/><rect x="2" y="3" width="6" height="3.2" rx=".6" fill="#d93a2b"/><path d="M3.1 5.3V3.9h.75a.45.45 0 0 1 0 .9H3.1M4.9 5.3V3.9h.5a.7.7 0 0 1 0 1.4zM6.6 5.3V3.9h.95M6.6 4.6h.75" fill="none" stroke="#fff" stroke-width=".45" stroke-linecap="round"/><path d="M5.2 12.6c.9-1.6 1.6-3.4 1.8-4.9.15-1-.9-1-.8 0 .2 1.6 1.6 3.3 3.6 4.1 1 .4 1.3-.5.3-.6-1.9-.2-3.9.4-5.3 1.3-.6.4-.2 1 .4.1z" fill="none" stroke="#d93a2b" stroke-width=".7" stroke-linejoin="round"/></svg>';
const pdfChip = (n) => `<span class="mw-fchip">${ACRO}<b>${n}</b></span>`;
const ctxChip = (n, more, a) => `<span class="mw-cchip-wrap"${at(a)}><span class="mw-cchip">${fi("pdf")}<span class="n">${n}</span><span class="cx">${glyph.x}</span></span>${more ? `<span class="mw-cchip more">${more}</span>` : ""}</span>`;

/** Select three quotes, ask for a comparison, and the Worker writes Quote Comparison.docx beside them. */
export function viewAsk({ h = 620 } = {}) {
  // 1–3 select; 4 click the field and type; 5 send; 6–7 steps; 8 the file appears; 9 the turn ends.
  const steps = [900, 550, 550, 800, 900, 800, 1100, 1300, 600];
  const list = [
    { n: "budget.xlsx", k: "xlsx", d: "Yesterday at 7:02 PM", s: "30 KB" },
    { n: "kitchen-plan.pdf", k: "pdf", d: "Oct 28, 2026 at 9:40 AM", s: "1.1 MB" },
    { n: "Permits", k: "folder", d: "Nov 3, 2026 at 4:12 PM", s: "--" },
    { n: "Photos", k: "folder", d: "Today at 8:15 AM", s: "--" },
    { n: "Quote Comparison.docx", k: "docx", d: "Today at 9:44 AM", s: "18 KB", at: { in: 8 }, dot: { in: 9 } },
    { n: "quote-barrow-tile.pdf", k: "pdf", d: "Oct 30, 2026 at 2:16 PM", s: "207 KB", sel: 1, press: 1 },
    { n: "quote-north-co.pdf", k: "pdf", d: "Oct 31, 2026 at 10:05 AM", s: "184 KB", sel: 2, press: 2 },
    { n: "quote-ridgeline.pdf", k: "pdf", d: "Nov 2, 2026 at 5:50 PM", s: "234 KB", sel: 3, press: 3 },
    { n: "tile-sample.png", k: "img", d: "Oct 27, 2026 at 6:33 PM", s: "2.3 MB" },
  ];
  const side = sidebar({ std: STD_ALL.map((id) => ({ id })), con: CON.map((name) => ({ name, cur: name === "Home Renovation", dots: name === "Home Renovation" ? [["run", { in: 5, out: 9 }]] : [] })) });
  const chips = [ctxChip("quote-barrow-tile.pdf", "", { in: 1, out: 2 }), ctxChip("quote-barrow-tile.pdf", "+1", { in: 2, out: 3 }), ctxChip("quote-barrow-tile.pdf", "+2", { in: 3 })];
  const info = `<div class="mw-pane info"${at({ out: 5 })}>${tabs("Info")}<div class="mw-pscroll">${pv("Home Renovation", "8 items", "--cf-2")}${automations()}</div>${infoComp({ placeholder: "Work in Home Renovation", sugA: { out: 4 }, chips, ctxIn: 1, type: 4, text: "Compare these three quotes and put the details in a document.", focusIn: 4, sendAt: 5 })}</div>`;
  const msgs = `<div class="mw-fchips">${["quote-barrow-tile.pdf", "quote-north-co.pdf", "quote-ridgeline.pdf"].map(pdfChip).join("")}</div><div class="mw-ub a-send">Compare these three quotes and put the details in a document.</div>
<div class="mw-working shim"${at({ in: 5, out: 6 })}>Working…</div>
<div class="mw-steps"${at({ in: 6, out: 9 })}>${step({ icon: "thought", done: "Thought for 3s", inAt: 6 })}${step({ icon: "read", run: "Reading", done: "Read", target: "quote-barrow-tile.pdf", inAt: 6, doneAt: 7 })}${step({ icon: "read", done: "Read", target: "quote-north-co.pdf", inAt: 7 })}${step({ icon: "read", done: "Read", target: "quote-ridgeline.pdf", inAt: 7 })}${step({ icon: "ran", run: "Running", done: "Ran", target: "python3 write_comparison.py", cmd: true, inAt: 7, doneAt: 9 })}</div>
<span class="mw-pill a-fade"${at({ in: 9 })}>${glyph.read}<span>Read files, ran a command</span>${glyph.chevR}</span>
<div class="mw-as a-rise"${at({ in: 9, d: 120 })}><p>Barrow Tile is lowest at $8,420 and can start November 18. Ridgeline costs $1,150 more but includes demolition and haul-away. North Co. leaves out the backsplash, so its $7,980 isn’t a like-for-like price.</p><p>I put the line-by-line comparison in ${fileLink("Quote Comparison.docx")}.</p></div>`;
  const chat = chatPane({ title: "Compare quotes", a: { in: 5 }, msgs, comp: chatComp(9) });
  const body = `${side}${main({ title: "Home Renovation", icon: folderTitle("Home Renovation"), lists: rows(list, { focus: true, focusOut: 4 }), path: HR_PATH, count: swap([["8 items", { out: 1 }], ["1 of 8 selected", { in: 1, out: 2 }], ["2 of 8 selected", { in: 2, out: 3 }], ["3 of 8 selected", { in: 3, out: 8 }], ["3 of 9 selected", { in: 8 }]]) })}<aside class="mw-panel">${info}${chat}</aside>`;
  return win({ label: "Three quotes selected in Home Renovation and a request to compare them; the Worker answers in the Chat and writes Quote Comparison.docx", h, steps, start: "30,96", body });
}

// ---------- Home Renovation: Skills & Extensions ----------

/** The Action menu opens Skills & Extensions: the tools every Worker has, then what's installed everywhere and for this Connected Folder. */
export function viewSkills({ h = 680 } = {}) {
  // 1 press Action, and its menu opens; 2 choose Skills & Extensions…, and the dialog rises over the dimmed window.
  const steps = [1100, 1000];
  const list = [
    { n: "budget.xlsx", k: "xlsx", d: "Yesterday at 7:02 PM", s: "30 KB" },
    { n: "kitchen-plan.pdf", k: "pdf", d: "Oct 28, 2026 at 9:40 AM", s: "1.1 MB" },
    { n: "Permits", k: "folder", d: "Nov 3, 2026 at 4:12 PM", s: "--" },
    { n: "Photos", k: "folder", d: "Today at 8:15 AM", s: "--" },
    { n: "Quote Comparison.docx", k: "docx", d: "Today at 9:44 AM", s: "18 KB" },
    { n: "quote-barrow-tile.pdf", k: "pdf", d: "Oct 30, 2026 at 2:16 PM", s: "207 KB" },
    { n: "quote-north-co.pdf", k: "pdf", d: "Oct 31, 2026 at 10:05 AM", s: "184 KB" },
    { n: "quote-ridgeline.pdf", k: "pdf", d: "Nov 2, 2026 at 5:50 PM", s: "234 KB" },
    { n: "tile-sample.png", k: "img", d: "Oct 27, 2026 at 6:33 PM", s: "2.3 MB" },
  ];
  const side = sidebar({ std: STD_ALL.map((id) => ({ id })), con: CON.map((name) => ({ name, cur: name === "Home Renovation" })) });
  const menu = actionMenu({ open: 1, choose: 2, item: "Skills & Extensions…" });
  const info = `<div class="mw-pane info">${tabs("Info")}<div class="mw-pscroll">${pv("Home Renovation", "9 items", "--cf-2")}${automations()}</div>${infoComp({ placeholder: "Work in Home Renovation" })}</div>`;
  const seg = (items, on) => `<span class="se-seg">${items.map((t) => `<span${t === on ? ' class="on"' : ""}>${t}</span>`).join("")}</span>`;
  const tile = (icon, name, status, tone, setup = false) => `<div class="se-tile"><span class="ic">${glyph[icon]}</span><b>${name}</b><span class="se-st ${tone}"><i></i>${status}</span>${setup ? `<span class="se-set">Set Up${glyph.chevR}</span>` : ""}</div>`;
  const heading = (title, sub, count) => `<div class="se-hd"><span><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</span>${count ? `<i class="se-ct">${count}</i>` : ""}</div>`;
  const item = (icon, name, kind, detail) => `<div class="se-row"><span class="ki">${glyph[icon]}</span><span class="cp"><span class="tl"><b>${name}</b><span class="se-kind">${kind}</span></span><span class="dt">${detail}</span></span><span class="chev">${glyph.chevR}</span></div>`;
  const more = (icon, name, count) => `<div class="se-sum">${glyph.chevR}${glyph[icon]}<span>${name}</span><small>${count}</small></div>`;
  const dialog = `<div class="mw-dim a-fade"${at({ in: 2 })}></div>
<div class="se a-dlg"${at({ in: 2 })}><header class="se-h"><span class="se-t">Skills &amp; Extensions</span>${seg(["Installed", "Discover"], "Installed")}<span class="se-sp"></span><span class="mw-btn se-add">${glyph.plus}<span>Add Custom</span></span><span class="se-x">${glyph.x}</span></header>
<div class="se-b"><div class="se-tools"><span class="se-search">${glyph.search}<span>Search installed tools</span></span>${seg(["All", "Skills", "Extensions"], "All")}</div>
${heading("Included with AmpleFile")}<div class="se-grid">${tile("desktop", "Computer Control", "Ready", "ok")}${tile("globe", "Web", "Ready", "ok")}${tile("pages", "Documents", "Ready", "ok")}${tile("connect", "Service Connections", "No Connections", "warn", true)}</div>
<div class="se-cols"><section>${heading("Everywhere", "AmpleFile Agent and all Workers", 2)}<div class="se-card">${item("skill", "Meeting Notes", "Skill", "Turns rough notes into decisions, owners, and next steps.")}${item("plug", "Calendar helper", "Extension", "1 tool · 1 command")}</div></section>
<section>${heading("This Connected Folder only", "Home Renovation", 1)}<div class="se-card">${item("skill", "Quote Check", "Skill", "Compares contractor quotes line by line and flags what’s missing.")}</div></section></div>
${heading("Tools and Packages", "Pi’s built-in tools and the Pi packages installed through it")}<div class="se-card">${more("code", "Built-In Tools", 7)}${more("box", "Packages", 1)}</div></div></div>`;
  const body = `${side}${main({ title: "Home Renovation", icon: folderTitle("Home Renovation"), more: { press: 1 }, menu, lists: rows(list), path: HR_PATH, count: "9 items" })}<aside class="mw-panel">${info}</aside>`;
  return win({ label: "Skills & Extensions for Home Renovation: Computer Control, Web, Documents, and Service Connections are included with AmpleFile, with a Skill and an Extension installed everywhere and one Skill for this Connected Folder", h, steps, start: "40,46", body, extra: dialog });
}

// ---------- Taxes 2026: Undo in History ----------

/** History lists a checkpoint before each Worker reply; Undo puts the folder back. */
export function viewHistory({ h = 600 } = {}) {
  const steps = [1100, 3600];
  const list = [
    { n: "1099-INT-first-bank.pdf", k: "pdf", d: "Feb 2, 2026 at 9:15 AM", s: "117 KB" },
    { n: "1099-NEC-client-works.pdf", k: "pdf", d: "Feb 5, 2026 at 1:40 PM", s: "94 KB" },
    { n: "charitable-gifts.xlsx", k: "xlsx", d: "Oct 19, 2026 at 8:22 PM", s: "23 KB" },
    { n: "estimated-payments.xlsx", k: "xlsx", d: "Sep 15, 2026 at 7:10 AM", s: "18 KB" },
    { n: "questions-for-accountant.docx", k: "docx", d: "Today at 10:05 AM", s: "21 KB", dot: true, at: { out: 1 } },
    { n: "Receipts", k: "folder", d: "Yesterday at 6:41 PM", s: "--" },
    { n: "Statements", k: "folder", d: swap([["Today at 10:03 AM", { out: 1 }], ["Yesterday at 6:40 PM", { in: 1 }]]), s: "--", dot: { out: 1 } },
    { n: "W-2-2026.pdf", k: "pdf", d: "Jan 30, 2026 at 5:02 PM", s: "86 KB" },
  ];
  // A dot that's there from the start and leaves at a step.
  const html = rows(list).replace('<i class="mw-cdot a-pop" data-out="1"></i>', '<i class="mw-cdot" data-out="1"></i>');
  const side = sidebar({ std: STD_ALL.map((id) => ({ id })), con: CON.map((name) => ({ name, cur: name === "Taxes 2026", dots: name === "Taxes 2026" ? [["done"]] : [] })) });
  const change = (t, sub, btn, press) => `<div class="mw-crow two"><span class="gl">${glyph.history}</span><span class="tt"><span>${t}</span><span class="sub">${sub}</span></span><span class="mw-btn small"${at(press != null ? { press } : {})}>${btn}</span></div>`;
  const chatRow = (t, sub, d) => `<div class="mw-crow two"><span class="gl">${glyph.chat}</span><span class="tt"><span>${t}</span><span class="sub">${sub}</span></span>${d ? '<i class="mw-dot done"></i>' : ""}<span class="chev">${glyph.chevR}</span></div>`;
  const changes = card(change("Before a Worker reply", "Today at 10:02 AM · 12 files", "Undo", 1) + change("Before a Worker reply", "Yesterday at 6:40 PM · 31 files", "Undo") + change("Before deleting old-drafts", "Monday at 11:15 AM · 3 files", "Undo") + change("Saved by you", "Nov 1 · 48 files", "Restore"));
  const chats = card(chatRow("Rename the statements", "Today at 10:05 AM", true) + chatRow("What’s still missing?", "Yesterday at 7:15 PM") + chatRow("Sort receipts by month", "Yesterday at 6:41 PM"));
  const panel = `<div class="mw-pane info">${tabs("History", true)}<div class="mw-pscroll"><section class="mw-sec first"><div class="mw-sec-h">Changes</div>${changes}</section><section class="mw-sec"><div class="mw-sec-h">Chats</div>${chats}</section></div><div class="mw-comp"><div class="mw-field"><span class="tx"><span class="ph">Work in Taxes 2026</span></span><span class="mw-send">${glyph.send}</span></div>${meta()}</div></div>`;
  const body = `${side}${main({ title: "Taxes 2026", icon: folderTitle("Taxes 2026"), lists: html, path: ["Macintosh HD", "Users", "you", "Documents", "Taxes 2026"], count: swap([["8 items", { out: 1 }], ["7 items", { in: 1 }]]) })}<aside class="mw-panel">${panel}</aside>`;
  return win({ label: "AmpleFile's History tab for Taxes 2026: Undo on the latest Worker reply puts the folder back as it was", h, steps, start: "56,92", body, extra: toast("Undid Worker reply", { in: 1, fade: 2 }, "info", "Undo") });
}

// ---------- Home Renovation with Connected Folders inside ----------

/** Garden, Kitchen, and Permits are Connected Folders inside Home Renovation; its Worker asks two of them and writes the plan. */
export function viewNested({ h = 520 } = {}) {
  // 1 click the field and type; 2 send; 3 Kitchen and Permits start; 4 Kitchen answers; 5 Permits answers; 6 the plan is written; 7 the turn ends.
  const steps = [900, 900, 1100, 1500, 500, 800, 600];
  const side = sidebar({
    std: STD_ALL.map((id) => ({ id })),
    con: [
      { name: "Client Work" }, { name: "Downloads" },
      { name: "Home Renovation", cur: true, open: true, dots: [["run", { in: 2, out: 7 }]] },
      { name: "Garden", depth: 1 },
      { name: "Kitchen", depth: 1, dots: [["run", { in: 3, out: 4 }], ["done", { in: 4 }]] },
      { name: "Permits", depth: 1, dots: [["run", { in: 3, out: 5, d: 260 }], ["done", { in: 5 }]] },
      { name: "Taxes 2026" },
    ],
  });
  const list = [
    { n: "budget.xlsx", k: "xlsx", d: "Yesterday at 7:02 PM", s: "30 KB" },
    { n: "Garden", k: "folder", tint: "--cf-2", d: "Nov 1, 2026 at 3:20 PM", s: "--" },
    { n: "Kitchen", k: "folder", tint: "--cf-2", d: "Today at 9:58 AM", s: "--" },
    { n: "Kitchen Week Plan.docx", k: "docx", d: "Today at 10:01 AM", s: "23 KB", at: { in: 6 }, dot: { in: 7 } },
    { n: "kitchen-plan.pdf", k: "pdf", d: "Oct 28, 2026 at 9:40 AM", s: "1.1 MB" },
    { n: "Permits", k: "folder", tint: "--cf-2", d: "Today at 9:57 AM", s: "--" },
    { n: "Quote Comparison.docx", k: "docx", d: "Today at 9:44 AM", s: "18 KB" },
    { n: "tile-sample.png", k: "img", d: "Oct 27, 2026 at 6:33 PM", s: "2.3 MB" },
  ];
  const ask = "Ask Kitchen how the tile order is going and Permits what’s still open, then write up the week.";
  const info = `<div class="mw-pane info"${at({ out: 2 })}>${tabs("Info")}<div class="mw-pscroll">${pv("Home Renovation", "7 items", "--cf-2")}${automations()}</div>${infoComp({ placeholder: "Work in Home Renovation", sugA: { out: 1 }, type: 1, text: ask, focusIn: 1, sendAt: 2 })}</div>`;
  const msgs = `<div class="mw-ub a-send">${ask}</div>
<div class="mw-working shim"${at({ in: 2, out: 7 })}>Working…</div>
<span class="mw-pill a-fade"${at({ in: 7 })}>${glyph.ran}<span>Ran commands</span>${glyph.chevR}</span>
<div class="mw-as a-rise"${at({ in: 7, d: 120 })}><p>The Kitchen Worker says the tile ships Tuesday and the installer starts Thursday. The Permits Worker says the electrical inspection is still open; the inspector can come Wednesday or Friday.</p><p>I put the week’s plan in ${fileLink("Kitchen Week Plan.docx")}, with the inspection on Wednesday so it lands before the installer.</p></div>`;
  const chat = chatPane({ title: "Plan the kitchen week", a: { in: 2 }, msgs, comp: chatComp(7) });
  const body = `${side}${main({ title: "Home Renovation", icon: folderTitle("Home Renovation"), lists: rows(list), path: HR_PATH, count: swap([["7 items", { out: 6 }], ["8 items", { in: 6 }]]) })}<aside class="mw-panel">${info}${chat}</aside>`;
  return win({ label: "Home Renovation's Worker asks the Kitchen and Permits Workers inside it for updates, then writes Kitchen Week Plan.docx", h, steps, start: "40,94", body });
}

// ---------- The AmpleFile agent in the menu bar ----------

const pg = {
  history: sv('<path d="M2.6 8.2A5.4 5.4 0 1 0 4.2 4.2"/><path d="M2.4 2.6v2.6H5"/><path d="M8 5.2v3l2 1.3"/>', 1.15),
  compose: sv('<path d="M7.5 2.75H4a1.25 1.25 0 0 0-1.25 1.25v8A1.25 1.25 0 0 0 4 13.25h8A1.25 1.25 0 0 0 13.25 12V8.5"/><path d="m11.25 2.25 2.5 2.5L8 10.5H5.5V8z"/>', 1.1),
  thought: sv('<path d="M5.5 10.5h6.75a2.25 2.25 0 0 0 0-4.5h-.15A3.25 3.25 0 0 0 5.8 5.4 2.55 2.55 0 0 0 5.5 10.5z"/><circle cx="3.4" cy="12.6" r="1"/><circle cx="1.8" cy="14.5" r=".6"/>', 1.1),
  ran: sv('<rect x="2" y="2.25" width="12" height="11.5" rx="2"/><path d="M2 5.25h12"/><path d="m4.75 7.6 1.75 1.5-1.75 1.5M8.25 10.6h3"/>', 1.1),
};

/** Each word of a reply in its own span, so it can stream in. */
const words = (t) => t.replace(/\S+\s*/g, (w) => `<span class="w">${w}</span>`);

/**
 * The menu-bar popover (the real window is 400 x 560), redesigned in 0.1.2 to match the panel Chat.
 * 1 the question types in; 2 it's sent: the bubble lands, Send becomes Stop, the timer starts; 3 Thinking…;
 * 4 Thought, a command runs; 5 another runs; 6 Thinking… again; 7 the steps fold into the pill and the reply streams; 8 the turn ends.
 */
export function viewAgent() {
  const steps = [600, 380, 500, 900, 900, 800, 1300, 350];
  const Q = "What did my folders get done today?";
  const verb = (run, done, k) => `<b class="shim"${at({ out: k })}>${run}</b><b${at({ in: k })}>${done}</b>`;
  const pstep = (icon, inner, a) => `<div class="mw-step a-step"${at(a)}><span class="si">${pg[icon]}</span><span class="sl">${inner}</span></div>`;
  const tick = (k, start = "") => `<span class="st tk" data-tick="${k}">${start}</span>`;
  const stepsHtml = `<div class="mb-steps"${at({ in: 3, out: 7 })}>
${pstep("thought", `${verb("Thinking…", "Thought for 2s", 4)}<span${at({ out: 4 })}>${tick(3)}</span>`, { in: 3 })}
${pstep("ran", `${verb("Running", "Ran", 5)}<span class="st cmd">amplefile agent overview --json</span>`, { in: 4 })}
${pstep("ran", `${verb("Running", "Ran", 6)}<span class="st cmd">amplefile requests list --json</span>`, { in: 5 })}
${pstep("thought", `<b class="shim">Thinking…</b>${tick(6)}`, { in: 6 })}</div>`;
  const reply = `<div class="mb-as" data-stream="7"${at({ in: 7 })}><p>${words("Three Connected Folders moved forward today:")}</p><ul><li><b>${words("Downloads")}</b>${words(": Organize New Files filed 6 new files into their folders.")}</li><li><b>${words("Home Renovation")}</b>${words(": the Worker compared three quotes and wrote Quote Comparison.docx.")}</li><li><b>${words("Taxes 2026")}</b>${words(": the Worker renamed two statements and has a question for you about a missing 1099-DIV.")}</li></ul><p>${words("Want me to open Taxes 2026?")}</p></div>`;
  const send = (cls, icon, a) => `<span class="mb-send${cls}"${at(a)}>${glyph[icon]}</span>`;
  return `<div class="mb-pop s1 s2 s3 s4 s5 s6 s7 s8" data-steps="${steps.join(",")}" role="img" aria-label="The AmpleFile Agent in the menu bar answering what three Connected Folders got done today">
<div class="mb-head"><span class="t">${swap([["New Chat", { out: 2 }], [Q, { in: 2 }]])}</span><span class="mb-ib" title="Chats">${pg.history}</span><span class="mb-ib" title="New Chat">${pg.compose}</span></div>
<div class="mb-body"><div class="mb-empty"${at({ out: 2 })}><b>What would you like to work on?</b><span>Pick up a saved chat, or start here.</span></div>
<div class="mb-ub a-send"${at({ in: 2 })}>${Q}</div>${stepsHtml}
<span class="mb-pill a-fade"${at({ in: 7 })}>${pg.ran}<span>Ran commands</span>${glyph.chevR}</span>${reply}</div>
<div class="mb-timer"${at({ in: 2, out: 8 })}>${tick(2, "0s")}</div>
<div class="mb-comp"><div class="mb-field"><span class="tx"><span class="tyw"${at({ out: 2 })}><span class="ty" data-type="1" data-text="${Q}"></span></span><span class="caret"></span><span class="ph"${at({ out: 1 })}>Tell AmpleFile what to do</span><span class="ph"${at({ in: 2, out: 8 })}>Steer (Enter)</span><span class="ph"${at({ in: 8 })}>Tell AmpleFile what to do</span></span>${send("", "send", { out: 1 })}${send(" on", "send", { in: 1, out: 2, press: 2 })}${send(" on", "stop", { in: 2, out: 8 })}${send("", "send", { in: 8 })}</div>
<div class="mb-meta"><span>Claude Sonnet</span><span class="lv">Medium${glyph.chevD}</span></div></div></div>`;
}

// ---------- CSS, in design pixels; every px becomes calc(N * var(--u)) ----------

const STEP_CSS = Array.from({ length: 12 }, (_, i) => {
  const k = i + 1;
  return `:is(.mw, .mb-pop)[data-steps]:not(.s${k}) [data-in="${k}"], :is(.mw, .mb-pop)[data-steps].s${k} [data-out="${k}"] { display:none !important; }
:is(.mw, .mb-pop)[data-steps].s${k} [data-fade="${k}"] { opacity:0; transform:translateY(4px); pointer-events:none; }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-row[data-gone="${k}"] { height:0; opacity:0; }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-row[data-sel="${k}"] { background:var(--fm-cap2); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-rlist.focus .mw-row[data-sel="${k}"] { background:var(--fm-accent); color:var(--fm-on); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-rlist.focus .mw-row[data-sel="${k}"] .c { color:rgba(255,255,255,.9); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-rlist.focus .mw-row[data-sel="${k}"] .c.n { color:var(--fm-on); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-rlist.focus[data-focus-out="${k}"] .mw-row[data-sel] { background:var(--fm-cap2); color:var(--fm-text); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-rlist.focus[data-focus-out="${k}"] .mw-row[data-sel] .c { color:var(--fm-text2); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-rlist.focus[data-focus-out="${k}"] .mw-row[data-sel] .c.n { color:var(--fm-text); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-field[data-focus-in="${k}"] { border-color:var(--fm-accent); box-shadow:0 0 0 3px var(--fm-accent-soft); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-field[data-focus-in="${k}"] .caret { display:block; }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-sw[data-on="${k}"] { background:var(--fm-accent); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-sw[data-on="${k}"]::after { transform:translateX(14px); }
:is(.mw, .mb-pop)[data-steps].s${k} .mw-row[data-flash="${k}"] { animation:mw-flash 2000ms ease-out both; }`;
}).join("\n");

export const WINDOW_CSS_PX = `
.mw { --fm-window:#ffffff; --fm-side:#f0f0f2; --fm-text:#1d1d1f; --fm-text2:#5d5d62; --fm-text3:#66666c; --fm-line:rgba(0,0,0,.08); --fm-stripe:#f6f6f8; --fm-cap:rgba(0,0,0,.055); --fm-cap2:rgba(0,0,0,.09); --fm-seg:#ffffff; --fm-accent:#0a64d6; --fm-accent-soft:rgba(10,100,214,.14); --fm-on:#ffffff; --fm-panel:#f5f5f7; --fm-field:#ffffff; --fm-field-line:rgba(0,0,0,.14); --fm-card:#ffffff; --fm-card-line:rgba(0,0,0,.08); --fm-btn:#ffffff; --fm-btn-shadow:0 0 0 .5px rgba(0,0,0,.14), 0 1px 2px rgba(0,0,0,.14), 0 1px 0 rgba(0,0,0,.04); --fm-green:#1e9e4a;
  --cf-1:#ec9e3a; --cf-2:#4fb36c; --cf-3:#9980e0; --cf-4:#e46689; --cf-5:#3fa3c3;
  --es:cubic-bezier(.2,0,0,1); --ep:cubic-bezier(.34,1.4,.64,1);
  position:relative; width:1280px; height:760px; display:flex; border-radius:12px; overflow:hidden; background:var(--fm-window); color:var(--fm-text); box-shadow:0 40px 90px rgba(0,0,0,.34), 0 0 0 .5px rgba(0,0,0,.3);
  font-family:-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif; font-size:13px; line-height:1.35; letter-spacing:0; text-align:left; -webkit-font-smoothing:antialiased; }
.mw svg { display:block; flex:none; }
.mw-side, .mw-sh, .mw-search, .mw-crow, .mw-cchip, .mw-btn, .mw-seg, .mw-si, .mw-field, .mw-toast { box-sizing:border-box; }
.mw-sl { list-style:none; margin:0; padding:0; }
.mw b { font-weight:600; }

/* Icons */
.mw .fi { position:relative; display:inline-block; flex:none; box-sizing:border-box; font-size:18px; }
.mw .fi-folder { --fold:#62b3f4; --fold-tab:#4a9de6; width:1.16em; height:.84em; margin-top:.1em; border-radius:.08em; background:var(--fold-tab); }
.mw .fi-folder::before { content:""; position:absolute; top:-.1em; left:0; width:.44em; height:.16em; border-radius:.07em .07em 0 0; background:var(--fold-tab); }
.mw .fi-folder::after { content:""; position:absolute; inset:.13em 0 0; border-radius:.08em; background:var(--fold); box-shadow:inset 0 .03em 0 rgba(255,255,255,.35); }
.mw .fi-folder.tint { --fold:color-mix(in srgb, var(--fold-base) 62%, #fff); --fold-tab:color-mix(in srgb, var(--fold-base) 80%, #fff); }
.mw .fi-doc { --tag:#77777f; width:.76em; height:.98em; border:.045em solid #c4c4cb; border-radius:.07em; background:repeating-linear-gradient(180deg, #dadae0 0, #dadae0 .03em, transparent .03em, transparent .1em) .13em .16em / .48em .42em no-repeat, #fff; }
.mw .fi-doc::after { content:""; position:absolute; right:0; bottom:.12em; left:0; height:.21em; background:var(--tag); }
.mw .t-pdf { --tag:#de4339; } .mw .t-docx { --tag:#2f6ddb; } .mw .t-xlsx { --tag:#1e8a4c; } .mw .t-pptx { --tag:#d9622a; }
.mw .fi-img { width:1.1em; height:.84em; margin-top:.08em; overflow:hidden; border:.04em solid rgba(0,0,0,.14); border-radius:.07em; background:#7fb3e0; }
.mw .fi-img::before { content:""; position:absolute; right:.25em; bottom:-.32em; left:-.15em; height:.62em; border-radius:50%; background:rgba(255,255,255,.4); }
.mw .fi-img::after { content:""; position:absolute; top:.13em; right:.17em; width:.17em; height:.17em; border-radius:50%; background:rgba(255,255,255,.82); }
.mw .fi-box { width:.98em; height:.78em; margin-top:.12em; border:.04em solid rgba(0,0,0,.14); border-radius:.09em; background:#d8c29a; }
.mw .fi-box::before { content:""; position:absolute; top:0; left:.4em; width:.14em; height:.36em; background:#bd9d61; }

/* Sidebar */
.mw-side { flex:none; width:228px; display:flex; flex-direction:column; padding:0 10px 12px; border-right:.5px solid var(--fm-line); background:var(--fm-side); overflow:hidden; }
.mw-inset { height:34px; flex:none; position:relative; }
.mw-lights { position:absolute; left:4px; top:10px; display:flex; gap:8px; }
.mw-lights i { width:12px; height:12px; border-radius:50%; background:#ff5f57; box-shadow:inset 0 0 0 .5px rgba(0,0,0,.14); }
.mw-lights i:nth-child(2) { background:#febc2e; } .mw-lights i:nth-child(3) { background:#28c840; }
.mw-sl.top { margin-top:4px; }
.mw-sh { display:flex; align-items:center; gap:4px; height:30px; padding:6px 5px 0 8px; color:var(--fm-text3); font-size:11px; font-weight:600; white-space:nowrap; }
.mw-sh > span { flex:1; }
.mw-sh svg { width:14px; height:14px; }
.mw-si { position:relative; display:flex; align-items:center; gap:8px; height:28px; padding:0 8px 0 calc(21px + var(--depth, 0) * 16px); border-radius:7px; white-space:nowrap; transition:background-color 110ms ease-out; }
.mw-si.cur { background:var(--fm-cap2); }
.mw-si .ic { width:18px; flex:none; display:grid; place-items:center; color:var(--fm-accent); }
.mw-si .ic svg { width:16px; height:16px; }
.mw-si .ic .fi { font-size:15px; }
.mw-si .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.mw-caret { position:absolute; top:0; left:calc(var(--depth, 0) * 16px + 4px); width:15px; height:100%; display:grid; place-items:center; color:var(--fm-text2); }
.mw-caret svg { width:11px; height:11px; }
.mw-caret.open svg { transform:rotate(90deg); }
.mw-dot { flex:none; width:7px; height:7px; border-radius:50%; }
.mw-dot.run { background:var(--fm-accent); animation:mw-pulse 1.2s ease-in-out infinite; }
.mw-dot.done { background:var(--fm-green); }

/* Main */
.mw-main { flex:1; min-width:0; display:flex; flex-direction:column; background:var(--fm-window); }
.mw-tb { height:56px; flex:none; display:flex; align-items:center; gap:10px; padding:0 14px 0 12px; }
.mw-tb > * { flex-shrink:0; }
.mw-cap { display:inline-flex; align-items:center; gap:2px; height:32px; padding:0 3px; border-radius:999px; background:var(--fm-cap); }
.mw-tool { display:inline-grid; place-items:center; min-width:28px; height:26px; border-radius:999px; color:var(--fm-text2); }
.mw-tool svg { width:16px; height:16px; }
.mw-tool.dis { opacity:.35; }
.mw-tool.on { background:var(--fm-seg); color:var(--fm-text); box-shadow:0 1px 2px rgba(0,0,0,.14); }
.mw-title { display:flex; flex:0 0 auto; align-items:center; gap:8px; max-width:42%; min-width:0; margin-left:4px; font-size:15px; font-weight:600; white-space:nowrap; }
.mw-title .fi { font-size:17px; }
.mw-title .tt { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.mw-space { flex:1 1 0; }
.mw-search { display:flex; flex:0 1 236px; align-items:center; gap:6px; min-width:34px; height:32px; padding:0 6px 0 11px; border-radius:999px; background:var(--fm-cap); color:var(--fm-text3); white-space:nowrap; overflow:hidden; }
.mw-search svg { width:14px; height:14px; color:var(--fm-text2); }
.mw-cols, .mw-row { display:grid; grid-template-columns:minmax(160px, 1fr) 172px 76px; align-items:center; }
.mw-cols { height:28px; flex:none; margin:0 8px; padding:0 8px; border-top:1px solid var(--fm-line); border-bottom:1px solid var(--fm-line); }
.mw-col { display:flex; align-items:center; gap:3px; padding-right:10px; color:var(--fm-text2); font-size:12px; white-space:nowrap; }
.mw-col.on { color:var(--fm-text); }
.mw-col svg { width:10px; height:10px; }
.mw-col.s { justify-content:flex-end; padding-right:22px; }
.mw-rows { position:relative; flex:1; min-height:0; overflow:hidden; padding:4px 8px 24px; }
.mw-rlist { display:grid; align-content:start; background:repeating-linear-gradient(180deg, transparent 0 26px, var(--fm-stripe) 26px 52px); border-radius:6px; }
.mw-rlist.stack { position:absolute; top:4px; left:8px; right:8px; transition:opacity 200ms ease-out, transform 200ms ease-out; }
.mw-rlist.stack[data-fade] { transition-duration:160ms; }
.mw-row { height:26px; padding:0 8px; border-radius:6px; overflow:clip; transition:background-color 110ms ease-out, color 110ms ease-out, scale 160ms var(--es), height 170ms var(--es), opacity 120ms ease-out; }
.mw-row.sel { background:var(--fm-cap2); }
.mw-row .c { display:block; min-width:0; padding-right:10px; overflow:hidden; color:var(--fm-text2); white-space:nowrap; text-overflow:ellipsis; transition:color 110ms ease-out; }
.mw-row .c.n { display:flex; align-items:center; gap:6px; color:var(--fm-text); }
.mw-row .c.s { padding-right:22px; text-align:right; }
.mw-row .ri { display:inline-flex; flex:none; align-items:center; justify-content:center; width:22px; }
.mw-row .rn { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.mw-cdot { display:inline-block; flex:none; width:7px; height:7px; margin:0 6px; border-radius:50%; background:var(--fm-accent); }
.mw-path { height:28px; flex:none; display:flex; align-items:center; gap:2px; padding:0 14px; border-top:1px solid var(--fm-line); color:var(--fm-text2); font-size:11px; white-space:nowrap; }
.mw-goto { width:22px; height:22px; margin:0 4px 0 -6px; display:grid; place-items:center; color:var(--fm-text2); }
.mw-goto svg { width:15px; height:15px; }
.mw-crumbs { flex:1; min-width:0; display:flex; align-items:center; overflow:hidden; }
.mw-crumbs .cr { padding:2px 4px; }
.mw-crumbs .sep svg { width:9px; height:9px; opacity:.55; }
.mw-path .ct { flex:none; padding-left:12px; }

/* Panel */
.mw-panel { position:relative; flex:none; width:320px; min-height:0; display:grid; grid-template:minmax(0, 1fr) / minmax(0, 1fr); border-left:1px solid var(--fm-line); background:var(--fm-panel); overflow:clip; }
.mw-pane { grid-area:1 / 1; min-height:0; display:flex; flex-direction:column; background:var(--fm-panel); }
.mw-tabs { height:56px; flex:none; display:flex; align-items:center; justify-content:center; padding:0 16px; }
.mw-seg { display:flex; width:100%; max-width:240px; padding:2px; border-radius:8px; background:var(--fm-cap); }
.mw-seg-b { flex:1; display:inline-flex; align-items:center; justify-content:center; gap:6px; height:24px; padding:0 10px; border-radius:6px; font-weight:500; white-space:nowrap; }
.mw-seg-b.on { background:var(--fm-btn); box-shadow:var(--fm-btn-shadow); }
.mw-pscroll { flex:1; min-height:0; overflow:hidden; padding:6px 16px 18px; }
.mw-pscroll.untabbed { padding-top:16px; }
.mw-hd { text-align:center; }
.mw-pv { height:124px; display:grid; place-items:center; }
.mw-pv .fi { font-size:92px; }
.mw-pv-name { margin-top:8px; font-size:15px; font-weight:600; white-space:nowrap; }
.mw-pv-meta { margin-top:3px; color:var(--fm-text2); font-size:12px; white-space:nowrap; }
.mw-sec { margin-top:20px; }
.mw-sec.first { margin-top:4px; }
.mw-sec-h { margin:0 4px 6px; font-size:12px; font-weight:600; white-space:nowrap; }
.mw-card { overflow:hidden; border:.5px solid var(--fm-card-line); border-radius:10px; background:var(--fm-card); }
.mw-crow { display:flex; align-items:center; gap:10px; min-height:36px; margin-bottom:-.5px; padding:6px 12px; border-bottom:.5px solid var(--fm-card-line); }
.mw-crow .tn { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.mw-crow .gl { flex:none; display:grid; place-items:center; color:var(--fm-text2); }
.mw-crow .gl svg { width:15px; height:15px; }
.mw-crow .tt { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.mw-crow .tt > span { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.mw-crow .sub { color:var(--fm-text2); font-size:11px; }
.mw-crow .chev { flex:none; color:var(--fm-text2); opacity:.6; }
.mw-crow .chev svg { width:11px; height:11px; }
.mw-sw { position:relative; flex:none; width:34px; height:20px; border-radius:999px; background:var(--fm-cap2); transition:background-color 180ms var(--es); }
.mw-sw::after { content:""; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3); transition:transform 220ms var(--ep); }
.mw .mw-sw.is-press { scale:.9; }
.mw-sw.on { background:var(--fm-accent); }
.mw-sw.on::after { transform:translateX(14px); }
.mw-cta { padding:18px 16px; border-radius:10px; background:var(--fm-card); text-align:center; }
.mw-cta .t { font-weight:600; }
.mw-cta .s { margin:4px 0 12px; color:var(--fm-text2); font-size:12px; line-height:1.4; white-space:nowrap; }
.mw-btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; height:28px; padding:0 12px; border-radius:7px; background:var(--fm-btn); box-shadow:var(--fm-btn-shadow); font-weight:500; white-space:nowrap; transition:background-color 110ms ease-out, box-shadow 110ms ease-out, scale 160ms var(--es), filter 110ms ease-out; }
.mw-btn.primary { margin-top:2px; background:var(--fm-accent); box-shadow:0 .5px 1.5px rgba(0,0,0,.2); color:var(--fm-on); }
.mw-btn.small { flex:none; height:24px; padding:0 10px; border-radius:6px; font-size:12px; }
.mw-rcpt { margin:4px 0 18px; padding:12px 14px; border:.5px solid var(--fm-card-line); border-radius:10px; background:var(--fm-card); }
.mw-rhead { display:flex; align-items:center; gap:7px; min-width:0; }
.mw-rhead .t { flex:1; min-width:0; overflow:hidden; font-weight:600; white-space:nowrap; text-overflow:ellipsis; }
.mw-rhead .tm, .mw-rsum { color:var(--fm-text3); font-size:12px; white-space:nowrap; }
.mw-rsum { margin:2px 0 8px 14px; }
.mw-rlist2 { display:grid; gap:1px; margin:0 -6px; }
.mw-rrow { display:flex; align-items:center; gap:8px; height:26px; padding:0 6px; }
.mw-rrow .n { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.mw-rrow .v { flex:none; color:var(--fm-text3); font-size:12px; }
.mw-ract { display:flex; justify-content:flex-end; gap:8px; margin-top:10px; }

/* Message box */
.mw-comp { flex:none; padding:12px 12px 6px; background:var(--fm-panel); }
.mw-comp.chat { padding:12px 24px 18px; }
.mw-sugs { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
.mw-btn.mw-sug { justify-content:flex-start; width:100%; height:32px; padding:0 12px; font-weight:400; }
.mw-sug svg { width:14px; height:14px; color:var(--fm-accent); }
.mw-sug span { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.mw-ctx { display:flex; margin-bottom:8px; min-width:0; overflow:hidden; }
.mw-cchip-wrap { display:flex; gap:5px; min-width:0; }
.mw-cchip { display:inline-flex; flex:0 1 auto; align-items:center; gap:5px; min-width:0; height:24px; padding:0 3px 0 8px; border-radius:6px; background:var(--fm-cap); font-size:11px; white-space:nowrap; }
.mw-cchip .fi { font-size:13px; }
.mw-cchip .n { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.mw-cchip .cx { width:18px; height:18px; display:grid; place-items:center; color:var(--fm-text2); }
.mw-cchip .cx svg { width:9px; height:9px; }
.mw-cchip.more { flex:none; padding:0 8px; color:var(--fm-text2); }
.mw-field { display:flex; align-items:center; gap:6px; padding:4px 4px 4px 14px; border:1px solid var(--fm-field-line); border-radius:18px; background:var(--fm-field); transition:border-color 140ms ease-out, box-shadow 160ms ease-out; }
.mw-field.focus { border-color:var(--fm-accent); box-shadow:0 0 0 3px var(--fm-accent-soft); }
.mw-field .tx { flex:1; min-width:0; height:26px; display:flex; align-items:center; overflow:hidden; white-space:nowrap; }
.mw-field .ty { color:var(--fm-text); }
.mw-field .ty { display:flex; justify-content:flex-end; max-width:100%; min-width:0; overflow:hidden; }
.mw-field .ty:empty { display:none; }
.mw-field .ty:not(:empty) ~ .ph { display:none; }
.mw-field .ph { min-width:0; overflow:hidden; color:var(--fm-text3); text-overflow:ellipsis; }
.mw-field .caret { display:none; flex:none; width:1.5px; height:16px; margin:0 1px; background:var(--fm-text); animation:mw-blink 1.06s steps(1) infinite; }
.mw-field.focus .caret { display:block; }
.mw-field .ty:not(:empty) + .caret { margin-left:0; }
.mw-send { width:28px; height:28px; flex:none; display:grid; place-items:center; border-radius:50%; background:var(--fm-cap2); color:var(--fm-text2); transition:background-color 120ms ease-out, color 120ms ease-out; }
.mw-send svg { width:14px; height:14px; }
.mw-field:has(.ty:not(:empty)) .mw-send, .mw-send.run { background:var(--fm-accent); color:var(--fm-on); }
.mw-send.run svg { width:16px; height:16px; }
.mw-meta { display:flex; align-items:center; gap:6px; height:20px; margin:6px 9px 0 8px; }
.mw-model { display:inline-flex; align-items:center; gap:6px; height:20px; padding:0 6px; color:var(--fm-text2); font-size:11px; font-weight:500; white-space:nowrap; }
.mw-model svg { width:11px; height:11px; margin-left:-2px; }
.mw-meta .mw-ring { width:16px; height:16px; margin-left:auto; color:var(--fm-text2); }

/* Chat */
.mw-ph { height:56px; flex:none; display:flex; align-items:center; gap:6px; padding:0 12px; border-bottom:1px solid var(--fm-line); }
.mw-capbtn { min-width:28px; height:26px; display:grid; place-items:center; color:var(--fm-text2); }
.mw-capbtn svg { width:16px; height:16px; }
.mw-ph-t { flex:1; min-width:0; overflow:hidden; font-weight:600; white-space:nowrap; text-overflow:ellipsis; }
.mw-msgs { flex:1; min-height:0; display:flex; flex-direction:column; align-items:flex-start; gap:14px; padding:28px 32px 16px 34px; overflow:hidden; }
.mw-ub { box-sizing:border-box; align-self:flex-end; max-width:88%; margin-bottom:6px; padding:11px 12px; border-radius:16px; background:var(--fm-accent); color:var(--fm-on); line-height:1.5; }
.mw-fchips { align-self:flex-end; display:flex; flex-direction:column; align-items:flex-end; gap:8px; margin-bottom:-10px; }
.mw-fchip { display:inline-flex; align-items:center; gap:9px; height:28px; padding:0 9px 0 10px; border:1px solid rgba(0,0,0,.1); border-radius:6px; background:#fff; font-size:12px; white-space:nowrap; }
.mw-fchip b { font-weight:600; }
.mw-fchip svg { width:16px; height:16px; }
.mw-as { line-height:1.5; }
.mw-as p { margin:0 0 9px; }
.mw-as p:last-child { margin-bottom:0; }
.mw-as ul { margin:0 0 9px; padding-left:17px; list-style:disc; }
.mw-as li { margin:2px 0; padding-left:2px; }
.mw-as li::marker { color:var(--fm-text3); }
.mw-link { display:inline-flex; align-items:baseline; gap:3px; color:var(--fm-accent); }
.mw-link svg { width:11px; height:11px; align-self:center; }
.mw-working { color:#5b6b80; font-weight:500; }
.mw-steps { display:flex; flex-direction:column; align-self:stretch; min-width:0; color:#667386; }
.mw-step { display:grid; grid-template-columns:16px minmax(0, 1fr); column-gap:8px; align-items:start; padding:4px 0; }
.mw-step .si { color:#8792a3; margin-top:2px; }
.mw-step .si svg { width:15px; height:15px; }
.mw-step .sl { display:flex; align-items:baseline; gap:6px; min-width:0; line-height:1.45; }
.mw-step b { flex:none; color:#475569; font-weight:600; }
.mw-step .st { min-width:0; overflow:hidden; color:#8792a3; white-space:nowrap; text-overflow:ellipsis; }
.mw-step .st.cmd { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px; }
.mw .shim { color:transparent !important; background:linear-gradient(90deg, #5b6b80 0%, #5b6b80 38%, #cdd4de 50%, #5b6b80 62%, #5b6b80 100%); background-size:260% 100%; -webkit-background-clip:text; background-clip:text; animation:mw-shimmer 1.7s linear infinite; }
.mw-pill { display:inline-flex; align-items:center; gap:7px; max-width:100%; height:24px; margin-top:-2px; padding:0 10px 0 11px; border-radius:999px; background:rgba(0,0,0,.05); color:#475569; font-size:12px; font-weight:600; white-space:nowrap; }
.mw-pill > span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.mw-pill svg { width:13px; height:13px; color:#8792a3; }
.mw-pill svg:last-child { width:11px; height:11px; color:#9aa4b2; }

/* The Action menu, and Skills & Extensions over the dimmed window (styles.css, file-manager-dialogs.css) */
.mw-anchor { position:relative; }
.mw-menu { position:absolute; z-index:5; top:calc(100% + 4px); left:3px; box-sizing:border-box; width:228px; padding:5px; border-radius:10px; background:rgba(252,252,253,.96); box-shadow:0 12px 34px rgba(0,0,0,.22), 0 0 0 .5px rgba(0,0,0,.08); font-weight:400; transform-origin:0 0; }
.mw-menu .mi { display:flex; align-items:center; height:24px; padding:0 10px; border-radius:5px; white-space:nowrap; }
.mw-menu .sep { display:block; height:1px; margin:5px 8px; background:rgba(0,0,0,.08); }
.mw .mw-menu .mi.is-press { scale:1; background:var(--fm-accent); color:var(--fm-on); }
.mw-dim { position:absolute; z-index:5; inset:0; background:rgba(0,0,0,.18); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px); }
.se { position:absolute; z-index:5; inset:24px 100px; display:flex; flex-direction:column; border-radius:12px; overflow:hidden; background:#f5f5f7; box-shadow:0 24px 70px rgba(0,0,0,.26), 0 0 0 .5px rgba(0,0,0,.14); }
.se svg { display:block; flex:none; }
.se-h { box-sizing:border-box; flex:none; height:53px; display:flex; align-items:center; gap:10px; padding:0 14px 0 24px; border-bottom:.5px solid rgba(0,0,0,.08); }
.se-t { margin-right:6px; font-size:15px; font-weight:600; white-space:nowrap; }
.se-seg { display:inline-flex; flex:none; padding:2px; border-radius:8px; background:var(--fm-cap); }
.se-seg span { display:inline-flex; align-items:center; height:24px; padding:0 12px; border-radius:6px; font-weight:500; white-space:nowrap; }
.se-seg .on { background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.14); }
.se-sp { flex:1; }
.mw-btn.se-add { height:28px; padding:0 12px 0 9px; border-radius:6px; gap:6px; }
.se-add svg { width:14px; height:14px; }
.se-x { width:28px; height:28px; display:grid; place-items:center; border-radius:50%; background:var(--fm-cap); color:var(--fm-text2); }
.se-x svg { width:12px; height:12px; }
.se-b { flex:1; min-height:0; overflow:hidden; padding:18px 24px; }
.se-tools { display:flex; gap:12px; }
.se-search { box-sizing:border-box; flex:1; min-width:0; display:flex; align-items:center; gap:8px; height:28px; padding:0 10px; border:.5px solid rgba(0,0,0,.14); border-radius:7px; background:#fff; color:var(--fm-text3); white-space:nowrap; }
.se-search svg { width:14px; height:14px; color:var(--fm-text2); }
.se-hd { display:flex; align-items:center; margin:20px 2px 7px; }
.se-hd > span { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.se-hd b { white-space:nowrap; }
.se-hd small { color:var(--fm-text2); font-size:11px; white-space:nowrap; }
.se-ct { box-sizing:border-box; flex:none; min-width:19px; height:18px; display:grid; place-items:center; padding:0 6px; border-radius:4px; background:var(--fm-cap); color:var(--fm-text2); font-size:11px; font-style:normal; font-weight:500; }
.se-grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; }
.se-tile { box-sizing:border-box; height:127px; display:flex; flex-direction:column; align-items:flex-start; gap:6px; padding:12px; border:.5px solid var(--fm-card-line); border-radius:10px; background:#fff; }
.se-tile .ic { width:32px; height:32px; margin-bottom:2px; display:grid; place-items:center; border-radius:8px; background:#f5f5f7; }
.se-tile .ic svg { width:18px; height:18px; }
.se-tile b { white-space:nowrap; }
.se-st { display:flex; align-items:center; gap:6px; color:var(--fm-text2); font-size:12px; white-space:nowrap; }
.se-st i { width:8px; height:8px; border-radius:50%; background:#66666c; }
.se-st.ok i { background:var(--fm-green); }
.se-st.warn i { background:#c26a00; }
.se-set { display:inline-flex; align-items:center; gap:3px; color:var(--fm-accent); font-size:12px; font-weight:500; }
.se-set svg { width:10px; height:10px; }
.se-cols { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); align-items:start; gap:0 20px; }
.se-card { overflow:hidden; border:.5px solid var(--fm-card-line); border-radius:10px; background:#fff; }
.se-row { box-sizing:border-box; display:flex; align-items:flex-start; gap:10px; min-height:59px; margin-bottom:-.5px; padding:10px 12px; border-bottom:.5px solid var(--fm-card-line); }
.se-row .ki { flex:none; width:20px; height:20px; display:grid; place-items:center; color:var(--fm-text2); }
.se-row .ki svg { width:17px; height:17px; }
.se-row .cp { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.se-row .tl { display:flex; align-items:center; gap:6px; }
.se-row .tl b { white-space:nowrap; }
.se-kind { display:inline-flex; align-items:center; height:18px; padding:0 6px; border-radius:4px; background:var(--fm-cap); color:var(--fm-text2); font-size:11px; font-weight:500; }
.se-row .dt { overflow:hidden; color:var(--fm-text2); font-size:12px; white-space:nowrap; text-overflow:ellipsis; }
.se-row .chev { flex:none; align-self:center; color:var(--fm-text3); }
.se-row .chev svg { width:12px; height:12px; }
.se-sum { box-sizing:border-box; display:flex; align-items:center; gap:8px; height:40px; margin-bottom:-.5px; padding:0 12px; border-bottom:.5px solid var(--fm-card-line); }
.se-sum svg { width:12px; height:12px; color:var(--fm-text2); }
.se-sum svg + svg { width:15px; height:15px; }
.se-sum span { flex:1; }
.se-sum small { color:var(--fm-text2); font-size:12px; font-weight:500; }

/* Notices rise from the bottom center of the folder list */
.mw-toast { position:absolute; z-index:4; bottom:40px; left:594px; translate:-50% 0; display:flex; align-items:center; gap:10px; min-height:42px; padding:10px 10px 10px 14px; border:1px solid #d8e0e8; border-left:4px solid #0b6fd6; border-radius:8px; background:rgba(255,255,255,.96); box-shadow:0 8px 16px rgba(0,0,0,.14); color:#253044; font-weight:600; white-space:nowrap; transition:opacity 220ms ease-out, transform 220ms ease-out; }
.mw-toast.ok { border-left-color:#1f9e55; }
.mw-toast .ta { padding:3px 4px; color:#095cb4; font-weight:700; }
.mw-toast .tx { width:26px; height:26px; margin-right:-4px; display:grid; place-items:center; border-radius:999px; color:#095cb4; }
.mw-toast .tx svg { width:12px; height:12px; }

/* The pointer that clicks for you */
.mw-cursor { position:absolute; z-index:6; left:0; top:0; width:22px; height:22px; margin:-3px 0 0 -6px; opacity:0; pointer-events:none; filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); transition:left 760ms cubic-bezier(.45,.05,.25,1), top 760ms cubic-bezier(.45,.05,.25,1), opacity 240ms ease-out; }
.mw-cursor.on { opacity:1; }
.mw-cursor svg { width:100%; height:100%; transition:scale 120ms var(--es); transform-origin:30% 15%; }
.mw-cursor.down svg { scale:.86; }
.mw .is-press { scale:.95; }
.mw .mw-btn.primary.is-press { filter:brightness(.9); scale:.97; }
.mw .mw-row.is-press { scale:1; }

/* Arrivals, as the app draws them (lib/motion.ts and file-manager.css) */
@keyframes mw-blink { 50% { opacity:0; } }
@keyframes mw-pulse { 0%, 100% { opacity:1; transform:scale(1); } 50% { opacity:.35; transform:scale(.75); } }
@keyframes mw-shimmer { from { background-position:130% 0; } to { background-position:-130% 0; } }
@keyframes mw-rise { from { opacity:0; translate:0 6px; } }
@keyframes mw-fade { from { opacity:0; } }
@keyframes mw-push { from { opacity:0; translate:32px 0; } }
@keyframes mw-pop { from { opacity:0; scale:0; } }
@keyframes mw-grow { from { height:0; opacity:0; } }
@keyframes mw-drop { from { translate:0 -7px; } }
@keyframes mw-toast { from { opacity:0; translate:-50% 8px; } }
@keyframes mw-step { from { opacity:0; translate:0 2px; } }
@keyframes mw-send { from { opacity:0; translate:0 120px; scale:.9; } 60% { opacity:1; } }
@keyframes mw-name { from { opacity:0; translate:0 7px; filter:blur(2px); } }
@keyframes mw-flash { 0%, 60% { background-color:rgba(10,100,214,.2); } 100% { background-color:transparent; } }
@keyframes mw-sendpress { 40% { scale:.82; } }
@keyframes mw-menu { from { opacity:0; scale:.96; translate:0 -4px; } }
@keyframes mw-dlg { from { opacity:0; scale:.97; translate:0 8px; } }
.mw .a-menu { animation:mw-menu 150ms var(--es) both; }
.mw .a-dlg { animation:mw-dlg 260ms var(--es) both; }
.mw .a-rise { animation:mw-rise 240ms var(--es) var(--d, 0ms) both; }
.mw .a-fade { animation:mw-fade 180ms ease-out var(--d, 0ms) both; }
.mw .a-list { animation:mw-fade 1ms both; }
.mw .a-push { animation:mw-push 260ms var(--es) both; }
.mw .a-push .mw-ph { animation:mw-fade 180ms ease-out both; }
.mw .a-pop { animation:mw-pop 240ms var(--ep) var(--d, 0ms) both; }
.mw .mw-dot.run.a-pop { animation:mw-pop 240ms var(--ep) var(--d, 0ms) both, mw-pulse 1.2s ease-in-out calc(240ms + var(--d, 0ms)) infinite; }
.mw .a-row { overflow:clip; animation:mw-grow 220ms var(--es) var(--d, 0ms) both; }
.mw .a-row > * { animation:mw-drop 260ms var(--es) var(--d, 0ms) both; }
.mw .a-toast { animation:mw-toast 200ms var(--es) both; }
.mw .a-step { animation:mw-step 180ms var(--es) both; }
.mw .a-send { animation:mw-send 420ms var(--es) 40ms both; transform-origin:100% 100%; }
.mw .nm-swap[data-in] { display:inline-block; animation:mw-name 340ms var(--es) both; }
.mw .mw-send.is-press { scale:.84; }
.mw-main, .mw-panel, .mw-side, .se, .mw-dim { transition:opacity 280ms ease-out; }
.mw.is-cut .mw-main, .mw.is-cut .mw-panel, .mw.is-cut .mw-side, .mw.is-cut .se, .mw.is-cut .mw-dim { opacity:0; transition-duration:220ms; }
.mw.is-cut .mw-toast { display:none; }
.mw.no-anim, .mw.no-anim * { animation:none !important; transition:none !important; }
@media (prefers-reduced-motion: reduce) { .mw *, .mw-cursor { animation:none !important; transition:none !important; } .mw .shim { color:#5b6b80 !important; background:none; } }
${STEP_CSS}

/* The menu-bar popover at its real size (0.1.2): the panel Chat's parts on the popover material; grey stands in for the Mac's translucency */
.mb-pop { --es:cubic-bezier(.2,0,0,1); position:relative; width:400px; height:560px; display:flex; flex-direction:column; border-radius:12px; overflow:hidden; background:#e3e3e5; color:#1d1d1f; box-shadow:0 30px 70px rgba(0,0,0,.4), 0 0 0 .5px rgba(0,0,0,.28);
  font-family:-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif; font-size:13px; line-height:1.6; text-align:left; -webkit-font-smoothing:antialiased; }
.mb-pop svg { display:block; flex:none; }
.mb-head { box-sizing:border-box; height:44px; flex:none; display:flex; align-items:center; gap:2px; padding:0 8px 0 14px; border-bottom:1px solid rgba(0,0,0,.08); }
.mb-head .t { flex:1; min-width:0; overflow:hidden; font-weight:600; white-space:nowrap; text-overflow:ellipsis; }
.mb-ib { width:28px; height:26px; display:grid; place-items:center; color:#5d5d62; }
.mb-ib svg { width:16px; height:16px; }
.mb-body { position:relative; flex:1; min-height:0; display:flex; flex-direction:column; align-items:flex-start; gap:14px; padding:16px; overflow:hidden; }
.mb-empty { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; text-align:center; white-space:nowrap; }
.mb-empty b { font-weight:600; }
.mb-empty span { color:#66666c; font-size:12px; }
.mb-ub { box-sizing:border-box; align-self:flex-end; max-width:85%; padding:7px 12px; border-radius:16px; background:#0a64d6; color:#fff; }
.mb-steps { align-self:stretch; display:flex; flex-direction:column; margin-top:4px; color:#667386; }
.mb-pop .mw-step { padding:4.5px 0; }
.mb-pop .mw-step .sl { line-height:1.6; gap:6px; }
.mb-pop .mw-step .si { margin-top:2px; color:#8792a3; }
.mb-pop .mw-step .si svg { width:16px; height:16px; }
.mb-pop .mw-step b { color:#526072; }
.mb-pop .mw-step .st.cmd { font-size:12px; }
.mb-pop .mw-step .tk:empty { display:none; }
.mb-pill { box-sizing:border-box; display:inline-flex; align-items:center; gap:7px; height:24px; margin-bottom:18px; padding:0 10px 0 11px; border-radius:999px; background:rgba(0,0,0,.055); color:#5d5d62; font-size:12px; font-weight:500; white-space:nowrap; }
.mb-pill svg { width:13px; height:13px; color:#8792a3; }
.mb-pill svg:last-child { width:11px; height:11px; color:#9aa4b2; }
.mb-as { align-self:stretch; font-family:"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size:13px; line-height:21px; }
.mb-as p { margin:0 0 12px; }
.mb-as p:last-child { margin-bottom:0; }
.mb-as ul { margin:0 0 12px; padding-left:20px; list-style:disc; }
.mb-as li { margin:0 0 2px; }
.mb-as li::marker { color:#66666c; }
.mb-as b { font-weight:600; }
.mb-as.streaming .w:not(.on), .mb-as.streaming :is(p, ul, li, b):not(.on) { display:none; }
.mb-timer { position:absolute; right:16px; bottom:84px; color:#66666c; font-variant-numeric:tabular-nums; white-space:nowrap; }
.mb-comp { flex:none; padding:12px 12px 6px; }
.mb-field { box-sizing:border-box; display:flex; align-items:center; gap:6px; height:36px; padding:4px 4px 4px 14px; border:1px solid #0a64d6; border-radius:18px; background:#fff; box-shadow:0 0 0 3px rgba(10,100,214,.14); transition:border-color 140ms ease-out, box-shadow 160ms ease-out; }
.mb-field .tx { flex:1; min-width:0; height:26px; display:flex; align-items:center; overflow:hidden; white-space:nowrap; }
.mb-field .tyw { display:flex; min-width:0; overflow:hidden; }
.mb-field .ty { display:flex; justify-content:flex-end; min-width:0; overflow:hidden; }
.mb-field .ty:empty { display:none; }
.mb-field .ph { min-width:0; overflow:hidden; color:#66666c; text-overflow:ellipsis; }
.mb-field .caret { flex:none; width:1.5px; height:16px; margin:0 1px; background:#1d1d1f; animation:mw-blink 1.06s steps(1) infinite; }
.mb-send { width:28px; height:28px; flex:none; display:grid; place-items:center; border-radius:50%; background:rgba(0,0,0,.09); color:#5d5d62; transition:scale 160ms var(--es); }
.mb-send.on { background:#0a64d6; color:#fff; }
.mb-send svg { width:14px; height:14px; }
.mb-send.is-press { scale:.84; }
.mb-meta { display:flex; align-items:center; gap:9px; height:20px; margin-top:7px; padding-left:14px; color:#5d5d62; font-size:11px; font-weight:500; white-space:nowrap; }
.mb-meta .lv { display:inline-flex; align-items:center; gap:4px; color:#66666c; transition:opacity 160ms ease-out; }
.mb-meta .lv svg { width:10px; height:10px; }
/* while the turn runs the field isn't focused and the level dims */
.mb-pop[data-steps].s2:not(.s8) .mb-field { border-color:rgba(0,0,0,.14); box-shadow:none; }
.mb-pop[data-steps].s2:not(.s8) .mb-field .caret { display:none; }
.mb-pop[data-steps].s2:not(.s8) .mb-meta .lv { opacity:.6; }
/* motion */
.mb-pop .shim { color:transparent !important; background:linear-gradient(90deg, #5b6b80 0%, #5b6b80 38%, #cdd4de 50%, #5b6b80 62%, #5b6b80 100%); background-size:260% 100%; -webkit-background-clip:text; background-clip:text; animation:mw-shimmer 1.7s linear infinite; }
.mb-pop .a-send { animation:mw-send 420ms var(--es) 40ms both; transform-origin:100% 100%; }
.mb-pop .a-step { animation:mw-step 180ms var(--es) both; }
.mb-pop .a-fade { animation:mw-fade 200ms ease-out both; }
.mb-pop .mb-head .t .sw[data-in] { display:inline-block; animation:mw-fade 220ms ease-out both; }
.mb-body, .mb-head .t { transition:opacity 260ms ease-out; }
.mb-pop.is-cut .mb-body, .mb-pop.is-cut .mb-head .t { opacity:0; transition-duration:200ms; }
.mb-pop.no-anim, .mb-pop.no-anim * { animation:none !important; transition:none !important; }
@media (prefers-reduced-motion: reduce) { .mb-pop *, .mb-pop .shim { animation:none !important; transition:none !important; } .mb-pop .shim { color:#5b6b80 !important; background:none; } }
`;
export const WINDOW_CSS = WINDOW_CSS_PX.replace(/(\d*\.?\d+)px/g, "calc($1 * var(--u))");
