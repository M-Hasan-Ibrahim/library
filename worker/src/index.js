/**
 * Library read-only API (Cloudflare Worker + D1 binding `DB`).
 *
 *   GET /api/library        { categories, languages, items }   (one round trip)
 *   GET /api/categories     categories.json shape
 *   GET /api/languages      languages.json shape
 *   GET /api/items          items.json shape (no bodies)
 *   GET /api/items/:slug    one items.json entry + "blocks" (rich text)
 *
 * Only GET, HEAD and OPTIONS are accepted; there is no write path.
 * CORS: only origins listed in the ALLOWED_ORIGINS variable receive
 * Access-Control-Allow-Origin. The data is public, so other clients are not
 * blocked; browsers on other sites simply cannot read the responses.
 *
 * /api/admin/* is handled separately by admin.js (Cloudflare Access sign-in,
 * verified here on every request).
 */
import { handleAdmin, isAdminPath } from "./admin.js";
import { getCategories, getItem, getItems, getLanguages, getLibrary } from "./content.js";
import { allowedOrigin, json } from "./http.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 120;
const CACHE_SECONDS = 60;

// A Map (not an object), so paths can never resolve to inherited properties.
const COLLECTIONS = new Map([
  ["/api/library", getLibrary],
  ["/api/categories", getCategories],
  ["/api/languages", getLanguages],
  ["/api/items", getItems],
]);

/** Resolves a path to data, or undefined for "not found". */
async function route(pathname, db) {
  const collection = COLLECTIONS.get(pathname);
  if (collection) return collection(db);

  const match = /^\/api\/items\/([^/]+)$/.exec(pathname);
  if (match) {
    // The raw path segment must already be a plain slug: encoded or unusual
    // characters (quotes, %27, dots, spaces...) are rejected before any query.
    const slug = match[1];
    if (slug.length > MAX_SLUG_LENGTH || !SLUG.test(slug)) return undefined;
    return getItem(db, slug);
  }
  return undefined;
}

function corsHeaders(request, env) {
  // Responses differ by Origin, so caches must key on it.
  const headers = { Vary: "Origin" };
  const origin = allowedOrigin(request, env);
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function respond(request, status, data, extraHeaders) {
  return json(request, status, data, {
    "Cache-Control": status === 200 ? `public, max-age=${CACHE_SECONDS}` : "no-store",
    ...extraHeaders,
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (isAdminPath(pathname)) return handleAdmin(request, env, pathname);

    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      const headers = { ...cors };
      if (headers["Access-Control-Allow-Origin"]) {
        headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
        headers["Access-Control-Max-Age"] = "86400";
      }
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond(request, 405, { error: "Method not allowed" }, { ...cors, Allow: "GET, HEAD, OPTIONS" });
    }

    try {
      const data = await route(pathname, env.DB);
      if (data === undefined) return respond(request, 404, { error: "Not found" }, cors);
      return respond(request, 200, data, cors);
    } catch (error) {
      // Details go to the Worker logs only, never to the client.
      console.error("Library API error:", error instanceof Error ? error.message : error);
      return respond(request, 500, { error: "Internal error" }, cors);
    }
  },
};
