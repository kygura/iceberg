import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, parseImage } from "../server.mjs";
import { fakeDeps } from "./fakes.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A stand-in for the built dist/ so the tests do not depend on `npm run build`.
const staticDir = mkdtempSync(path.join(tmpdir(), "iceberg-static-"));
mkdirSync(path.join(staticDir, "assets"));
writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>Iceberg Sounder</title>");
writeFileSync(path.join(staticDir, "assets", "app-abc123.js"), "export {};");

let srv, base;
before(async () => {
  srv = createApp(fakeDeps().deps, { staticDir });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); rmSync(staticDir, { recursive: true, force: true }); });

test("health reports configured services", async () => {
  const r = await fetch(base + "/api/health");
  const j = await r.json();
  assert.equal(j.claude, true);
  assert.equal(j.exa, true);
});

test("serves the page with a CSP that allows video embeds", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /frame-src https:\/\/www\.youtube-nocookie\.com/);
  assert.match(await r.text(), /Iceberg Sounder/);
});

test("hashed assets are cached as immutable, other files are not", async () => {
  const a = await fetch(base + "/assets/app-abc123.js");
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal((await fetch(base + "/")).headers.get("cache-control"), null);
});

test("blocks path traversal and unknown files", async () => {
  for (const p of ["/../server.mjs", "/%2e%2e/server.mjs", "/package.json", "/nope.js"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
  }
});

test("rejects an empty topic", async () => {
  const r = await fetch(base + "/api/dive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "  " }) });
  assert.equal(r.status, 400);
});

test("streams a full dive as NDJSON", async () => {
  const r = await fetch(base + "/api/dive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "test", depth: "quick" }) });
  assert.equal(r.status, 200);
  const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "status");
  assert.equal(lines.at(-1).type, "done");
});

test("media endpoint returns items for one entry", async () => {
  const r = await fetch(base + "/api/media", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "T", term: "Thing" }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.items.length >= 2);
});

async function withApp(env, fn) {
  const s = createApp(fakeDeps().deps, { env });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${s.address().port}`); } finally { s.close(); }
}
const post = (u, body, headers = {}) => fetch(u, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function withHandlerApp(deps, opts, fn) {
  const s = createApp(deps, opts);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${s.address().port}`); } finally { s.close(); }
}
const noServerKeys = () => { const { deps } = fakeDeps(); return { ...deps, claude: { ...deps.claude, configured: false }, exa: { ...deps.exa, configured: false } }; };

test("without server keys, searches need the visitor's keys", async () => {
  await withHandlerApp(noServerKeys(), { env: {} }, async (b) => {
    const h = await (await fetch(b + "/api/health")).json();
    assert.equal(h.claude, false); assert.equal(h.byok, true);
    const r = await post(b + "/api/media", { topic: "T", term: "x" });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.error.code, "keys_needed");
    assert.deepEqual(j.error.missing, ["Anthropic", "Exa"]);
  });
});

test("a visitor's keys build clients for that request only", async () => {
  const seen = [];
  const { deps } = fakeDeps();
  const opts = { env: {}, makeClaude: (k) => { seen.push(["claude", k]); return deps.claude; }, makeExa: (k) => { seen.push(["exa", k]); return deps.exa; } };
  await withHandlerApp(noServerKeys(), opts, async (b) => {
    const r = await post(b + "/api/dive", { topic: "T", depth: "quick" }, { "x-anthropic-key": "sk-ant-test-123456", "x-exa-key": "exa-test-123456" });
    assert.equal(r.status, 200);
    const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).type, "done");
    assert.deepEqual(seen, [["claude", "sk-ant-test-123456"], ["exa", "exa-test-123456"]]);
    assert.equal((await post(b + "/api/media", { topic: "T", term: "x" }, { "x-anthropic-key": "bad key with spaces" })).status, 400);
  });
});

test("one visitor key plus the server's other key is enough", async () => {
  const { deps } = fakeDeps();
  const half = { ...deps, claude: { ...deps.claude, configured: false } };
  await withHandlerApp(half, { env: {}, makeClaude: () => deps.claude }, async (b) => {
    const r1 = await post(b + "/api/media", { topic: "T", term: "x" });
    assert.deepEqual((await r1.json()).error.missing, ["Anthropic"]);
    assert.equal((await post(b + "/api/media", { topic: "T", term: "x" }, { "x-anthropic-key": "sk-ant-test-123456" })).status, 200);
  });
});

test("on Vercel the server's keys stay private unless ALLOW_PUBLIC=1", async () => {
  await withApp({ VERCEL: "1" }, async (b) => {
    const h = await (await fetch(b + "/api/health")).json();
    assert.equal(h.claude, false); assert.equal(h.exa, false);
    assert.equal((await post(b + "/api/dive", { topic: "T" })).status, 401);
  });
  await withApp({ VERCEL: "1", ALLOW_PUBLIC: "1" }, async (b) => {
    assert.equal((await (await fetch(b + "/api/health")).json()).claude, true);
    assert.equal((await post(b + "/api/media", { topic: "T", term: "x" })).status, 200);
  });
});

test("a rejected visitor key points at the Keys panel, not .env", async () => {
  const { deps } = fakeDeps();
  const { AppError } = await import("../lib/errors.mjs");
  const badExa = { ...deps.exa, search: async () => { throw new AppError("exa_auth", "Exa rejected the API key. Check EXA_API_KEY in your .env file.", { fatal: true }); } };
  await withHandlerApp(noServerKeys(), { env: {}, makeClaude: () => deps.claude, makeExa: () => badExa }, async (b) => {
    const r = await post(b + "/api/media", { topic: "T", term: "x" }, { "x-anthropic-key": "sk-ant-test-123456", "x-exa-key": "exa-test-123456" });
    const j = await r.json();
    assert.match(j.error.message, /under Keys/);
  });
});

test("handler accepts a body the runtime already parsed", async () => {
  const { createHandler } = await import("../server.mjs");
  const handler = createHandler(fakeDeps().deps, { env: {} });
  const out = { status: 0, body: "" };
  const res = { headersSent: false, writeHead(s) { out.status = s; this.headersSent = true; }, end(b) { out.body = String(b); }, on() {} };
  await handler({ method: "POST", url: "/api/media", headers: {}, body: { topic: "T", term: "x" } }, res);
  assert.equal(out.status, 200);
  assert.ok(JSON.parse(out.body).items.length);
});

test("owner link: the secret sets a cookie that unlocks the server's keys on Vercel", async () => {
  const env = { VERCEL: "1", OWNER_SECRET: "owner-secret-0123456789" };
  await withApp(env, async (b) => {
    assert.equal((await (await fetch(b + "/api/health")).json()).claude, false);
    assert.equal((await post(b + "/api/owner", { secret: "wrong-secret-000000000" })).status, 401);
    const r = await post(b + "/api/owner", { secret: env.OWNER_SECRET });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie");
    assert.match(cookie, /^ice_owner=[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/);
    assert.doesNotMatch(cookie, /owner-secret/, "the cookie holds a derived token, not the secret");
    const jar = { cookie: cookie.split(";")[0] };
    const h = await (await fetch(b + "/api/health", { headers: jar })).json();
    assert.equal(h.owner, true); assert.equal(h.claude, true);
    assert.equal((await post(b + "/api/media", { topic: "T", term: "x" }, jar)).status, 200);
    assert.equal((await post(b + "/api/media", { topic: "T", term: "x" }, { cookie: "ice_owner=forged" })).status, 401);
    const out = await fetch(b + "/api/owner", { method: "DELETE", headers: jar });
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  });
  await withApp({ VERCEL: "1" }, async (b) => {
    assert.equal((await post(b + "/api/owner", { secret: "anything-at-all-123" })).status, 401, "no OWNER_SECRET, no owner mode");
  });
});

test("chat needs only an Anthropic key and checks the conversation's shape", async () => {
  const { deps } = fakeDeps();
  const half = { ...deps, exa: { ...deps.exa, configured: false } };
  await withHandlerApp(half, { env: {} }, async (b) => {
    const ok = await post(b + "/api/chat", { topic: "T", digest: "TOPIC: T", messages: [{ role: "user", text: "What is known?" }] });
    assert.equal(ok.status, 200, "no Exa key needed");
    const lines = (await ok.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.type === "text"));
    assert.equal(lines.at(-1).type, "done");
    const noDigest = await post(b + "/api/chat", { topic: "T", digest: "", messages: [{ role: "user", text: "Q" }] });
    assert.equal(noDigest.status, 400);
    const endsOnBot = await post(b + "/api/chat", { topic: "T", digest: "D", messages: [{ role: "user", text: "Q" }, { role: "assistant", text: "A" }] });
    assert.equal(endsOnBot.status, 400);
    const twoUsers = await post(b + "/api/chat", { topic: "T", digest: "D", messages: [{ role: "user", text: "Q" }, { role: "user", text: "Q2" }] });
    assert.equal(twoUsers.status, 400);
  });
  await withHandlerApp(noServerKeys(), { env: {} }, async (b) => {
    const r = await post(b + "/api/chat", { topic: "T", digest: "D", messages: [{ role: "user", text: "Q" }] });
    assert.equal(r.status, 401);
    assert.deepEqual((await r.json()).error.missing, ["Anthropic"]);
  });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");

test("parseImage takes the type from the file's bytes and rejects junk", () => {
  assert.deepEqual(parseImage(null), { image: null });
  assert.equal(parseImage({ media_type: "image/png", data: JPEG }).image.media_type, "image/jpeg", "client's type is ignored");
  assert.equal(parseImage("data:image/png;base64," + PNG).image.media_type, "image/png");
  assert.ok(parseImage({ data: Buffer.from("GIF89a-ish").toString("base64") }).image, "gif");
  assert.ok(parseImage({ data: Buffer.from("<svg></svg>").toString("base64") }).error, "svg is refused");
  assert.ok(parseImage({ data: "not base64!" }).error);
  assert.ok(parseImage({ data: "A".repeat(4_000_004) }).error, "too large");
});

test("a dive can start from an image alone", async () => {
  const r = await fetch(base + "/api/dive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "", depth: "quick", image: { media_type: "image/jpeg", data: JPEG } }) });
  assert.equal(r.status, 200);
  const events = (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
  const plan = events.find((e) => e.type === "plan");
  assert.equal(plan.title, "Pictured Lighthouse");
  assert.ok(plan.reading);
  assert.equal(events.at(-1).type, "done");
});

test("a bad image is refused before any work starts", async () => {
  const r = await fetch(base + "/api/dive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "x", image: { data: Buffer.from("hello").toString("base64") } }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "bad_image");
});
