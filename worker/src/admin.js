/**
 * Admin API. Everything under /api/admin/ is protected twice:
 *   1. Cloudflare Access (application "Library Admin", path api/admin/*)
 *      signs the admin in with Google and forwards a JWT.
 *   2. This Worker verifies that JWT (access.js) before anything else,
 *      including before answering 404 for unknown admin paths.
 *
 *   GET  /api/admin/session                      { email, expiresAt }
 *   GET  /api/admin/login                        302 to the Library website (fixed address)
 *        (also /api/admin/, /api/admin/* — where Access lands Cloudflare-started logins)
 *
 *   GET    /api/admin/items                      all items incl. drafts (no bodies)
 *   POST   /api/admin/items                      create (always a draft)          201
 *   GET    /api/admin/items/:id                  one item incl. drafts + blocks
 *   PATCH  /api/admin/items/:id                  edit the fields sent; { revision, ... }
 *   DELETE /api/admin/items/:id                  delete; { revision }
 *   POST   /api/admin/items/:id/publish          { revision }
 *   POST   /api/admin/items/:id/unpublish        { revision }
 *   GET    /api/admin/items/:id/revisions        history (newest first)
 *   GET    /api/admin/items/:id/revisions/:rev   one version's full content
 *   POST   /api/admin/items/:id/restore          { revision, fromRevision }
 *   GET    /api/admin/deleted-items              deleted items that can be restored
 *   GET    /api/admin/youtube/:videoId           video information (youtube.js)
 *   POST   /api/admin/files                      upload a PDF to R2 (files.js)     201
 *   GET    /api/admin/files/<key>                read an upload: drafts, history, unsaved
 *                                                (files.js; Range and ?download=1)
 *
 * Writes (POST/PATCH/DELETE) also require: Origin exactly in ALLOWED_ORIGINS
 * and Sec-Fetch-Site same-site/same-origin when sent (CSRF), Content-Type
 * application/json (forces a CORS preflight), and a body of at most 256 KB.
 * The upload route instead takes Content-Type application/pdf (also a
 * preflighted type) and up to 25 MB, checked by files.js.
 * CORS: only admin responses allow credentials, and only for ALLOWED_ORIGINS;
 * public endpoints (index.js) never allow credentials. Every admin response
 * is no-store.
 */
import { AccessError, readAccessConfig, verifyAccessToken } from "./access.js";
import {
  createItem,
  deletedItems,
  deleteItem,
  getItem,
  HttpError,
  itemHistory,
  itemRevision,
  listItems,
  restoreItem,
  setItemStatus,
  updateItem,
} from "./adminItems.js";
import { serveAdminFile, uploadPdf } from "./files.js";
import { allowedOrigin, allowedOrigins, json } from "./http.js";
import { ValidationError } from "./itemInput.js";
import { youtubeInfo } from "./youtube.js";

const ADMIN_PREFIX = "/api/admin/";
const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE"]);
const MAX_BODY_BYTES = 256 * 1024;
const PREFLIGHT_METHODS = "GET, HEAD, POST, PATCH, DELETE, OPTIONS";

export const isAdminPath = (pathname) => pathname.startsWith(ADMIN_PREFIX);

function adminCors(request, env) {
  const headers = { Vary: "Origin" };
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

/**
 * Where /api/admin/login sends the admin after signing in. It comes only from
 * the SITE_URL variable (never from the request) and must be one of the
 * ALLOWED_ORIGINS, so the endpoint cannot be used as an open redirect.
 * "?admin=signed-in" tells the site to ask GET /api/admin/session right away
 * (the site then removes it, leaving https://<site>/#/). It grants nothing.
 */
export const SIGNED_IN_MARKER = "admin=signed-in";

function siteHome(env) {
  try {
    const { origin } = new URL(String(env.SITE_URL ?? ""));
    return allowedOrigins(env).includes(origin) ? `${origin}/?${SIGNED_IN_MARKER}#/` : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ requests */

/** CSRF and format checks for POST / PATCH / DELETE (null when fine). */
function writeRequestProblem(request, env, { upload = false } = {}) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) {
    return [403, { error: "Writes are only accepted from the Library website", code: "forbidden_origin" }];
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-site" && fetchSite !== "same-origin") {
    return [403, { error: "Cross-site write refused", code: "forbidden_origin" }];
  }
  if (upload) return null; // type and size are checked by files.js
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
    return [415, { error: "Send JSON (Content-Type: application/json)", code: "unsupported_media_type" }];
  }
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return [413, { error: "Request body too large (256 KB maximum)", code: "too_large" }];
  }
  return null;
}

async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, { error: "Request body too large (256 KB maximum)", code: "too_large" });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, { error: "Body is not valid JSON", code: "bad_json" });
  }
}

/* ------------------------------------------------------------ routes */

const loginRoute = {
  GET: ({ request, env, headers }) => {
    const home = siteHome(env);
    if (!home) {
      console.error("Admin login: SITE_URL is missing or not in ALLOWED_ORIGINS");
      return json(request, 503, { error: "Admin sign-in is not configured" }, headers);
    }
    return new Response(null, { status: 302, headers: { ...headers, Location: home } });
  },
};

const ok = (status, data) => ({ status, data });

const STATIC_ROUTES = new Map([
  ["/api/admin/session", { GET: ({ session }) => ok(200, { email: session.email, expiresAt: session.expiresAt }) }],
  ["/api/admin/login", loginRoute],
  // Logins started by Cloudflare itself (the "Log in to Library Admin" button
  // on its logout page, an App Launcher tile) have no page to return to, so
  // Access returns to the application's primary destination as written. While
  // that destination is the wildcard "api/admin/*", the browser lands on these
  // literal paths. They are only reached after the token check and send the
  // admin to the same fixed site address as /api/admin/login.
  ["/api/admin/*", loginRoute],
  ["/api/admin/%2A", loginRoute],
  ["/api/admin/%2a", loginRoute],
  ["/api/admin/", loginRoute],
  ["/api/admin/items", {
    GET: ({ env }) => listItems(env.DB).then((data) => ok(200, data)),
    POST: async ({ env, request, session }) => ok(201, await createItem(env.DB, await readJson(request), session.email, env)),
  }],
  ["/api/admin/deleted-items", { GET: ({ env }) => deletedItems(env.DB).then((data) => ok(200, data)) }],
  ["/api/admin/files", {
    upload: true,
    POST: async ({ env, request, session }) => ok(201, await uploadPdf(request, env, session.email)),
  }],
]);

const ITEM_ID = "(itm_[a-z0-9]+(?:_[a-z0-9]+)*)";
const PATTERN_ROUTES = [
  [new RegExp(`^/api/admin/items/${ITEM_ID}$`), {
    GET: ({ env, params: [id] }) => getItem(env.DB, id).then((data) => ok(200, data)),
    PATCH: async ({ env, request, session, params: [id] }) => ok(200, await updateItem(env.DB, id, await readJson(request), session.email, env)),
    DELETE: async ({ env, request, session, params: [id] }) => ok(200, await deleteItem(env.DB, id, await readJson(request), session.email)),
  }],
  [new RegExp(`^/api/admin/items/${ITEM_ID}/publish$`), {
    POST: async ({ env, request, session, params: [id] }) => ok(200, await setItemStatus(env.DB, id, await readJson(request), session.email, "published")),
  }],
  [new RegExp(`^/api/admin/items/${ITEM_ID}/unpublish$`), {
    POST: async ({ env, request, session, params: [id] }) => ok(200, await setItemStatus(env.DB, id, await readJson(request), session.email, "draft")),
  }],
  [new RegExp(`^/api/admin/items/${ITEM_ID}/restore$`), {
    POST: async ({ env, request, session, params: [id] }) => ok(200, await restoreItem(env.DB, id, await readJson(request), session.email, env)),
  }],
  [new RegExp(`^/api/admin/items/${ITEM_ID}/revisions$`), {
    GET: ({ env, params: [id] }) => itemHistory(env.DB, id).then((data) => ok(200, data)),
  }],
  [new RegExp(`^/api/admin/items/${ITEM_ID}/revisions/([1-9][0-9]{0,8})$`), {
    GET: ({ env, params: [id, revision] }) => itemRevision(env.DB, id, Number(revision)).then((data) => ok(200, data)),
  }],
  [/^\/api\/admin\/youtube\/([A-Za-z0-9_-]{11})$/, {
    GET: ({ env, params: [videoId] }) => youtubeInfo(videoId, env).then((data) => ok(200, data)),
  }],
  // The key's own pattern (files.js FILE_KEY) bounds it to 93 characters.
  [/^\/api\/admin\/files\/(pdf\/\d{4}\/\d{2}\/[a-z0-9]{16}-[a-z0-9-]{1,60}\.pdf)$/, {
    GET: ({ request, env, headers, params: [key] }) => serveAdminFile(request, env, key, headers),
  }, 96],
];

function matchRoute(pathname) {
  const exact = STATIC_ROUTES.get(pathname);
  if (exact) return { route: exact, params: [] };
  for (const [pattern, route, maxLength = 64] of PATTERN_ROUTES) {
    const match = pattern.exec(pathname);
    if (match && match[1].length <= maxLength) return { route, params: match.slice(1) };
  }
  return null;
}

const allowedMethods = (route) => {
  const methods = Object.keys(route).filter((key) => key === key.toUpperCase());
  if (methods.includes("GET")) methods.splice(methods.indexOf("GET") + 1, 0, "HEAD");
  return methods.join(", ");
};

/* ------------------------------------------------------------ entry point */

export async function handleAdmin(request, env, pathname) {
  const cors = adminCors(request, env);
  const headers = { ...NO_STORE, ...cors };

  // Preflight: Access lets OPTIONS through without a sign-in, so it carries
  // no token. It only describes what the browser may send; it returns no data.
  if (request.method === "OPTIONS") {
    const preflight = { ...cors };
    if (cors["Access-Control-Allow-Origin"]) {
      preflight["Access-Control-Allow-Methods"] = PREFLIGHT_METHODS;
      // Range: the site's PDF viewer reads an admin file piece by piece.
      preflight["Access-Control-Allow-Headers"] = "Content-Type, X-File-Name, Range";
      preflight["Access-Control-Max-Age"] = "600";
    }
    return new Response(null, { status: 204, headers: preflight });
  }

  const config = readAccessConfig(env);
  if (!config) {
    console.error("Admin sign-in is not configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD or ADMIN_EMAIL)");
    return json(request, 503, { error: "Admin sign-in is not configured" }, headers);
  }

  let session;
  try {
    session = await verifyAccessToken(request.headers.get("Cf-Access-Jwt-Assertion"), config);
  } catch (error) {
    const reason = error instanceof AccessError ? error.reason : "error";
    // The reason code is safe to log; the token itself never is.
    console.warn(`Admin request rejected (${reason}): ${request.method} ${pathname}`);
    if (reason === "keys_unavailable") {
      return json(request, 503, { error: "Sign-in is temporarily unavailable" }, headers);
    }
    return json(request, 401, { error: "Unauthorized" }, headers);
  }

  // Signed in from here on.
  const match = matchRoute(pathname);
  if (!match) return json(request, 404, { error: "Not found" }, headers);
  const handler = match.route[request.method] ?? (request.method === "HEAD" ? match.route.GET : undefined);
  if (!handler) {
    return json(request, 405, { error: "Method not allowed" }, { ...headers, Allow: allowedMethods(match.route) });
  }
  if (WRITE_METHODS.has(request.method)) {
    const problem = writeRequestProblem(request, env, { upload: match.route.upload === true });
    if (problem) return json(request, problem[0], problem[1], headers);
  }

  try {
    const result = await handler({ request, env, session, headers, params: match.params });
    if (result instanceof Response) return result;
    return json(request, result.status, result.data, headers);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json(request, 422, { error: "Some fields are not valid", code: "validation", fields: error.fields }, headers);
    }
    if (error instanceof HttpError) return json(request, error.status, error.body, headers);
    // Details go to the Worker logs only, never to the client.
    console.error(`Admin ${request.method} ${pathname} failed:`, error instanceof Error ? error.message : error);
    return json(request, 500, { error: "Internal error" }, headers);
  }
}
