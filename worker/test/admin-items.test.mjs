// Admin content-management API tests: the real Worker (worker/src/index.js)
// against a real SQLite database built from the migrations + production seed
// (support/sqliteD1.mjs). Run: npm run test:worker
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { clearSigningKeyCache } from "../src/access.js";
import worker from "../src/index.js";
import { ADMIN, AUD, CERTS_URL, createSigningKey, signToken, SITE, TEAM, validClaims } from "./helpers.mjs";
import { createTestDb } from "./support/sqliteD1.mjs";

const trusted = await createSigningKey("trusted-kid");
const attacker = await createSigningKey("trusted-kid");
const ROOT = new URL("../../", import.meta.url);
const ITEMS_JSON = JSON.parse(readFileSync(new URL("src/content/items.json", ROOT), "utf8"));
const bodyOf = (slug) => JSON.parse(readFileSync(new URL(`src/content/bodies/${slug}.json`, ROOT), "utf8")).blocks;
const TODAY = new Date().toISOString().slice(0, 10);

let db;
let env;
const realFetch = globalThis.fetch;
beforeEach(() => {
  clearSigningKeyCache();
  db = createTestDb();
  env = { ALLOWED_ORIGINS: SITE, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAIL: ADMIN, SITE_URL: `${SITE}/`, DB: db };
  globalThis.fetch = async (url, init) =>
    String(url) === CERTS_URL ? new Response(JSON.stringify({ keys: [trusted.jwk] })) : realFetch(url, init);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------ helpers */

async function call(path, { method = "GET", body, token = "good", origin = SITE, headers = {} } = {}) {
  const h = { ...headers };
  if (token === "good") h["Cf-Access-Jwt-Assertion"] = await signToken(validClaims(), trusted);
  else if (token) h["Cf-Access-Jwt-Assertion"] = token;
  if (origin) h.Origin = origin;
  if (body !== undefined && !("Content-Type" in h)) h["Content-Type"] = "application/json";
  const init = { method, headers: h };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await worker.fetch(new Request(`https://api.library.mh-ibrahim.com${path}`, init), env);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, headers: response.headers, data };
}
const publicGet = (path) => call(path, { token: null, origin: null });
const rawRow = (id) => {
  const row = db.raw.prepare("SELECT * FROM items WHERE id = ?").get(id);
  return row ? { ...row } : null;
};
const count = (sql) => Number(db.raw.prepare(sql).get().n);
const history = (id) => db.raw.prepare("SELECT revision, action, changed_by, changed_at, note, snapshot_json FROM revisions WHERE entity_type = 'item' AND entity_id = ? ORDER BY revision").all(id).map((r) => ({ ...r }));

async function assertPublicHides(slug, id) {
  const list = await publicGet("/api/items");
  assert.ok(!list.data.some((i) => i.id === id || i.slug === slug), "draft must not be in /api/items");
  const library = await publicGet("/api/library");
  assert.ok(!library.data.items.some((i) => i.id === id), "draft must not be in /api/library");
  assert.equal((await publicGet(`/api/items/${slug}`)).status, 404, "draft slug must be 404");
}

const ARTICLE = {
  type: "article",
  categoryId: "cat_science",
  language: "en",
  title: "How Tides Work",
  description: "The Moon, the Sun and the oceans.",
  tags: ["physics", "ocean"],
  blocks: [
    { id: "b01", type: "paragraph", text: "Tides rise and fall **twice** a day, see [NASA](https://science.nasa.gov/)." },
    { id: "b02", type: "heading", level: 2, text: "Why twice?" },
    { id: "b03", type: "list", ordered: false, items: ["The Moon", "The Sun"] },
    { id: "b04", type: "details", summary: "More", blocks: [{ id: "b04a", type: "code", language: "shell", text: "echo tides" }] },
  ],
};
const ARABIC = {
  type: "article",
  categoryId: "cat_thoughts",
  language: "ar",
  title: "لماذا نكتب؟",
  description: "تأملات قصيرة في الكتابة، مع رقم ٣ وكلمة English.",
  tags: ["كتابة", "تأمل"],
  blocks: [
    { id: "b01", type: "paragraph", text: "الكتابة طريقة **للتفكير** ببطء — 🙂" },
    { id: "b02", type: "quote", text: "اكتب لتعرف ما تفكر فيه." },
    { id: "b03", type: "list", ordered: true, items: ["أولًا", "ثانيًا"] },
  ],
};
const PDF = { type: "pdf", categoryId: "cat_other", language: "en", title: "Field Notes", fileUrl: "documents/gradient-descent-lecture-notes.pdf", pageCount: 2 };
const VIDEO = { type: "youtube", categoryId: "cat_interesting_finds", language: "en", title: "A Good Talk", videoUrl: "https://youtu.be/UF8uR6Z6KLc" };
const LINK = {
  type: "link",
  categoryId: "cat_science",
  language: "en",
  title: "NASA Image of the Day",
  url: "https://www.nasa.gov/image-of-the-day/",
  links: [{ label: "NASA", url: "https://www.nasa.gov/" }],
};
const create = (item) => call("/api/admin/items", { method: "POST", body: item });

/* ------------------------------------------------------------ authentication and request guards */

describe("authentication and request guards", () => {
  const ROUTES = [
    ["GET", "/api/admin/items"],
    ["POST", "/api/admin/items", ARTICLE],
    ["GET", "/api/admin/items/itm_fermi_problems"],
    ["PATCH", "/api/admin/items/itm_fermi_problems", { revision: 1, title: "x" }],
    ["DELETE", "/api/admin/items/itm_fermi_problems", { revision: 1 }],
    ["POST", "/api/admin/items/itm_fermi_problems/publish", { revision: 1 }],
    ["POST", "/api/admin/items/itm_fermi_problems/unpublish", { revision: 1 }],
    ["POST", "/api/admin/items/itm_fermi_problems/restore", { revision: 1, fromRevision: 1 }],
    ["GET", "/api/admin/items/itm_fermi_problems/revisions"],
    ["GET", "/api/admin/items/itm_fermi_problems/revisions/1"],
    ["GET", "/api/admin/deleted-items"],
  ];

  test("every admin route refuses a missing, forged, other-email or other-application token (401) and changes nothing", async () => {
    const bad = [
      ["no token", null],
      ["forged (attacker key, real kid)", await signToken(validClaims(), attacker)],
      ["another Google account", await signToken(validClaims({ email: "someone@example.com" }), trusted)],
      ["another Access application", await signToken(validClaims({ aud: ["b".repeat(64)] }), trusted)],
      ["expired", await signToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 5 }), trusted)],
    ];
    for (const [method, path, body] of ROUTES) {
      for (const [label, token] of bad) {
        const res = await call(path, { method, body, token });
        assert.equal(res.status, 401, `${label}: ${method} ${path}`);
        assert.deepEqual(res.data, { error: "Unauthorized" });
      }
    }
    assert.equal(count("SELECT count(*) n FROM items"), 13);
    assert.equal(count("SELECT count(*) n FROM revisions"), 18);
    assert.equal(rawRow("itm_fermi_problems").title, "Fermi Problems");
  });

  test("CSRF: writes need the site's Origin; cross-site and missing Origin are refused (403)", async () => {
    for (const origin of [null, "https://evil.example", "https://library.mh-ibrahim.com.evil.com", "http://library.mh-ibrahim.com"]) {
      for (const [method, path, body] of [
        ["POST", "/api/admin/items", ARTICLE],
        ["PATCH", "/api/admin/items/itm_fermi_problems", { revision: 1, title: "CSRF" }],
        ["DELETE", "/api/admin/items/itm_fermi_problems", { revision: 1 }],
        ["POST", "/api/admin/items/itm_fermi_problems/unpublish", { revision: 1 }],
      ]) {
        const res = await call(path, { method, body, origin });
        assert.equal(res.status, 403, `${method} ${path} from ${origin}`);
        assert.equal(res.data.code, "forbidden_origin");
      }
    }
    const crossSite = await call("/api/admin/items", { method: "POST", body: ARTICLE, headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    assert.equal(count("SELECT count(*) n FROM items"), 13);
    assert.equal(count("SELECT count(*) n FROM revisions"), 18);
    assert.deepEqual({ ...rawRow("itm_fermi_problems") }, { ...rawRow("itm_fermi_problems"), title: "Fermi Problems", status: "published", revision: 1 });
    // The same write from the site is accepted.
    assert.equal((await call("/api/admin/items", { method: "POST", body: ARTICLE, headers: { "Sec-Fetch-Site": "same-site" } })).status, 201);
  });

  test("writes must be JSON (415), small (413) and well-formed (400)", async () => {
    const asText = await call("/api/admin/items", { method: "POST", body: JSON.stringify(ARTICLE), headers: { "Content-Type": "text/plain" } });
    assert.equal(asText.status, 415);
    const asForm = await call("/api/admin/items", { method: "POST", body: "title=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.equal(asForm.status, 415);
    const huge = await call("/api/admin/items", { method: "POST", body: { ...ARTICLE, description: "x".repeat(300 * 1024) } });
    assert.equal(huge.status, 413);
    const broken = await call("/api/admin/items", { method: "POST", body: "{not json" });
    assert.equal(broken.status, 400);
    assert.equal(broken.data.code, "bad_json");
    assert.equal(count("SELECT count(*) n FROM items"), 13);
  });

  test("preflight allows the write methods and Content-Type for the site only", async () => {
    const site = await call("/api/admin/items", { method: "OPTIONS", token: null });
    assert.equal(site.status, 204);
    assert.equal(site.headers.get("access-control-allow-methods"), "GET, HEAD, POST, PATCH, DELETE, OPTIONS");
    assert.equal(site.headers.get("access-control-allow-headers"), "Content-Type");
    const evil = await call("/api/admin/items", { method: "OPTIONS", token: null, origin: "https://evil.example" });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });

  test("unsupported methods -> 405 with Allow; admin responses are no-store with credentialed CORS", async () => {
    const put = await call("/api/admin/items", { method: "PUT", body: {} });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get("allow"), "GET, HEAD, POST");
    const list = await call("/api/admin/items");
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.equal(list.headers.get("access-control-allow-origin"), SITE);
    assert.equal(list.headers.get("access-control-allow-credentials"), "true");
  });
});

/* ------------------------------------------------------------ reading */

describe("reading (drafts included)", () => {
  test("GET /api/admin/items lists all 13 items with status and revision", async () => {
    const res = await call("/api/admin/items");
    assert.equal(res.status, 200);
    assert.equal(res.data.items.length, 13);
    assert.deepEqual(res.data.counts, { total: 13, published: 13, draft: 0 });
    assert.ok(res.data.items.every((i) => i.status === "published" && i.revision === 1 && !("blocks" in i)));
  });

  test("GET /api/admin/items/:id returns the item with its rich text", async () => {
    const res = await call("/api/admin/items/itm_rainbow");
    assert.equal(res.status, 200);
    const { status, revision, blocks, ...item } = res.data.item;
    assert.equal(status, "published");
    assert.equal(revision, 1);
    assert.ok(isDeepStrictEqual(item, ITEMS_JSON.find((i) => i.id === "itm_rainbow")));
    assert.ok(isDeepStrictEqual(blocks, bodyOf("how-a-rainbow-forms")));
  });

  test("unknown or malformed ids -> 404", async () => {
    assert.equal((await call("/api/admin/items/itm_does_not_exist")).status, 404);
    assert.equal((await call("/api/admin/items/itm_x';DROP TABLE items;--")).status, 404);
    assert.equal((await call("/api/admin/items/1")).status, 404);
  });
});

/* ------------------------------------------------------------ create */

describe("create", () => {
  test("an English article is created as a draft at revision 1 with a generated id and slug", async () => {
    const res = await create(ARTICLE);
    assert.equal(res.status, 201);
    const item = res.data.item;
    assert.match(item.id, /^itm_[a-z0-9]{16}$/);
    assert.equal(item.slug, "how-tides-work");
    assert.equal(item.status, "draft");
    assert.equal(item.revision, 1);
    assert.equal(item.readingMinutes, 1);
    assert.equal(item.addedAt, TODAY);
    assert.equal(item.updatedAt, TODAY);
    assert.ok(isDeepStrictEqual(item.blocks, ARTICLE.blocks));
    assert.deepEqual(item.tags, ARTICLE.tags);
    const h = history(item.id);
    assert.deepEqual(h.map((r) => [r.revision, r.action, r.changed_by]), [[1, "create", ADMIN]]);
    assert.match(h[0].changed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    await assertPublicHides(item.slug, item.id);
    assert.equal((await publicGet("/api/items")).data.length, 13);
  });

  test("Arabic text is stored and returned exactly; the slug falls back to item-xxxxxx", async () => {
    const res = await create(ARABIC);
    assert.equal(res.status, 201);
    const item = res.data.item;
    assert.match(item.slug, /^item-[a-z0-9]{6}$/);
    assert.equal(item.title, ARABIC.title);
    assert.equal(item.description, ARABIC.description);
    assert.deepEqual(item.tags, ARABIC.tags);
    assert.ok(isDeepStrictEqual(item.blocks, ARABIC.blocks));
    const again = await call(`/api/admin/items/${item.id}`);
    assert.equal(again.data.item.title, "لماذا نكتب؟");
    const snapshot = JSON.parse(history(item.id)[0].snapshot_json);
    assert.equal(snapshot.title, ARABIC.title);
    assert.ok(isDeepStrictEqual(JSON.parse(snapshot.body_json).blocks, ARABIC.blocks));
  });

  test("an explicit slug is used; Arabic items can have one too", async () => {
    const res = await create({ ...ARABIC, slug: "why-we-write" });
    assert.equal(res.status, 201);
    assert.equal(res.data.item.slug, "why-we-write");
  });

  test("PDF (site file and https URL), video and link items keep their type fields", async () => {
    const pdf = (await create(PDF)).data.item;
    assert.equal(pdf.fileUrl, "documents/gradient-descent-lecture-notes.pdf");
    assert.equal(pdf.pageCount, 2);
    assert.deepEqual(pdf.blocks, []);
    const remote = await create({ ...PDF, title: "Remote PDF", fileUrl: "https://example.org/paper.pdf", pageCount: null });
    assert.equal(remote.status, 201);
    assert.equal(remote.data.item.fileUrl, "https://example.org/paper.pdf");
    const video = (await create(VIDEO)).data.item;
    assert.equal(video.videoUrl, "https://youtu.be/UF8uR6Z6KLc");
    const link = (await create(LINK)).data.item;
    assert.equal(link.url, LINK.url);
    assert.deepEqual(link.links, LINK.links);
    assert.equal(link.readingMinutes, undefined);
  });

  test("a second item with the same title gets a unique slug", async () => {
    const first = (await create(ARTICLE)).data.item;
    const second = (await create(ARTICLE)).data.item;
    assert.equal(first.slug, "how-tides-work");
    assert.equal(second.slug, "how-tides-work-2");
    assert.notEqual(first.id, second.id);
  });

  test("an explicit slug already in use is refused (409) and nothing is overwritten", async () => {
    const res = await create({ ...ARTICLE, slug: "fermi-problems" });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, "slug_taken");
    assert.equal(rawRow("itm_fermi_problems").title, "Fermi Problems");
    assert.equal(count("SELECT count(*) n FROM items"), 13);
  });

  const invalid = [
    ["missing title", { ...ARTICLE, title: undefined }, "title"],
    ["empty title", { ...ARTICLE, title: "   " }, "title"],
    ["title over 200 characters", { ...ARTICLE, title: "x".repeat(201) }, "title"],
    ["title with a line break", { ...ARTICLE, title: "two\nlines" }, "title"],
    ["unknown category", { ...ARTICLE, categoryId: "cat_nope" }, "categoryId"],
    ["unknown language", { ...ARTICLE, language: "fr" }, "language"],
    ["tags not a list", { ...ARTICLE, tags: "physics" }, "tags"],
    ["21 tags", { ...ARTICLE, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, "tags"],
    ["tag over 40 characters", { ...ARTICLE, tags: ["x".repeat(41)] }, "tags"],
    ["duplicate tags", { ...ARTICLE, tags: ["a", "a"] }, "tags"],
    ["javascript: link", { ...ARTICLE, links: [{ label: "x", url: "javascript:alert(1)" }] }, "links"],
    ["link with an extra key", { ...ARTICLE, links: [{ label: "x", url: "https://a.b/", onclick: "x" }] }, "links"],
    ["unknown field", { ...ARTICLE, status: "published" }, "status"],
    ["client-chosen id", { ...ARTICLE, id: "itm_mine" }, "id"],
    ["invalid type", { ...ARTICLE, type: "podcast" }, "type"],
    ["article without blocks", { ...ARTICLE, blocks: undefined }, "blocks"],
    ["article with no text", { ...ARTICLE, blocks: [] }, "blocks"],
    ["PDF field on an article", { ...ARTICLE, fileUrl: "documents/x.pdf" }, "fileUrl"],
    ["PDF without a file", { ...PDF, fileUrl: undefined }, "fileUrl"],
    ["PDF javascript: URL", { ...PDF, fileUrl: "javascript:alert(1)" }, "fileUrl"],
    ["PDF path traversal", { ...PDF, fileUrl: "../secret.pdf" }, "fileUrl"],
    ["PDF page count 0", { ...PDF, pageCount: 0 }, "pageCount"],
    ["not a YouTube URL", { ...VIDEO, videoUrl: "https://vimeo.com/123" }, "videoUrl"],
    ["link with ftp URL", { ...LINK, url: "ftp://files.example.com/" }, "url"],
    ["link without URL", { ...LINK, url: undefined }, "url"],
    ["invalid slug", { ...ARTICLE, slug: "Bad Slug" }, "slug"],
    ["impossible date", { ...ARTICLE, addedAt: "2026-02-30" }, "addedAt"],
    ["unknown block type", { ...ARTICLE, blocks: [{ id: "b1", type: "html", text: "<b>x</b>" }] }, "blocks"],
    ["duplicate block id", { ...ARTICLE, blocks: [{ id: "b1", type: "paragraph", text: "a" }, { id: "b1", type: "paragraph", text: "b" }] }, "blocks"],
    ["heading level 5", { ...ARTICLE, blocks: [{ id: "b1", type: "heading", level: 5, text: "x" }] }, "blocks"],
    ["section inside a section", { ...ARTICLE, blocks: [{ id: "b1", type: "details", summary: "a", blocks: [{ id: "b2", type: "details", summary: "b", blocks: [{ id: "b3", type: "paragraph", text: "c" }] }] }] }, "blocks"],
    ["empty paragraph", { ...ARTICLE, blocks: [{ id: "b1", type: "paragraph", text: " " }] }, "blocks"],
    ["javascript: link in text", { ...ARTICLE, blocks: [{ id: "b1", type: "paragraph", text: "[x](javascript:alert(1))" }] }, "blocks"],
    ["control character in text", { ...ARTICLE, blocks: [{ id: "b1", type: "paragraph", text: "a\u0007b" }] }, "blocks"],
    ["extra key on a block", { ...ARTICLE, blocks: [{ id: "b1", type: "paragraph", text: "a", style: "color:red" }] }, "blocks"],
    ["text over 200 KB", { ...ARTICLE, blocks: Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, type: "paragraph", text: "x".repeat(19000) })) }, "blocks"],
  ];
  for (const [label, input, field] of invalid) {
    test(`422 ${label}`, async () => {
      const res = await create(JSON.parse(JSON.stringify(input)));
      assert.equal(res.status, 422, JSON.stringify(res.data));
      assert.equal(res.data.code, "validation");
      assert.ok(field in res.data.fields, `expected an error for "${field}", got ${JSON.stringify(res.data.fields)}`);
      assert.equal(count("SELECT count(*) n FROM items"), 13);
      assert.equal(count("SELECT count(*) n FROM revisions"), 18);
    });
  }
});

/* ------------------------------------------------------------ update */

describe("update (only the fields sent change)", () => {
  test("editing the title of a draft changes only title, updatedAt and revision", async () => {
    const { id } = (await create(ARTICLE)).data.item;
    const before = rawRow(id);
    const res = await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, title: "How Ocean Tides Work" } });
    assert.equal(res.status, 200);
    assert.equal(res.data.item.revision, 2);
    assert.equal(res.data.item.title, "How Ocean Tides Work");
    const after = rawRow(id);
    for (const column of Object.keys(before)) {
      if (["title", "updated_at", "revision"].includes(column)) continue;
      assert.equal(after[column], before[column], `${column} must not change`);
    }
    assert.deepEqual(history(id).map((r) => [r.revision, r.action]), [[1, "create"], [2, "update"]]);
  });

  test("editing a published seeded item keeps every other stored byte and is live immediately", async () => {
    const before = rawRow("itm_fermi_problems");
    const res = await call("/api/admin/items/itm_fermi_problems", { method: "PATCH", body: { revision: 1, description: "Estimating anything with orders of magnitude." } });
    assert.equal(res.status, 200);
    const after = rawRow("itm_fermi_problems");
    for (const column of Object.keys(before)) {
      if (["description", "updated_at", "revision"].includes(column)) continue;
      assert.equal(after[column], before[column], `${column} must not change`);
    }
    assert.equal((await publicGet("/api/items/fermi-problems")).data.description, "Estimating anything with orders of magnitude.");
  });

  test("new blocks recompute the reading time", async () => {
    const { id } = (await create(ARTICLE)).data.item;
    const long = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, type: "paragraph", text: "word ".repeat(100).trim() }));
    const res = await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, blocks: long } });
    assert.equal(res.status, 200);
    assert.equal(res.data.item.readingMinutes, 3);
    assert.ok(isDeepStrictEqual(res.data.item.blocks, long));
  });

  test("a stale revision is refused (409) with the current revision; nothing changes", async () => {
    const { id } = (await create(ARTICLE)).data.item;
    await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, title: "First edit" } });
    const stale = await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, title: "Lost update" } });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, "conflict");
    assert.equal(stale.data.currentRevision, 2);
    assert.equal(rawRow(id).title, "First edit");
    assert.equal(history(id).length, 2);
  });

  test("atomic: if the history row cannot be written, the edit itself is rolled back", async () => {
    const { id } = (await create(ARTICLE)).data.item;
    // Occupy revision 2 in the history so the edit's history insert must fail.
    db.raw.prepare("INSERT INTO revisions (entity_type, entity_id, revision, action, snapshot_json, changed_by) VALUES ('item', ?, 2, 'update', '{}', 'test')").run(id);
    const before = rawRow(id);
    const res = await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, title: "Must not stick" } });
    assert.equal(res.status, 409);
    assert.deepEqual(rawRow(id), before, "item unchanged: the UPDATE was rolled back with the failed history insert");
  });

  test("two simultaneous edits from the same revision: exactly one wins", async () => {
    const { id } = (await create(ARTICLE)).data.item;
    const [a, b] = await Promise.all([
      call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, title: "Edit A" } }),
      call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, title: "Edit B" } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const winner = a.status === 200 ? "Edit A" : "Edit B";
    assert.equal(rawRow(id).title, winner);
    assert.deepEqual(history(id).map((r) => r.revision), [1, 2]);
    assert.equal(JSON.parse(history(id)[1].snapshot_json).title, winner);
  });

  const refused = [
    ["missing revision", { title: "x" }, "revision"],
    ["slug change", { revision: 1, slug: "new-slug" }, "slug"],
    ["type change", { revision: 1, type: "link" }, "type"],
    ["status change", { revision: 1, status: "published" }, "status"],
    ["id change", { revision: 1, id: "itm_other" }, "id"],
    ["updatedAt", { revision: 1, updatedAt: "2020-01-01" }, "updatedAt"],
    ["field of another type", { revision: 1, url: "https://example.com/" }, "url"],
    ["no changes", { revision: 1 }, "body"],
    ["invalid value", { revision: 1, tags: [1, 2] }, "tags"],
  ];
  for (const [label, body, field] of refused) {
    test(`422 ${label}`, async () => {
      const { id } = (await create(ARTICLE)).data.item;
      const before = rawRow(id);
      const res = await call(`/api/admin/items/${id}`, { method: "PATCH", body });
      assert.equal(res.status, 422, JSON.stringify(res.data));
      assert.ok(field in res.data.fields, JSON.stringify(res.data.fields));
      assert.deepEqual(rawRow(id), before);
    });
  }

  test("editing an unknown item -> 404", async () => {
    assert.equal((await call("/api/admin/items/itm_missing", { method: "PATCH", body: { revision: 1, title: "x" } })).status, 404);
  });
});

/* ------------------------------------------------------------ publish / unpublish */

describe("publish and unpublish", () => {
  test("a draft becomes public only when published, and private again when unpublished", async () => {
    const { id, slug } = (await create(ARTICLE)).data.item;
    await assertPublicHides(slug, id);
    const published = await call(`/api/admin/items/${id}/publish`, { method: "POST", body: { revision: 1 } });
    assert.equal(published.status, 200);
    assert.equal(published.data.item.status, "published");
    assert.equal(published.data.item.revision, 2);
    assert.equal((await publicGet("/api/items")).data.length, 14);
    const live = await publicGet(`/api/items/${slug}`);
    assert.equal(live.status, 200);
    assert.ok(isDeepStrictEqual(live.data.blocks, ARTICLE.blocks));
    assert.equal((await publicGet("/api/library")).data.items.length, 14);

    const again = await call(`/api/admin/items/${id}/publish`, { method: "POST", body: { revision: 2 } });
    assert.equal(again.status, 200);
    assert.equal(again.data.changed, false);
    assert.equal(history(id).length, 2);

    const stale = await call(`/api/admin/items/${id}/unpublish`, { method: "POST", body: { revision: 1 } });
    assert.equal(stale.status, 409);

    const hidden = await call(`/api/admin/items/${id}/unpublish`, { method: "POST", body: { revision: 2 } });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.data.item.status, "draft");
    await assertPublicHides(slug, id);
    assert.deepEqual(history(id).map((r) => r.action), ["create", "publish", "unpublish"]);
  });
});

/* ------------------------------------------------------------ delete and restore */

describe("delete and restore", () => {
  test("delete needs the current revision, keeps a tombstone, and lists the item as deleted", async () => {
    const { id, slug } = (await create(VIDEO)).data.item;
    const stale = await call(`/api/admin/items/${id}`, { method: "DELETE", body: { revision: 7 } });
    assert.equal(stale.status, 409);
    assert.ok(rawRow(id));
    const res = await call(`/api/admin/items/${id}`, { method: "DELETE", body: { revision: 1 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.deleted, { id, slug, title: VIDEO.title, revision: 2 });
    assert.equal(rawRow(id), null);
    assert.equal((await call(`/api/admin/items/${id}`)).status, 404);
    const h = history(id);
    assert.deepEqual(h.map((r) => [r.revision, r.action]), [[1, "create"], [2, "delete"]]);
    assert.equal(JSON.parse(h[1].snapshot_json).video_url, VIDEO.videoUrl);
    const deleted = await call("/api/admin/deleted-items");
    assert.deepEqual(deleted.data.items.map((i) => [i.id, i.slug, i.revision]), [[id, slug, 2]]);
  });

  test("a deleted published item comes back as a DRAFT, then exactly as before when published", async () => {
    const original = rawRow("itm_fermi_problems");
    const del = await call("/api/admin/items/itm_fermi_problems", { method: "DELETE", body: { revision: 1 } });
    assert.equal(del.status, 200);
    assert.equal((await publicGet("/api/items/fermi-problems")).status, 404);
    assert.equal((await publicGet("/api/items")).data.length, 12);

    const restored = await call("/api/admin/items/itm_fermi_problems/restore", { method: "POST", body: { revision: 2, fromRevision: 2 } });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.item.status, "draft");
    assert.equal(restored.data.item.revision, 3);
    assert.equal((await publicGet("/api/items/fermi-problems")).status, 404, "restored item must stay private until published");

    await call("/api/admin/items/itm_fermi_problems/publish", { method: "POST", body: { revision: 3 } });
    const live = await publicGet("/api/items/fermi-problems");
    const { blocks, updatedAt, ...item } = live.data;
    const { updatedAt: _originalUpdatedAt, ...expected } = ITEMS_JSON.find((i) => i.id === "itm_fermi_problems");
    assert.ok(isDeepStrictEqual(item, expected));
    assert.equal(updatedAt, TODAY, "a restore counts as an update");
    assert.ok(isDeepStrictEqual(blocks, bodyOf("fermi-problems")));
    const after = rawRow("itm_fermi_problems");
    for (const column of Object.keys(original)) {
      if (["updated_at", "revision"].includes(column)) continue;
      assert.equal(after[column], original[column], `${column} must equal the original`);
    }
    assert.deepEqual(history("itm_fermi_problems").map((r) => [r.revision, r.action]), [[1, "import"], [2, "delete"], [3, "restore"], [4, "publish"]]);
  });

  test("restoring a deleted item needs its latest revision and a free slug", async () => {
    const { id, slug } = (await create(LINK)).data.item;
    await call(`/api/admin/items/${id}`, { method: "DELETE", body: { revision: 1 } });
    const stale = await call(`/api/admin/items/${id}/restore`, { method: "POST", body: { revision: 1, fromRevision: 1 } });
    assert.equal(stale.status, 409);
    // Someone else took the slug meanwhile (simulated directly in the database).
    db.raw.prepare("INSERT INTO items (id, slug, type, category_id, language, title, added_at, updated_at, url) VALUES ('itm_squatter', ?, 'link', 'cat_science', 'en', 'Other', '2026-01-01', '2026-01-01', 'https://example.com/')").run(slug);
    const taken = await call(`/api/admin/items/${id}/restore`, { method: "POST", body: { revision: 2, fromRevision: 1 } });
    assert.equal(taken.status, 409);
    assert.equal(taken.data.code, "slug_taken");
    assert.equal(rawRow(id), null);
  });

  test("restoring an earlier version of an existing item creates a new revision with that content", async () => {
    const { id } = (await create(ARTICLE)).data.item;
    await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, title: "Edit one", tags: ["changed"] } });
    await call(`/api/admin/items/${id}/publish`, { method: "POST", body: { revision: 2 } });
    await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 3, title: "Edit two" } });
    const res = await call(`/api/admin/items/${id}/restore`, { method: "POST", body: { revision: 4, fromRevision: 1 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.item.revision, 5);
    assert.equal(res.data.item.title, ARTICLE.title);
    assert.deepEqual(res.data.item.tags, ARTICLE.tags);
    assert.equal(res.data.item.status, "published", "restore keeps the current status");
    const last = history(id).at(-1);
    assert.equal(last.action, "restore");
    assert.equal(last.note, "Restored revision 1");
    assert.equal((await call(`/api/admin/items/${id}/restore`, { method: "POST", body: { revision: 5, fromRevision: 99 } })).status, 404);
  });

  test("a seeded item edited and then restored to its import snapshot is byte-identical again", async () => {
    const original = rawRow("itm_rainbow");
    await call("/api/admin/items/itm_rainbow", { method: "PATCH", body: { revision: 1, title: "Changed", blocks: [{ id: "x1", type: "paragraph", text: "Replaced" }] } });
    const res = await call("/api/admin/items/itm_rainbow/restore", { method: "POST", body: { revision: 2, fromRevision: 1 } });
    assert.equal(res.status, 200);
    const after = rawRow("itm_rainbow");
    for (const column of Object.keys(original)) {
      if (["updated_at", "revision"].includes(column)) continue;
      assert.equal(after[column], original[column], `${column} must equal the import snapshot`);
    }
    assert.ok(isDeepStrictEqual(res.data.item.blocks, bodyOf("how-a-rainbow-forms")));
  });
});

/* ------------------------------------------------------------ history */

describe("revision history", () => {
  test("history is complete, ordered, attributed, and every snapshot equals the row at that time", async () => {
    const { id } = (await create(ARABIC)).data.item;
    const snapshots = [rawRow(id)];
    await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, title: "عنوان جديد" } });
    snapshots.push(rawRow(id));
    await call(`/api/admin/items/${id}/publish`, { method: "POST", body: { revision: 2 } });
    snapshots.push(rawRow(id));
    await call(`/api/admin/items/${id}/restore`, { method: "POST", body: { revision: 3, fromRevision: 1 } });
    snapshots.push(rawRow(id));
    await call(`/api/admin/items/${id}`, { method: "DELETE", body: { revision: 4 } });

    const h = history(id);
    assert.deepEqual(h.map((r) => r.revision), [1, 2, 3, 4, 5]);
    assert.deepEqual(h.map((r) => r.action), ["create", "update", "publish", "restore", "delete"]);
    assert.ok(h.every((r) => r.changed_by === ADMIN));
    snapshots.forEach((row, index) => assert.deepEqual(JSON.parse(h[index].snapshot_json), row, `snapshot ${index + 1}`));
    assert.deepEqual(JSON.parse(h[4].snapshot_json), { ...snapshots[3], revision: 5 }, "tombstone = deleted row");

    const list = await call(`/api/admin/items/${id}/revisions`);
    assert.equal(list.status, 200);
    assert.equal(list.data.deleted, true);
    assert.deepEqual(list.data.revisions.map((r) => r.revision), [5, 4, 3, 2, 1]);
    const v2 = await call(`/api/admin/items/${id}/revisions/2`);
    assert.equal(v2.data.item.title, "عنوان جديد");
    assert.equal(v2.data.action, "update");
    assert.equal((await call(`/api/admin/items/${id}/revisions/9`)).status, 404);
    assert.equal((await call("/api/admin/items/itm_never/revisions")).status, 404);
  });

  test("seeded items start with their import snapshot", async () => {
    const res = await call("/api/admin/items/itm_rainbow/revisions");
    assert.deepEqual(res.data.revisions.map((r) => [r.revision, r.action, r.changedBy]), [[1, "import", "migration 0003"]]);
  });
});

/* ------------------------------------------------------------ injection, text, public isolation */

describe("injection, text fidelity and public isolation", () => {
  test("SQL-looking input is stored as plain text and changes nothing else", async () => {
    const nasty = {
      ...ARTICLE,
      title: "Robert'); DROP TABLE items;--",
      description: "' OR '1'='1",
      tags: ["\"; DELETE FROM revisions; --", "x' UNION SELECT * FROM items --"],
      blocks: [{ id: "b1", type: "paragraph", text: "'; UPDATE items SET status = 'draft'; --" }],
    };
    const res = await create(nasty);
    assert.equal(res.status, 201);
    const back = (await call(`/api/admin/items/${res.data.item.id}`)).data.item;
    assert.equal(back.title, nasty.title);
    assert.equal(back.description, nasty.description);
    assert.deepEqual(back.tags, nasty.tags);
    assert.ok(isDeepStrictEqual(back.blocks, nasty.blocks));
    assert.equal(count("SELECT count(*) n FROM items"), 14);
    assert.equal(count("SELECT count(*) n FROM items WHERE status = 'published'"), 13);
    assert.equal(count("SELECT count(*) n FROM revisions"), 19);
  });

  test("the public API never shows drafts at any stage, and seeded content stays identical", async () => {
    const ids = [];
    for (const input of [ARTICLE, ARABIC, PDF, VIDEO, LINK]) {
      const item = (await create(input)).data.item;
      ids.push(item.id);
      await assertPublicHides(item.slug, item.id);
    }
    await call(`/api/admin/items/${ids[0]}`, { method: "PATCH", body: { revision: 1, title: "Still a draft" } });
    await assertPublicHides("how-tides-work", ids[0]);
    const library = await publicGet("/api/library");
    assert.ok(isDeepStrictEqual(library.data.items, ITEMS_JSON));
  });
});
