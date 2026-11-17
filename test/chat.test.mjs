import { test } from "node:test";
import assert from "node:assert/strict";
import { runChat, chatSystem } from "../lib/pipeline.mjs";
import { digestOf } from "../public/digest.js";
import { ZONES } from "../public/zones.js";
import { fakeDeps } from "./fakes.mjs";

const ice = {
  title: "Test topic", topic: "test topic", summary: "An overview.", notes: "Focus on records.",
  sources: [
    { id: 2, title: "Commission report", url: "https://www.archives.gov/report", date: "1964-09-24", excerpt: "The official report." },
    { id: 1, title: "A blog post", url: "https://example.org/post", excerpt: "x".repeat(2000) },
  ],
  layers: ZONES.map((z, i) => ({
    key: z.key, theme: `${z.name} theme`,
    entries: i === 5 ? [] : [{ term: `${z.name} fact`, summary: "Summary.", detail: "Detail.", sources: [2, 1], confidence: i === 6 ? "speculative" : "established",
      ...(i === 0 ? { deep: { text: "Long write-up. ".repeat(400) } } : {}) }],
  })),
};

test("the digest carries every level, entry, citation and source", () => {
  const d = digestOf(ice);
  for (const z of ZONES) assert.match(d, new RegExp(`LEVEL ${z.level}: ${z.name}`));
  assert.match(d, /- Above water fact \(established\) \[2\]\[1\]: Summary\. Detail\./);
  assert.match(d, /The trench fact \(speculative\)/);
  assert.match(d, /\(no entries\)/);
  assert.match(d, /Dig deeper write-up: Long write-up/);
  assert.match(d, /\[2\] Commission report \| archives\.gov \| Official record \| 1964-09-24/);
  assert.ok(d.indexOf("[1] A blog post") < d.indexOf("[2] Commission report"), "sources in number order");
  assert.match(d, /RESEARCHER'S NOTES: Focus on records\./);
});

test("a long digest shrinks excerpts and write-ups before entries", () => {
  const full = digestOf(ice);
  const small = digestOf(ice, { maxChars: 2000 });
  assert.ok(small.length <= 2000 && small.length < full.length);
  for (const z of ZONES) if (z.key !== "hadal") assert.match(small, new RegExp(`${z.name} fact`), "every entry survives");
  assert.doesNotMatch(small, /xxxxxxxxxx/, "excerpts went first");
});

test("chat sends the digest as a system prompt and the conversation as turns", async () => {
  const { deps, calls } = fakeDeps();
  const events = [];
  const messages = [{ role: "user", text: "First?" }, { role: "assistant", text: "Answer." }, { role: "user", text: "Second?" }];
  await runChat({ topic: "Test topic", digest: "THE DIGEST", messages, depth: "quick", emit: (e) => events.push(e), signal: new AbortController().signal, deps });
  const sent = calls.streamPrompts.at(-1);
  assert.match(sent.system, /THE DIGEST/);
  assert.match(sent.system, /\[\[/, "asks for entry links");
  assert.deepEqual(sent.messages, [{ role: "user", content: "First?" }, { role: "assistant", content: "Answer." }, { role: "user", content: "Second?" }]);
  assert.ok(events.some((e) => e.type === "text"));
  assert.equal(events.at(-1).type, "done");
  assert.match(chatSystem("X", "D"), /untrusted/);
});
