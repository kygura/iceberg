// Turns an iceberg into the compact text the chat sidebar sends to Claude:
// every level and entry with its confidence and citations, any "Dig deeper"
// write-ups, and the source list. Shared by the browser and the tests.
import { ZONES } from "./zones.js";
import { tierOf, labelOf } from "./provenance.js";

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const flat = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * Builds the digest. If it runs past maxChars, source excerpts are shortened
 * first, then the Dig deeper write-ups, so the entries themselves always fit.
 */
export function digestOf(ice, { maxChars = 120000 } = {}) {
  const build = (excerptChars, longChars) => {
    const out = [`TOPIC: ${flat(ice.title || ice.topic)}`];
    if (ice.summary) out.push(`OVERVIEW: ${flat(ice.summary)}`);
    if (ice.notes) out.push(`RESEARCHER'S NOTES: ${flat(ice.notes)}`);
    ice.layers.forEach((l) => {
      const z = ZONES.find((x) => x.key === l.key);
      if (!z) return;
      out.push("", `LEVEL ${z.level}: ${z.name} (${z.label})${l.theme ? ". Theme: " + flat(l.theme) : ""}`);
      if (!l.entries.length) { out.push(l.missing ? "(not charted in this saved search)" : "(no entries)"); return; }
      for (const e of l.entries) {
        const cites = e.sources.map((id) => `[${id}]`).join("");
        out.push(`- ${flat(e.term)} (${e.confidence || "established"}) ${cites}: ${flat(e.summary)} ${flat(e.detail)}`.trim());
        if (e.deep?.text && longChars > 0) {
          const t = flat(e.deep.text);
          out.push(`  Dig deeper write-up: ${t.length > longChars ? t.slice(0, longChars) + "..." : t}`);
        }
      }
    });
    out.push("", "SOURCES (number, title, site, closeness to the original record, date, excerpt)");
    for (const s of [...ice.sources].sort((a, b) => a.id - b.id)) {
      const ex = excerptChars > 0 ? flat(s.excerpt).slice(0, excerptChars) : "";
      out.push(`[${s.id}] ${flat(s.title) || host(s.url)} | ${host(s.url)} | ${labelOf(s.tier || tierOf(s.url))}${s.date ? " | " + String(s.date).slice(0, 10) : ""}${ex ? " | " + ex : ""}`);
    }
    return out.join("\n");
  };
  for (const [ex, long] of [[280, 4000], [160, 2000], [80, 800], [0, 300], [0, 0]]) {
    const text = build(ex, long);
    if (text.length <= maxChars) return text;
  }
  return build(0, 0).slice(0, maxChars);
}

/** Counts shown in the sidebar header. */
export const digestStats = (ice) => ({
  levels: ice.layers.filter((l) => l.entries.length).length,
  entries: ice.layers.reduce((n, l) => n + l.entries.length, 0),
  sources: ice.sources.length,
});
