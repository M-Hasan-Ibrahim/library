/**
 * Integration API: lets ONE external client (e.g. a Claude agent) create
 * article drafts with a dedicated API token. It is not an admin session.
 *
 *   POST /api/integrations/drafts     create an article draft         201 { id, status: "draft" }
 *
 * That is the only operation. The integration cannot publish, edit, delete,
 * list or read drafts, and its token is never accepted by /api/admin/*
 * (which only trusts Cloudflare Access, see admin.js), nor is the Access
 * session accepted here. Drafts become public only when the admin publishes
 * them from the website.
 *
 * Authentication: "Authorization: Bearer <token>". The Worker never stores
 * the token itself: the secret INTEGRATION_TOKEN_SHA256 holds the SHA-256 hex
 * digest of it (comma-separated digests allow a rotation overlap). The token
 * is 256 random bits (worker/tools/integration-token.mjs), so a plain SHA-256
 * is enough; comparison is constant-time. Removing the secret revokes the
 * integration (the route then answers 503).
 *
 * Limits: JSON only, body at most MAX_BODY_BYTES; rate limited by the
 * REQUIRED Workers Rate Limiting binding INTEGRATION_RATE_LIMITER (bursts;
 * failed sign-ins are limited per client IP) and by a daily quota in D1
 * (DAILY_DRAFT_LIMIT drafts per rolling 24 hours), checked atomically in the
 * same D1 transaction that creates the draft (createItem's dailyLimit).
 * Fail closed: if the binding is missing, misconfigured or failing, every
 * request is refused (503) instead of skipping the protection.
 *
 * No CORS headers are sent: the route is for server-to-server clients, so
 * browsers on other sites can neither call it with a token nor read answers.
 */
import { createItem, HttpError } from "./adminItems.js";
import { json } from "./http.js";
import { ValidationError } from "./itemInput.js";

export const INTEGRATION_PREFIX = "/api/integrations/";
export const DRAFTS_PATH = "/api/integrations/drafts";
export const INTEGRATION_ACTOR = "integration:claude"; // revisions.changed_by for its drafts
export const MAX_BODY_BYTES = 128 * 1024;
export const DAILY_DRAFT_LIMIT = 50;

// The article fields an integration may send (a subset of itemInput.js's
// create fields). Never: status, slug, id, addedAt, revision, other types' fields.
const ACCEPTED_FIELDS = new Set(["type", "categoryId", "language", "title", "description", "tags", "links", "blocks"]);
const PUBLISH_FIELDS = new Set(["status", "published", "publish", "publishedAt", "visibility"]);
const TOKEN_FORMAT = /^lib_int_[A-Za-z0-9_-]{43}$/; // "lib_int_" + 32 random bytes, base64url
const DIGEST_FORMAT = /^[0-9a-f]{64}$/;
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export const isIntegrationPath = (pathname) => pathname === "/api/integrations" || pathname.startsWith(INTEGRATION_PREFIX);

/* ------------------------------------------------------------ token */

/** The configured token digests (lowercase hex), or [] when the integration is off. */
export function configuredDigests(env) {
  return String(env.INTEGRATION_TOKEN_SHA256 ?? "")
    .split(",")
    .map((digest) => digest.trim().toLowerCase())
    .filter((digest) => DIGEST_FORMAT.test(digest));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** The matching digest for the request's bearer token, or null. */
async function authenticate(request, digests) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match || !TOKEN_FORMAT.test(match[1])) return null;
  const presented = await sha256Hex(match[1]);
  let found = null;
  for (const digest of digests) if (constantTimeEqual(presented, digest)) found = digest; // no early exit
  return found;
}

/* ------------------------------------------------------------ limits */

const hasRateLimiter = (env) => typeof env.INTEGRATION_RATE_LIMITER?.limit === "function";

/**
 * "allowed", "limited", or "unavailable" (binding failed or answered something
 * unexpected). Callers treat "unavailable" as a refusal: fail closed.
 */
async function rateLimit(env, key) {
  try {
    const outcome = await env.INTEGRATION_RATE_LIMITER.limit({ key });
    if (outcome?.success === true) return "allowed";
    if (outcome?.success === false) return "limited";
    console.error("Integration rate limiter returned an unexpected result");
  } catch (error) {
    console.error("Integration rate limiter error:", error instanceof Error ? error.message : error);
  }
  return "unavailable";
}

async function readBody(request) {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
    throw new HttpError(415, { error: "Send JSON (Content-Type: application/json)", code: "unsupported_media_type" });
  }
  const tooLarge = () => new HttpError(413, { error: `Request body too large (${MAX_BODY_BYTES / 1024} KB maximum)`, code: "too_large" });
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw tooLarge();
  // Read at most MAX_BODY_BYTES + 1 bytes, whatever Content-Length said.
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, { error: "Body is not valid JSON", code: "bad_json" });
  }
}

/* ------------------------------------------------------------ input */

/** Keeps only article creation fields; anything else (status, slug...) is refused, not ignored. */
function draftInput(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError({ body: "must be a JSON object" });
  }
  const errors = {};
  for (const key of Object.keys(body)) {
    if (PUBLISH_FIELDS.has(key)) errors[key] = "the integration can only create drafts; the admin publishes them";
    else if (!ACCEPTED_FIELDS.has(key)) errors[key] = "is not an accepted field here";
  }
  if ("type" in body && body.type !== "article") errors.type = "must be article";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  // createItem validates every field and always creates a draft at revision 1.
  return { ...body, type: "article" };
}

/* ------------------------------------------------------------ entry point */

export async function handleIntegration(request, env, pathname) {
  const reply = (status, data, extra) => json(request, status, data, { ...HEADERS, ...extra });

  if (pathname !== DRAFTS_PATH) return reply(404, { error: "Not found" });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed" }, { Allow: "POST" });

  const digests = configuredDigests(env);
  if (digests.length === 0) {
    console.error("Integration request refused: INTEGRATION_TOKEN_SHA256 is not configured");
    return reply(503, { error: "This integration is not enabled" });
  }

  if (!hasRateLimiter(env)) {
    console.error("Integration request refused: the INTEGRATION_RATE_LIMITER binding is missing or misconfigured");
    return reply(503, { error: "This integration is temporarily unavailable", code: "rate_limiter_unavailable" });
  }
  const limitReply = (outcome) =>
    outcome === "limited"
      ? reply(429, { error: "Too many requests", code: "rate_limited" }, { "Retry-After": "60" })
      : reply(503, { error: "This integration is temporarily unavailable", code: "rate_limiter_unavailable" });

  const digest = await authenticate(request, digests);
  if (!digest) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    // The token itself is never logged.
    console.warn(`Integration request rejected (bad or missing token): ${request.method} ${pathname}`);
    const outcome = await rateLimit(env, `unauthorized:${ip}`);
    if (outcome !== "allowed") return limitReply(outcome);
    return reply(401, { error: "Unauthorized" }, { "WWW-Authenticate": 'Bearer realm="library-integrations"' });
  }

  const outcome = await rateLimit(env, `token:${digest.slice(0, 16)}`);
  if (outcome !== "allowed") return limitReply(outcome);

  try {
    const body = await readBody(request);
    const input = draftInput(body);
    // The daily quota is checked inside the create transaction (atomic).
    const { item } = await createItem(env.DB, input, INTEGRATION_ACTOR, env, { dailyLimit: DAILY_DRAFT_LIMIT });
    console.log(`Integration draft created: ${item.id}`);
    return reply(201, { id: item.id, status: "draft" });
  } catch (error) {
    if (error instanceof ValidationError) {
      return reply(422, { error: "Some fields are not valid", code: "validation", fields: error.fields });
    }
    if (error instanceof HttpError) {
      return reply(error.status, error.body, error.status === 429 ? { "Retry-After": "3600" } : undefined);
    }
    console.error("Integration draft failed:", error instanceof Error ? error.message : error);
    return reply(500, { error: "Internal error" });
  }
}
