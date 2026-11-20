// OAuth, sign-in (Cloudflare Access) and consent: the real Worker and OAuth library.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  accessJwt, authorizeQuery, call, CLAUDE_CALLBACK, CLAUDE_IP, CLAUDE_IP_2, CONFIGURED_CIDRS, consent, createEnv, exchangeCode, installAccessKeys, mcp,
  OTHER_IP, pkce, PUBLIC, registerClient, RESOURCE, restoreFetch, signIn,
} from "./support/harness.mjs";

let env;
beforeEach(() => {
  installAccessKeys();
  env = createEnv();
});
afterEach(restoreFetch);

describe("discovery metadata (what Claude.ai reads)", () => {
  test("protected resource metadata names exactly <PUBLIC>/mcp and this server", async () => {
    const res = await call(env, "/.well-known/oauth-protected-resource/mcp");
    assert.equal(res.status, 200);
    assert.equal(res.json.resource, RESOURCE);
    assert.deepEqual(res.json.authorization_servers, [PUBLIC]);
    assert.deepEqual(res.json.scopes_supported, ["drafts:create"]);
  });

  test("authorization server metadata: S256 PKCE, code flow, no registration endpoint", async () => {
    const res = await call(env, "/.well-known/oauth-authorization-server");
    assert.equal(res.status, 200);
    assert.equal(res.json.issuer, PUBLIC);
    assert.equal(res.json.authorization_endpoint, `${PUBLIC}/authorize`);
    assert.equal(res.json.token_endpoint, `${PUBLIC}/token`);
    assert.deepEqual(res.json.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(res.json.response_types_supported, ["code"]);
    assert.ok(!("registration_endpoint" in res.json), "dynamic client registration must be off");
    assert.ok(!res.json.grant_types_supported.some((g) => /token-exchange|implicit|jwt-bearer/.test(g)));
  });

  test("/mcp without a token -> 401 with a WWW-Authenticate pointing to the metadata", async () => {
    const res = await mcp(env, null, { method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate");
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, new RegExp(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`));
  });

  test("registration endpoints do not exist", async () => {
    for (const path of ["/register", "/oauth/register", "/registration"]) {
      const res = await call(env, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) });
      assert.equal(res.status, 404, path);
    }
    assert.equal([...env.OAUTH_KV.store.keys()].filter((k) => k.startsWith("client:")).length, 0);
  });
});

describe("authorization code flow with the pre-registered client", () => {
  test("consent -> code to the Claude callback -> tokens (client_secret_basic)", async () => {
    const { tokens, location } = await signIn(env);
    assert.equal(`${location.origin}${location.pathname}`, CLAUDE_CALLBACK);
    assert.equal(location.searchParams.get("state"), "state-123");
    assert.equal(location.searchParams.get("iss"), PUBLIC);
    assert.equal(tokens.token_type.toLowerCase(), "bearer");
    assert.equal(tokens.scope, "drafts:create");
    assert.equal(tokens.expires_in, 3600);
    assert.ok(tokens.refresh_token);
    assert.equal((await mcp(env, tokens.access_token, { method: "ping" })).status, 200);
  });

  test("client_secret_post is accepted too", async () => {
    const { tokens } = await signIn(env, { method: "post" });
    assert.ok(tokens.access_token);
  });

  test("refresh works; the old refresh token stops working after rotation grace", async () => {
    const { client, tokens } = await signIn(env);
    const refresh = (refreshToken) =>
      call(env, "/token", {
        method: "POST",
        ip: CLAUDE_IP,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}` },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, resource: RESOURCE }).toString(),
      });
    const first = await refresh(tokens.refresh_token);
    assert.equal(first.status, 200);
    assert.ok(first.json.access_token && first.json.access_token !== tokens.access_token);
    assert.equal((await mcp(env, first.json.access_token, { method: "ping" })).status, 200);
    const dead = await refresh("not-a-refresh-token");
    assert.equal(dead.status, 400);
    assert.equal(dead.json.error, "invalid_grant");
  });

  test("wrong client secret, unknown client, wrong PKCE verifier, reused code -> refused", async () => {
    const client = await registerClient(env);
    const { verifier, challenge } = pkce();
    const location = new URL((await consent(env, authorizeQuery(client.clientId, challenge))).post.headers.get("location"));
    const code = location.searchParams.get("code");

    const badSecret = await exchangeCode(env, { ...client, clientSecret: "wrong-secret" }, code, verifier);
    assert.equal(badSecret.status, 401);
    assert.equal(badSecret.json.error, "invalid_client");
    const unknown = await exchangeCode(env, { clientId: "someone-else", clientSecret: client.clientSecret }, code, verifier);
    assert.equal(unknown.status, 401);
    const badVerifier = await exchangeCode(env, client, code, pkce().verifier);
    assert.equal(badVerifier.json.error, "invalid_grant");
    // After a failed attempt the code may be burnt; a fresh code works once and only once.
    const fresh = pkce();
    const code2 = new URL((await consent(env, authorizeQuery(client.clientId, fresh.challenge))).post.headers.get("location")).searchParams.get("code");
    assert.equal((await exchangeCode(env, client, code2, fresh.verifier)).status, 200);
    assert.equal((await exchangeCode(env, client, code2, fresh.verifier)).json.error, "invalid_grant");
  });

  test("forged, revoked or random access tokens -> 401", async () => {
    const { client, tokens } = await signIn(env);
    for (const token of ["random", `${tokens.access_token}x`, tokens.access_token.replace(/.$/, (c) => (c === "a" ? "b" : "a"))]) {
      assert.equal((await mcp(env, token, { method: "ping" })).status, 401);
    }
    // Revocation (RFC 7009) through the token endpoint.
    const revoke = await call(env, "/token", {
      method: "POST",
      ip: CLAUDE_IP,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams({ token: tokens.access_token }).toString(),
    });
    assert.equal(revoke.status, 200);
    assert.equal((await mcp(env, tokens.access_token, { method: "ping" })).status, 401);
  });

  test("tokens are not usable with an Access JWT alone, nor as an Access JWT", async () => {
    const jwt = await accessJwt();
    const res = await call(env, "/mcp", { method: "POST", ip: CLAUDE_IP, headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt, Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    assert.equal(res.status, 401);
  });
});

describe("authorization endpoint: who may approve", () => {
  test("without the Access JWT, with another email, a wrong audience or an expired token -> refused, no code", async () => {
    const client = await registerClient(env);
    const query = authorizeQuery(client.clientId, pkce().challenge);
    assert.equal((await call(env, `/authorize${query}`)).status, 401);
    assert.equal((await call(env, `/authorize${query}`, { headers: { "Cf-Access-Jwt-Assertion": await accessJwt({ email: "intruder@example.com" }) } })).status, 403);
    assert.equal((await call(env, `/authorize${query}`, { headers: { "Cf-Access-Jwt-Assertion": await accessJwt({ aud: ["b".repeat(64)] }) } })).status, 401);
    assert.equal((await call(env, `/authorize${query}`, { headers: { "Cf-Access-Jwt-Assertion": await accessJwt({ exp: Math.floor(Date.now() / 1000) - 60 }) } })).status, 401);
    const { post } = await consent(env, query, { jwt: await accessJwt({ email: "intruder@example.com" }) });
    assert.equal(post.status, 403);
  });

  test("Access not configured (placeholder AUD or missing ADMIN_EMAIL) -> 503", async () => {
    const client = await registerClient(env);
    const query = authorizeQuery(client.clientId, pkce().challenge);
    const jwt = await accessJwt();
    env.ACCESS_AUD = "REPLACE_WITH_ACCESS_AUD_OF_LIBRARY_MCP_AUTHORIZE";
    assert.equal((await call(env, `/authorize${query}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).status, 503);
    env = createEnv({ ADMIN_EMAIL: undefined, OAUTH_KV: env.OAUTH_KV });
    assert.equal((await call(env, `/authorize${query}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })).status, 503);
  });

  test("invalid requests: unknown client, unregistered redirect, no PKCE, plain PKCE, wrong resource -> 400 page, never a redirect", async () => {
    const client = await registerClient(env);
    const { challenge } = pkce();
    const jwt = await accessJwt();
    const cases = [
      authorizeQuery("unknown-client", challenge),
      authorizeQuery(client.clientId, challenge, { redirect_uri: "https://evil.example/callback" }),
      authorizeQuery(client.clientId, challenge, { redirect_uri: "https://claude.ai/api/mcp/auth_callback/../../evil" }),
      authorizeQuery(client.clientId, challenge, { code_challenge: null, code_challenge_method: null }),
      authorizeQuery(client.clientId, challenge, { code_challenge_method: "plain" }),
      authorizeQuery(client.clientId, challenge, { response_type: "token" }),
      authorizeQuery(client.clientId, challenge, { resource: "https://api.library.mh-ibrahim.com/" }),
    ];
    for (const query of cases) {
      const res = await call(env, `/authorize${query}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } });
      assert.equal(res.status, 400, query);
      assert.equal(res.headers.get("location"), null);
    }
  });

  test("the consent page cannot be framed and is not cached", async () => {
    const client = await registerClient(env);
    const res = await call(env, `/authorize${authorizeQuery(client.clientId, pkce().challenge)}`, { headers: { "Cf-Access-Jwt-Assertion": await accessJwt() } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("set-cookie"), /^__Host-library-mcp-consent=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    assert.match(res.text, /create <strong>private article drafts<\/strong>/);
    assert.match(res.text, /not<\/strong> be able to publish, edit, delete, list or read/);
  });

  test("CSRF: wrong Origin, missing or mismatched nonce, missing cookie -> 403, no code", async () => {
    const client = await registerClient(env);
    const query = authorizeQuery(client.clientId, pkce().challenge);
    for (const options of [
      { origin: "https://evil.example" },
      { origin: null },
      { nonceOverride: "A".repeat(43) },
      { cookieOverride: "" },
      { cookieOverride: `__Host-library-mcp-consent=${"B".repeat(43)}` },
    ]) {
      const { post } = await consent(env, query, options);
      assert.equal(post.status, 403, JSON.stringify(options));
      assert.equal(post.headers.get("location"), null);
    }
  });

  test("Deny -> redirect to Claude with access_denied, no code", async () => {
    const client = await registerClient(env);
    const { post } = await consent(env, authorizeQuery(client.clientId, pkce().challenge), { decision: "deny" });
    assert.equal(post.status, 302);
    const location = new URL(post.headers.get("location"));
    assert.equal(`${location.origin}${location.pathname}`, CLAUDE_CALLBACK);
    assert.equal(location.searchParams.get("error"), "access_denied");
    assert.equal(location.searchParams.get("code"), null);
  });

  test("whatever scope is requested, only drafts:create is granted", async () => {
    const client = await registerClient(env);
    const { verifier, challenge } = pkce();
    const { post } = await consent(env, authorizeQuery(client.clientId, challenge, { scope: "drafts:create admin publish" }));
    const code = new URL(post.headers.get("location")).searchParams.get("code");
    const tokens = await exchangeCode(env, client, code, verifier);
    assert.equal(tokens.json.scope, "drafts:create");
  });
});

describe("Claude.ai address allowlist covers the whole OAuth flow", () => {
  const basic = (client) => `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
  const tokenRequest = (client, form, ip) =>
    call(env, "/token", { method: "POST", ip, headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic(client) }, body: new URLSearchParams(form).toString() });

  test("the configured ranges are exactly Anthropic's documented outbound IPv4 ranges", () => {
    assert.deepEqual(CONFIGURED_CIDRS.split(",").map((s) => s.trim()).sort(), ["153.61.208.0/20", "160.79.104.0/21"]);
  });

  test("discovery, code exchange, refresh, revocation and MCP calls succeed from both ranges", async () => {
    // Discovery (from Anthropic) is public anyway; /authorize is the owner's browser (any address).
    assert.equal((await call(env, "/.well-known/oauth-protected-resource/mcp", { ip: CLAUDE_IP_2 })).status, 200);
    for (const [exchangeIp, refreshIp, mcpIp] of [[CLAUDE_IP, CLAUDE_IP_2, CLAUDE_IP_2], [CLAUDE_IP_2, CLAUDE_IP, CLAUDE_IP], ["153.61.223.255", "160.79.111.255", "153.61.208.0"]]) {
      const client = await registerClient(env);
      const { verifier, challenge } = pkce();
      const { post } = await consent(env, authorizeQuery(client.clientId, challenge));
      const code = new URL(post.headers.get("location")).searchParams.get("code");
      const exchanged = await exchangeCode(env, client, code, verifier, { ip: exchangeIp });
      assert.equal(exchanged.status, 200, `exchange from ${exchangeIp}`);
      assert.equal((await mcp(env, exchanged.json.access_token, { method: "tools/list" }, { ip: mcpIp })).status, 200, `mcp from ${mcpIp}`);
      const refreshed = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: exchanged.json.refresh_token, resource: RESOURCE }, refreshIp);
      assert.equal(refreshed.status, 200, `refresh from ${refreshIp}`);
      assert.equal((await mcp(env, refreshed.json.access_token, { method: "ping" }, { ip: mcpIp })).status, 200);
      assert.equal((await tokenRequest(client, { token: refreshed.json.access_token }, exchangeIp)).status, 200, "revocation");
      assert.equal((await mcp(env, refreshed.json.access_token, { method: "ping" }, { ip: mcpIp })).status, 401);
    }
  });

  test("outside both ranges (incl. edges and IPv6) the token endpoint and /mcp refuse, before any OAuth work", async () => {
    const { client, tokens } = await signIn(env);
    for (const ip of ["160.79.112.0", "160.79.103.255", "153.61.224.0", "153.61.207.255", "2607:6bc0::10", OTHER_IP]) {
      const refresh = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: RESOURCE }, ip);
      assert.equal(refresh.status, 403, `refresh from ${ip}`);
      assert.equal((await mcp(env, tokens.access_token, { method: "ping" }, { ip })).status, 403, `mcp from ${ip}`);
    }
    // The refused refresh attempts did not consume the refresh token.
    const ok = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: RESOURCE }, CLAUDE_IP);
    assert.equal(ok.status, 200);
  });

  test("the owner's browser can sign in and approve from any address", async () => {
    const client = await registerClient(env);
    const { challenge } = pkce();
    const query = authorizeQuery(client.clientId, challenge);
    const res = await call(env, `/authorize${query}`, { ip: OTHER_IP, headers: { "Cf-Access-Jwt-Assertion": await accessJwt() } });
    assert.equal(res.status, 200);
  });
});

describe("outer protections", () => {
  test("/mcp and /token only from Claude's address range", async () => {
    const { client, tokens } = await signIn(env);
    assert.equal((await mcp(env, tokens.access_token, { method: "ping" }, { ip: OTHER_IP })).status, 403);
    assert.equal((await mcp(env, tokens.access_token, { method: "ping" }, { ip: null })).status, 403); // no address at all
    const res = await exchangeCode(env, client, "code", "verifier", { ip: OTHER_IP });
    assert.equal(res.status, 403);
    // Metadata and the sign-in page are public (the browser calls /authorize).
    assert.equal((await call(env, "/.well-known/oauth-authorization-server", { ip: OTHER_IP })).status, 200);
  });

  test("missing ALLOWED_CLIENT_CIDRS refuses /mcp; '*' disables the check explicitly", async () => {
    const { tokens } = await signIn(env);
    env.ALLOWED_CLIENT_CIDRS = "";
    assert.equal((await mcp(env, tokens.access_token, { method: "ping" })).status, 403);
    env.ALLOWED_CLIENT_CIDRS = "*";
    assert.equal((await mcp(env, tokens.access_token, { method: "ping" }, { ip: OTHER_IP })).status, 200);
  });

  test("a browser Origin other than Claude's is refused on /mcp", async () => {
    const { tokens } = await signIn(env);
    assert.equal((await mcp(env, tokens.access_token, { method: "ping" }, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await mcp(env, tokens.access_token, { method: "ping" }, { headers: { Origin: "https://claude.ai" } })).status, 200);
  });

  test("missing PUBLIC_URL or KV -> 503; another host -> 404", async () => {
    assert.equal((await call(createEnv({ PUBLIC_URL: "" }), "/")).status, 503);
    assert.equal((await call(createEnv({ PUBLIC_URL: "https://mcp.test.example/sub" }), "/")).status, 503);
    assert.equal((await call(createEnv({ OAUTH_KV: undefined }), "/")).status, 503);
    const other = createEnv({ PUBLIC_URL: "https://other.example" });
    assert.equal((await call(other, "/.well-known/oauth-authorization-server")).status, 404);
  });
});
