# Iceberg Sounder

Live at **https://iceberg.nca.ink**

Name a research topic and get an iceberg chart: seven levels from common knowledge down to contested claims, with 60 to 80 entries in a full dive, built from live web search, with every entry citing its sources. Images and video live with the entries they show:

- **Each level** shows a strip of its entries' pictures and videos.
- **Each entry** opens a modal with a media stage (videos play inline through YouTube's privacy-enhanced player or Vimeo; images open full size), a filmstrip of everything attached, then the text and sources.
- **Images** come from the cited pages' preview images and from Wikimedia Commons, with author and license shown.

## Run it

Needs Node 20 or later.

```bash
npm install
cp .env.example .env   # then add ANTHROPIC_API_KEY and EXA_API_KEY
npm start              # http://localhost:3000
```

The page opens on a blank note. Write the topic as the title and, if you like, notes underneath to steer the research (an angle, a period, sources to favor or skip). The notes are a [Tiptap](https://tiptap.dev) editor: Markdown shortcuts (`## `, `- `, `1. `, `> `, `**bold**`) work as you type, selecting text shows a formatting bar, and `/` opens a menu of blocks and actions (research now, set the effort, open the example, start a new search). Claude receives the notes as Markdown. Press Ctrl+Enter (⌘+Enter on a Mac) or **Research** to start.

## Starting from an image

Paste an image anywhere on the note (or drop it on the note, or use **Image** or `/image`), and Claude researches what it shows. The title is optional: leave it blank and Claude names the topic from the image; type one and the image narrows it. Notes still steer the angle.

The browser downscales the image to a JPEG, 1568 px on the long edge, and sends it with the dive. It goes to Claude only in the planning call, which now also returns `image_reading`: two to four sentences on what the image shows, how sure the identification is, and what angle the research takes. That reading is added to the notes for every later lead and chart prompt, so all seven levels stay tied to the image, and it appears above the chart as **What Claude saw in the image**. Claude is told not to identify private individuals from their faces.

The server reads the image type from the file's own header bytes (JPEG, PNG, GIF or WebP) and refuses anything over about 3 MB. The saved iceberg keeps a 240 px thumbnail in localStorage and the 1568 px copy in IndexedDB, which is dropped when the iceberg is deleted or falls off the saved list. Clicking either thumbnail (on the note or above the chart) opens that copy in the image viewer. The chat digest includes the reading. An image search costs the same number of calls as a text one, plus the image's input tokens on the planning call (about 1,600 for a full-size image).

Past searches and a pre-built example (the Voynich manuscript) are in the **Saved searches** menu, so you can look around before adding keys.

## The levels

| | Level | Depth | What goes there |
|---|---|---|---|
| 1 | Above water | +10 m | What everyone has heard |
| 2 | The waterline | 0 m | The standard account |
| 3 | The shallows | 50 m | What enthusiasts know: people, dates, terms, side stories |
| 4 | Deep water | 200 m | What specialists argue about |
| 5 | The archive floor | 1,000 m | What the records say: filings, patents, letters, data |
| 6 | The abyss | 4,000 m | What got forgotten: overlooked incidents, minor figures, lost items |
| 7 | The trench | 11,000 m | What nobody can settle: fringe theories, disputes, open questions |

Entries get smaller and quieter level by level. Searches saved before level 6 existed open with that level marked as missing.

## How a dive works

1. Claude (`claude-opus-5-5`) reads the topic and your notes and plans five search queries for each level, each after a different angle (at least two aimed at official records or primary documents), one search for the topic's official records, plus searches for videos, image-rich pages, papers and Commons images.
2. The server runs them through Exa and streams results to the browser as they arrive.
3. Claude reads each level's first-round results and lists 4 to 6 leads they point toward (a named person, a court filing, a patent, an incident) that the results don't cover yet. Those get a second round of searches. Quick dives skip this round.
4. Claude charts each level from both rounds plus the topic's official records, using structured output: 6 to 8 entries at the top, up to 12 further down. Entries that cite nothing are dropped.

Sources are ranked by how close they are to the original (`public/provenance.js`): official records (government, courts, legislation, patents), then archives, libraries and museums, scholarship, reference works, press, other sites, and video last. Claude is told to cite the closest source, and the server sorts each entry's citations by that rank. Media follows the same order: document scans and archival photos before decorative images, official or archival footage before other video.
5. **Dig deeper** on an entry fetches the cited pages in full and streams a longer write-up with citations and follow-up topics.

## Asking about the findings

Once a level is charted, **Ask about the findings** opens a sidebar chat. Each question sends Claude a digest of the iceberg (`public/digest.js`): every level and entry with its confidence and cited source numbers, any Dig deeper write-ups, and the source list with titles, sites, provenance labels and short excerpts. The Voynich example's digest is about 13,000 characters (29 entries, 19 sources); a full dive with 70 entries and 150 sources comes to roughly 90,000. Above 120,000, excerpts and write-ups are shortened before any entry is cut. The digest goes in a cached system prompt, so follow-up questions in the same conversation reuse it.

Claude answers from the digest, cites sources as [n], and links entries it mentions; clicking one opens that entry. It says when the findings don't cover a question and points to Dig deeper or a new iceberg. The chat needs only an Anthropic key, and each conversation is saved with its iceberg.

The Quick / Thorough / Deepest setting maps to Claude's `low` / `medium` / `high` effort. Requests use the API's server-side refusal fallback, so a declined request is retried on a fallback model instead of failing.

## Cost

A dive makes 15 Claude calls (1 plan, 7 lead lists at low effort, 7 charts) and up to about 80 Exa searches; a Quick dive skips the lead lists and makes 8 calls and about 40 searches. A deep dive makes 1 Claude call plus a page fetch of up to 5 sources. Every dive is billed to whichever keys it runs on. The server listens on 127.0.0.1 by default.

## Keys

Visitors can bring their own keys: the **Keys** panel stores an Anthropic and an Exa key in the browser and sends them as `x-anthropic-key` and `x-exa-key` headers with each search. The server builds clients from them for that request only and doesn't store or log them. A visitor can bring one key and use the server's other one, where the server's keys are available.

Running locally, the server's own keys from `.env` are used when a visitor brings none.

## Deploy on Vercel

The repo deploys as-is: `public/` is served statically and each file in `api/` is a function using the same handler as `server.mjs`. No environment variables are required: visitors search with their own keys. Optional ones:

| Variable | |
|---|---|
| `ANTHROPIC_API_KEY`, `EXA_API_KEY` | the server's own keys, used for owner-mode browsers or with `ALLOW_PUBLIC=1` |
| `OWNER_SECRET` | 16+ characters. Open `https://your-site/#owner=SECRET` once per browser and that browser searches on the server's keys from then on |
| `ALLOW_PUBLIC` | `1` lets visitors without keys search on the server's keys, at your cost |
| `WIKIMEDIA_CONTACT` | an email or URL; turns on Commons images |

On Vercel the server's keys are never used unless `ALLOW_PUBLIC=1`, so a public URL can't spend your credits by accident. For yourself, set `OWNER_SECRET` and open the owner link once on each browser you use: an HttpOnly cookie (an HMAC of the secret, not the secret itself) then marks that browser, and the secret travels in the URL fragment so it never reaches request logs. The Keys panel has a link to leave owner mode.

## Layout

```
server.mjs          HTTP server: static files, /api/dive (topic and/or image), /api/deep and /api/chat (NDJSON streams), /api/health
lib/pipeline.mjs    dive and deep-dive orchestration, prompts
public/editor.js    the notes editor (Tiptap), Markdown export
public/digest.js    the compact text of an iceberg that the chat sends to Claude
public/vendor/      prebuilt Tiptap bundle; regenerate with `npm run vendor`
lib/claude.mjs      Anthropic SDK calls and output schemas
lib/exa.mjs         Exa search and page contents
lib/commons.mjs     Wikimedia Commons image search
public/             the page (no build step)
test/               node:test suites; fakes stand in for Claude, Exa and Commons
```

`npm test` runs everything offline.
