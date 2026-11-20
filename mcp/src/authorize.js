/**
 * OAuth authorization endpoint (/authorize): the only interactive page.
 *
 * Who: Cloudflare Access (an application covering exactly this path, Google
 * login, one allowed email) signs the owner in and forwards a JWT. Access is
 * not trusted alone: the Worker verifies that JWT on GET and POST with the
 * Library's own verifier (worker/src/access.js: signature, issuer, audience,
 * expiry, exact ADMIN_EMAIL).
 *
 * What: GET shows a consent page for the (pre-registered) client; POST
 * approves or denies. The authorization request is parsed and validated by
 * the OAuth library both times from the original query string (never from
 * form fields), so the client, redirect URI, PKCE (S256 required) and resource
 * cannot be altered between the two.
 *
 * CSRF / clickjacking: POST needs the page's Origin, a 256-bit nonce that
 * matches a __Host- SameSite=Strict cookie set by the GET, and a valid Access
 * JWT; the page cannot be framed (CSP frame-ancestors 'none', X-Frame-Options).
 */
import { authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { AccessError, readAccessConfig, verifyAccessToken } from "../../worker/src/access.js";
import { SCOPE } from "./mcp.js";

export const NONCE_COOKIE = "__Host-library-mcp-consent";
export const USER_ID = "owner"; // the single user of this server (ADMIN_EMAIL)
const MAX_FORM_BYTES = 8 * 1024;
const NONCE_SECONDS = 600;

/* ------------------------------------------------------------ helpers */

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function pageHeaders(extra = {}) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // form-action also covers the redirect after the POST in some browsers.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  };
}

function page(status, title, bodyHtml, extraHeaders) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f5f2;color:#1d1d1b}main{max-width:32rem;margin:10vh auto;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px #0002}
h1{font-size:1.3rem;margin:0 0 1rem}ul{padding-left:1.2rem}.muted{color:#5f5f5a;font-size:.9rem}.row{display:flex;gap:.75rem;margin-top:1.5rem}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #1d1d1b;cursor:pointer}button.primary{background:#1d1d1b;color:#fff}
@media (prefers-color-scheme:dark){body{background:#151514;color:#eee}main{background:#222220}.muted{color:#aaa}button{border-color:#eee;background:#222220;color:#eee}button.primary{background:#eee;color:#151514}}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body></html>`;
  return new Response(html, { status, headers: pageHeaders(extraHeaders) });
}

const errorPage = (status, message) => page(status, "Library drafts", `<p>${escapeHtml(message)}</p>`);

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function cookieValue(request, name) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** The signed-in owner's email, or a Response refusing the request. */
async function owner(request, env) {
  const config = readAccessConfig(env);
  if (!config) {
    console.error("Authorization refused: ACCESS_TEAM_DOMAIN, ACCESS_AUD or ADMIN_EMAIL is missing or malformed");
    return { refusal: errorPage(503, "Sign-in is not configured.") };
  }
  try {
    const session = await verifyAccessToken(request.headers.get("Cf-Access-Jwt-Assertion"), config);
    return { email: session.email };
  } catch (error) {
    const reason = error instanceof AccessError ? error.reason : "error";
    console.warn(`Authorization refused (${reason}): ${request.method} /authorize`);
    if (reason === "keys_unavailable") return { refusal: errorPage(503, "Sign-in is temporarily unavailable. Try again.") };
    return { refusal: errorPage(reason === "not_admin" ? 403 : 401, "You are not allowed to authorize this connector.") };
  }
}

/** The library-validated authorization request (query string only), or a Response. */
async function authRequest(request, env) {
  const url = new URL(request.url);
  let parsed;
  try {
    parsed = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(url.toString(), { method: "GET" }));
  } catch (error) {
    console.warn("Authorization request rejected:", error?.description ?? error?.message ?? "invalid");
    return { refusal: errorPage(400, "This authorization request is not valid.") };
  }
  if (parsed.responseType !== "code" || !parsed.codeChallenge || parsed.codeChallengeMethod !== "S256") {
    return { refusal: errorPage(400, "This authorization request is not valid (authorization code with PKCE S256 required).") };
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  if (!client) return { refusal: errorPage(400, "Unknown client.") };
  return { parsed, client };
}

/* ------------------------------------------------------------ GET: consent page */

async function showConsent(request, env) {
  const who = await owner(request, env);
  if (who.refusal) return who.refusal;
  const auth = await authRequest(request, env);
  if (auth.refusal) return auth.refusal;

  const nonce = randomNonce();
  const action = `/authorize${new URL(request.url).search}`;
  const clientName = auth.client.clientName || "Claude";
  const body = `
<p><strong>${escapeHtml(clientName)}</strong> asks to connect to your Library as <strong>${escapeHtml(who.email)}</strong>.</p>
<p>If you allow it, it will be able to:</p>
<ul><li>create <strong>private article drafts</strong> (up to 50 a day)</li></ul>
<p>It will <strong>not</strong> be able to publish, edit, delete, list or read any article.</p>
<p class="muted">Returns to: ${escapeHtml(new URL(auth.parsed.redirectUri).origin)}. You can revoke access at any time.</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<div class="row"><button class="primary" type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></div>
</form>`;
  return page(200, "Connect Library drafts", body, {
    "Set-Cookie": `${NONCE_COOKIE}=${nonce}; Max-Age=${NONCE_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Strict`,
  });
}

/* ------------------------------------------------------------ POST: decision */

async function decide(request, env) {
  const expectedOrigin = new URL(String(env.PUBLIC_URL)).origin;
  if (request.headers.get("Origin") !== expectedOrigin) return errorPage(403, "Cross-site request refused.");
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(request.headers.get("Content-Type") ?? "")) return errorPage(415, "Unsupported request.");
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_FORM_BYTES) return errorPage(413, "Request too large.");

  const who = await owner(request, env);
  if (who.refusal) return who.refusal;

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_FORM_BYTES) return errorPage(413, "Request too large.");
  const form = new URLSearchParams(text);
  const cookieNonce = cookieValue(request, NONCE_COOKIE);
  if (!cookieNonce || !/^[A-Za-z0-9_-]{43}$/.test(cookieNonce) || !constantTimeEqual(form.get("nonce") ?? "", cookieNonce)) {
    return errorPage(403, "This page expired. Start the connection again from Claude.");
  }

  const auth = await authRequest(request, env);
  if (auth.refusal) return auth.refusal;
  const clearNonce = `${NONCE_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
  const redirect = (location) => new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", "Set-Cookie": clearNonce } });

  const decision = form.get("decision");
  if (decision === "deny") return redirect(authorizationErrorRedirect(auth.parsed, "access_denied"));
  if (decision !== "approve") return errorPage(400, "Unknown decision.");

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: auth.parsed,
    userId: USER_ID,
    metadata: { label: auth.client.clientName || "Claude", approvedAt: new Date().toISOString() },
    scope: [SCOPE], // only this scope, whatever was requested
    props: { email: who.email },
  });
  console.log(`Authorization granted to client ${auth.parsed.clientId}`);
  return redirect(redirectTo);
}

export const authorizeHandler = {
  async fetch(request, env) {
    if (request.method === "GET" || request.method === "HEAD") return showConsent(request, env);
    if (request.method === "POST") return decide(request, env);
    return new Response(null, { status: 405, headers: { Allow: "GET, POST", "Cache-Control": "no-store" } });
  },
};
