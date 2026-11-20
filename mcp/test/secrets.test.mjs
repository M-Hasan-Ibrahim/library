// Secret handling: the integration token, the OAuth client secret, access and
// refresh tokens, authorization codes and Access JWTs never appear in MCP
// responses, error messages or logs (and the integration token appears in no
// response at all).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ipAllowed, parseCidrs, parseIp } from "../src/net.js";
import { accessJwt, authorizeQuery, consent, createEnv, exchangeCode, installAccessKeys, mcp, pkce, registerClient, restoreFetch, seen } from "./support/harness.mjs";

const ARTICLE = { title: "Secret test", language: "en", categoryId: "cat_other", blocks: [{ id: "b1", type: "paragraph", text: "Hello." }] };

let logs;
const originals = {};
beforeEach(() => {
  installAccessKeys();
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originals[level] = console[level];
    console[level] = (...args) => {
      logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  seen.length = 0;
});
afterEach(() => {
  Object.assign(console, originals);
  restoreFetch();
});

describe("secrets never leak", () => {
  test("a full session (sign-in, tool calls, errors) leaks no secret in responses or logs", async () => {
    const env = createEnv();
    const client = await registerClient(env);
    const { verifier, challenge } = pkce();
    const jwt = await accessJwt();
    const { post } = await consent(env, authorizeQuery(client.clientId, challenge), { jwt });
    const code = new URL(post.headers.get("location")).searchParams.get("code");
    const tokens = (await exchangeCode(env, client, code, verifier)).json;

    // Success, validation error, unknown tool, Library errors, an upstream that echoes the token back.
    await mcp(env, tokens.access_token, { method: "tools/list" });
    await mcp(env, tokens.access_token, { method: "tools/call", params: { name: "create_library_draft", arguments: ARTICLE } });
    await mcp(env, tokens.access_token, { method: "tools/call", params: { name: "create_library_draft", arguments: { ...ARTICLE, status: "published" } } });
    await mcp(env, tokens.access_token, { method: "tools/call", params: { name: "delete_library_draft", arguments: {} } });
    env.LIBRARY_API.respond = () =>
      new Response(JSON.stringify({ error: "x", fields: { title: `bad ${env.LIBRARY_INTEGRATION_TOKEN}` } }), { status: 422 });
    const echoed = await mcp(env, tokens.access_token, { method: "tools/call", params: { name: "create_library_draft", arguments: ARTICLE } });
    assert.match(echoed.json.result.content[0].text, /\[redacted\]/);
    env.LIBRARY_API.respond = () => new Response(`upstream failure ${env.LIBRARY_INTEGRATION_TOKEN}`, { status: 500 });
    await mcp(env, tokens.access_token, { method: "tools/call", params: { name: "create_library_draft", arguments: ARTICLE } });
    env.LIBRARY_API.respond = () => {
      throw new Error(`socket closed ${env.LIBRARY_INTEGRATION_TOKEN}`);
    };
    await mcp(env, tokens.access_token, { method: "tools/call", params: { name: "create_library_draft", arguments: ARTICLE } });
    await mcp(env, "invalid-token", { method: "ping" });

    const secrets = {
      integrationToken: env.LIBRARY_INTEGRATION_TOKEN,
      clientSecret: client.clientSecret,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      authorizationCode: code,
      accessJwt: jwt,
    };
    for (const [name, value] of Object.entries(secrets)) {
      assert.ok(value && value.length > 10, name);
      assert.ok(!logs.some((line) => line.includes(value)), `${name} found in logs`);
    }
    // The integration token and client secret are in no response at all.
    for (const response of seen) {
      const all = response.text + JSON.stringify(response.headers);
      assert.ok(!all.includes(secrets.integrationToken), `integration token in a response to ${response.path}`);
      assert.ok(!all.includes(secrets.clientSecret), `client secret in a response to ${response.path}`);
    }
    // MCP responses never carry OAuth credentials either.
    for (const response of seen.filter((r) => r.path === "/mcp")) {
      for (const name of ["accessToken", "refreshToken", "authorizationCode", "accessJwt"]) {
        assert.ok(!response.text.includes(secrets[name]), `${name} in an MCP response`);
      }
    }
    // The KV store holds no secret in clear text (the library stores hashes / encrypted data).
    const kvDump = [...env.OAUTH_KV.store.entries()].map(([k, v]) => `${k} ${v.value}`).join("\n");
    for (const name of ["integrationToken", "clientSecret", "accessToken", "refreshToken", "authorizationCode", "accessJwt"]) {
      assert.ok(!kvDump.includes(secrets[name]), `${name} stored in clear text in KV`);
    }
  });

  test("the integration token is only ever sent to the Library API, in the Authorization header", async () => {
    const env = createEnv();
    const client = await registerClient(env);
    const { verifier, challenge } = pkce();
    const { post } = await consent(env, authorizeQuery(client.clientId, challenge));
    const tokens = (await exchangeCode(env, client, new URL(post.headers.get("location")).searchParams.get("code"), verifier)).json;
    await mcp(env, tokens.access_token, { method: "tools/call", params: { name: "create_library_draft", arguments: ARTICLE } });
    const [sent] = env.LIBRARY_API.calls;
    assert.equal(sent.headers.authorization, `Bearer ${env.LIBRARY_INTEGRATION_TOKEN}`);
    assert.ok(!sent.body.includes(env.LIBRARY_INTEGRATION_TOKEN));
    assert.ok(!sent.url.includes(env.LIBRARY_INTEGRATION_TOKEN));
    // The client's own OAuth token is never forwarded to the Library.
    assert.ok(!JSON.stringify(sent).includes(tokens.access_token));
  });
});

describe("address allowlist parsing", () => {
  test("IPv4 and IPv6 ranges", () => {
    const ranges = parseCidrs("160.79.104.0/21, 2001:db8::/32, bogus, 10.0.0.0/99");
    assert.equal(ranges.length, 2);
    for (const ip of ["160.79.104.0", "160.79.111.255", "2001:db8::1", "2001:0db8:ffff::"]) assert.ok(ipAllowed(ip, ranges), ip);
    for (const ip of ["160.79.112.0", "160.79.103.255", "8.8.8.8", "2001:db9::1", "", null, "not-an-ip", "::ffff:160.79.104.1"]) assert.ok(!ipAllowed(ip, ranges), String(ip));
    assert.equal(parseCidrs("*"), null);
    assert.ok(ipAllowed("8.8.8.8", parseCidrs("*")));
    assert.deepEqual(parseCidrs(""), []);
    assert.ok(!ipAllowed("160.79.104.1", parseCidrs("")));
    assert.equal(parseIp("::1").value, 1n);
    assert.equal(parseIp("1.2.3"), null);
    assert.equal(parseIp("1:2:3:4:5:6:7:8:9"), null);
  });
});
