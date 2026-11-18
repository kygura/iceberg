import { ZONES as ZONE_TEXT, LEVELS } from "./zones.js";
import { EXAMPLE } from "./example.js";
import { createNotesEditor } from "./editor.js";
import { tierOf, rankOf, labelOf } from "./provenance.js";
import { digestOf, digestStats } from "./digest.js";

const ZONES = ZONE_TEXT;

/* ===== Helpers ===== */
const $ = (s) => document.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c instanceof Node ? c : String(c)); }
  return el;
}
const safeUrl = (u) => { try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function img(src, { alt = "", cls, onfail } = {}) {
  const url = safeUrl(src);
  if (!url) return null;
  const el = h("img", { src: url, alt, class: cls, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  el.addEventListener("error", () => { onfail ? onfail(el) : el.remove(); }, { once: true });
  return el;
}

/* Video hosts we can embed */
function videoOf(url) {
  try {
    const u = new URL(url); const host = u.hostname.replace(/^(www|m)\./, "");
    let id = null;
    if (host === "youtube.com" || host === "music.youtube.com") {
      id = u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/) || [])[1];
    } else if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    if (id && /^[\w-]{6,}$/.test(id)) return { host: "youtube", id, embed: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const vid = (u.pathname.match(/(\d{5,})/) || [])[1];
      if (vid) return { host: "vimeo", id: vid, embed: `https://player.vimeo.com/video/${vid}?autoplay=1&dnt=1`, thumb: null };
    }
  } catch {}
  return null;
}
const thumbOf = (s) => s.image || videoOf(s.url)?.thumb || "";
const ICON = {
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  paper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 15.5h6"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v11h14v-11M10 12h4"/></svg>',
};
const svg = (name) => { const s = h("span"); s.innerHTML = ICON[name]; return s.firstChild; };

function md(text, ice) {
  return String(text).trim().split(/\n{2,}/).filter(Boolean).map((p) =>
    "<p>" + esc(p.trim())
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[(\d{1,3})\]/g, (m, n) => (ice.sources.some((s) => s.id === +n) ? `<a class="cite" href="#src-${n}" data-cite="${n}">[${n}]</a>` : m))
      .replace(/\n/g, "<br>") + "</p>").join("");
}

async function* ndjson(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}
/* Visitors' own API keys: kept in this browser, sent as headers with each search. */
const KKEY = "iceberg-sounder.keys";
const loadKeys = () => { try { const k = JSON.parse(localStorage.getItem(KKEY) || "{}"); return { anthropic: String(k.anthropic || ""), exa: String(k.exa || "") }; } catch { return { anthropic: "", exa: "" }; } };
let userKeys = loadKeys();
const keyHeaders = () => ({ ...(userKeys.anthropic ? { "x-anthropic-key": userKeys.anthropic } : {}), ...(userKeys.exa ? { "x-exa-key": userKeys.exa } : {}) });
function needKeys(code) { if (code === "keys_needed" || code === "bad_key") openKeys(); }
async function postStream(path, body, signal) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...keyHeaders() }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    needKeys(data?.error?.code);
    throw { code: data?.error?.code || "http_" + res.status, message: data?.error?.message || `The server returned ${res.status}.` };
  }
  return ndjson(res);
}

/* ===== State + storage ===== */
const HKEY = "iceberg-sounder.standalone.v1";
const loadHistory = () => { try { const v = JSON.parse(localStorage.getItem(HKEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
function saveHistory(ice) {
  if (ice.example) return;
  try {
    const list = loadHistory().filter((x) => x.id !== ice.id);
    list.unshift(ice);
    localStorage.setItem(HKEY, JSON.stringify(list.slice(0, 12)));
  } catch {}
  pruneImages();
  renderRecent();
}
/* Full-size pasted images, kept in IndexedDB by iceberg id: they're too large
   for localStorage, where each saved iceberg keeps only a 240 px thumbnail. */
const fullImages = (() => {
  const mem = new Map();
  let dbp = null;
  const db = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("iceberg-sounder", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("images");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => { const t = d.transaction("images", mode); const out = fn(t.objectStore("images")); t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); });
  };
  return {
    put(id, url) { mem.set(id, url); tx("readwrite", (st) => st.put(url, id)).catch(() => {}); },
    async get(id) { if (mem.has(id)) return mem.get(id); try { const u = await tx("readonly", (st) => st.get(id)); if (u) mem.set(id, u); return u || null; } catch { return null; } },
    /* Drops images whose iceberg is no longer saved. */
    async prune(keep) {
      try {
        const keys = await tx("readonly", (st) => st.getAllKeys());
        const gone = (keys || []).filter((k) => !keep.has(k));
        gone.forEach((k) => mem.delete(k));
        if (gone.length) await tx("readwrite", (st) => gone.forEach((k) => st.delete(k)));
      } catch {}
    },
  };
})();
const pruneImages = () => fullImages.prune(new Set([...loadHistory().map((x) => x.id), state.ice?.id].filter(Boolean)));
const state = { ice: null, open: null, busy: false };
const server = { ok: false, claude: false, exa: false, commons: false, owner: false };
let buildCtl = null, deepCtl = null;
const canDive = () => server.ok && (!!userKeys.anthropic || server.claude) && (!!userKeys.exa || server.exa);
const missingKeys = () => [!userKeys.anthropic && !server.claude && "Anthropic", !userKeys.exa && !server.exa && "Exa"].filter(Boolean);

/* ===== Rendering ===== */
const sourceById = (ice, id) => ice.sources.find((s) => s.id === id);
const zoneOf = (key) => ZONES.find((z) => z.key === key);
const isMedia = (s) => !!s && (!!videoOf(s.url) || !!s.image);
/* Closeness to the original record. Older saves have no tier, so it's worked out from the address. */
const tierOfSource = (s) => s.tier || tierOf(s.url);
const byCloseness = (list) => list.map((s, k) => ({ s, k, r: rankOf(tierOfSource(s)) })).sort((a, b) => a.r - b.r || a.k - b.k).map((x) => x.s);
const tierTag = (s) => { const t = tierOfSource(s); return h("span", { class: "tier t-" + t, text: labelOf(t) }); };
/* An entry's media, closest to the original first: what was attached to it, then any cited source with a picture or video. */
function mediaOf(ice, e) {
  const ids = [...(e.media || []), ...e.sources];
  const out = [];
  for (const id of ids) { const s = sourceById(ice, id); if (isMedia(s) && !out.includes(s)) out.push(s); }
  return byCloseness(out);
}

function renderHero() {
  const ice = state.ice; const hero = $("#hero");
  renderNoteMeta();
  if (!ice) { hero.hidden = true; hero.replaceChildren(); return; }
  hero.hidden = false;
  const entries = countEntries(ice);
  const done = ice.layers.filter((l) => l.status === "done").length;
  const media = ice.layers.reduce((n, l) => n + l.entries.filter((e) => mediaOf(ice, e).length).length, 0);
  const named = ice.title && ice.title.toLowerCase() !== String(ice.topic).toLowerCase();
  const pic = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(ice.image || "") ? ice.image : null;
  const seen = pic || ice.reading
    ? h("figure", { class: "hero-image" },
      pic ? h("button", { class: "thumb-open", type: "button", "aria-label": "View the image this search started from, full size",
        onclick: async () => viewImage((await fullImages.get(ice.id)) || pic, ice.imageSize ? `${ice.imageSize[0]} × ${ice.imageSize[1]} px original, shown at the size sent to Claude` : "") },
        h("img", { src: pic, alt: "" })) : null,
      h("figcaption", {}, h("span", { class: "k", text: "WHAT CLAUDE SAW IN THE IMAGE" }),
        ice.reading ? h("p", { text: ice.reading }) : h("p", { text: "Reading the image…" })))
    : null;
  hero.replaceChildren(...[
    named ? h("h2", { text: ice.title }) : null,
    seen,
    ice.summary ? h("p", { text: ice.summary })
      : h("div", { class: "skel-lines", "aria-label": "Planning the search" }, h("span", { class: "skel" }), h("span", { class: "skel" }), h("span", { class: "skel short" })),
    h("div", { class: "readouts" },
      h("span", {}, h("b", { text: String(entries) }), " entries"),
      h("span", {}, h("b", { text: String(ice.sources.length) }), " sources"),
      h("span", {}, h("b", { text: String(media) }), " with images or video"),
      h("span", {}, h("b", { text: `${done}/${LEVELS}` }), " levels charted"))].filter(Boolean));
}

/* One image per entry, drawn from its media. Prefer an image no other
   entry uses yet; never repeat one inside a level (those entries get a letter tile). */
function pickThumbs(ice) {
  const usedAll = new Set(); const picks = new Map();
  ice.layers.forEach((l, li) => {
    const usedHere = new Set();
    l.entries.forEach((e, ei) => {
      const cands = mediaOf(ice, e).filter((s) => thumbOf(s) && !usedHere.has(thumbOf(s)));
      const s = cands.find((c) => !usedAll.has(thumbOf(c))) || cands[0];
      if (s) { usedAll.add(thumbOf(s)); usedHere.add(thumbOf(s)); picks.set(li + ":" + ei, s); }
    });
  });
  return picks;
}
function entryThumb(e, src) {
  const box = h("span", { class: "ethumb", "aria-hidden": "true" });
  const letter = () => h("span", { class: "mono-letter", text: (e.term.match(/[\p{L}\p{N}]/u) || ["·"])[0].toUpperCase() });
  const pic = src ? img(thumbOf(src), { alt: "", onfail: (el) => el.replaceWith(letter()) }) : null;
  box.append(pic || letter());
  if (pic && videoOf(src.url)) box.append(h("span", { class: "vid" }, svg("play")));
  return box;
}

function levelEl(i) {
  const z = ZONES[i]; const layer = state.ice.layers[i];
  const open = state.open && state.open.li === i ? state.open.ei : -1;
  const thumbs = pickThumbs(state.ice);
  let inner;
  if (layer.status === "done" && layer.entries.length) {
    inner = layer.entries.map((e, k) => h("button", {
      class: "entry " + (e.confidence || "established") + (k === open ? " open" : ""), type: "button",
      "aria-label": `${e.term}. ${e.confidence || "established"}, ${e.sources.length} source${e.sources.length === 1 ? "" : "s"}`,
      onclick: () => openEntry(i, k),
    }, entryThumb(e, thumbs.get(i + ":" + k)), h("span", { class: "et" }, e.term, e.sources.length ? h("sup", { text: String(e.sources.length) }) : null)));
  } else if (["pending", "searching", "following", "charting"].includes(layer.status)) {
    inner = [5, 8, 4, 7, 6, 9, 5, 7].map((w) => h("span", { class: "skel", style: `width:${w}em` }));
  } else if (layer.status === "error") {
    inner = [h("span", { class: "note bad", text: layer.error || "This level couldn't be charted." })];
  } else {
    inner = [h("span", { class: "note", text: layer.missing ? "This level was added after this search was saved. Run it again to fill it." : "No results at this level." })];
  }
  const busy = ["searching", "following", "charting"].includes(layer.status);
  const cited = new Set(layer.entries.flatMap((e) => e.sources)).size;
  const count = {
    pending: "waiting", searching: "searching the web", following: "following leads", charting: "reading results",
    done: `${layer.entries.length} entries · ${cited} sources`, error: "failed", empty: "no results",
  }[layer.status] || "";

  return h("section", { class: "level", id: "lv-" + z.key, "data-level": String(z.level), "aria-label": `Level ${z.level}: ${z.name}` },
    h("div", { class: "level-in" },
    h("div", { class: "rail" },
      h("span", { class: "num" }, h("span", { text: `Level ${z.level}` }), h("span", { class: "depth", text: z.depth })),
      h("span", { class: "name", text: z.name }),
      h("span", { class: "label", text: z.label }),
      !layer.theme && layer.status === "pending" && state.busy ? h("span", { class: "theme" }, h("span", { class: "skel", style: "width:11em" }))
        : layer.theme ? h("span", { class: "theme", text: layer.theme }) : null,
      h("span", { class: "count" + (busy ? " busy" : ""), text: count })),
    h("div", { class: "entries" }, inner),
    levelMedia(i)));
}
/* Every picture and video attached to this level's entries, each opening its entry. */
function levelMedia(i) {
  const ice = state.ice; const layer = ice.layers[i];
  if (layer.status !== "done") return null;
  const seen = new Set(); const items = [];
  layer.entries.forEach((e, k) => mediaOf(ice, e).forEach((s) => {
    if (seen.has(s.id)) return; seen.add(s.id); items.push({ s, k, e });
  }));
  if (!items.length) return null;
  return h("div", { class: "lvmedia", role: "list", "aria-label": `Images and video for ${ZONES[i].name}` },
    items.slice(0, 12).map(({ s, k, e }) => {
      const v = videoOf(s.url);
      const b = h("button", { class: "lvm" + (v ? " is-video" : ""), type: "button", role: "listitem", title: `${e.term} — ${s.title}`,
        "aria-label": `${v ? "Video" : "Image"} for ${e.term}: ${s.title}`, onclick: () => openEntry(i, k, s.id) });
      const im = img(thumbOf(s), { alt: "", onfail: () => b.remove() });
      if (!im) return null;
      b.append(im, h("span", { class: "lvm-cap", text: e.term }));
      if (v) b.append(h("span", { class: "vid" }, svg("play")));
      return b;
    }));
}
function renderBand(i) { const old = document.getElementById("lv-" + ZONES[i].key); const el = levelEl(i); if (old) old.replaceWith(el); else $("#levels").append(el); renderLvNav(); }
function renderOcean() { $("#levels").replaceChildren(...ZONES.map((_, i) => levelEl(i))); renderLvNav(); }

/* Phones: a sticky bar of the levels, marking the one on screen. */
function renderLvNav() {
  const ice = state.ice;
  $("#lvnav").replaceChildren(...ZONES.map((z, i) => h("button", {
    type: "button", "data-key": z.key, "aria-label": `Level ${z.level}: ${z.name}`,
    onclick: () => document.getElementById("lv-" + z.key)?.scrollIntoView({ behavior: "smooth", block: "start" }),
  }, h("span", { class: "n", text: String(z.level) }), h("span", { class: "t", text: z.name }),
     ice.layers[i].entries.length ? h("span", { class: "c", text: String(ice.layers[i].entries.length) }) : null)));
  markLvNav();
}
let navTick = 0;
function markLvNav() {
  const nav = $("#lvnav"); if (!nav.offsetParent) return;
  const line = nav.getBoundingClientRect().bottom + 8;
  let current = null;
  for (const z of ZONES) { const el = document.getElementById("lv-" + z.key); if (el && el.getBoundingClientRect().top <= line) current = z.key; }
  nav.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.key === current;
    if (on && b.getAttribute("aria-current") !== "true") b.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    b.toggleAttribute("aria-current", false); if (on) b.setAttribute("aria-current", "true");
  });
}
window.addEventListener("scroll", () => { if (!navTick) navTick = requestAnimationFrame(() => { navTick = 0; markLvNav(); }); }, { passive: true });

/* --- Media --- */
function playerEl(s, { compact = false } = {}) {
  const v = videoOf(s.url); if (!v) return null;
  const box = h("div", { class: "player" });
  const poster = img(s.image || v.thumb, { alt: "", onfail: (el) => el.replaceWith(h("span", { class: "noimg", text: v.host === "vimeo" ? "Vimeo" : "YouTube" })) });
  const play = h("button", { class: "play", type: "button", "aria-label": `Play ${s.title}` }, h("span", {}, svg("play")));
  play.addEventListener("click", () => {
    box.replaceChildren(h("iframe", {
      src: v.embed, title: s.title, allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true,
      referrerpolicy: "strict-origin-when-cross-origin", loading: "lazy",
    }));
  });
  box.append(poster || h("span", { class: "noimg", text: v.host === "vimeo" ? "Vimeo" : "YouTube" }), play);
  if (compact) box.style.borderRadius = "8px";
  return box;
}
function citedIn(ice) {
  const map = new Map();
  ice.layers.forEach((l) => l.entries.forEach((e) => e.sources.forEach((id) => {
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(zoneOf(l.key).name);
  })));
  return map;
}
const SOURCES_SHOWN = 6;
function renderSources() {
  const ice = state.ice; const cited = citedIn(ice);
  const all = state.allSources || ice.sources.length <= SOURCES_SHOWN + 2;
  const more = $("#srcMore");
  more.hidden = all;
  more.textContent = `Show all ${ice.sources.length} sources`;
  $("#sources").replaceChildren(...byCloseness(ice.sources).map((s, n) => {
    const th = h("span", { class: "sthumb" });
    const pic = img(thumbOf(s), { alt: "", onfail: (el) => { const f = img(s.favicon, { cls: "favicon" }); f ? el.replaceWith(f) : el.remove(); } }) || img(s.favicon, { cls: "favicon" });
    if (pic) th.append(pic);
    return h("li", { id: "src-" + s.id, hidden: (!all && n >= SOURCES_SHOWN) || null },
      h("span", { class: "sid", text: `[${s.id}]` }), th,
      h("div", {},
        h("a", { class: "stitle", href: s.url, target: "_blank", rel: "noopener noreferrer", text: s.title || s.url }),
        h("div", { class: "smeta" },
          tierTag(s),
          h("span", { text: hostOf(s.url) }),
          s.author ? h("span", { text: s.author }) : null,
          s.license ? h("span", { class: "lic", text: s.license }) : null,
          s.date ? h("span", { text: s.date.slice(0, 10) }) : null,
          cited.has(s.id) ? h("span", { class: "cited", text: "cited in " + [...cited.get(s.id)].join(", ") }) : h("span", { text: "found while searching" }))));
  }));
}
let mediaTimer = 0;
function renderSeabed(soon = false) {
  if (soon) { clearTimeout(mediaTimer); mediaTimer = setTimeout(() => renderSeabed(false), 250); return; }
  renderSources();
}
/* Saved searches: a dropdown with one row per iceberg made in this browser, plus the example. */
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const countEntries = (ice) => ice.layers.reduce((n, l) => n + l.entries.length, 0);
function deleteSaved(id) {
  try { localStorage.setItem(HKEY, JSON.stringify(loadHistory().filter((x) => x.id !== id))); } catch {}
  pruneImages();
  if (state.ice?.id === id) show(null); else renderRecent();
}
function savedRow(ice, { removable }) {
  const on = state.ice?.id === ice.id;
  const meta = [ice.createdAt ? fmtDate(ice.createdAt) : (ice.example ? "Example" : ""), `${countEntries(ice)} entries`].filter(Boolean).join(" · ");
  return h("li", { class: "saved-row" + (on ? " on" : "") },
    h("button", { class: "saved-open", type: "button", role: "menuitem", "aria-current": on ? "true" : null, onclick: () => { closeSaved(); show(ice); } },
      h("span", { class: "t", text: ice.title || ice.topic }), h("span", { class: "m", text: meta })),
    removable ? h("button", { class: "saved-del", type: "button", "aria-label": `Delete ${ice.title || ice.topic}`, title: "Delete", onclick: () => deleteSaved(ice.id), text: "×" }) : null);
}
function closeSaved() { const d = $("#saved"); if (d) d.open = false; }
function renderRecent() {
  const hist = loadHistory();
  const label = state.ice ? (state.ice.title || state.ice.topic) : "Saved searches";
  const menu = h("div", { class: "saved-menu", role: "menu" },
    h("button", { class: "saved-new", type: "button", role: "menuitem", onclick: () => { closeSaved(); newNote(); } }, h("span", { text: "+" }), " New search"),
    h("div", { class: "saved-h", text: "Your searches" }),
    hist.length ? h("ul", {}, ...hist.map((x) => savedRow(x, { removable: true })))
      : h("p", { class: "saved-empty", text: "Searches you run are saved here, in this browser." }),
    h("div", { class: "saved-h", text: "Example" }),
    h("ul", {}, savedRow(EXAMPLE, { removable: false })));
  const d = h("details", { class: "saved", id: "saved" },
    h("summary", { "aria-label": "Saved searches" },
      h("span", { class: "lbl", text: label }), hist.length ? h("span", { class: "n", text: String(hist.length) }) : null, svg("chev")),
    menu);
  if (state.busy) d.classList.add("off");
  $("#recent").replaceChildren(d);
}
document.addEventListener("click", (ev) => { const d = $("#saved"); if (d?.open && !d.contains(ev.target)) d.open = false; });
function renderAll() {
  const empty = !state.ice;
  document.body.classList.toggle("empty", empty);
  $("main.chart").hidden = empty; $("section.appendix").hidden = empty;
  renderHero(); renderRecent(); renderChat();
  if (empty) { $("#levels").replaceChildren(); $("#lvnav").replaceChildren(); $("#sources").replaceChildren(); return; }
  renderOcean(); renderSeabed();
}
/* Older saves have six levels; line their layers up with the current levels by key. */
function withAllLevels(ice) {
  if (!ice || (ice.layers.length === LEVELS && ice.layers.every((l, i) => l.key === ZONES[i].key))) return ice;
  const layers = ZONES.map((z) => ice.layers.find((l) => l.key === z.key)
    || { key: z.key, status: "empty", entries: [], theme: "", missing: true });
  return Object.assign(ice, { layers });
}
function show(ice) {
  if (state.busy) return;
  withAllLevels(ice);
  chatCtl?.abort(); chatCtl = null;
  state.ice = ice; state.allSources = false; closeDrawer(); clearImage();
  if (ice) setNote(ice.topic || ice.title, ice.notesDoc || ice.notes || ""); else { const d = loadDraft(); setNote(d.topic, d.doc); }
  renderAll(); window.scrollTo({ top: 0 });
}
function newNote() { if (state.busy) return; saveDraft({ topic: "", doc: "" }); show(null); $("#topic").focus(); }

/* ===== The note ===== */
/* Title: plain text, one line. Notes: a Tiptap editor (see editor.js). */
const DKEY = "iceberg-sounder.draft";
const loadDraft = () => {
  try { const d = JSON.parse(localStorage.getItem(DKEY) || "{}"); return { topic: String(d.topic || ""), doc: d.doc && d.doc.type === "doc" ? d.doc : String(d.notes || "") }; }
  catch { return { topic: "", doc: "" }; }
};
const saveDraft = (d) => { try { localStorage.setItem(DKEY, JSON.stringify(d)); } catch {} };
const titleText = () => $("#topic").innerText.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
function getNote() { return { topic: titleText(), notes: notesEd.getMarkdown(), doc: notesEd.getJSON() }; }
function setNote(topic, doc) { $("#topic").textContent = topic || ""; notesEd.setContent(doc || ""); }
const draftNow = () => { if (!state.ice) { const n = getNote(); saveDraft({ topic: n.topic, doc: n.doc }); } };
function renderNoteMeta() {
  const ice = state.ice; const el = $("#noteMeta");
  if (!ice) { el.textContent = "New search"; return; }
  const n = getNote();
  const edited = !state.busy && (n.topic !== String(ice.topic || ice.title).trim() || n.notes !== String(ice.notes || "").trim());
  el.replaceChildren(
    h("span", { text: ice.example ? "Example" : state.busy ? "Researching…" : "Saved " + fmtDate(ice.createdAt || Date.now()) }),
    ...(edited ? [h("span", { class: "edited", text: " · edited, run it again to research the new version" })] : []));
}
function placeCaretEnd(el) {
  el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
/* ===== Effort menu: custom dropdown, value kept in the hidden #tier input ===== */
const TIERS = [
  { v: "quick", t: "Quick", d: "Fast, lighter reading" },
  { v: "thorough", t: "Thorough", d: "The default" },
  { v: "deep", t: "Deepest", d: "Slowest, most careful" },
];
const effortOpen = () => !$("#effortMenu").hidden;
function setTier(v) {
  const t = TIERS.find((x) => x.v === v) || TIERS[1];
  $("#tier").value = t.v;
  $("#effortBtn .lbl").textContent = t.t;
  for (const o of $("#effortMenu").children) o.setAttribute("aria-selected", String(o.dataset.v === t.v));
}
function closeEffort(refocus) {
  $("#effortMenu").hidden = true; $("#effortBtn").setAttribute("aria-expanded", "false");
  if (refocus) $("#effortBtn").focus();
}
function openEffort() {
  if (state.busy) return;
  $("#effortMenu").hidden = false; $("#effortBtn").setAttribute("aria-expanded", "true");
  const cur = [...$("#effortMenu").children].find((o) => o.dataset.v === $("#tier").value) || $("#effortMenu").firstChild;
  cur.focus();
}
function pickTier(v) { setTier(v); closeEffort(true); }
(function setupEffort() {
  const menu = $("#effortMenu"), btn = $("#effortBtn");
  btn.append(svg("chev"));
  menu.append(...TIERS.map((t) => h("div", { class: "effort-opt", role: "option", tabindex: "-1", "data-v": t.v, "aria-selected": "false", onclick: () => pickTier(t.v) },
    h("span", { class: "t", text: t.t }), h("span", { class: "m", text: t.d }))));
  setTier($("#tier").value);
  btn.addEventListener("click", () => (effortOpen() ? closeEffort() : openEffort()));
  btn.addEventListener("keydown", (ev) => { if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); openEffort(); } });
  menu.addEventListener("keydown", (ev) => {
    const opts = [...menu.children], i = opts.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") { ev.preventDefault(); opts[Math.min(i + 1, opts.length - 1)].focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); opts[Math.max(i - 1, 0)].focus(); }
    else if (ev.key === "Home") { ev.preventDefault(); opts[0].focus(); }
    else if (ev.key === "End") { ev.preventDefault(); opts[opts.length - 1].focus(); }
    else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); if (i >= 0) pickTier(opts[i].dataset.v); }
    else if (ev.key === "Tab") closeEffort();
  });
  document.addEventListener("click", (ev) => { if (effortOpen() && !$("#effort").contains(ev.target)) closeEffort(); });
})();

const notesEd = createNotesEditor({
  el: $("#notes"), bubble: $("#bubble"), slash: $("#slash"),
  placeholder: "Add notes to steer the research: an angle, a period, sources you trust, what to skip. Type / for commands.",
  actions: [
    { key: "research", t: "Research", d: "Start the search now", k: "", run: () => $("#diveBtn").click() },
    { key: "image", t: "Attach an image", d: "Research what it shows", k: "", run: () => $("#attachInput").click() },
    { key: "quick", t: "Quick", d: "Fast, lighter reading", run: () => { setTier("quick"); } },
    { key: "thorough", t: "Thorough", d: "The default", run: () => { setTier("thorough"); } },
    { key: "deepest", t: "Deepest", d: "Slowest, most careful", run: () => { setTier("deep"); } },
    { key: "example", t: "Open the example", d: "The Voynich manuscript", run: () => show(EXAMPLE) },
    { key: "new", t: "New search", d: "Clear this page", run: () => newNote() },
  ],
  onChange: () => { draftNow(); renderNoteMeta(); },
  onSubmit: () => $("#diveBtn").click(),
  onExitTop: () => placeCaretEnd($("#topic")),
});
(function setupTitle() {
  const title = $("#topic");
  if (title.contentEditable !== "plaintext-only") title.contentEditable = "true";
  title.addEventListener("paste", (ev) => { ev.preventDefault(); document.execCommand("insertText", false, (ev.clipboardData?.getData("text/plain") || "").replace(/\s+/g, " ")); });
  title.addEventListener("input", () => {
    if (!title.textContent.trim()) title.replaceChildren();
    if (title.innerText.length > 160) { title.textContent = title.innerText.slice(0, 160); placeCaretEnd(title); }
    draftNow(); renderNoteMeta();
  });
  title.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); $("#diveBtn").click(); }
    else if (ev.key === "Enter" || (ev.key === "ArrowDown" && !ev.shiftKey)) { ev.preventDefault(); notesEd.focusStart(); }
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $("#kbdHint").replaceChildren(h("kbd", { text: mac ? "⌘" : "Ctrl" }), h("kbd", { text: "↵" }));
  const d = loadDraft(); setNote(d.topic, d.doc);
})();

/* ===== Pasted image ===== */
/* An image pasted, dropped or chosen on the note is downscaled here to a JPEG
   (1568 px on the long edge, the size Claude reads at full detail) and sent with
   the dive. Claude reads it, names the subject and plans the searches from it.
   Only a small thumbnail is kept with the saved iceberg. */
const IMAGE_EDGE = 1568, THUMB_EDGE = 240;
let attached = null;
async function loadBitmap(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch {} }
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const im = new Image(); im.src = url; await im.decode(); return im;
}
function toJpeg(bmp, edge, quality) {
  const w = bmp.width, hgt = bmp.height, k = Math.min(1, edge / Math.max(w, hgt));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hgt * k));
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); // transparent areas become white, not black
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}
async function attachImage(file) {
  if (state.busy || !file) return;
  if (!/^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(file.type)) { setStatus("Use a PNG, JPEG, GIF or WebP image.", "err"); return; }
  if (file.size > 30 * 1024 * 1024) { setStatus("That image is too large. Use one under 30 MB.", "err"); return; }
  try {
    const bmp = await loadBitmap(file);
    const full = toJpeg(bmp, IMAGE_EDGE, 0.86);
    attached = { media_type: "image/jpeg", data: full.slice(full.indexOf(",") + 1), full, thumb: toJpeg(bmp, THUMB_EDGE, 0.72), w: bmp.width, h: bmp.height };
    bmp.close?.();
  } catch { setStatus("Couldn't read that image. Try a PNG or JPEG.", "err"); return; }
  renderImage();
}
function clearImage() { if (!attached) return; attached = null; renderImage(); }
function renderImage() {
  $("#noteImage").hidden = !attached;
  $("#topic").dataset.placeholder = attached ? "Topic (optional)" : "Untitled topic";
  if (!attached) { $("#noteImageImg").removeAttribute("src"); return; }
  $("#noteImageImg").src = attached.thumb;
  $("#noteImageImg").alt = "The attached image";
  $("#noteImageMeta").textContent = `${attached.w} × ${attached.h} px. Claude reads it and researches what it shows. The title is optional; notes steer the angle.`;
}
/* The clipboard's image, unless it also carries text: Word and similar apps put a
   picture of the copied text on the clipboard, and the text is what's wanted. */
function imageFrom(dt, { textWins = true } = {}) {
  if (!dt) return null;
  if (textWins && (dt.getData?.("text/plain") || "").trim()) return null;
  const item = [...(dt.items || [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
  return item?.getAsFile() || [...(dt.files || [])].find((f) => f.type.startsWith("image/")) || null;
}
(function setupImage() {
  const note = $("#note"), input = $("#attachInput");
  $("#attachBtn").addEventListener("click", () => input.click());
  input.addEventListener("change", () => { attachImage(input.files?.[0]); input.value = ""; });
  $("#noteImageRemove").addEventListener("click", () => { clearImage(); notesEd.focusEnd(); });
  $("#noteImageOpen").addEventListener("click", () => { if (attached) viewImage(attached.full, `${attached.w} × ${attached.h} px original, shown at the size sent to Claude`); });
  // Capture phase, so the title's and the editor's own paste handlers never see it.
  document.addEventListener("paste", (ev) => {
    if (ev.target?.closest?.("#chatForm, #keysForm")) return;
    const file = imageFrom(ev.clipboardData);
    if (!file) return;
    ev.preventDefault(); ev.stopPropagation();
    attachImage(file);
  }, true);
  const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes("Files");
  note.addEventListener("dragover", (ev) => { if (!hasFiles(ev) || state.busy) return; ev.preventDefault(); note.classList.add("dropping"); });
  note.addEventListener("dragleave", (ev) => { if (!note.contains(ev.relatedTarget)) note.classList.remove("dropping"); });
  note.addEventListener("drop", (ev) => {
    note.classList.remove("dropping");
    const file = imageFrom(ev.dataTransfer, { textWins: false });
    if (!file) return;
    ev.preventDefault(); ev.stopPropagation();
    attachImage(file);
  }, true);
  renderImage();
})();

/* ===== Status ===== */
const prog = { done: 0, total: 1 };
function setStatus(text, kind) {
  const el = $("#statusLine");
  el.className = "status-line" + (kind === "err" ? " err" : "");
  el.replaceChildren(...(kind === "busy" ? [h("span", { class: "ping" })] : []), h("span", { text }));
}
function setProgress() { $("#barFill").style.width = Math.round((prog.done / prog.total) * 100) + "%"; }
function setBusy(b) {
  state.busy = b;
  $("#effort").classList.toggle("off", b); if (b) closeEffort();
  $("#diveBtn").disabled = b || !canDive();
  $("#diveBtn").hidden = b;
  $("#attachBtn").disabled = b;
  $("#stopBtn").hidden = !b;
  $("#bar").hidden = !b;
  $("#note").classList.toggle("busy", b);
  renderNoteMeta();
  if (b) { prog.done = 0; setProgress(); }
  renderRecent();
}

/* ===== Dive ===== */
async function build(topic, notes = "", notesDoc = null) {
  topic = String(topic || "").replace(/\s+/g, " ").trim().slice(0, 160);
  notes = String(notes || "").trim().slice(0, 2000);
  const image = attached;
  if (!topic && !image) { setStatus("Write a topic as the title, or paste an image."); $("#topic").focus(); return; }
  if (state.busy || !canDive()) return;
  const ctl = buildCtl = new AbortController();
  const ice = { id: "ice-" + Date.now().toString(36), topic, notes, notesDoc: notes ? notesDoc : null, title: topic || "Image search", summary: "", createdAt: Date.now(), sources: [],
    ...(image ? { image: image.thumb, imageSize: [image.w, image.h], reading: "" } : {}),
    layers: ZONES.map((z) => ({ key: z.key, status: "pending", entries: [], theme: "" })) };
  if (image) fullImages.put(ice.id, image.full);
  state.ice = ice; closeDrawer(); setBusy(true); renderAll();
  prog.total = 1 + LEVELS * 3; prog.done = 0;
  setStatus(image ? "Reading the image and planning searches…" : `Planning searches for “${topic}”…`, "busy");
  let finished = false;
  try {
    const body = { topic, notes, depth: $("#tier").value, ...(image ? { image: { media_type: image.media_type, data: image.data } } : {}) };
    for await (const ev of await postStream("/api/dive", body, ctl.signal)) {
      if (ev.type === "status") setStatus(ev.text, "busy");
      else if (ev.type === "plan") {
        ice.title = ev.title || topic || ice.title; ice.summary = ev.summary || "";
        if (image) ice.reading = ev.reading || "";
        // With no topic typed, the one Claude named from the image becomes the title.
        if (!ice.topic) { ice.topic = ice.title; if (!titleText()) { $("#topic").textContent = ice.title; draftNow(); } }
        ice.layers.forEach((l, i) => { l.theme = ev.themes?.[i] || ""; });
        prog.done = 1; setProgress(); renderHero(); renderOcean();
      } else if (ev.type === "source") {
        const s = ev.source; if (!safeUrl(s.url)) continue;
        const at = ice.sources.findIndex((x) => x.id === s.id);
        if (at >= 0) ice.sources[at] = s; else ice.sources.push(s);
        renderSeabed(true); renderHero();
        if (s.image && ice.layers.some((l) => l.entries.some((en) => en.sources.includes(s.id)))) renderOcean();
      } else if (ev.type === "layer") {
        const l = ice.layers[ev.index]; if (!l) continue;
        l.status = ev.status;
        if (ev.entries) l.entries = ev.entries;
        if (ev.error) l.error = ev.error;
        const step = { following: 1, charting: 2, done: 3, empty: 3, error: 3 }[ev.status] || 0;
        if (step > (l.steps || 0)) { prog.done += step - (l.steps || 0); l.steps = step; }
        setProgress(); renderBand(ev.index); renderHero(); renderChat();
      } else if (ev.type === "done") {
        finished = true;
        setStatus(ev.charted ? `Charted ${ev.charted} of ${LEVELS} levels, ${countEntries(ice)} entries, from ${ev.sources} sources.` : "No level could be charted. Try a more specific topic.", ev.charted ? null : "err");
      } else if (ev.type === "error") {
        finished = true;
        setStatus(ev.error?.message || "The dive failed.", "err");
      }
    }
    if (!finished && !ctl.signal.aborted) setStatus("The connection to the server dropped before the dive finished.", "err");
  } catch (e) {
    if (ctl.signal.aborted || e?.name === "AbortError") setStatus("Stopped. Finished levels are kept.");
    else setStatus(e?.message || "Couldn't reach the server. Is it still running?", "err");
  } finally {
    ice.layers.forEach((l, i) => { delete l.steps; if (["pending", "searching", "following", "charting"].includes(l.status)) { l.status = "error"; l.error = "Stopped before this level was reached."; renderBand(i); } });
    if (buildCtl === ctl) buildCtl = null;
    setBusy(false); renderSeabed();
    if (ice.layers.some((l) => l.entries.length)) saveHistory(ice);
  }
}

/* ===== Entry modal ===== */
let lastFocus = null, mediaCtl = null;
function closeDrawer() {
  deepCtl?.abort(); deepCtl = null;
  mediaCtl?.abort(); mediaCtl = null;
  if ($("#drawer").hidden) return;
  $("#drawer").hidden = true; $("#scrim").hidden = true; state.open = null;
  document.body.classList.remove("modal-open");
  document.querySelectorAll(".entry.open").forEach((el) => el.classList.remove("open"));
  lastFocus?.focus?.();
}

function stageEl(s) {
  const v = videoOf(s.url);
  const cap = h("div", { class: "mcap" },
    h("span", { class: "kind", text: `${v ? "Video" : "Image"} · ${labelOf(tierOfSource(s))}` }),
    h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer", text: s.title || hostOf(s.url) }),
    h("span", { class: "h", text: [`[${s.id}]`, hostOf(s.url), s.author, s.license].filter(Boolean).join(" · ") }));
  if (v) return h("figure", { class: "stage" }, h("div", { class: "frame" }, playerEl(s)), cap);
  const frame = h("div", { class: "frame" });
  const im = img(s.image, { alt: s.title, onfail: (el) => el.replaceWith(h("span", { class: "noimg", text: "This image couldn't be loaded. Open the source to see it." })) });
  if (im) { im.addEventListener("click", () => openLightbox(s)); frame.append(im); }
  return h("figure", { class: "stage" }, frame, cap);
}

function renderModalMedia(ice, e, box, selectedId, searching) {
  const items = mediaOf(ice, e);
  const sel = items.find((s) => s.id === selectedId) || items[0];
  box.dataset.sel = sel ? String(sel.id) : "";
  const kids = [];
  if (sel) kids.push(stageEl(sel));
  else kids.push(h("div", { class: "stage empty" }, h("div", { class: "frame" },
    h("span", { class: "big-letter", text: (e.term.match(/[\p{L}\p{N}]/u) || ["·"])[0].toUpperCase() }),
    h("span", { class: "noimg", text: searching ? "Looking for images and video…" : "No images or video found for this entry." }))));
  if (items.length > 1 || searching) {
    kids.push(h("div", { class: "strip", role: "list", "aria-label": "All media for this entry" },
      items.map((s) => {
        const b = h("button", { type: "button", role: "listitem", "aria-pressed": String(s === sel), title: s.title,
          "aria-label": `${videoOf(s.url) ? "Video" : "Image"}: ${s.title}`,
          onclick: () => renderModalMedia(ice, e, box, s.id, searching) });
        const im = img(thumbOf(s), { alt: "", onfail: (el) => el.replaceWith(h("span", { class: "noimg", text: hostOf(s.url) })) });
        if (im) b.append(im);
        if (videoOf(s.url)) b.append(h("span", { class: "vid" }, svg("play")));
        return b;
      }),
      searching ? h("span", { class: "strip-busy", text: "Searching…" }) : null));
  }
  box.replaceChildren(...kids);
}

/* First open of an entry with no video: look for video and Commons pictures of it. */
async function enrichEntry(ice, e, li, ei, box) {
  if (ice.example || e.mediaSearched || !canDive() || mediaOf(ice, e).some((s) => videoOf(s.url))) return;
  mediaCtl?.abort();
  const ctl = mediaCtl = new AbortController();
  renderModalMedia(ice, e, box, null, true);
  try {
    const res = await fetch("/api/media", { method: "POST", headers: { "content-type": "application/json", ...keyHeaders() },
      body: JSON.stringify({ topic: ice.title, term: e.term }), signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || "Media search failed.");
    e.media = e.media || [];
    for (const it of data.items || []) {
      if (!safeUrl(it.url)) continue;
      let s = ice.sources.find((x) => x.url === it.url);
      if (!s) {
        s = { id: Math.max(0, ...ice.sources.map((x) => x.id)) + 1, title: it.title || hostOf(it.url), url: it.url, author: it.author || "",
          date: it.date || "", image: it.image || "", favicon: it.favicon || "", excerpt: it.excerpt || "", license: it.license || "", commons: !!it.commons };
        ice.sources.push(s);
      }
      if (isMedia(s) && !e.media.includes(s.id)) e.media.push(s.id);
    }
    e.mediaSearched = true;
    if (!ice.example) saveHistory(ice);
    renderBand(li); renderHero(); renderSeabed(true);
  } catch (err) {
    if (ctl.signal.aborted) return;
    e.mediaSearched = true;
  } finally {
    if (mediaCtl === ctl) mediaCtl = null;
  }
  if (state.open?.li === li && state.open?.ei === ei && state.ice === ice) {
    renderModalMedia(ice, e, box, Number(box.dataset.sel) || null, false);
  }
}

function openEntry(li, ei, mediaId) {
  deepCtl?.abort(); deepCtl = null;
  mediaCtl?.abort(); mediaCtl = null;
  const ice = state.ice; const e = ice.layers[li].entries[ei]; const z = ZONES[li];
  state.open = { li, ei };
  if ($("#drawer").hidden) lastFocus = document.activeElement;
  $("#dZone").replaceChildren(h("span", { text: `Level ${z.level} of ${LEVELS} · ${z.depth}` }), h("b", { text: z.name }));
  document.querySelectorAll(".entry.open").forEach((el) => el.classList.remove("open"));
  document.querySelectorAll(`#lv-${z.key} .entry`)[ei]?.classList.add("open");
  const srcs = byCloseness(e.sources.map((id) => sourceById(ice, id)).filter(Boolean));

  const mediaBox = h("div", { class: "mmedia" });
  renderModalMedia(ice, e, mediaBox, mediaId, false);

  const deepBox = h("div", { class: "deep", hidden: !e.deep || null });
  const holesBox = h("div", { class: "holes" });
  const deepErr = h("div", { class: "err", hidden: true });
  if (e.deep) { deepBox.innerHTML = md(e.deep.text, ice); renderHoles(holesBox, e.deep.holes); }

  const digBtn = h("button", { class: "btn primary", type: "button", disabled: !canDive() || null, text: e.deep ? "Dig deeper again" : "Dig deeper" });
  const stopBtn = h("button", { class: "btn", type: "button", hidden: true, text: "Stop" });
  const newBtn = h("button", { class: "btn", type: "button", disabled: !canDive() || state.busy || null, text: "Build an iceberg for this",
    onclick: () => { const t = `${e.term} (${ice.title})`; closeDrawer(); setNote(t, ""); build(t); } });
  digBtn.onclick = () => digDeeper(ice, e, { deepBox, holesBox, deepErr, digBtn, stopBtn });
  stopBtn.onclick = () => deepCtl?.abort();

  const text = h("div", { class: "mtext" }, ...[
    h("h2", { id: "dTitle", text: e.term }),
    h("span", { class: "conf " + e.confidence, text: e.confidence }),
    h("p", { class: "lead", text: e.summary }),
    e.detail ? h("p", { class: "detail", text: e.detail }) : null,
    h("div", { class: "actions" }, digBtn, stopBtn, newBtn),
    !canDive() ? h("div", { class: "err" }, "Dig deeper needs Anthropic and Exa keys. ", h("button", { class: "linkish", type: "button", text: "Add them under Keys", onclick: () => { closeDrawer(); openKeys(); } }), ".") : null,
    deepErr, deepBox, holesBox,
    h("div", { class: "dsec" }, h("h3", { text: `Sources · ${srcs.length}` }),
      h("ul", { class: "citelist" }, srcs.map((s) => {
        const th = h("span", { class: "cthumb" }); const t = img(thumbOf(s), { alt: "" }); if (t) th.append(t);
        return h("li", {}, h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" },
          h("span", { class: "sid", text: `[${s.id}]` }), th,
          h("span", {}, h("div", { class: "t", text: s.title }), h("div", { class: "x" }, tierTag(s), ` ${hostOf(s.url)}${s.excerpt ? " — " + s.excerpt : ""}`))));
      }))),
  ].filter(Boolean));

  $("#dBody").replaceChildren(h("div", { class: "mgrid" }, mediaBox, text));
  $("#drawer").hidden = false; $("#scrim").hidden = false;
  document.body.classList.add("modal-open");
  text.scrollTop = 0; $("#dBody").scrollTop = 0;
  $("#dClose").focus();
  enrichEntry(ice, e, li, ei, mediaBox);
}
function renderHoles(box, holes) {
  box.replaceChildren(...((holes || []).length ? [h("div", { class: "dsec", style: "width:100%" }, h("h3", { text: "Related topics" }),
    h("div", { class: "holes" }, holes.map((t) => h("button", { class: "chip", type: "button", disabled: state.busy || !canDive() || null, text: t,
      onclick: () => { closeDrawer(); setNote(t, ""); build(t); } }))))] : []));
}
function splitHoles(text) {
  const m = text.match(/\n\s*Rabbit holes:\s*(.*)\s*$/i);
  if (!m) return { body: text, holes: [] };
  return { body: text.slice(0, m.index), holes: m[1].split("|").map((s) => s.replace(/[*_`]/g, "").trim()).filter(Boolean).slice(0, 4) };
}
async function digDeeper(ice, e, ui) {
  deepCtl?.abort();
  const ctl = deepCtl = new AbortController();
  const srcs = byCloseness(e.sources.map((id) => sourceById(ice, id)).filter(Boolean)).slice(0, 5);
  ui.digBtn.disabled = true; ui.stopBtn.hidden = false; ui.deepErr.hidden = true;
  ui.deepBox.hidden = false; ui.holesBox.replaceChildren();
  ui.deepBox.innerHTML = `<p class="think">Starting…</p>`;
  let text = "", ok = false, truncated = false;
  try {
    const events = await postStream("/api/deep", {
      topic: ice.title, depth: $("#tier").value,
      entry: { term: e.term, summary: e.summary, detail: e.detail },
      sources: srcs.map((s) => ({ id: s.id, title: s.title, url: s.url, excerpt: s.excerpt })),
    }, ctl.signal);
    for await (const ev of events) {
      if (ev.type === "status" && !text) ui.deepBox.innerHTML = `<p class="think">${esc(ev.text)}</p>`;
      else if (ev.type === "reset") text = "";
      else if (ev.type === "text") { text += ev.delta; ui.deepBox.innerHTML = md(splitHoles(text).body, ice); }
      else if (ev.type === "done") { ok = true; truncated = ev.truncated; }
      else if (ev.type === "error") { ui.deepErr.textContent = ev.error?.message || "The deep dive failed."; ui.deepErr.hidden = false; }
    }
  } catch (err) {
    if (!(ctl.signal.aborted || err?.name === "AbortError")) { ui.deepErr.textContent = err?.message || "Couldn't reach the server."; ui.deepErr.hidden = false; }
  } finally {
    if (deepCtl === ctl) deepCtl = null;
    ui.digBtn.disabled = !canDive(); ui.stopBtn.hidden = true;
  }
  if (!text) { ui.deepBox.innerHTML = ""; ui.deepBox.hidden = true; return; }
  const { body, holes } = splitHoles(text);
  ui.deepBox.innerHTML = md(body, ice) + (truncated ? `<p class="think">Cut short at the length limit.</p>` : "");
  if (ok) {
    e.deep = { text: body, holes };
    renderHoles(ui.holesBox, holes);
    saveHistory(ice);
    ui.digBtn.textContent = "Dig deeper again";
  }
}

/* ===== Chat about the findings ===== */
/* A sidebar where the reader asks Claude about this iceberg. Each request sends
   a compact digest of the chart (see digest.js) plus the conversation so far.
   The conversation is kept on the iceberg, so it is saved with it. */
let chatCtl = null;
const chatOpen = () => !$("#chat").hidden;
const canChat = () => server.ok && (!!userKeys.anthropic || server.claude);
const chatReady = (ice) => !!ice && ice.layers.some((l) => l.entries.length);
const STARTERS = [
  "Which entries are best documented, and by which kind of source?",
  "What is contested here, and what does each side point to?",
  "Which entries rest on a single source or a weak one?",
  "Walk me from the top level to the bottom in a few paragraphs.",
];
/* Finds an entry by its printed term, for [[Term]] links in answers. */
function findEntry(ice, term) {
  const t = term.trim().toLowerCase();
  for (const [li, l] of ice.layers.entries()) {
    const ei = l.entries.findIndex((e) => e.term.trim().toLowerCase() === t);
    if (ei >= 0) return { li, ei };
  }
  return null;
}
/* Answers: paragraphs, short lists, **bold**, [n] citations and [[Term]] entry links. */
function chatMd(text, ice) {
  const inline = (line) => esc(line)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[\[([^\]\n]{1,140})\]\]/g, (m, term) => {
      const at = findEntry(ice, term.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
      return at ? `<a href="#lv-${ZONES[at.li].key}" class="chat-entry" role="button" data-li="${at.li}" data-ei="${at.ei}">${term}</a>` : term;
    })
    .replace(/\[(\d{1,4})\]/g, (m, n) => (ice.sources.some((x) => x.id === +n) ? `<a class="cite" href="#src-${n}" data-cite="${n}">[${n}]</a>` : m));
  // Within a block, consecutive list lines become one list; other lines a paragraph.
  const kindOf = (l) => (/^\s*[-*]\s+/.test(l) ? "ul" : /^\s*\d+[.)]\s+/.test(l) ? "ol" : "p");
  return String(text).trim().split(/\n{2,}/).filter(Boolean).map((block) => {
    const runs = [];
    for (const l of block.split("\n").filter((x) => x.trim())) {
      const k = kindOf(l);
      if (runs.length && runs.at(-1).k === k) runs.at(-1).lines.push(l); else runs.push({ k, lines: [l] });
    }
    return runs.map(({ k, lines }) => k === "p" ? "<p>" + lines.map(inline).join("<br>") + "</p>"
      : `<${k}>` + lines.map((l) => "<li>" + inline(l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")) + "</li>").join("") + `</${k}>`).join("");
  }).join("");
}
function chatMsgEl(m, ice) {
  if (m.role === "user") return h("div", { class: "chat-msg user", text: m.text });
  const el = h("div", { class: "chat-msg bot" });
  el.innerHTML = chatMd(m.text, ice);
  return el;
}
function renderChat() {
  const ice = state.ice; const ready = chatReady(ice);
  $("#chatLaunch").hidden = !ready || chatOpen();
  $("#chatLaunch").setAttribute("aria-expanded", String(chatOpen()));
  if (!ready) { if (chatOpen()) closeChat(); return; }
  const st = digestStats(ice);
  $("#chatMeta").textContent = `${st.entries} entries · ${st.levels} levels · ${st.sources} sources`;
  const log = ice.chat || [];
  $("#chatClear").hidden = !log.length || !!chatCtl;
  const kids = log.map((m) => chatMsgEl(m, ice));
  if (!log.length) {
    kids.push(h("div", { class: "chat-empty" },
      h("p", { text: `Ask anything about ${ice.title || ice.topic}. Answers come from the ${st.entries} entries and ${st.sources} sources in this iceberg, with citations.` }),
      h("div", { class: "chat-starters" }, STARTERS.map((q) => h("button", { class: "chip", type: "button", text: q, onclick: () => askChat(q) })))));
  }
  if (!canChat()) kids.push(h("div", { class: "err" }, "Asking needs an Anthropic key. ", h("button", { class: "linkish", type: "button", text: "Add it under Keys", onclick: () => { closeChat(); openKeys(); } }), "."));
  $("#chatLog").replaceChildren(...kids);
  $("#chatSend").disabled = !canChat() || !!chatCtl;
  $("#chatSend").hidden = !!chatCtl; $("#chatStop").hidden = !chatCtl;
}
function openChat() {
  if (!chatReady(state.ice)) return;
  $("#chat").hidden = false; document.body.classList.add("chat-open");
  renderChat(); scrollChat(); $("#chatInput").focus();
}
function closeChat() {
  if ($("#chat").hidden) return;
  $("#chat").hidden = true; document.body.classList.remove("chat-open");
  renderChat(); $("#chatLaunch").focus?.();
}
const scrollChat = () => { const log = $("#chatLog"); log.scrollTop = log.scrollHeight; };
function sizeChatInput() { const t = $("#chatInput"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 160) + "px"; }
async function askChat(question) {
  const ice = state.ice; question = String(question || "").trim();
  if (!question || chatCtl || !canChat() || !chatReady(ice)) return;
  ice.chat = ice.chat || [];
  ice.chat.push({ role: "user", text: question });
  $("#chatInput").value = ""; sizeChatInput();
  const ctl = chatCtl = new AbortController();
  renderChat();
  const bot = h("div", { class: "chat-msg bot" }, h("p", { class: "think", text: "Reading the findings…" }));
  $("#chatLog").append(bot); scrollChat();
  let text = "", ok = false, failed = "";
  try {
    const events = await postStream("/api/chat", {
      topic: ice.title || ice.topic, depth: $("#tier").value, digest: digestOf(ice),
      messages: ice.chat.map((m) => ({ role: m.role, text: m.text })),
    }, ctl.signal);
    for await (const ev of events) {
      if (ev.type === "reset") text = "";
      else if (ev.type === "text") {
        const stick = $("#chatLog").scrollHeight - $("#chatLog").scrollTop - $("#chatLog").clientHeight < 40;
        text += ev.delta; bot.innerHTML = chatMd(text, ice);
        if (stick) scrollChat();
      } else if (ev.type === "done") ok = true;
      else if (ev.type === "error") failed = ev.error?.message || "The answer failed.";
    }
  } catch (err) {
    if (!(ctl.signal.aborted || err?.name === "AbortError")) failed = err?.message || "Couldn't reach the server.";
  } finally {
    if (chatCtl === ctl) chatCtl = null;
  }
  if (state.ice !== ice) return;
  if (text.trim()) {
    // A stopped answer is kept as far as it got, so the conversation still alternates.
    ice.chat.push({ role: "assistant", text: text.trim() + (ok ? "" : "\n\n(Stopped before the answer finished.)") });
    if (!ice.example) saveHistory(ice);
  } else {
    // Nothing came back: drop the question and put it back in the box.
    ice.chat.pop();
    $("#chatInput").value = question; sizeChatInput();
  }
  renderChat(); scrollChat();
  if (failed) { $("#chatLog").append(h("div", { class: "chat-msg bot" }, h("p", { class: "err", text: failed }))); scrollChat(); }
}
$("#chatLaunch").addEventListener("click", openChat);
$("#chatClose").addEventListener("click", closeChat);
$("#chatStop").addEventListener("click", () => chatCtl?.abort());
$("#chatClear").addEventListener("click", () => {
  const ice = state.ice; if (!ice || chatCtl) return;
  ice.chat = []; if (!ice.example) saveHistory(ice); renderChat(); $("#chatInput").focus();
});
$("#chatForm").addEventListener("submit", (ev) => { ev.preventDefault(); askChat($("#chatInput").value); });
$("#chatInput").addEventListener("input", sizeChatInput);
$("#chatInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); askChat($("#chatInput").value); }
});
$("#chatLog").addEventListener("click", (ev) => {
  const b = ev.target.closest(".chat-entry");
  if (!b || !state.ice) return;
  ev.preventDefault();
  const li = +b.dataset.li, ei = +b.dataset.ei;
  if (!state.ice.layers[li]?.entries[ei]) return;
  if (window.innerWidth < 1240) closeChat();
  document.getElementById("lv-" + ZONES[li].key)?.scrollIntoView({ block: "center" });
  openEntry(li, ei);
});

/* ===== Lightbox ===== */
let lbReturn = null;
function openLightbox(s) {
  lbReturn = document.activeElement;
  $("#lbImg").src = s.image; $("#lbImg").alt = s.title;
  $("#lbTitle").textContent = `[${s.id}] ${s.title}`;
  $("#lbMeta").textContent = [hostOf(s.url), s.author, s.license].filter(Boolean).join(" · ");
  $("#lbLink").href = s.url; $("#lbLink").hidden = false;
  $("#lightbox").hidden = false; $("#lbClose").focus();
}
/* The pasted image in the same viewer. It has no source page, so no link. */
function viewImage(url, meta = "") {
  if (!/^data:image\/jpeg;base64,/.test(url || "")) return;
  lbReturn = document.activeElement;
  $("#lbImg").src = url; $("#lbImg").alt = "The image this search started from";
  $("#lbTitle").textContent = "The image this search started from";
  $("#lbMeta").textContent = meta;
  $("#lbLink").hidden = true; $("#lbLink").removeAttribute("href");
  $("#lightbox").hidden = false; $("#lbClose").focus();
}
function closeLightbox() {
  if ($("#lightbox").hidden) return;
  $("#lightbox").hidden = true; $("#lbImg").removeAttribute("src");
  lbReturn?.focus?.();
}

/* ===== Events ===== */
$("#diveBtn").addEventListener("click", () => { const n = getNote(); build(n.topic, n.notes, n.doc); });
$("#stopBtn").addEventListener("click", () => buildCtl?.abort());
$("#dClose").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
$("#lbClose").addEventListener("click", closeLightbox);
$("#lightbox").addEventListener("click", (ev) => { if (ev.target.id === "lightbox") closeLightbox(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { if (!$("#slash").hidden) return; if (effortOpen()) { closeEffort(true); return; } if ($("#keys").open) $("#keys").open = false; else if ($("#saved")?.open) closeSaved(); else if (!$("#lightbox").hidden) closeLightbox(); else if (!$("#drawer").hidden) closeDrawer(); else if (chatOpen() && !chatCtl) closeChat(); } });
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a.cite");
  if (!a) return;
  ev.preventDefault();
  let el = document.getElementById("src-" + a.dataset.cite);
  if (el?.hidden) { state.allSources = true; renderSources(); el = document.getElementById("src-" + a.dataset.cite); }
  if (!el) return;
  closeDrawer();
  if (window.innerWidth < 1240) closeChat();
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1800);
});

$("#srcMore").addEventListener("click", () => { state.allSources = true; renderSources(); });
/* ===== Keys panel ===== */
function openKeys() { const d = $("#keys"); d.open = true; setTimeout(() => (userKeys.anthropic || server.claude ? (userKeys.exa || server.exa ? null : $("#kExa")) : $("#kAnthropic"))?.focus(), 0); }
function renderKeys(note = "") {
  $("#kAnthropic").value = userKeys.anthropic; $("#kExa").value = userKeys.exa;
  const own = server.claude && server.exa;
  $("#ownerOut").hidden = !server.owner;
  $("#keysIntro").textContent = server.owner
    ? "Owner mode is on for this browser, so searches use the site's keys. Keys you add here would be used instead."
    : own
    ? "This site has its own keys, so yours are optional. If you add them, searches run on your accounts instead. Keys stay in this browser and the server doesn't store them."
    : "Searches run on your own Anthropic and Exa accounts. Your keys stay in this browser and go to this site's server with each search, which passes them on and doesn't store them.";
  $("#keysDot").className = "kdot" + (canDive() ? " on" : "");
  $("#keysNote").textContent = note;
}
function refreshReady() {
  $("#diveBtn").disabled = state.busy || !canDive();
  renderChat();
  if (state.busy) return;
  const miss = missingKeys();
  if (!server.ok) return;
  if (miss.length) setStatus(`Add your ${miss.join(" and ")} API key${miss.length > 1 ? "s" : ""} under Keys to search. The example in Saved searches works without them.`);
  else setStatus("Ready.");
}
$("#keysForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  userKeys = { anthropic: $("#kAnthropic").value.trim(), exa: $("#kExa").value.trim() };
  try { localStorage.setItem(KKEY, JSON.stringify(userKeys)); } catch {}
  renderKeys(userKeys.anthropic || userKeys.exa ? "Saved in this browser." : "No keys saved."); refreshReady();
  if (canDive()) setTimeout(() => { $("#keys").open = false; }, 700);
});
$("#kForget").addEventListener("click", () => {
  userKeys = { anthropic: "", exa: "" };
  try { localStorage.removeItem(KKEY); } catch {}
  renderKeys("Keys removed from this browser."); refreshReady();
});
document.addEventListener("click", (ev) => { const d = $("#keys"); if (d.open && !d.contains(ev.target)) d.open = false; });
try { localStorage.removeItem("iceberg-sounder.access"); } catch {}
$("#ownerOut").addEventListener("click", async () => {
  await fetch("/api/owner", { method: "DELETE" }).catch(() => {});
  await checkHealth(); renderKeys("Owner mode is off for this browser.");
});

/* ===== Boot ===== */
renderAll();
setStatus("Checking the server…");
$("#diveBtn").disabled = true;
/* An owner link (/#owner=SECRET) turns on owner mode for this browser. The
   secret is in the fragment so it never reaches request logs. */
async function claimOwner() {
  const m = location.hash.match(/^#owner=(.+)$/);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  const r = await fetch("/api/owner", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: decodeURIComponent(m[1]) }) }).catch(() => null);
  return !!r?.ok;
}
function checkHealth() {
  return fetch("/api/health", { cache: "no-store" }).then((r) => r.json()).then((hl) => {
    Object.assign(server, { ok: true, claude: !!hl.claude, exa: !!hl.exa, commons: !!hl.commons, owner: !!hl.owner });
    renderKeys(); refreshReady();
  }).catch(() => setStatus("Couldn't reach the server. Start it with npm start.", "err"));
}
async function bootOwner() {
  const claimed = await claimOwner();
  await checkHealth();
  if (claimed === true && server.owner) setStatus("Owner mode is on: this browser now searches with the site's keys.");
  else if (claimed === false) setStatus("That owner link isn't valid.", "err");
}
bootOwner();
window.addEventListener("hashchange", () => { if (location.hash.startsWith("#owner=")) bootOwner(); });
