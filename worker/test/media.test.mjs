// Migration 0004: YouTube video information, PDF uploads to R2 and serving,
// file bookkeeping (attach / orphan clean-up) and the new rich-text blocks.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { clearSigningKeyCache } from "../src/access.js";
import { cleanupOrphans, FILE_KEY, parseRange } from "../src/files.js";
import worker from "../src/index.js";
import { RATE_LIMIT, resetYouTubeRateLimit } from "../src/youtube.js";
import { AUD, ADMIN, CERTS_URL, createSigningKey, signToken, SITE, TEAM, validClaims } from "./helpers.mjs";
import { MemoryR2 } from "./support/memoryR2.mjs";
import { createTestDb } from "./support/sqliteD1.mjs";

const API = "https://api.library.mh-ibrahim.com";
const trusted = await createSigningKey("trusted-kid");
const realFetch = globalThis.fetch;
let db;
let env;
let youtube; // (url) => Response | Promise<Response>, the fake Google/YouTube

beforeEach(() => {
  clearSigningKeyCache();
  resetYouTubeRateLimit();
  db = createTestDb();
  env = { ALLOWED_ORIGINS: SITE, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAIL: ADMIN, SITE_URL: `${SITE}/`, PUBLIC_API_URL: API, DB: db, FILES: new MemoryR2() };
  youtube = () => new Response("not stubbed", { status: 500 });
  globalThis.fetch = async (url, init) => {
    if (String(url) === CERTS_URL) return new Response(JSON.stringify({ keys: [trusted.jwk] }));
    if (/googleapis\.com|youtube\.com\/oembed/.test(String(url))) return youtube(String(url), init);
    return realFetch(url, init);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(path, { method = "GET", body, token = "good", origin = SITE, headers = {} } = {}) {
  const h = { ...headers };
  if (token === "good") h["Cf-Access-Jwt-Assertion"] = await signToken(validClaims(), trusted);
  if (origin) h.Origin = origin;
  if (body !== undefined && !("Content-Type" in h)) h["Content-Type"] = "application/json";
  const init = { method, headers: h };
  if (body !== undefined) init.body = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  const response = await worker.fetch(new Request(`${API}${path}`, init), env);
  const buffer = new Uint8Array(await response.arrayBuffer());
  let data = null;
  try {
    data = JSON.parse(new TextDecoder().decode(buffer));
  } catch {}
  return { status: response.status, headers: response.headers, data, bytes: buffer };
}
const publicGet = (path, headers = {}) => call(path, { token: null, origin: null, headers });

/* ------------------------------------------------------------ PDFs */

const pdfBytes = (size = 2048, { start = "%PDF-1.7\n", end = "\n%%EOF\n" } = {}) => {
  const bytes = new Uint8Array(size).fill(0x20);
  bytes.set(new TextEncoder().encode(start), 0);
  bytes.set(new TextEncoder().encode(end), size - end.length);
  return bytes;
};
const upload = (bytes, { name = "Lecture Notes.pdf", type = "application/pdf", headers = {}, ...rest } = {}) =>
  call("/api/admin/files", {
    method: "POST",
    body: bytes,
    headers: { "Content-Type": type, "Content-Length": String(bytes.length), "X-File-Name": encodeURIComponent(name), ...headers },
    ...rest,
  });

describe("migration 0004", () => {
  test("adds two empty columns and the files table; existing items are untouched", () => {
    const columns = db.raw.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
    assert.ok(columns.includes("video_description") && columns.includes("media_json"));
    assert.equal(Number(db.raw.prepare("SELECT count(*) AS n FROM items WHERE video_description IS NOT NULL OR media_json IS NOT NULL").get().n), 0);
    assert.equal(Number(db.raw.prepare("SELECT count(*) AS n FROM items").get().n), 13);
    assert.equal(Number(db.raw.prepare("SELECT count(*) AS n FROM files").get().n), 0);
    const viewColumns = db.raw.prepare("PRAGMA table_info(published_items)").all().map((c) => c.name);
    assert.ok(viewColumns.includes("video_description"), "the SELECT * view includes the new column");
  });

  test("public answers for existing items carry no new fields", async () => {
    for (const slug of ["but-what-is-a-neural-network", "gradient-descent-lecture-notes", "fermi-problems"]) {
      const { data } = await publicGet(`/api/items/${slug}`);
      assert.equal("videoDescription" in data, false);
      assert.equal("videoInfo" in data, false);
    }
  });
});

describe("PDF upload (admin)", () => {
  test("a valid PDF is stored under a new random key and recorded as an upload", async () => {
    const bytes = pdfBytes(5000);
    const res = await upload(bytes);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const { key, url, name, size } = res.data.file;
    assert.match(key, FILE_KEY);
    assert.match(key, /^pdf\/\d{4}\/\d{2}\/[a-z0-9]{16}-lecture-notes\.pdf$/);
    assert.equal(url, `${API}/files/${key}`);
    assert.equal(name, "Lecture Notes.pdf");
    assert.equal(size, 5000);
    const stored = env.FILES.objects.get(key);
    assert.deepEqual(stored.bytes, bytes);
    assert.equal(stored.httpMetadata.contentType, "application/pdf");
    assert.equal(stored.customMetadata.originalName, "Lecture Notes.pdf");
    assert.equal(stored.customMetadata.uploadedBy, ADMIN);
    const row = db.raw.prepare("SELECT * FROM files WHERE key = ?").get(key);
    assert.equal(row.status, "uploaded");
    assert.equal(row.size, 5000);
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
  });

  test("two uploads of the same file get two different keys (nothing is overwritten)", async () => {
    const a = await upload(pdfBytes());
    const b = await upload(pdfBytes());
    assert.notEqual(a.data.file.key, b.data.file.key);
    assert.equal(env.FILES.objects.size, 2);
  });

  test("unsafe names never choose the path", async () => {
    for (const name of ["../../etc/passwd.pdf", "..\\..\\windows\\x.pdf", "a/b/c.pdf", "%2e%2e%2fsecret.pdf", "ملف.pdf", "....pdf", "x\u0000y.pdf"]) {
      const res = await upload(pdfBytes(), { name });
      assert.equal(res.status, 201, name);
      assert.match(res.data.file.key, FILE_KEY, name);
      assert.ok(!res.data.file.key.includes(".."), name);
      assert.ok(!res.data.file.name.includes("/") && !res.data.file.name.includes("\\"), name);
    }
  });

  test("refused: not signed in, foreign origin, wrong type, no size, too large, not a PDF, cut off", async () => {
    assert.equal((await upload(pdfBytes(), { token: null })).status, 401);
    assert.equal((await upload(pdfBytes(), { origin: "https://evil.example" })).status, 403);
    assert.equal((await upload(pdfBytes(), { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await upload(pdfBytes(), { type: "application/json" })).data.code, "unsupported_media_type");
    assert.equal((await upload(pdfBytes(), { type: "text/html" })).status, 415);
    assert.equal((await upload(pdfBytes(), { headers: { "Content-Length": String(26 * 1024 * 1024) } })).data.code, "too_large");
    assert.equal((await upload(pdfBytes(), { headers: { "Content-Length": "abc" } })).status, 411);
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>%%EOF");
    assert.equal((await upload(html)).data.code, "not_pdf");
    assert.equal((await upload(pdfBytes(3000, { end: "\nstream garbage" }))).data.code, "incomplete_pdf");
    assert.equal(env.FILES.objects.size, 0, "nothing stored");
    assert.equal(Number(db.raw.prepare("SELECT count(*) AS n FROM files").get().n), 0);
  });

  test("a real 25 MB limit: 25 MB is accepted, one byte more is not", async () => {
    assert.equal((await upload(pdfBytes(25 * 1024 * 1024))).status, 201);
    assert.equal((await upload(pdfBytes(25 * 1024 * 1024 + 1))).status, 413);
  });

  test("without the R2 binding, uploads answer 503 (storage not set up)", async () => {
    delete env.FILES;
    assert.equal((await upload(pdfBytes())).data.code, "storage_unavailable");
  });
});

const pdfItem = (fileUrl, extra = {}) => ({ type: "pdf", categoryId: "cat_science", language: "en", title: "Uploaded notes", fileUrl, pageCount: 3, ...extra });
async function createPdfItem(fileUrl, extra) {
  const res = await call("/api/admin/items", { method: "POST", body: pdfItem(fileUrl, extra) });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.item;
}
async function setStatus(item, action) {
  const res = await call(`/api/admin/items/${item.id}/${action}`, { method: "POST", body: { revision: item.revision } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.item;
}
/** An upload used by a published item (the only kind visitors can read). */
async function publishedFile(bytes = pdfBytes(), options) {
  const file = (await upload(bytes, options)).data.file;
  await setStatus(await createPdfItem(file.url), "publish");
  return file;
}
const adminFile = (key, { query = "", ...options } = {}) => call(`/api/admin/files/${key}${query}`, options);
const fileRow = (key) => db.raw.prepare("SELECT * FROM files WHERE key = ?").get(key);
const fileCount = () => Number(db.raw.prepare("SELECT count(*) AS n FROM files").get().n);
// Everything but the date: two 404s that must not be told apart.
const shape = (res) => ({ status: res.status, body: new TextDecoder().decode(res.bytes), headers: [...res.headers].filter(([name]) => name !== "date") });

describe("serving uploaded PDFs (public, published items only)", () => {
  test("GET: the exact bytes, inline, cacheable for an hour by the visitor only, CORS for the site", async () => {
    const bytes = pdfBytes(4096);
    const { key } = await publishedFile(bytes, { name: "Notes été.pdf" });
    const res = await call(`/files/${key}`, { token: null, origin: SITE });
    assert.equal(res.status, 200);
    assert.deepEqual(res.bytes, bytes);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("content-length"), "4096");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("cache-control"), "private, max-age=3600");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("access-control-allow-origin"), SITE);
    assert.match(res.headers.get("access-control-expose-headers"), /Content-Range/);
    assert.equal(res.headers.get("content-disposition"), `inline; filename="Notes _t_.pdf"; filename*=UTF-8''Notes%20%C3%A9t%C3%A9.pdf`);
  });

  test("?download=1 asks the browser to save it under its original name", async () => {
    const { key } = await publishedFile(pdfBytes(), { name: "Field Notes.pdf" });
    const res = await publicGet(`/files/${key}?download=1`);
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="Field Notes.pdf"/);
  });

  test("Range requests (PDF viewers read pages piece by piece), HEAD, 304, 416", async () => {
    const bytes = pdfBytes(1000);
    const { key } = await publishedFile(bytes);
    const part = await publicGet(`/files/${key}`, { Range: "bytes=10-19" });
    assert.equal(part.status, 206);
    assert.deepEqual(part.bytes, bytes.subarray(10, 20));
    assert.equal(part.headers.get("content-range"), "bytes 10-19/1000");
    const tail = await publicGet(`/files/${key}`, { Range: "bytes=-7" });
    assert.deepEqual(tail.bytes, bytes.subarray(993));
    assert.equal((await publicGet(`/files/${key}`, { Range: "bytes=5000-" })).status, 416);
    assert.equal((await publicGet(`/files/${key}`, { Range: "pages=1" })).status, 416);
    const head = await call(`/files/${key}`, { method: "HEAD", token: null, origin: null });
    assert.equal(head.status, 200);
    assert.equal(head.bytes.length, 0);
    assert.equal(head.headers.get("content-length"), "1000");
    const etag = head.headers.get("etag");
    assert.equal((await publicGet(`/files/${key}`, { "If-None-Match": etag })).status, 304);
    assert.deepEqual(parseRange("bytes=0-", 10), { offset: 0, length: 10 });
    assert.equal(parseRange("bytes=-0", 10), false);
  });

  test("unknown keys, path tricks and writes are refused", async () => {
    const { key } = await publishedFile();
    // ("..", like on Cloudflare's edge, is resolved before the Worker sees the path.)
    for (const path of ["/files/pdf/2026/11/aaaaaaaaaaaaaaaa-x.pdf", "/files/pdf/2026/../../../secret", `/files/${key}/../x`, "/files/pdf%2f2026", "/files/..%2F..%2Fapi%2Flibrary", "/files/", `/files/${key.toUpperCase()}`, "/files/pdf/2026/11/" + "a".repeat(16) + "-x.exe", `/files/${key}%00`, `/files/${encodeURIComponent(key)}`]) {
      assert.equal((await publicGet(path)).status, 404, path);
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      assert.equal((await call(`/files/${key}`, { method, token: null, body: "x" })).status, 405, method);
    }
    assert.ok(!(await publicGet(`/files/${key}`)).headers.get("access-control-allow-credentials"));
  });
});

describe("who can read an uploaded PDF", () => {
  test("not saved yet, or in a draft: 404 for visitors (exactly like a missing file), readable by the admin", async () => {
    const bytes = pdfBytes(3000);
    const file = (await upload(bytes)).data.file;
    const never = `pdf/2026/11/${"q".repeat(16)}-lecture-notes.pdf`;
    assert.deepEqual(shape(await publicGet(`/files/${file.key}`)), shape(await publicGet(`/files/${never}`)), "unsaved = never existed");
    const own = await adminFile(file.key);
    assert.equal(own.status, 200);
    assert.deepEqual(own.bytes, bytes);
    const item = await createPdfItem(file.url);
    assert.equal(item.status, "draft");
    assert.deepEqual(shape(await publicGet(`/files/${file.key}`)), shape(await publicGet(`/files/${never}`)), "draft = never existed");
    assert.deepEqual(shape(await call(`/files/${file.key}`, { token: null, origin: SITE })).body, shape(await call(`/files/${never}`, { token: null, origin: SITE })).body);
    // A visitor's token-less request to the admin address never reaches the file.
    assert.equal((await adminFile(file.key, { token: null })).status, 401);
    assert.equal((await adminFile(file.key, { token: null, origin: null })).status, 401);
  });

  test("publish -> public; unpublish -> 404 again; publish again -> public", async () => {
    const file = (await upload(pdfBytes())).data.file;
    let item = await createPdfItem(file.url);
    item = await setStatus(item, "publish");
    assert.equal((await publicGet(`/files/${file.key}`)).status, 200);
    item = await setStatus(item, "unpublish");
    assert.equal((await publicGet(`/files/${file.key}`)).status, 404);
    assert.equal((await adminFile(file.key)).status, 200, "the admin still reads it");
    await setStatus(item, "publish");
    assert.equal((await publicGet(`/files/${file.key}`)).status, 200);
  });

  test("replaced PDF: only the current file is public; the old one is kept for the history (admin only)", async () => {
    const first = (await upload(pdfBytes(), { name: "v1.pdf" })).data.file;
    const second = (await upload(pdfBytes(), { name: "v2.pdf" })).data.file;
    let item = await setStatus(await createPdfItem(first.url), "publish");
    const updated = await call(`/api/admin/items/${item.id}`, { method: "PATCH", body: { revision: item.revision, fileUrl: second.url } });
    item = updated.data.item;
    assert.equal((await publicGet(`/files/${second.key}`)).status, 200);
    assert.equal((await publicGet(`/files/${first.key}`)).status, 404);
    assert.equal((await adminFile(first.key)).status, 200);
    assert.ok(env.FILES.objects.has(first.key));
  });

  test("deleted item: its file is no longer public, but kept so it can be restored (as a draft: still not public)", async () => {
    const file = (await upload(pdfBytes())).data.file;
    const item = await setStatus(await createPdfItem(file.url), "publish");
    assert.equal((await publicGet(`/files/${file.key}`)).status, 200);
    const removed = await call(`/api/admin/items/${item.id}`, { method: "DELETE", body: { revision: item.revision } });
    assert.equal(removed.status, 200);
    assert.equal((await publicGet(`/files/${file.key}`)).status, 404);
    assert.equal((await adminFile(file.key)).status, 200);
    const restored = await call(`/api/admin/items/${item.id}/restore`, { method: "POST", body: { revision: removed.data.deleted.revision, fromRevision: item.revision } });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(restored.data.item.status, "draft");
    assert.equal((await publicGet(`/files/${file.key}`)).status, 404);
  });

  test("one file in a draft and in a published item is public (the published item uses it)", async () => {
    const file = (await upload(pdfBytes())).data.file;
    await createPdfItem(file.url);
    assert.equal((await publicGet(`/files/${file.key}`)).status, 404);
    await setStatus(await createPdfItem(file.url, { title: "Uploaded notes, published" }), "publish");
    assert.equal((await publicGet(`/files/${file.key}`)).status, 200);
  });

  test("a published item does not make a removed file public, nor does a look-alike address", async () => {
    const file = await publishedFile();
    db.raw.prepare("UPDATE files SET status = 'deleted' WHERE key = ?").run(file.key); // (never happens to a used file)
    assert.equal((await publicGet(`/files/${file.key}`)).status, 404);
    assert.equal((await adminFile(file.key)).status, 404);
    const other = (await upload(pdfBytes())).data.file;
    // Another item's text that merely mentions the address does not publish it.
    const article = await call("/api/admin/items", { method: "POST", body: { type: "article", categoryId: "cat_science", language: "en", title: "Mentions a file", blocks: [{ id: "b1", type: "paragraph", text: `[the notes](${other.url})` }] } });
    assert.equal(article.status, 201, JSON.stringify(article.data));
    await setStatus(article.data.item, "publish");
    assert.equal((await publicGet(`/files/${other.key}`)).status, 404);
  });

  test("admin address: Range, HEAD, download, never cached, CORS with credentials for the site only", async () => {
    const bytes = pdfBytes(1000);
    const file = (await upload(bytes, { name: "Draft notes.pdf" })).data.file;
    const part = await adminFile(file.key, { headers: { Range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.deepEqual(part.bytes, bytes.subarray(100, 200));
    const head = await adminFile(file.key, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "1000");
    const save = await adminFile(file.key, { query: "?download=1" });
    assert.match(save.headers.get("content-disposition"), /^attachment; filename="Draft notes.pdf"/);
    assert.equal(save.headers.get("cache-control"), "private, no-store");
    assert.equal(save.headers.get("x-robots-tag"), "noindex");
    assert.equal(save.headers.get("access-control-allow-origin"), SITE);
    assert.equal(save.headers.get("access-control-allow-credentials"), "true");
    assert.match(save.headers.get("access-control-expose-headers"), /Content-Range/);
    const foreign = await adminFile(file.key, { origin: "https://evil.example" });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null, "another site's page cannot read it");
    for (const path of [`/api/admin/files/pdf/2026/11/${"q".repeat(16)}-gone.pdf`, `/api/admin/files/${file.key}/../x`, "/api/admin/files/pdf%2f2026", `/api/admin/files/${file.key.toUpperCase()}`, "/api/admin/files/pdf/2026/11/x.pdf"]) {
      assert.equal((await call(path)).status, 404, path);
    }
    assert.equal((await call(`/api/admin/files/${file.key}`, { method: "DELETE", body: {} })).status, 405);
    const preflight = await worker.fetch(new Request(`${API}/api/admin/files/${file.key}`, { method: "OPTIONS", headers: { Origin: SITE, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range" } }), env);
    assert.match(preflight.headers.get("access-control-allow-headers"), /\bRange\b/);
  });
});

describe("PDF items use uploaded files", () => {
  test("saving an item with an upload marks it attached; an unknown upload address is refused", async () => {
    const file = (await upload(pdfBytes())).data.file;
    await createPdfItem(file.url);
    assert.equal(fileRow(file.key).status, "attached");
    const missing = await call("/api/admin/items", { method: "POST", body: pdfItem(`${API}/files/pdf/2026/11/abcdefghijklmnop-gone.pdf`) });
    assert.equal(missing.status, 422);
    assert.match(missing.data.fields.fileUrl, /does not exist/);
    const bad = await call("/api/admin/items", { method: "POST", body: pdfItem(`${API}/files/../../secrets.pdf`) });
    assert.equal(bad.status, 422);
    assert.ok(bad.data.fields.fileUrl);
  });

  test("an API on plain http (local testing) accepts its own uploads, and no other http address", async () => {
    env.PUBLIC_API_URL = "http://127.0.0.1:8788";
    const file = (await upload(pdfBytes())).data.file;
    assert.ok(file.url.startsWith("http://127.0.0.1:8788/files/pdf/"));
    const created = await call("/api/admin/items", { method: "POST", body: pdfItem(file.url) });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const other = await call("/api/admin/items", { method: "POST", body: { ...pdfItem("http://example.com/files/notes.pdf"), slug: "other-http" } });
    assert.equal(other.status, 422);
    assert.match(other.data.fields.fileUrl, /https:\/\//);
  });

  test("replacing the PDF keeps the old file, and restoring the old version uses it again", async () => {
    const first = (await upload(pdfBytes(), { name: "v1.pdf" })).data.file;
    const second = (await upload(pdfBytes(), { name: "v2.pdf" })).data.file;
    const item = await createPdfItem(first.url);
    const updated = await call(`/api/admin/items/${item.id}`, { method: "PATCH", body: { revision: 1, fileUrl: second.url } });
    assert.equal(updated.data.item.fileUrl, second.url);
    assert.ok(env.FILES.objects.has(first.key), "the old file stays");
    const restored = await call(`/api/admin/items/${item.id}/restore`, { method: "POST", body: { revision: 2, fromRevision: 1 } });
    assert.equal(restored.data.item.fileUrl, first.url);
    assert.equal((await adminFile(first.key)).status, 200);
    await setStatus(restored.data.item, "publish");
    assert.equal((await publicGet(`/files/${first.key}`)).status, 200);
  });

  test("existing items keep their site files (documents/…) unchanged", async () => {
    const row = db.raw.prepare("SELECT file_url FROM items WHERE id = 'itm_gradient_descent'").get();
    assert.equal(row.file_url, "documents/gradient-descent-lecture-notes.pdf");
    const patch = await call("/api/admin/items/itm_gradient_descent", { method: "PATCH", body: { revision: 1, title: "Gradient Descent: Lecture Notes (edited)" } });
    assert.equal(patch.status, 200);
    assert.equal(patch.data.item.fileUrl, "documents/gradient-descent-lecture-notes.pdf");
  });

  test("the record is written before the file: a failed R2 write leaves neither", async () => {
    env.FILES.put = async () => {
      throw new Error("R2 unavailable");
    };
    const res = await upload(pdfBytes());
    assert.equal(res.status, 500);
    assert.equal(res.data.error, "Internal error", "no details leak");
    assert.equal(fileCount(), 0);
    assert.equal(env.FILES.objects.size, 0);
  });

  test("random keys use the whole alphabet without bias toward early letters", async () => {
    const counts = new Map();
    for (let n = 0; n < 40; n += 1) {
      const token = (await upload(pdfBytes())).data.file.key.split("/").pop().slice(0, 16);
      for (const c of token) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    // 640 characters over 36 symbols (about 18 each): every count stays well below a biased "a".."d".
    assert.ok(counts.size >= 30, `symbols seen: ${counts.size}`);
    assert.ok(Math.max(...counts.values()) < 45);
  });
});

describe("scheduled clean-up of unused uploads", () => {
  const age = (...keys) => keys.forEach((key) => db.raw.prepare("UPDATE files SET uploaded_at = '2000-01-01T00:00:00.000Z' WHERE key = ?").run(key));
  const run = () => worker.scheduled({ cron: "23 * * * *", scheduledTime: Date.now() }, env, { waitUntil() {} });

  test("the hourly run removes only uploads older than a day that nothing uses", async () => {
    const unused = (await upload(pdfBytes(), { name: "unused.pdf" })).data.file;
    const used = (await upload(pdfBytes(), { name: "used.pdf" })).data.file;
    const replaced = (await upload(pdfBytes(), { name: "replaced.pdf" })).data.file;
    const fresh = (await upload(pdfBytes(), { name: "fresh.pdf" })).data.file;
    const item = await createPdfItem(replaced.url);
    await call(`/api/admin/items/${item.id}`, { method: "PATCH", body: { revision: 1, fileUrl: used.url } });
    // "replaced" is now only in the history; make three uploads look two days old.
    age(unused.key, used.key, replaced.key);
    db.raw.prepare("UPDATE files SET status = 'uploaded' WHERE key = ?").run(replaced.key); // even if it were never marked
    await run();
    assert.ok(!env.FILES.objects.has(unused.key));
    for (const kept of [used, replaced, fresh]) assert.ok(env.FILES.objects.has(kept.key), kept.name);
    assert.equal(fileRow(unused.key).status, "deleted");
    assert.ok(fileRow(unused.key).deleted_at);
    assert.equal((await publicGet(`/files/${unused.key}`)).status, 404);
    assert.equal((await adminFile(unused.key)).status, 404);
    // Saving an item with the removed upload is refused with a clear message.
    const late = await call("/api/admin/items", { method: "POST", body: pdfItem(unused.url) });
    assert.equal(late.status, 422);
    assert.match(late.data.fields.fileUrl, /upload it again/);
  });

  test("uploading no longer removes anything: only the scheduled run does", async () => {
    const old = (await upload(pdfBytes())).data.file;
    age(old.key);
    await upload(pdfBytes());
    assert.ok(env.FILES.objects.has(old.key));
    assert.equal(fileRow(old.key).status, "uploaded");
    assert.deepEqual(await cleanupOrphans(env), [old.key]);
  });

  test("a file mentioned anywhere in an item or its history is kept (text links, related links, deleted items)", async () => {
    const inText = (await upload(pdfBytes(), { name: "in-text.pdf" })).data.file;
    const inLinks = (await upload(pdfBytes(), { name: "in-links.pdf" })).data.file;
    const ofDeleted = (await upload(pdfBytes(), { name: "of-deleted.pdf" })).data.file;
    const article = await call("/api/admin/items", { method: "POST", body: { type: "article", categoryId: "cat_science", language: "en", title: "Links to uploads", blocks: [{ id: "b1", type: "paragraph", text: `See [the notes](${inText.url}).` }], links: [{ label: "Slides", url: inLinks.url }] } });
    assert.equal(article.status, 201, JSON.stringify(article.data));
    const item = await createPdfItem(ofDeleted.url);
    await call(`/api/admin/items/${item.id}`, { method: "DELETE", body: { revision: 1 } });
    for (const f of [inText, inLinks, ofDeleted]) db.raw.prepare("UPDATE files SET status = 'uploaded', uploaded_at = '2000-01-01T00:00:00.000Z' WHERE key = ?").run(f.key);
    assert.deepEqual(await cleanupOrphans(env), []);
    for (const f of [inText, inLinks, ofDeleted]) assert.ok(env.FILES.objects.has(f.key), f.name);
    // Even without its history (never pruned today), a live item keeps its files.
    db.raw.prepare("DELETE FROM revisions WHERE entity_id = ?").run(article.data.item.id);
    assert.deepEqual(await cleanupOrphans(env), []);
    for (const f of [inText, inLinks]) assert.ok(env.FILES.objects.has(f.key), f.name);
  });

  test("a removal interrupted half way (R2 failed, or the run stopped) is finished by the next run", async () => {
    const a = (await upload(pdfBytes(), { name: "a.pdf" })).data.file;
    const b = (await upload(pdfBytes(), { name: "b.pdf" })).data.file;
    age(a.key, b.key);
    const realDelete = env.FILES.delete.bind(env.FILES);
    env.FILES.delete = async (key) => {
      if (key === a.key) throw new Error("R2 timeout");
      return realDelete(key);
    };
    assert.deepEqual(await cleanupOrphans(env), [b.key], "one failure does not stop the others");
    assert.equal(fileRow(a.key).status, "deleting");
    assert.equal((await adminFile(a.key)).status, 404, "on its way out: not served, even to the admin");
    env.FILES.delete = realDelete;
    assert.deepEqual(await cleanupOrphans(env), [a.key]);
    assert.equal(fileRow(a.key).status, "deleted");
    assert.ok(!env.FILES.objects.has(a.key));
  });

  test("an item saved at the very moment its upload is being removed fails as a whole (nothing points at a missing file)", async () => {
    const file = (await upload(pdfBytes())).data.file;
    const itemsBefore = Number(db.raw.prepare("SELECT count(*) AS n FROM items").get().n);
    const revisionsBefore = Number(db.raw.prepare("SELECT count(*) AS n FROM revisions").get().n);
    // The clean-up claims the file right after the save checked it.
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = realPrepare(sql);
      if (!sql.startsWith("SELECT status FROM files")) return statement;
      return { bind: (...params) => ({ first: async () => {
        const found = await statement.bind(...params).first();
        db.raw.prepare("UPDATE files SET status = 'deleting' WHERE key = ?").run(params[0]);
        return found;
      } }) };
    };
    const res = await call("/api/admin/items", { method: "POST", body: pdfItem(file.url) });
    db.prepare = realPrepare;
    assert.equal(res.status, 422, JSON.stringify(res.data));
    assert.match(res.data.fields.fileUrl, /upload it again/);
    assert.equal(Number(db.raw.prepare("SELECT count(*) AS n FROM items").get().n), itemsBefore);
    assert.equal(Number(db.raw.prepare("SELECT count(*) AS n FROM revisions").get().n), revisionsBefore);
    assert.throws(() => db.raw.prepare("UPDATE files SET status = 'uploaded' WHERE key = ?").run(file.key), /removed file cannot be used again/);
  });

  test("a save that wins the race keeps the file (the claim only takes unused uploads)", async () => {
    const file = (await upload(pdfBytes())).data.file;
    age(file.key);
    await createPdfItem(file.url); // saved before the run
    db.raw.prepare("UPDATE files SET status = 'uploaded' WHERE key = ?").run(file.key); // as if the run had already listed it
    assert.deepEqual(await cleanupOrphans(env), []);
    assert.ok(env.FILES.objects.has(file.key));
  });

  test("at most 25 per run; the rest goes in the next runs", async () => {
    const keys = [];
    for (let n = 0; n < 30; n += 1) keys.push((await upload(pdfBytes())).data.file.key);
    age(...keys);
    assert.equal((await cleanupOrphans(env)).length, 25);
    assert.equal((await cleanupOrphans(env)).length, 5);
    assert.equal(env.FILES.objects.size, 0);
  });

  test("without storage or with nothing to do, the run does nothing", async () => {
    assert.deepEqual(await cleanupOrphans(env), []);
    delete env.FILES;
    await run();
  });
});

/* ------------------------------------------------------------ YouTube */

const VIDEO = "aircAruvnKk";
const dataApiAnswer = (snippet, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { items: snippet ? [{ id: VIDEO, snippet }] : [] } : snippet), { status, headers: { "Content-Type": "application/json" } });
const SNIPPET = {
  title: "But what is a neural network? | Deep learning chapter 1",
  description: "What are the neurons, why are there layers?\n\nTimestamps:\n0:00 Introduction",
  tags: ["neural networks", "machine learning", "  "],
  channelId: "UCYO_jab_esuFRV4b17AJtAw",
  channelTitle: "3Blue1Brown",
  publishedAt: "2017-10-05T17:00:01Z",
  thumbnails: { high: { url: "https://i.ytimg.com/vi/aircAruvnKk/hqdefault.jpg" }, maxres: { url: "https://i.ytimg.com/vi/aircAruvnKk/maxresdefault.jpg" } },
  defaultAudioLanguage: "en",
};

describe("YouTube video information (admin)", () => {
  test("with the API key: title, description, tags, channel and thumbnail; the key is never returned", async () => {
    env.YOUTUBE_API_KEY = "secret-key-123";
    let requested = "";
    youtube = (url) => {
      requested = url;
      return dataApiAnswer(SNIPPET);
    };
    const res = await call(`/api/admin/youtube/${VIDEO}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const v = res.data.video;
    assert.equal(v.source, "youtube-api");
    assert.equal(v.title, SNIPPET.title);
    assert.equal(v.description, SNIPPET.description);
    assert.deepEqual(v.tags, ["neural networks", "machine learning"]);
    assert.equal(v.channelTitle, "3Blue1Brown");
    assert.equal(v.channelUrl, "https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw");
    assert.equal(v.thumbnailUrl, SNIPPET.thumbnails.maxres.url);
    assert.deepEqual(v.missing, []);
    assert.match(requested, /^https:\/\/www\.googleapis\.com\/youtube\/v3\/videos\?part=snippet&id=aircAruvnKk&/);
    assert.ok(!JSON.stringify(res.data).includes("secret-key-123"));
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("missing description and tags are reported, never invented", async () => {
    env.YOUTUBE_API_KEY = "k";
    youtube = () => dataApiAnswer({ ...SNIPPET, description: "", tags: undefined });
    const v = (await call(`/api/admin/youtube/${VIDEO}`)).data.video;
    assert.equal(v.description, "");
    assert.deepEqual(v.tags, []);
    assert.deepEqual(v.missing, ["description", "tags"]);
  });

  test("Arabic titles come through exactly", async () => {
    env.YOUTUBE_API_KEY = "k";
    youtube = () => dataApiAnswer({ ...SNIPPET, title: "كيف تعمل الشبكات العصبية؟ 🙂", defaultLanguage: "ar" });
    const v = (await call(`/api/admin/youtube/${VIDEO}`)).data.video;
    assert.equal(v.title, "كيف تعمل الشبكات العصبية؟ 🙂");
    assert.equal(v.language, "ar");
  });

  test("unavailable videos, quota, bad key and network failures have clear answers", async () => {
    env.YOUTUBE_API_KEY = "k";
    youtube = () => dataApiAnswer(null);
    assert.equal((await call(`/api/admin/youtube/${VIDEO}`)).data.code, "video_not_found");
    youtube = () => dataApiAnswer({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403);
    const quota = await call(`/api/admin/youtube/${VIDEO}`);
    assert.equal(quota.status, 503);
    assert.equal(quota.data.code, "youtube_quota");
    youtube = () => dataApiAnswer({ error: { errors: [{ reason: "keyInvalid" }] } }, 400);
    assert.equal((await call(`/api/admin/youtube/${VIDEO}`)).data.code, "youtube_config");
    youtube = () => {
      throw new TypeError("network down");
    };
    assert.equal((await call(`/api/admin/youtube/${VIDEO}`)).data.code, "youtube_unreachable");
  });

  test("without the key: oEmbed gives title and channel only, and says so", async () => {
    let requested = "";
    youtube = (url) => {
      requested = url;
      return new Response(JSON.stringify({ title: "The Egg", author_name: "Kurzgesagt", author_url: "https://www.youtube.com/@kurzgesagt", thumbnail_url: "https://i.ytimg.com/vi/x/hqdefault.jpg" }));
    };
    const v = (await call(`/api/admin/youtube/${VIDEO}`)).data.video;
    assert.match(requested, /^https:\/\/www\.youtube\.com\/oembed\?url=/);
    assert.equal(v.source, "youtube-oembed");
    assert.equal(v.title, "The Egg");
    assert.equal(v.channelUrl, "https://www.youtube.com/@kurzgesagt");
    assert.deepEqual(v.missing, ["description", "tags"]);
    youtube = () => new Response("Unauthorized", { status: 401 });
    assert.equal((await call(`/api/admin/youtube/${VIDEO}`)).data.code, "video_not_found");
  });

  test("admin only, exact ids, rate limited", async () => {
    youtube = () => new Response(JSON.stringify({ title: "T", author_name: "C", author_url: "https://www.youtube.com/@c" }));
    assert.equal((await call(`/api/admin/youtube/${VIDEO}`, { token: null })).status, 401);
    for (const id of ["short", "aircAruvnKk1", "airc%2FruvnK", "..%2Fsession", "aircAruvnK!"]) {
      assert.equal((await call(`/api/admin/youtube/${id}`)).status, 404, id);
    }
    let last = 0;
    for (let i = 0; i <= RATE_LIMIT; i += 1) last = (await call(`/api/admin/youtube/${VIDEO}`)).status;
    assert.equal(last, 429);
  });
});

describe("video items keep the original description and the fetched information", () => {
  const INFO = { source: "youtube-api", fetchedAt: "2026-11-08T10:00:00.000Z", videoId: VIDEO, title: SNIPPET.title, description: SNIPPET.description, tags: ["neural networks"], channelTitle: "3Blue1Brown", channelUrl: "https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw", thumbnailUrl: "https://i.ytimg.com/vi/aircAruvnKk/hqdefault.jpg" };
  const VIDEO_ITEM = { type: "youtube", categoryId: "cat_science", language: "en", title: "Neural networks", videoUrl: `https://youtu.be/${VIDEO}`, videoDescription: SNIPPET.description, videoInfo: INFO };

  test("stored; visitors get the description, only the admin gets the fetched information", async () => {
    const created = await call("/api/admin/items", { method: "POST", body: VIDEO_ITEM });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.item.videoDescription, SNIPPET.description);
    assert.deepEqual(created.data.item.videoInfo, INFO);
    const { id, slug } = created.data.item;
    await call(`/api/admin/items/${id}/publish`, { method: "POST", body: { revision: 1 } });
    const pub = (await publicGet(`/api/items/${slug}`)).data;
    assert.equal(pub.videoDescription, SNIPPET.description);
    assert.equal("videoInfo" in pub, false);
    const list = (await publicGet("/api/items")).data.find((item) => item.slug === slug);
    assert.equal("videoDescription" in list, false, "the list stays small");
  });

  test("rules: size, control characters, shape, YouTube-only addresses, videos only", async () => {
    const bad = async (changes) => (await call("/api/admin/items", { method: "POST", body: { ...VIDEO_ITEM, ...changes } })).data.fields;
    assert.ok((await bad({ videoDescription: "x".repeat(5001) })).videoDescription);
    assert.ok((await bad({ videoDescription: "bell\u0007" })).videoDescription);
    assert.ok((await bad({ videoInfo: { ...INFO, extra: 1 } })).videoInfo);
    assert.ok((await bad({ videoInfo: { ...INFO, channelUrl: "https://evil.example/" } })).videoInfo);
    assert.ok((await bad({ videoInfo: { ...INFO, thumbnailUrl: "javascript:alert(1)" } })).videoInfo);
    assert.ok((await bad({ videoInfo: { ...INFO, videoId: "nope" } })).videoInfo);
    const article = await call("/api/admin/items", { method: "POST", body: { type: "article", categoryId: "cat_science", language: "en", title: "A", blocks: [{ id: "b1", type: "paragraph", text: "x" }], videoDescription: "no" } });
    assert.match(article.data.fields.videoDescription, /not an accepted field/);
  });

  test("editing other fields leaves them untouched; null clears the information", async () => {
    const { id } = (await call("/api/admin/items", { method: "POST", body: VIDEO_ITEM })).data.item;
    const edited = (await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 1, title: "Changed" } })).data.item;
    assert.equal(edited.videoDescription, SNIPPET.description);
    assert.deepEqual(edited.videoInfo, INFO);
    const cleared = (await call(`/api/admin/items/${id}`, { method: "PATCH", body: { revision: 2, videoInfo: null, videoDescription: "" } })).data.item;
    assert.equal(cleared.videoInfo, null);
    assert.equal("videoDescription" in cleared, false);
  });
});

/* ------------------------------------------------------------ new blocks */

describe("rich text: third heading level, divider, nested lists", () => {
  const article = (blocks) => ({ type: "article", categoryId: "cat_science", language: "en", title: "Blocks", blocks });

  test("accepted and counted for reading time", async () => {
    const blocks = [
      { id: "h", type: "heading", level: 4, text: "Small heading" },
      { id: "d", type: "divider" },
      { id: "l", type: "list", ordered: false, items: ["one", { text: "two", list: { ordered: true, items: ["a", { text: "b", list: { items: ["deep"] } }] } }] },
    ];
    const res = await call("/api/admin/items", { method: "POST", body: article(blocks) });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.deepEqual(res.data.item.blocks, blocks);
    assert.equal(res.data.item.readingMinutes, 1);
  });

  test("refused: heading level 5, divider with text, lists deeper than 3, empty nested items", async () => {
    const fields = async (blocks) => (await call("/api/admin/items", { method: "POST", body: article(blocks) })).data.fields?.blocks ?? "";
    assert.match(await fields([{ id: "h", type: "heading", level: 5, text: "x" }]), /level/);
    assert.match(await fields([{ id: "d", type: "divider", text: "x" }]), /not allowed/);
    assert.match(await fields([{ id: "l", type: "list", items: [{ text: "1", list: { items: [{ text: "2", list: { items: [{ text: "3", list: { items: ["4"] } }] } }] } }] }]), /3 levels/);
    assert.match(await fields([{ id: "l", type: "list", items: [{ text: "", list: { items: ["x"] } }] }]), /must not be empty/);
    assert.match(await fields([{ id: "l", type: "list", items: [{ text: "x", list: { items: [] } }] }]), /non-empty/);
    assert.match(await fields([{ id: "l", type: "list", items: [{ text: "x", extra: 1, list: { items: ["y"] } }] }]), /nested list/);
  });
});
