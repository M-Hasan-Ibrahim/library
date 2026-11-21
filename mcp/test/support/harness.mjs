// Test harness: the real Worker (src/index.js) with the real OAuth library, an
// in-memory KV, a fake rate limiter, a fake Library API service binding, and
// throwaway Access signing keys (from the Library's own test helpers).
// Every credential here is generated per run and exists only in memory.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { clearSigningKeyCache } from "../../../worker/src/access.js";
import { ADMIN, AUD, CERTS_URL, createSigningKey, signToken, TEAM, validClaims } from "../../../worker/test/helpers.mjs";
import worker from "../../src/index.js";
import { CLAUDE_CALLBACK, clientRecord, newClientCredentials } from "../../tools/oauth-client.mjs";
import { createMemoryKV } from "./memoryKV.mjs";

export { ADMIN, AUD, CLAUDE_CALLBACK, signToken, validClaims };
export const PUBLIC = "https://mcp.test.example";
export const RESOURCE = `${PUBLIC}/mcp`;
export const CLAUDE_IP = "160.79.105.10"; // in 160.79.104.0/21
export const CLAUDE_IP_2 = "153.61.210.20"; // in 153.61.208.0/20
export const OTHER_IP = "203.0.113.9";
/** ALLOWED_CLIENT_CIDRS exactly as deployed (read from wrangler.jsonc, so tests check the real setting). */
export const CONFIGURED_CIDRS = /"ALLOWED_CLIENT_CIDRS":\s*"([^"]*)"/.exec(
  readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
)[1];
export const accessKey = await createSigningKey("access-kid");

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

export function createEnv(overrides = {}) {
  const upstream = {
    calls: [],
    respond: () => new Response(JSON.stringify({ id: "itm_abcdefghijklmnop", status: "draft" }), { status: 201, headers: { "Content-Type": "application/json" } }),
    async fetch(request) {
      upstream.calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
      return upstream.respond(request);
    },
  };
  const limiter = { allow: true, keys: [], async limit({ key }) { limiter.keys.push(key); return { success: limiter.allow }; } };
  return {
    PUBLIC_URL: PUBLIC,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ADMIN_EMAIL: ADMIN,
    ALLOWED_CLIENT_CIDRS: CONFIGURED_CIDRS,
    MCP_ALLOWED_ORIGINS: "https://claude.ai,https://claude.com",
    LIBRARY_API_URL: "https://api.library.test",
    LIBRARY_INTEGRATION_TOKEN: `lib_int_${randomBytes(32).toString("base64url")}`,
    OAUTH_KV: createMemoryKV(),
    MCP_RATE_LIMITER: limiter,
    LIBRARY_API: upstream,
    ...overrides,
  };
}

/** Records every response so secret-handling tests can scan them. */
export const seen = [];

export async function call(env, path, { method = "GET", headers = {}, body, ip } = {}) {
  const h = { ...headers };
  if (ip) h["CF-Connecting-IP"] = ip;
  const init = { method, headers: h };
  if (body !== undefined) init.body = body;
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const response = await worker.fetch(new Request(`${PUBLIC}${path}`, init), env, ctx);
  const text = await response.text();
  seen.push({ path, status: response.status, headers: Object.fromEntries(response.headers), text });
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, headers: response.headers, text, json };
}

const realFetch = globalThis.fetch;
/** Serves the Access signing keys; call in beforeEach. */
export function installAccessKeys() {
  clearSigningKeyCache();
  globalThis.fetch = async (url, init) =>
    String(url) === CERTS_URL ? new Response(JSON.stringify({ keys: [accessKey.jwk] })) : realFetch(url, init);
}
export function restoreFetch() {
  globalThis.fetch = realFetch;
}

export const accessJwt = (claims = {}) => signToken(validClaims(claims), accessKey);

export async function registerClient(env) {
  const credentials = newClientCredentials();
  await env.OAUTH_KV.put(`client:${credentials.clientId}`, JSON.stringify(clientRecord(credentials.clientId, credentials.clientSecret)));
  return credentials;
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizeQuery(clientId, challenge, overrides = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    scope: "drafts:create",
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...overrides,
  });
  for (const [key, value] of Object.entries(overrides)) if (value === null) params.delete(key);
  return `?${params}`;
}

export const nonceFrom = (response) => /__Host-library-mcp-consent=([A-Za-z0-9_-]{43})/.exec(response.headers.get("set-cookie") ?? "")?.[1];

/** GET the consent page then POST the decision; returns the POST response. */
export async function consent(env, query, { decision = "approve", jwt, origin = PUBLIC, nonceOverride, cookieOverride, extraHeaders = {}, originFromPage } = {}) {
  const token = jwt ?? (await accessJwt());
  const page = await call(env, `/authorize${query}`, { headers: { "Cf-Access-Jwt-Assertion": token } });
  const nonce = nonceFrom(page);
  const cookie = cookieOverride ?? `__Host-library-mcp-consent=${nonce}`;
  const form = new URLSearchParams({ nonce: nonceOverride ?? nonce ?? "", decision });
  const headers = { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, ...extraHeaders };
  // originFromPage(page): the Origin a real browser would send, derived from the page's headers.
  const effectiveOrigin = originFromPage ? originFromPage(page) : origin;
  if (effectiveOrigin) headers.Origin = effectiveOrigin;
  return { page, post: await call(env, `/authorize${query}`, { method: "POST", headers, body: form.toString() }) };
}

export async function exchangeCode(env, { clientId, clientSecret }, code, verifier, { method = "basic", ip = CLAUDE_IP } = {}) {
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier, resource: RESOURCE });
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (method === "basic") headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  else {
    form.set("client_id", clientId);
    form.set("client_secret", clientSecret);
  }
  return call(env, "/token", { method: "POST", headers, body: form.toString(), ip });
}

/** The full OAuth flow: register client, consent, exchange the code. Returns tokens + client. */
export async function signIn(env, options = {}) {
  const client = await registerClient(env);
  const { verifier, challenge } = pkce();
  const { post } = await consent(env, authorizeQuery(client.clientId, challenge));
  if (post.status !== 302) throw new Error(`consent failed: ${post.status} ${post.text.slice(0, 200)}`);
  const location = new URL(post.headers.get("location"));
  const code = location.searchParams.get("code");
  const tokens = await exchangeCode(env, client, code, verifier, options);
  if (tokens.status !== 200) throw new Error(`token exchange failed: ${tokens.status} ${tokens.text.slice(0, 200)}`);
  return { client, tokens: tokens.json, location };
}

let nextId = 1;
export async function mcp(env, accessToken, message, { headers = {}, ip = CLAUDE_IP } = {}) {
  const body = typeof message === "string" ? message : JSON.stringify({ jsonrpc: "2.0", id: nextId++, ...message });
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return call(env, "/mcp", { method: "POST", headers: h, body, ip });
}
