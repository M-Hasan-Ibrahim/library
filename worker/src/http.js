/**
 * Response helpers shared by the public API (index.js) and the admin API
 * (admin.js), so both send the same security headers.
 */

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** Origins listed in the ALLOWED_ORIGINS variable (comma-separated). */
export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** The request's Origin when it is allowed, otherwise null. */
export function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  return origin && allowedOrigins(env).includes(origin) ? origin : null;
}

/** JSON response (empty body for HEAD). */
export function json(request, status, data, headers) {
  const body = request.method === "HEAD" ? null : JSON.stringify(data);
  return new Response(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}
