/**
 * library-mcp: a remote MCP server (Streamable HTTP) that lets the owner's
 * Claude.ai connector create PRIVATE article drafts in the Library, and
 * nothing else.
 *
 *   /mcp                                     MCP endpoint (OAuth access token required) — mcp.js
 *   /authorize                               sign-in (Cloudflare Access) + consent — authorize.js
 *   /token                                   OAuth token endpoint (authorization code + PKCE, refresh)
 *   /.well-known/oauth-protected-resource    RFC 9728 metadata (resource = <PUBLIC_URL>/mcp)
 *   /.well-known/oauth-authorization-server  RFC 8414 metadata
 *
 * OAuth (@cloudflare/workers-oauth-provider): one PRE-REGISTERED confidential
 * client (Claude.ai, redirect https://claude.ai/api/mcp/auth_callback), created
 * with tools/oauth-client.mjs. There is no registration endpoint. Tokens and
 * grants live in KV (binding OAUTH_KV), stored hashed/encrypted by the library.
 *
 * Outer checks before the library: /mcp and /token only from ALLOWED_CLIENT_CIDRS
 * (Claude's published egress range); /mcp refuses browser Origins other than
 * MCP_ALLOWED_ORIGINS (DNS-rebinding protection the MCP transport spec requires).
 * Missing configuration fails closed.
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authorizeHandler } from "./authorize.js";
import { mcpHandler, SCOPE } from "./mcp.js";
import { ipAllowed, parseCidrs } from "./net.js";

const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
const CLIENT_ONLY_PATHS = new Set(["/mcp", "/token"]);

const plain = (status, text, extra) =>
  new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra } });

/** Non-API routes (anything without a valid token on /mcp ends up in the library, not here). */
const defaultHandler = {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return authorizeHandler.fetch(request, env, ctx);
    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return plain(200, "Library drafts MCP server. Add it to Claude as a custom connector: <this address>/mcp\n");
    }
    return plain(404, "Not found\n");
  },
};

/** The MCP handler only for exactly /mcp (the provider matches apiRoute as a prefix). */
const apiHandler = {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/mcp") return plain(404, "Not found\n");
    return mcpHandler.fetch(request, env, ctx);
  },
};

let cached = { url: null, provider: null };

/** One provider per configured public URL (the resource identifier depends on it). */
function providerFor(publicUrl) {
  if (cached.url !== publicUrl) {
    cached = {
      url: publicUrl,
      provider: new OAuthProvider({
        apiRoute: "/mcp",
        apiHandler,
        defaultHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        // No clientRegistrationEndpoint: dynamic registration is off.
        accessTokenTTL: ACCESS_TOKEN_TTL,
        refreshTokenTTL: REFRESH_TOKEN_TTL,
        scopesSupported: [SCOPE],
        requiredScopes: [SCOPE],
        allowTokenExchangeGrant: false,
        // Log only the status and error code (never request details); keep the library's response.
        onError: ({ status, code }) => {
          console.warn(`OAuth error response: ${status} ${code}`);
        },
        resourceMetadata: { resource: `${publicUrl}/mcp`, resource_name: "Library drafts" },
      }),
    };
  }
  return cached.provider;
}

/** PUBLIC_URL as "https://host" (no path, no trailing slash), or null. */
function publicUrlOf(env) {
  try {
    const url = new URL(String(env.PUBLIC_URL ?? ""));
    const ok = url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username;
    return ok ? url.origin : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const publicUrl = publicUrlOf(env);
    if (!publicUrl || !env.OAUTH_KV) {
      console.error("library-mcp is not configured (PUBLIC_URL or OAUTH_KV)");
      return plain(503, "Not configured\n");
    }
    const url = new URL(request.url);
    // Serve only on the configured host (the OAuth metadata and resource depend on it).
    if (url.origin !== publicUrl) return plain(404, "Not found\n");

    if (CLIENT_ONLY_PATHS.has(url.pathname)) {
      const ranges = parseCidrs(env.ALLOWED_CLIENT_CIDRS);
      if (!ipAllowed(request.headers.get("CF-Connecting-IP"), ranges)) {
        // The address is logged (not a secret) so a change in Anthropic's ranges is easy to spot.
        console.warn(`Refused ${request.method} ${url.pathname}: source address ${request.headers.get("CF-Connecting-IP") ?? "unknown"} not allowed`);
        return plain(403, "Forbidden\n");
      }
    }
    if (url.pathname === "/mcp") {
      const origin = request.headers.get("Origin");
      const allowed = String(env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (origin && !allowed.includes(origin)) return plain(403, "Origin not allowed\n");
    }
    return providerFor(publicUrl).fetch(request, env, ctx);
  },
};
