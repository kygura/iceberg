// Shared by the server (prompts) and the browser (drawing). Levels are fixed,
// ordered from what everyone knows down to what nobody can settle.
// Keys stay stable across versions so older saved searches still line up;
// `hadal` was added later, between the archives and the contested claims.
//   name    the level's name on the chart
//   depth   the depth marker printed beside it
//   label   who knows this, in a few words
//   brief   what belongs here (sent to Claude)
//   count   how many entries Claude is asked for: [min, max]
export const ZONES = [
  { key: "tip", level: 1, name: "Above water", depth: "+10 m", label: "What everyone has heard",
    brief: "common knowledge: what most people have heard, the headline facts, the image the topic calls to mind",
    count: [6, 8] },
  { key: "waterline", level: 2, name: "The waterline", depth: "0 m", label: "The standard account",
    brief: "the standard account a newcomer reads in an encyclopedia entry, a documentary or a long article",
    count: [8, 10] },
  { key: "twilight", level: 3, name: "The shallows", depth: "50 m", label: "What enthusiasts know",
    brief: "enthusiast knowledge: named people, dates, places, technical terms, lesser-known episodes and side stories",
    count: [10, 12] },
  { key: "midnight", level: 4, name: "Deep water", depth: "200 m", label: "What specialists argue about",
    brief: "specialist and scholarly detail: methods, findings, debates in the literature, technical specifics",
    count: [10, 12] },
  { key: "abyss", level: 5, name: "The archive floor", depth: "1,000 m", label: "What the records say",
    brief: "primary sources: archival documents, official records, court filings, patents, letters, original data and what they show",
    count: [8, 12] },
  { key: "hadal", level: 6, name: "The abyss", depth: "4,000 m", label: "What got forgotten",
    brief: "obscure and forgotten material: overlooked incidents, minor figures, lost or destroyed items, retracted claims, footnotes few people have read",
    count: [8, 12] },
  { key: "trench", level: 7, name: "The trench", depth: "11,000 m", label: "What nobody can settle",
    brief: "contested ground: fringe theories, disputed claims, hoaxes, unresolved questions and what each side points to",
    count: [8, 12] },
];
export const LEVELS = ZONES.length;
