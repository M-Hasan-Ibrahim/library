// Integration API tests (POST /api/integrations/drafts): the real Worker
// (worker/src/index.js) against a real SQLite database built from the
// migrations (support/sqliteD1.mjs). Tokens here are generated per run and
// exist only in memory. Run: npm run test:worker
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { clearSigningKeyCache } from "../src/access.js";
import { createItem } from "../src/adminItems.js";
import worker from "../src/index.js";
import { DAILY_DRAFT_LIMIT, INTEGRATION_ACTOR, MAX_BODY_BYTES } from "../src/integrations.js";
import { ADMIN, AUD, CERTS_URL, createSigningKey, signToken, SITE, TEAM, validClaims } from "./helpers.mjs";
import { createTestDb } from "./support/sqliteD1.mjs";

const newToken = () => `lib_int_${randomBytes(32).toString("base64url")}`;
const digestOf = (token) => createHash("sha256").update(token).digest("hex");
const TOKEN = newToken();
const OTHER_TOKEN = newToken(); // well-formed but not configured
const trusted = await createSigningKey("trusted-kid");

const ARTICLE = {
  type: "article",
  categoryId: "cat_science",
  language: "en",
  title: "Notes on Integration Drafts",
  description: "Written by an external client.",
  tags: ["test"],
  links: [{ label: "Example", url: "https://example.com/" }],
  blocks: [
    { id: "b01", type: "paragraph", text: "A **draft** created through the integration API." },
    { id: "b02", type: "heading", level: 2, text: "Second section" },
  ],
};

let db;
let env;
let limiterCalls;
const realFetch = globalThis.fetch;
beforeEach(() => {
  clearSigningKeyCache();
  db = createTestDb();
  limiterCalls = [];
  env = {
    ALLOWED_ORIGINS: SITE,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ADMIN_EMAIL: ADMIN,
    SITE_URL: `${SITE}/`,
    DB: db,
    INTEGRATION_TOKEN_SHA256: digestOf(TOKEN),
    INTEGRATION_RATE_LIMITER: {
      allow: true,
      async limit({ key }) {
        limiterCalls.push(key);
        return { success: this.allow };
      },
    },
  };
  globalThis.fetch = async (url, init) =>
    String(url) === CERTS_URL ? new Response(JSON.stringify({ keys: [trusted.jwk] })) : realFetch(url, init);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------ helpers */

async function call(path, { method = "POST", body = ARTICLE, token = TOKEN, headers = {} } = {}) {
  const h = { "CF-Connecting-IP": "203.0.113.7", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !("Content-Type" in h)) h["Content-Type"] = "application/json";
  const init = { method, headers: h };
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await worker.fetch(new Request(`https://api.library.mh-ibrahim.com${path}`, init), env);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, headers: response.headers, data };
}
const createDraft = (options) => call("/api/integrations/drafts", options);
const publicGet = (path) => worker.fetch(new Request(`https://api.library.mh-ibrahim.com${path}`), env).then(async (r) => ({ status: r.status, data: await r.json() }));
const itemCount = () => Number(db.raw.prepare("SELECT count(*) AS n FROM items").get().n);
const rawRow = (id) => {
  const row = db.raw.prepare("SELECT * FROM items WHERE id = ?").get(id);
  return row ? { ...row } : null;
};

async function assertNothingCreated(before, res, expectedStatus) {
  assert.equal(res.status, expectedStatus, JSON.stringify(res.data));
  assert.equal(itemCount(), before, "no item may be created");
}

/* ------------------------------------------------------------ tokens */

describe("authentication", () => {
  test("valid token -> 201 with only the new draft id", async () => {
    const res = await createDraft();
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.deepEqual(Object.keys(res.data).sort(), ["id", "status"]);
    assert.match(res.data.id, /^itm_[a-z0-9]{16}$/);
    assert.equal(res.data.status, "draft");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("access-control-allow-origin"), null, "no CORS for this route");

    const row = rawRow(res.data.id);
    assert.equal(row.status, "draft");
    assert.equal(row.revision, 1);
    assert.equal(row.type, "article");
    assert.equal(row.title, ARTICLE.title);
    assert.equal(row.slug, "notes-on-integration-drafts");
    const revision = db.raw.prepare("SELECT action, changed_by FROM revisions WHERE entity_id = ?").get(res.data.id);
    assert.deepEqual({ ...revision }, { action: "create", changed_by: INTEGRATION_ACTOR });
  });

  test("missing token -> 401, nothing created", async () => {
    const before = itemCount();
    const res = await createDraft({ token: null });
    await assertNothingCreated(before, res, 401);
    assert.deepEqual(res.data, { error: "Unauthorized" });
    assert.match(res.headers.get("www-authenticate"), /^Bearer /);
  });

  test("invalid tokens -> 401, nothing created", async () => {
    const before = itemCount();
    for (const token of [OTHER_TOKEN, TOKEN.slice(0, -1) + (TOKEN.endsWith("A") ? "B" : "A"), "short", digestOf(TOKEN), `${TOKEN}x`]) {
      await assertNothingCreated(before, await createDraft({ token }), 401);
    }
    // Wrong scheme, or the token somewhere other than the Authorization header.
    await assertNothingCreated(before, await createDraft({ token: null, headers: { Authorization: `Basic ${TOKEN}` } }), 401);
    await assertNothingCreated(before, await createDraft({ token: null, headers: { Authorization: TOKEN } }), 401);
    await assertNothingCreated(before, await createDraft({ token: null, headers: { "X-Api-Key": TOKEN } }), 401);
    await assertNothingCreated(before, await call(`/api/integrations/drafts?token=${TOKEN}`, { token: null }), 401);
  });

  test("an admin Access session is not accepted here", async () => {
    const before = itemCount();
    const jwt = await signToken(validClaims(), trusted);
    const res = await createDraft({ token: null, headers: { "Cf-Access-Jwt-Assertion": jwt, Origin: SITE } });
    await assertNothingCreated(before, res, 401);
  });

  test("not configured (secret removed = revoked) -> 503", async () => {
    const before = itemCount();
    delete env.INTEGRATION_TOKEN_SHA256;
    await assertNothingCreated(before, await createDraft(), 503);
    env.INTEGRATION_TOKEN_SHA256 = "not-a-digest";
    await assertNothingCreated(before, await createDraft(), 503);
  });

  test("rotation: either of two configured digests works; removing one revokes it", async () => {
    const next = newToken();
    env.INTEGRATION_TOKEN_SHA256 = `${digestOf(TOKEN)}, ${digestOf(next).toUpperCase()}`;
    assert.equal((await createDraft()).status, 201);
    assert.equal((await createDraft({ token: next, body: { ...ARTICLE, title: "Second" } })).status, 201);
    env.INTEGRATION_TOKEN_SHA256 = digestOf(next);
    assert.equal((await createDraft({ body: { ...ARTICLE, title: "Third" } })).status, 401);
  });
});

/* ------------------------------------------------------------ drafts only */

describe("drafts only: no publishing or other admin operations", () => {
  test("publishing attempts in the body are refused, nothing created", async () => {
    const before = itemCount();
    for (const extra of [{ status: "published" }, { status: "draft" }, { published: true }, { publish: true }]) {
      const res = await createDraft({ body: { ...ARTICLE, ...extra } });
      await assertNothingCreated(before, res, 422);
      assert.match(Object.values(res.data.fields)[0], /only create drafts/);
    }
  });

  test("publish endpoints are unreachable with the integration token", async () => {
    const { data } = await createDraft();
    const before = itemCount();
    const body = { revision: 1 };
    assert.equal((await call(`/api/integrations/drafts/${data.id}/publish`, { body })).status, 404);
    assert.equal((await call(`/api/integrations/items/${data.id}/publish`, { body })).status, 404);
    // The admin API only trusts Cloudflare Access, never this token.
    assert.equal((await call(`/api/admin/items/${data.id}/publish`, { body, headers: { Origin: SITE } })).status, 401);
    assert.equal(rawRow(data.id).status, "draft");
    assert.equal(rawRow(data.id).revision, 1);
    assert.equal(itemCount(), before);
  });

  test("no listing, reading, editing or deleting through the integration", async () => {
    const { data } = await createDraft();
    for (const [method, path] of [
      ["GET", "/api/integrations/drafts"],
      ["HEAD", "/api/integrations/drafts"],
      ["PATCH", "/api/integrations/drafts"],
      ["DELETE", "/api/integrations/drafts"],
      ["PUT", "/api/integrations/drafts"],
      ["OPTIONS", "/api/integrations/drafts"],
    ]) {
      const res = await call(path, { method, body: method === "GET" || method === "HEAD" ? undefined : { revision: 1 } });
      assert.equal(res.status, 405, `${method} ${path}`);
    }
    for (const method of ["GET", "PATCH", "DELETE"]) {
      assert.equal((await call(`/api/integrations/drafts/${data.id}`, { method, body: method === "GET" ? undefined : { revision: 1 } })).status, 404);
    }
    for (const [method, path] of [["GET", "/api/admin/items"], ["GET", `/api/admin/items/${data.id}`], ["PATCH", `/api/admin/items/${data.id}`], ["DELETE", `/api/admin/items/${data.id}`], ["GET", "/api/admin/session"]]) {
      const res = await call(path, { method, body: method === "GET" ? undefined : { revision: 1, title: "x" }, headers: { Origin: SITE } });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.equal(rawRow(data.id).title, ARTICLE.title);
    assert.equal(rawRow(data.id).revision, 1);
  });

  test("only article creation fields are accepted", async () => {
    const before = itemCount();
    const cases = [
      [{ ...ARTICLE, type: "link", url: "https://example.com/" }, "type"],
      [{ ...ARTICLE, slug: "chosen-slug" }, "slug"],
      [{ ...ARTICLE, id: "itm_aaaaaaaaaaaaaaaa" }, "id"],
      [{ ...ARTICLE, revision: 5 }, "revision"],
      [{ ...ARTICLE, addedAt: "2020-01-01" }, "addedAt"],
      [{ ...ARTICLE, fileUrl: "https://example.com/a.pdf" }, "fileUrl"],
      [{ ...ARTICLE, isAdmin: true }, "isAdmin"],
      [{ ...ARTICLE, categoryId: "cat_missing" }, "categoryId"],
      [{ ...ARTICLE, blocks: [] }, "blocks"],
      [{ ...ARTICLE, blocks: [{ id: "b1", type: "html", text: "<script>alert(1)</script>" }] }, "blocks"],
      [{ ...ARTICLE, links: [{ label: "x", url: "javascript:alert(1)" }] }, "links"],
      [{ ...ARTICLE, title: "" }, "title"],
      [{ ...ARTICLE, title: undefined }, "title"],
    ];
    for (const [body, field] of cases) {
      const res = await createDraft({ body });
      await assertNothingCreated(before, res, 422);
      assert.ok(field in res.data.fields || "item" in res.data.fields, `${field}: ${JSON.stringify(res.data.fields)}`);
    }
    await assertNothingCreated(before, await createDraft({ body: [ARTICLE] }), 422);
  });

  test("type may be omitted (always an article)", async () => {
    const { type: _type, ...rest } = ARTICLE;
    const res = await createDraft({ body: rest });
    assert.equal(res.status, 201);
    assert.equal(rawRow(res.data.id).type, "article");
  });
});

/* ------------------------------------------------------------ visibility */

describe("public visibility", () => {
  test("integration drafts never appear on the public API", async () => {
    const { data } = await createDraft();
    const { slug } = rawRow(data.id);
    const list = await publicGet("/api/items");
    assert.equal(list.status, 200);
    assert.ok(!list.data.some((i) => i.id === data.id || i.slug === slug), "draft must not be in /api/items");
    const library = await publicGet("/api/library");
    assert.ok(!library.data.items.some((i) => i.id === data.id), "draft must not be in /api/library");
    assert.equal((await publicGet(`/api/items/${slug}`)).status, 404);
  });
});

/* ------------------------------------------------------------ limits */

describe("request limits and rate limiting", () => {
  test("body larger than the limit -> 413 (with or without Content-Length)", async () => {
    const before = itemCount();
    const big = JSON.stringify({ ...ARTICLE, description: "x".repeat(MAX_BODY_BYTES) });
    await assertNothingCreated(before, await createDraft({ body: big }), 413);
    // A streamed body has no Content-Length: the Worker still stops reading at the limit.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const response = await worker.fetch(
      new Request("https://api.library.mh-ibrahim.com/api/integrations/drafts", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      }),
      env,
    );
    assert.equal(response.status, 413);
    assert.equal(itemCount(), before);
  });

  test("wrong content type -> 415, invalid JSON -> 400", async () => {
    const before = itemCount();
    await assertNothingCreated(before, await createDraft({ headers: { "Content-Type": "text/plain" } }), 415);
    await assertNothingCreated(before, await createDraft({ body: "{not json" }), 400);
  });

  test("rate limiter refusal -> 429; keys are per token, failed sign-ins per IP", async () => {
    const before = itemCount();
    env.INTEGRATION_RATE_LIMITER.allow = false;
    const res = await createDraft();
    await assertNothingCreated(before, res, 429);
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal((await createDraft({ token: OTHER_TOKEN })).status, 429);
    assert.match(limiterCalls[0], /^token:[0-9a-f]{16}$/);
    assert.equal(limiterCalls[1], "unauthorized:203.0.113.7");
    assert.ok(!limiterCalls.some((key) => key.includes(TOKEN)), "the token itself is never used as a key");
  });

  test("fail closed: missing or misconfigured rate limiter binding -> 503, nothing created", async () => {
    const before = itemCount();
    for (const binding of [undefined, null, {}, { limit: "yes" }, "INTEGRATION_RATE_LIMITER", 42]) {
      env.INTEGRATION_RATE_LIMITER = binding;
      for (const token of [TOKEN, OTHER_TOKEN, null]) {
        const res = await createDraft({ token });
        await assertNothingCreated(before, res, 503);
        assert.equal(res.data.code, "rate_limiter_unavailable");
      }
    }
  });

  test("fail closed: rate limiter errors or unexpected answers -> 503, nothing created", async () => {
    const before = itemCount();
    const answers = [
      async () => {
        throw new Error("limiter outage");
      },
      async () => undefined,
      async () => ({}),
      async () => ({ success: "true" }),
      async () => ({ success: 1 }),
    ];
    for (const limit of answers) {
      env.INTEGRATION_RATE_LIMITER = { limit };
      for (const token of [TOKEN, OTHER_TOKEN]) {
        const res = await createDraft({ token });
        await assertNothingCreated(before, res, 503);
        assert.equal(res.data.code, "rate_limiter_unavailable");
      }
    }
  });

  test("daily quota in D1 -> 429 once reached", async () => {
    const insert = db.raw.prepare(
      "INSERT INTO revisions (entity_type, entity_id, revision, action, snapshot_json, changed_by) VALUES ('item', ?, 1, 'create', '{}', ?)",
    );
    for (let i = 0; i < DAILY_DRAFT_LIMIT - 1; i += 1) insert.run(`itm_quota${i}`, INTEGRATION_ACTOR);
    // Older ones and the admin's own drafts do not count.
    db.raw.prepare(
      "INSERT INTO revisions (entity_type, entity_id, revision, action, snapshot_json, changed_by, changed_at) VALUES ('item', 'itm_old', 1, 'create', '{}', ?, '2020-01-01T00:00:00.000Z')",
    ).run(INTEGRATION_ACTOR);
    insert.run("itm_byadmin", ADMIN);
    assert.equal((await createDraft()).status, 201); // the 50th
    const before = itemCount();
    const res = await createDraft({ body: { ...ARTICLE, title: "One too many" } });
    await assertNothingCreated(before, res, 429);
    assert.equal(res.data.code, "quota_exceeded");
    assert.equal(res.headers.get("retry-after"), "3600");
  });
});

/* ------------------------------------------------------------ atomic quota */

describe("daily quota is atomic (checked inside the create transaction)", () => {
  const actorCreates = () =>
    Number(db.raw.prepare("SELECT count(*) AS n FROM revisions WHERE entity_type = 'item' AND action = 'create' AND changed_by = ?").get(INTEGRATION_ACTOR).n);
  const fillQuota = (n) => {
    const insert = db.raw.prepare(
      "INSERT INTO revisions (entity_type, entity_id, revision, action, snapshot_json, changed_by) VALUES ('item', ?, 1, 'create', '{}', ?)",
    );
    for (let i = 0; i < n; i += 1) insert.run(`itm_fill${i}`, INTEGRATION_ACTOR);
  };
  const orphanRevisions = () =>
    Number(db.raw.prepare("SELECT count(*) AS n FROM revisions r WHERE r.entity_id LIKE 'itm_%' AND r.entity_id NOT LIKE 'itm_fill%' AND r.entity_id <> 'itm_rival' AND r.action = 'create' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = r.entity_id)").get().n);

  test("a rival draft committed after this request's checks but before its insert -> 429, nothing written", async () => {
    fillQuota(DAILY_DRAFT_LIMIT - 1);
    // Simulates a concurrent request winning the last slot between this
    // request's validation and its create batch (the race of the old pre-check).
    const realBatch = db.batch.bind(db);
    let raced = false;
    db.batch = async (statements) => {
      if (!raced && statements.some((s) => /^INSERT INTO items/.test(s.sql))) {
        raced = true;
        db.raw.prepare(
          "INSERT INTO revisions (entity_type, entity_id, revision, action, snapshot_json, changed_by) VALUES ('item', 'itm_rival', 1, 'create', '{}', ?)",
        ).run(INTEGRATION_ACTOR);
      }
      return realBatch(statements);
    };
    const before = itemCount();
    const res = await createDraft();
    assert.ok(raced, "the create batch ran");
    await assertNothingCreated(before, res, 429);
    assert.equal(res.data.code, "quota_exceeded");
    assert.equal(actorCreates(), DAILY_DRAFT_LIMIT, "never more than the limit");
    assert.equal(orphanRevisions(), 0, "no history row without its item");
  });

  test("many concurrent requests at the edge never exceed the limit", async () => {
    fillQuota(DAILY_DRAFT_LIMIT - 3);
    const before = itemCount();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createDraft({ body: { ...ARTICLE, title: `Concurrent ${i}` } })),
    );
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 3, statuses.join(" "));
    assert.equal(statuses.filter((s) => s === 429).length, 7, statuses.join(" "));
    assert.equal(itemCount(), before + 3);
    assert.equal(actorCreates(), DAILY_DRAFT_LIMIT);
    assert.equal(orphanRevisions(), 0);
    for (const r of results.filter((x) => x.status === 201)) {
      const row = rawRow(r.data.id);
      assert.equal(row.status, "draft");
      assert.equal(row.revision, 1);
      const history = db.raw.prepare("SELECT revision, action, changed_by FROM revisions WHERE entity_id = ?").all(r.data.id).map((h) => ({ ...h }));
      assert.deepEqual(history, [{ revision: 1, action: "create", changed_by: INTEGRATION_ACTOR }]);
    }
  });

  test("createItem without dailyLimit (the admin path) is unchanged and not limited", async () => {
    fillQuota(DAILY_DRAFT_LIMIT + 5); // the integration's quota does not affect the admin
    const { item } = await createItem(db, { ...ARTICLE, title: "Admin draft" }, ADMIN, env);
    assert.equal(item.status, "draft");
    assert.equal(rawRow(item.id).revision, 1);
  });

  test("createItem with dailyLimit refuses atomically at the limit (direct call)", async () => {
    const before = itemCount();
    await assert.rejects(createItem(db, ARTICLE, "someone", env, { dailyLimit: 0 }), (error) => error.status === 429 && error.body.code === "quota_exceeded");
    assert.equal(itemCount(), before);
    assert.equal(Number(db.raw.prepare("SELECT count(*) AS n FROM revisions WHERE changed_by = 'someone'").get().n), 0);
    const { item } = await createItem(db, ARTICLE, "someone", env, { dailyLimit: 1 });
    assert.equal(item.status, "draft");
    await assert.rejects(createItem(db, { ...ARTICLE, title: "Second" }, "someone", env, { dailyLimit: 1 }), (error) => error.status === 429);
  });
});

/* ------------------------------------------------------------ isolation */

describe("isolation from the rest of the API", () => {
  test("the admin API still needs Access and still works with it", async () => {
    const jwt = await signToken(validClaims(), trusted);
    const res = await worker.fetch(new Request("https://api.library.mh-ibrahim.com/api/admin/session", { headers: { "Cf-Access-Jwt-Assertion": jwt, Origin: SITE } }), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).email, ADMIN);
  });

  test("unknown integration paths -> 404 even with a valid token", async () => {
    for (const path of ["/api/integrations", "/api/integrations/", "/api/integrations/items", "/api/integrations/drafts/"]) {
      assert.equal((await call(path)).status, 404, path);
    }
  });
});
