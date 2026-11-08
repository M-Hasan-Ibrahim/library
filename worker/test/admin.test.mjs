// Handler tests for the admin API and its isolation from the public API.
// They call the real Worker entry point (worker/src/index.js) with a fake
// Cloudflare environment. Run: npm run test:worker
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { clearSigningKeyCache } from "../src/access.js";
import worker from "../src/index.js";
import { ADMIN, AUD, CERTS_URL, createSigningKey, nowSeconds, signToken, SITE, TEAM, validClaims } from "./helpers.mjs";

const trusted = await createSigningKey("trusted-kid");
const attacker = await createSigningKey("trusted-kid");

// Minimal D1 stand-in for the public routes used here.
const fakeDb = {
  prepare: () => ({
    bind() {
      return this;
    },
    all: async () => ({ results: [{ code: "en", name: "English", native_name: "English", dir: "ltr" }] }),
    first: async () => null,
  }),
  batch: async (statements) => statements.map(() => ({ results: [] })),
};

const baseEnv = {
  ALLOWED_ORIGINS: SITE,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ADMIN_EMAIL: ADMIN,
  SITE_URL: `${SITE}/`,
  DB: fakeDb,
};

let keysAvailable;
const realFetch = globalThis.fetch;
beforeEach(() => {
  clearSigningKeyCache();
  keysAvailable = true;
  globalThis.fetch = async (url, init) => {
    if (String(url) === CERTS_URL) {
      if (!keysAvailable) throw new Error("network down");
      return new Response(JSON.stringify({ keys: [trusted.jwk] }), { headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url, init);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const goodToken = () => signToken(validClaims(), trusted);

async function call(path, { method = "GET", origin, token, headers = {}, env = baseEnv } = {}) {
  const requestHeaders = { ...headers };
  if (origin) requestHeaders.Origin = origin;
  if (token) requestHeaders["Cf-Access-Jwt-Assertion"] = token;
  const response = await worker.fetch(
    new Request(`https://api.library.mh-ibrahim.com${path}`, { method, headers: requestHeaders }),
    env,
  );
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, headers: response.headers, body, text };
}

describe("GET /api/admin/session", () => {
  test("valid token from the site -> 200 with the admin email, credentialed CORS, no-store", async () => {
    const res = await call("/api/admin/session", { origin: SITE, token: await goodToken() });
    assert.equal(res.status, 200);
    assert.equal(res.body.email, ADMIN);
    assert.match(res.body.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("access-control-allow-origin"), SITE);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.equal(res.headers.get("vary"), "Origin");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test("valid token from another origin -> no CORS headers (a browser there cannot read it)", async () => {
    const res = await call("/api/admin/session", { origin: "https://evil.example", token: await goodToken() });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });

  test("HEAD -> 200 with an empty body", async () => {
    const res = await call("/api/admin/session", { method: "HEAD", token: await goodToken() });
    assert.equal(res.status, 200);
    assert.equal(res.text, "");
  });

  const rejected = [
    ["no token", async () => undefined],
    ["token signed by another key", () => signToken(validClaims(), attacker)],
    ["expired token", () => signToken(validClaims({ exp: nowSeconds() - 5 }), trusted)],
    ["token for another email", () => signToken(validClaims({ email: "someone@example.com" }), trusted)],
    ["token for another Access application", () => signToken(validClaims({ aud: ["b".repeat(64)] }), trusted)],
    ["garbage token", async () => "not.a.jwt"],
  ];
  for (const [label, makeToken] of rejected) {
    test(`${label} -> 401, no data`, async () => {
      const res = await call("/api/admin/session", { origin: SITE, token: await makeToken() });
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: "Unauthorized" });
      assert.equal(res.headers.get("cache-control"), "no-store");
    });
  }

  test("token only in the CF_Authorization cookie (not from Access) -> 401", async () => {
    const res = await call("/api/admin/session", { headers: { Cookie: `CF_Authorization=${await goodToken()}` } });
    assert.equal(res.status, 401);
  });

  test("signing keys unavailable -> 503 (fails closed)", async () => {
    keysAvailable = false;
    const res = await call("/api/admin/session", { token: await goodToken() });
    assert.equal(res.status, 503);
  });

  test("sign-in not configured (no ADMIN_EMAIL) -> 503 for every admin request", async () => {
    const env = { ...baseEnv, ADMIN_EMAIL: undefined };
    const res = await call("/api/admin/session", { token: await goodToken(), env });
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: "Admin sign-in is not configured" });
  });
});

describe("GET /api/admin/login", () => {
  test("valid token -> 302 to the fixed Library address", async () => {
    const res = await call("/api/admin/login", { token: await goodToken() });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `${SITE}/?admin=signed-in#/`);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("redirect target cannot be chosen by the request (no open redirect)", async () => {
    const token = await goodToken();
    for (const query of ["?next=https://evil.example", "?redirect_url=//evil.example", "?return=javascript:alert(1)"]) {
      const res = await call(`/api/admin/login${query}`, { token });
      assert.equal(res.headers.get("location"), `${SITE}/?admin=signed-in#/`, query);
    }
  });

  test("no or invalid token -> 401, no redirect", async () => {
    for (const token of [undefined, await signToken(validClaims(), attacker)]) {
      const res = await call("/api/admin/login", { token });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("location"), null);
    }
  });

  test("Cloudflare-started logins landing on /api/admin/*, %2A or /api/admin/ -> same fixed redirect", async () => {
    const token = await goodToken();
    for (const path of ["/api/admin/*", "/api/admin/%2A", "/api/admin/%2a", "/api/admin/"]) {
      const res = await call(path, { token });
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get("location"), `${SITE}/?admin=signed-in#/`, path);
      assert.equal(res.headers.get("cache-control"), "no-store", path);
    }
  });

  test("those landing paths still require a valid token and allow GET only", async () => {
    for (const path of ["/api/admin/*", "/api/admin/"]) {
      const res = await call(path);
      assert.equal(res.status, 401, path);
      assert.equal(res.headers.get("location"), null, path);
      assert.equal((await call(path, { token: await signToken(validClaims(), attacker) })).status, 401, path);
      assert.equal((await call(path, { method: "POST", token: await goodToken() })).status, 405, path);
    }
  });

  test("SITE_URL missing or not an allowed origin -> 503", async () => {
    const token = await goodToken();
    for (const SITE_URL of [undefined, "https://evil.example/", "not a url"]) {
      const res = await call("/api/admin/login", { token, env: { ...baseEnv, SITE_URL } });
      assert.equal(res.status, 503, String(SITE_URL));
      assert.equal(res.headers.get("location"), null);
    }
  });
});

describe("other admin requests", () => {
  test("unknown admin path: 401 without a token, 404 with one (no path discovery)", async () => {
    assert.equal((await call("/api/admin/nothing-here")).status, 401);
    assert.equal((await call("/api/admin/nothing-here", { token: await goodToken() })).status, 404);
    assert.equal((await call("/api/admin/session/", { token: await goodToken() })).status, 404);
    assert.equal((await call("/api/admin/items/not-an-id", { token: await goodToken() })).status, 404);
  });

  test("methods a route does not support: 401 without a token, 405 with one", async () => {
    const token = await goodToken();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal((await call("/api/admin/session", { method })).status, 401, method);
      const res = await call("/api/admin/session", { method, token });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get("allow"), "GET, HEAD");
    }
    const login = await call("/api/admin/login", { method: "POST", token });
    assert.equal(login.status, 405);
    assert.equal(login.headers.get("allow"), "GET, HEAD");
  });

  test("preflight from the site -> 204 with credentialed CORS (no token needed, no data)", async () => {
    const res = await call("/api/admin/session", { method: "OPTIONS", origin: SITE });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), SITE);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.equal(res.headers.get("access-control-allow-methods"), "GET, HEAD, POST, PATCH, DELETE, OPTIONS");
    assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type");
    assert.equal(res.text, "");
  });

  test("preflight from another origin -> 204 without CORS headers", async () => {
    const res = await call("/api/admin/session", { method: "OPTIONS", origin: "https://evil.example" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });
});

describe("public API is unchanged", () => {
  test("GET /api/languages: public cache, CORS for the site, never credentials", async () => {
    const res = await call("/api/languages", { origin: SITE });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ code: "en", name: "English", nativeName: "English", dir: "ltr" }]);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    assert.equal(res.headers.get("access-control-allow-origin"), SITE);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });

  test("public endpoints work even when admin sign-in is not configured", async () => {
    const env = { ...baseEnv, ACCESS_AUD: undefined, ADMIN_EMAIL: undefined };
    assert.equal((await call("/api/languages", { env })).status, 200);
  });

  test("public preflight and write methods behave as before", async () => {
    const pre = await call("/api/items", { method: "OPTIONS", origin: SITE });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
    assert.equal(pre.headers.get("access-control-allow-credentials"), null);
    const post = await call("/api/items", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");
  });

  test("/api/admin without a trailing slash is not an admin route (plain 404)", async () => {
    const res = await call("/api/admin", { origin: SITE });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });

  test("a public 404 is unchanged", async () => {
    const res = await call("/api/nothing");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Not found" });
  });
});
