// Unit tests for Cloudflare Access JWT verification (worker/src/access.js).
// Run: npm run test:worker
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { AccessError, clearSigningKeyCache, readAccessConfig, verifyAccessToken } from "../src/access.js";
import { ADMIN, AUD, b64url, config, createSigningKey, ISSUER, keyFetcher, nowSeconds, signToken, TEAM, validClaims } from "./helpers.mjs";

const trusted = await createSigningKey("trusted-kid");
const attacker = await createSigningKey("trusted-kid"); // same kid, different key
const rotated = await createSigningKey("rotated-kid");

const rejects = (promise, reason) =>
  assert.rejects(promise, (error) => error instanceof AccessError && error.reason === reason, `expected ${reason}`);

let fetchKeys;
const verify = (token, options = {}) => verifyAccessToken(token, config, { fetchKeys, ...options });

beforeEach(() => {
  clearSigningKeyCache();
  fetchKeys = keyFetcher(trusted);
});

describe("valid tokens", () => {
  test("a correctly signed admin token is accepted", async () => {
    const claims = validClaims();
    const session = await verify(await signToken(claims, trusted));
    assert.deepEqual(session, { email: ADMIN, expiresAt: new Date(claims.exp * 1000).toISOString() });
  });

  test("aud may be a single string", async () => {
    await verify(await signToken(validClaims({ aud: AUD }), trusted));
  });

  test("email comparison ignores letter case only", async () => {
    const session = await verify(await signToken(validClaims({ email: ADMIN.toUpperCase() }), trusted));
    assert.equal(session.email, ADMIN);
  });

  test("nbf/iat slightly in the future are tolerated (clock skew)", async () => {
    await verify(await signToken(validClaims({ nbf: nowSeconds() + 20, iat: nowSeconds() + 20 }), trusted));
  });

  test("nbf and iat are optional", async () => {
    const { nbf, iat, ...claims } = validClaims();
    await verify(await signToken(claims, trusted));
  });
});

describe("missing or malformed tokens", () => {
  for (const [label, token] of [["undefined", undefined], ["null", null], ["empty", ""]]) {
    test(`${label} -> missing_token`, () => rejects(verify(token), "missing_token"));
  }
  for (const [label, token] of [
    ["one part", "abc"],
    ["two parts", "abc.def"],
    ["four parts", "a.b.c.d"],
    ["empty signature", `${b64url('{"alg":"RS256","kid":"trusted-kid"}')}.${b64url("{}")}.`],
    ["non-base64url characters", "a+b.c/d.e=f"],
    ["header is not JSON", `${b64url("nope")}.${b64url("{}")}.${b64url("x")}`],
    ["header is an array", `${b64url("[1]")}.${b64url("{}")}.${b64url("x")}`],
    ["over 8 KB", `${"a".repeat(5000)}.${"b".repeat(5000)}.c`],
  ]) {
    test(`${label} -> malformed`, () => rejects(verify(token), "malformed"));
  }

  test("missing kid -> malformed", async () => {
    const token = await signToken(validClaims(), trusted, { kid: undefined });
    await rejects(verify(token), "malformed");
  });

  test("payload that is not JSON (validly signed) -> malformed", async () => {
    const header = b64url(JSON.stringify({ alg: "RS256", kid: trusted.kid }));
    const payload = b64url("not json");
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", trusted.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    await rejects(verify(`${header}.${payload}.${b64url(new Uint8Array(signature))}`), "malformed");
  });
});

describe("forged tokens", () => {
  test('alg "none" -> unsupported_alg', async () => {
    const token = `${b64url(JSON.stringify({ alg: "none", kid: trusted.kid }))}.${b64url(JSON.stringify(validClaims()))}.AA`;
    await rejects(verify(token), "unsupported_alg");
  });

  test("alg HS256 (key-confusion attempt) -> unsupported_alg", async () => {
    const header = b64url(JSON.stringify({ alg: "HS256", kid: trusted.kid }));
    const payload = b64url(JSON.stringify(validClaims()));
    const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(trusted.jwk.n), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${header}.${payload}`));
    await rejects(verify(`${header}.${payload}.${b64url(new Uint8Array(signature))}`), "unsupported_alg");
  });

  test("signed by another key with the trusted kid -> bad_signature", async () => {
    await rejects(verify(await signToken(validClaims(), attacker)), "bad_signature");
  });

  test("key embedded in the token header is ignored -> bad_signature", async () => {
    const token = await signToken(validClaims(), attacker, { jwk: attacker.jwk, jku: "https://evil.example/keys" });
    await rejects(verify(token), "bad_signature");
  });

  test("payload changed after signing -> bad_signature", async () => {
    const [header, , signature] = (await signToken(validClaims({ email: "someone@example.com" }), trusted)).split(".");
    const forgedPayload = b64url(JSON.stringify(validClaims()));
    await rejects(verify(`${header}.${forgedPayload}.${signature}`), "bad_signature");
  });

  test("signature changed -> bad_signature", async () => {
    const [header, payload] = (await signToken(validClaims(), trusted)).split(".");
    const other = (await signToken(validClaims({ exp: nowSeconds() + 7200 }), trusted)).split(".")[2];
    await rejects(verify(`${header}.${payload}.${other}`), "bad_signature");
  });

  test("unknown kid -> unknown_key", async () => {
    await rejects(verify(await signToken(validClaims(), rotated)), "unknown_key");
  });
});

describe("claims", () => {
  const cases = [
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }, "bad_issuer"],
    ["http issuer", { iss: `http://${TEAM}` }, "bad_issuer"],
    ["missing issuer", { iss: undefined }, "bad_issuer"],
    ["wrong audience", { aud: ["b".repeat(64)] }, "bad_audience"],
    ["missing audience", { aud: undefined }, "bad_audience"],
    ["audience as a prefix", { aud: [AUD.slice(0, 32)] }, "bad_audience"],
    ["expired", { exp: nowSeconds() - 1 }, "expired"],
    ["expires right now", { exp: nowSeconds() }, "expired"],
    ["missing exp", { exp: undefined }, "no_expiry"],
    ["exp as a string", { exp: String(nowSeconds() + 3600) }, "no_expiry"],
    ["nbf in the future", { nbf: nowSeconds() + 120 }, "not_yet_valid"],
    ["iat in the future", { iat: nowSeconds() + 120 }, "issued_in_future"],
    ["different email", { email: "someone@example.com" }, "not_admin"],
    ["missing email", { email: undefined }, "not_admin"],
    ["admin email with a suffix", { email: `${ADMIN}.evil.com` }, "not_admin"],
    ["admin email with spaces", { email: ` ${ADMIN} ` }, "not_admin"],
    ["email as a list", { email: [ADMIN] }, "not_admin"],
  ];
  for (const [label, overrides, reason] of cases) {
    test(`${label} -> ${reason}`, async () => {
      await rejects(verify(await signToken(validClaims(overrides), trusted)), reason);
    });
  }
});

describe("public keys", () => {
  test("keys are fetched once and cached", async () => {
    await verify(await signToken(validClaims(), trusted));
    await verify(await signToken(validClaims(), trusted));
    assert.equal(fetchKeys.calls, 1);
  });

  test("unknown kids re-read the keys at most once per minute", async () => {
    const now = Date.now();
    await verify(await signToken(validClaims(), trusted), { now });
    await rejects(verify(await signToken(validClaims(), rotated), { now: now + 1000 }), "unknown_key");
    await rejects(verify(await signToken(validClaims(), rotated), { now: now + 2000 }), "unknown_key");
    assert.equal(fetchKeys.calls, 1, "no refetch within a minute");
    await rejects(verify(await signToken(validClaims(), rotated), { now: now + 61_000 }), "unknown_key");
    assert.equal(fetchKeys.calls, 2, "one refetch after a minute");
  });

  test("rotated keys are picked up", async () => {
    const now = Date.now();
    await verify(await signToken(validClaims(), trusted), { now });
    fetchKeys.jwks = [trusted.jwk, rotated.jwk];
    await verify(await signToken(validClaims(), rotated), { now: now + 61_000 });
  });

  test("no keys available (network down) -> keys_unavailable", async () => {
    fetchKeys.fail = true;
    await rejects(verify(await signToken(validClaims(), trusted)), "keys_unavailable");
  });

  test("response without usable RS256 keys -> keys_unavailable", async () => {
    fetchKeys.jwks = [{ kid: "x", kty: "EC", crv: "P-256" }, { ...trusted.jwk, alg: "RS512" }, { kid: "y", kty: "RSA", e: "AQAB" }];
    await rejects(verify(await signToken(validClaims(), trusted)), "keys_unavailable");
  });

  test("cached keys keep working when a refresh fails", async () => {
    const now = Date.now();
    await verify(await signToken(validClaims(), trusted), { now });
    fetchKeys.fail = true;
    const later = now + 2 * 60 * 60 * 1000;
    const claims = validClaims({ iat: Math.floor(later / 1000) - 10, nbf: Math.floor(later / 1000) - 10, exp: Math.floor(later / 1000) + 3600 });
    await verify(await signToken(claims, trusted), { now: later });
    assert.equal(fetchKeys.calls, 3, "1 initial fetch + 2 failed refresh attempts");
  });

  // Regression tests for the intermittent "Sign-in is temporarily unavailable" (503).
  test("simultaneous requests in a fresh instance share one key fetch and all succeed", async () => {
    fetchKeys.delayMs = 150;
    const token = await signToken(validClaims(), trusted);
    const results = await Promise.allSettled([verify(token), verify(token), verify(token)]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"]);
    assert.equal(fetchKeys.calls, 1);
  });

  test("a transient fetch error is retried within the same request", async () => {
    fetchKeys.failNext = 1;
    await verify(await signToken(validClaims(), trusted));
    assert.equal(fetchKeys.calls, 2);
  });

  test("after a failed key fetch, sign-in recovers within seconds (not a minute)", async () => {
    const now = Date.now();
    const token = await signToken(validClaims(), trusted);
    fetchKeys.fail = true;
    await rejects(verify(token, { now }), "keys_unavailable");
    assert.equal(fetchKeys.calls, 2, "two attempts");
    fetchKeys.fail = false;
    await rejects(verify(token, { now: now + 1000 }), "keys_unavailable");
    assert.equal(fetchKeys.calls, 2, "no new fetch within 2 seconds");
    await verify(token, { now: now + 3000 });
    assert.equal(fetchKeys.calls, 3, "retried after 2 seconds and succeeded");
  });
});

describe("configuration", () => {
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAIL: ADMIN };

  test("valid settings", () => {
    assert.deepEqual(readAccessConfig(env), { teamDomain: TEAM, audience: AUD, adminEmail: ADMIN, issuer: ISSUER });
  });

  test("settings are normalised (case, spaces)", () => {
    assert.deepEqual(
      readAccessConfig({ ACCESS_TEAM_DOMAIN: ` ${TEAM.toUpperCase()} `, ACCESS_AUD: AUD.toUpperCase(), ADMIN_EMAIL: ` ${ADMIN.toUpperCase()} ` }),
      { teamDomain: TEAM, audience: AUD, adminEmail: ADMIN, issuer: ISSUER },
    );
  });

  for (const [label, overrides] of [
    ["missing team domain", { ACCESS_TEAM_DOMAIN: undefined }],
    ["team domain outside cloudflareaccess.com", { ACCESS_TEAM_DOMAIN: "evil.example.com" }],
    ["team domain with a path", { ACCESS_TEAM_DOMAIN: `${TEAM}/x` }],
    ["missing audience", { ACCESS_AUD: undefined }],
    ["short audience", { ACCESS_AUD: "abc" }],
    ["missing admin email", { ADMIN_EMAIL: undefined }],
    ["admin email without @", { ADMIN_EMAIL: "admin.example.com" }],
  ]) {
    test(`${label} -> not configured`, () => assert.equal(readAccessConfig({ ...env, ...overrides }), null));
  }
});
