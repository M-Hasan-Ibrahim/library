/**
 * Admin API (Phase 1: sign-in only, no write endpoints yet).
 *
 *   GET /api/admin/session  -> { email, expiresAt } for the signed-in admin
 *   GET /api/admin/login    -> 302 to the Library website (fixed address)
 *
 * Every request under /api/admin/ is protected twice:
 *   1. Cloudflare Access (application "Library Admin", path api/admin/*)
 *      signs the admin in with Google and forwards a JWT.
 *   2. This Worker verifies that JWT (access.js) before doing anything,
 *      including before answering 404 for unknown admin paths.
 *
 * CORS: only admin responses allow credentials, and only for origins in
 * ALLOWED_ORIGINS. Public endpoints (index.js) never allow credentials.
 * Every admin response is no-store.
 */
import { AccessError, readAccessConfig, verifyAccessToken } from "./access.js";
import { allowedOrigin, allowedOrigins, json } from "./http.js";

const ADMIN_PREFIX = "/api/admin/";
const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

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
 */
function siteHome(env) {
  try {
    const { origin } = new URL(String(env.SITE_URL ?? ""));
    return allowedOrigins(env).includes(origin) ? `${origin}/#/` : null;
  } catch {
    return null;
  }
}

const ROUTES = new Map([
  [
    "/api/admin/session",
    {
      methods: ["GET", "HEAD"],
      handle: ({ request, session, headers }) =>
        json(request, 200, { email: session.email, expiresAt: session.expiresAt }, headers),
    },
  ],
  [
    "/api/admin/login",
    {
      methods: ["GET"],
      handle: ({ request, env, headers }) => {
        const home = siteHome(env);
        if (!home) {
          console.error("Admin login: SITE_URL is missing or not in ALLOWED_ORIGINS");
          return json(request, 503, { error: "Admin sign-in is not configured" }, headers);
        }
        return new Response(null, { status: 302, headers: { ...headers, Location: home } });
      },
    },
  ],
]);

export async function handleAdmin(request, env, pathname) {
  const cors = adminCors(request, env);
  const headers = { ...NO_STORE, ...cors };

  // Preflight: Access lets OPTIONS through without a sign-in, so it carries
  // no token. It only describes what the browser may send; it returns no data.
  if (request.method === "OPTIONS") {
    const preflight = { ...cors };
    if (cors["Access-Control-Allow-Origin"]) {
      preflight["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
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
  const route = ROUTES.get(pathname);
  if (!route) return json(request, 404, { error: "Not found" }, headers);
  if (!route.methods.includes(request.method)) {
    return json(request, 405, { error: "Method not allowed" }, { ...headers, Allow: route.methods.join(", ") });
  }
  return route.handle({ request, env, session, headers });
}
