/**
 * Cloudflare Access token verification for the admin API.
 *
 * Cloudflare Access sits in front of /api/admin/* and forwards each allowed
 * request with a signed JWT in the `Cf-Access-Jwt-Assertion` header. Access
 * alone is not trusted: this module checks the token on every request, so a
 * misconfigured Access path or any way around Access still gets a 401.
 *
 * Checks, in order (the claims are only read after the signature is valid):
 *   1. Shape: three base64url parts, at most MAX_TOKEN_LENGTH characters.
 *   2. Header: alg must be RS256 (no "none", no HMAC), kid must be present.
 *      Keys embedded in the token (jwk, jku, x5u) are never used.
 *   3. Signature: RSASSA-PKCS1-v1_5 / SHA-256 with the team's public key for
 *      that kid, from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs.
 *   4. iss = https://<team>.cloudflareaccess.com
 *   5. aud contains the Access application's audience (AUD) tag.
 *   6. exp in the future; nbf and iat not in the future (30 s clock skew).
 *   7. email equals the single admin email (compared in lowercase).
 */

const MAX_TOKEN_LENGTH = 8192;
const CLOCK_SKEW_SECONDS = 30;
const KEYS_TTL_MS = 60 * 60 * 1000; // re-read the public keys hourly
// Unknown kid while keys are cached: re-read at most once per minute, so
// random kids cannot make the Worker fetch on every request.
const UNKNOWN_KID_REFRESH_MS = 60 * 1000;
// No usable keys at all (first fetch failed): try again soon instead of
// refusing every sign-in for a minute.
const EMPTY_RETRY_MS = 2 * 1000;
const FETCH_ATTEMPTS = 2; // one retry inside the same request
const FETCH_RETRY_DELAY_MS = 250;
const FETCH_TIMEOUT_MS = 5000;

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A rejected token. `reason` is a short code for logs; it never contains the token. */
export class AccessError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "AccessError";
    this.reason = reason;
  }
}

/**
 * Admin sign-in settings from the Worker environment, or null when anything
 * is missing or malformed (the admin API then refuses every request).
 */
export function readAccessConfig(env) {
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase();
  const audience = String(env.ACCESS_AUD ?? "").trim().toLowerCase();
  const adminEmail = String(env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!TEAM_DOMAIN.test(teamDomain) || !AUDIENCE.test(audience) || !EMAIL.test(adminEmail)) return null;
  return { teamDomain, audience, adminEmail, issuer: `https://${teamDomain}` };
}

/* ------------------------------------------------------------ decoding */

function base64UrlToBytes(text) {
  if (!BASE64URL.test(text)) throw new AccessError("malformed");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new AccessError("malformed");
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJsonPart(part) {
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
  } catch (error) {
    if (error instanceof AccessError) throw error;
    throw new AccessError("malformed");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AccessError("malformed");
  return value;
}

/* ------------------------------------------------------------ public keys */

// Per team domain: imported keys by kid, cached for the life of the isolate.
const keyStores = new Map();

/** Test helper: forget all cached public keys. */
export function clearSigningKeyCache() {
  keyStores.clear();
}

async function fetchSigningKeys(teamDomain) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body?.keys) ? body.keys : [];
  } finally {
    clearTimeout(timer);
  }
}

async function importSigningKeys(jwks) {
  const keys = new Map();
  for (const jwk of jwks) {
    if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string" || jwk.kid === "") continue;
    if ((jwk.alg && jwk.alg !== "RS256") || (jwk.use && jwk.use !== "sig")) continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // A malformed key is skipped; the others still work.
    }
  }
  return keys;
}

const describe = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Fetches and imports the keys, retrying once; throws when nothing usable came back. */
async function loadSigningKeys(teamDomain, fetchKeys) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const keys = await importSigningKeys(await fetchKeys(teamDomain));
      if (keys.size > 0) return keys;
      lastError = new Error("response contained no usable RS256 keys");
    } catch (error) {
      lastError = error;
    }
    console.warn(`Access signing keys: attempt ${attempt}/${FETCH_ATTEMPTS} failed (${describe(lastError)})`);
    if (attempt < FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
  }
  throw lastError;
}

/**
 * Starts a key refresh, or joins the one already in progress, so that
 * simultaneous requests share a single fetch instead of finding no keys.
 */
function refreshKeys(store, teamDomain, nowMs, fetchKeys) {
  if (!store.pending) {
    store.attemptedAt = nowMs;
    store.pending = loadSigningKeys(teamDomain, fetchKeys)
      .then((keys) => {
        store.keys = keys;
        store.fetchedAt = nowMs;
      })
      .catch((error) => {
        // Keep any keys we already have (they rotate slowly); fail closed if none.
        console.error(`Access signing keys could not be fetched (${describe(error)})`);
      })
      .finally(() => {
        store.pending = null;
      });
  }
  return store.pending;
}

async function signingKey(config, kid, nowMs, fetchKeys) {
  let store = keyStores.get(config.teamDomain);
  if (!store) {
    store = { keys: new Map(), fetchedAt: 0, attemptedAt: -Infinity, pending: null };
    keyStores.set(config.teamDomain, store);
  }
  // A refresh started by another request is still running: wait for it.
  if (store.pending) await store.pending;

  const stale = nowMs - store.fetchedAt > KEYS_TTL_MS;
  const retryAfter = store.keys.size === 0 ? EMPTY_RETRY_MS : UNKNOWN_KID_REFRESH_MS;
  if ((stale || !store.keys.has(kid)) && nowMs - store.attemptedAt >= retryAfter) {
    await refreshKeys(store, config.teamDomain, nowMs, fetchKeys);
  }
  if (store.keys.size === 0) throw new AccessError("keys_unavailable");
  const key = store.keys.get(kid);
  if (!key) throw new AccessError("unknown_key");
  return key;
}

/* ------------------------------------------------------------ verification */

/**
 * Verifies an Access JWT and returns the admin session.
 * @param {string|null|undefined} token  value of the Cf-Access-Jwt-Assertion header
 * @param {ReturnType<typeof readAccessConfig>} config
 * @param {{ now?: number, fetchKeys?: (teamDomain: string) => Promise<object[]> }} [options]  for tests
 * @returns {Promise<{ email: string, expiresAt: string }>}
 * @throws {AccessError}
 */
export async function verifyAccessToken(token, config, { now = Date.now(), fetchKeys = fetchSigningKeys } = {}) {
  if (typeof token !== "string" || token === "") throw new AccessError("missing_token");
  if (token.length > MAX_TOKEN_LENGTH) throw new AccessError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) throw new AccessError("malformed");

  const header = decodeJsonPart(parts[0]);
  if (header.alg !== "RS256") throw new AccessError("unsupported_alg");
  if (typeof header.kid !== "string" || header.kid === "" || header.kid.length > 256) throw new AccessError("malformed");
  const signature = base64UrlToBytes(parts[2]);

  const key = await signingKey(config, header.kid, now, fetchKeys);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!valid) throw new AccessError("bad_signature");

  // Only now is the payload trustworthy enough to read.
  const claims = decodeJsonPart(parts[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (claims.iss !== config.issuer) throw new AccessError("bad_issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.audience)) throw new AccessError("bad_audience");
  if (!Number.isFinite(claims.exp)) throw new AccessError("no_expiry");
  if (nowSeconds >= claims.exp) throw new AccessError("expired");
  if (claims.nbf !== undefined && !(Number.isFinite(claims.nbf) && claims.nbf <= nowSeconds + CLOCK_SKEW_SECONDS)) {
    throw new AccessError("not_yet_valid");
  }
  if (claims.iat !== undefined && !(Number.isFinite(claims.iat) && claims.iat <= nowSeconds + CLOCK_SKEW_SECONDS)) {
    throw new AccessError("issued_in_future");
  }
  if (typeof claims.email !== "string" || claims.email.toLowerCase() !== config.adminEmail) {
    throw new AccessError("not_admin");
  }

  return { email: config.adminEmail, expiresAt: new Date(claims.exp * 1000).toISOString() };
}
