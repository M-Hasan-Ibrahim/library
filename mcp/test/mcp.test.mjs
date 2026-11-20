// MCP protocol + the create_library_draft tool: draft creation, validation,
// draft-only behaviour and refusal of every other operation.
import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, test } from "node:test";
import { mcpHandler } from "../src/mcp.js";
import { TOOL } from "../src/tool.js";
import { call, CLAUDE_IP, createEnv, installAccessKeys, mcp, restoreFetch, signIn } from "./support/harness.mjs";

const ARTICLE = {
  title: "Notes from Claude",
  description: "A short test article.",
  language: "en",
  categoryId: "cat_science",
  tags: ["test"],
  links: [{ label: "Example", url: "https://example.com/" }],
  blocks: [
    { id: "b1", type: "paragraph", text: "A **draft** written through MCP." },
    { id: "b2", type: "heading", level: 2, text: "More" },
    { id: "b3", type: "list", items: ["one", { text: "two", list: { items: ["two.a"] } }] },
    { id: "b4", type: "details", summary: "Details", blocks: [{ id: "b4a", type: "code", language: "js", text: "1 + 1" }] },
  ],
};

let env;
let token;
beforeEach(async () => {
  installAccessKeys();
  env = createEnv();
  token = (await signIn(env)).tokens.access_token;
});
afterEach(restoreFetch);

const callTool = (args, name = "create_library_draft") => mcp(env, token, { method: "tools/call", params: { name, arguments: args } });

describe("protocol", () => {
  test("initialize negotiates a supported version and announces tools only", async () => {
    for (const [requested, expected] of [["2025-06-18", "2025-06-18"], ["2025-03-26", "2025-03-26"], ["2025-11-25", "2025-11-25"], ["1999-01-01", "2025-06-18"]]) {
      const res = await mcp(env, token, { method: "initialize", params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json");
      assert.equal(res.json.result.protocolVersion, expected);
      assert.deepEqual(Object.keys(res.json.result.capabilities), ["tools"]);
      assert.equal(res.json.result.serverInfo.name, "library-mcp");
    }
  });

  test("tools/list returns exactly one tool: create_library_draft", async () => {
    const res = await mcp(env, token, { method: "tools/list" });
    assert.equal(res.json.result.tools.length, 1);
    const [tool] = res.json.result.tools;
    assert.equal(tool.name, "create_library_draft");
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, ["title", "language", "categoryId", "blocks"]);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["blocks", "categoryId", "description", "language", "links", "tags", "title"]);
  });

  test("notifications -> 202 without body; ping -> {}", async () => {
    const res = await mcp(env, token, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    assert.equal(res.status, 202);
    assert.equal(res.text, "");
    assert.deepEqual((await mcp(env, token, { method: "ping" })).json.result, {});
  });

  test("GET/DELETE /mcp -> 405; batches, bad JSON, wrong type, bad version, oversize -> refused", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await call(env, "/mcp", { method, ip: CLAUDE_IP, headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 405, method);
    }
    assert.equal((await mcp(env, token, JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]))).status, 400);
    assert.equal((await mcp(env, token, "{not json")).status, 400);
    assert.equal((await mcp(env, token, { method: "ping" }, { headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await mcp(env, token, { method: "ping" }, { headers: { "MCP-Protocol-Version": "2024-01-01" } })).status, 400);
    assert.equal((await mcp(env, token, { method: "ping" }, { headers: { "MCP-Protocol-Version": "2025-06-18" } })).status, 200);
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_library_draft", arguments: { ...ARTICLE, description: "x".repeat(170 * 1024) } } });
    assert.equal((await mcp(env, token, big)).status, 413);
    assert.equal(env.LIBRARY_API.calls.length, 0);
  });
});

describe("create_library_draft", () => {
  test("creates a draft: forwards exactly the article fields with the integration token", async () => {
    const res = await callTool(ARTICLE);
    assert.equal(res.status, 200);
    const result = res.json.result;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { id: "itm_abcdefghijklmnop", status: "draft" });
    assert.match(result.content[0].text, /Draft created \(id itm_abcdefghijklmnop\)/);

    assert.equal(env.LIBRARY_API.calls.length, 1);
    const sent = env.LIBRARY_API.calls[0];
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "https://api.library.test/api/integrations/drafts");
    assert.equal(sent.headers.authorization, `Bearer ${env.LIBRARY_INTEGRATION_TOKEN}`);
    assert.equal(sent.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(sent.body), { type: "article", ...ARTICLE });
  });

  test("minimal article (no description, tags or links) and Arabic", async () => {
    const res = await callTool({ title: "لماذا نكتب؟", language: "ar", categoryId: "cat_thoughts", blocks: [{ id: "b1", type: "paragraph", text: "نص قصير." }] });
    assert.deepEqual(res.json.result.structuredContent, { id: "itm_abcdefghijklmnop", status: "draft" });
  });

  test("publishing or other non-article fields are refused before the Library is called", async () => {
    for (const extra of [{ status: "published" }, { published: true }, { publish: true }, { slug: "x" }, { id: "itm_x" }, { type: "link" }, { fileUrl: "https://x/a.pdf" }, { addedAt: "2020-01-01" }, { revision: 1 }]) {
      const res = await callTool({ ...ARTICLE, ...extra });
      assert.equal(res.json.result.isError, true, JSON.stringify(extra));
      assert.match(res.json.result.content[0].text, new RegExp(`- ${Object.keys(extra)[0]}:`));
    }
    assert.match((await callTool({ ...ARTICLE, status: "published" })).json.result.content[0].text, /only creates drafts/);
    assert.equal(env.LIBRARY_API.calls.length, 0);
  });

  test("invalid content is refused before the Library is called", async () => {
    const cases = [
      {},
      { ...ARTICLE, title: "" },
      { ...ARTICLE, title: "a".repeat(201) },
      { ...ARTICLE, language: "fr" },
      { ...ARTICLE, categoryId: "cat_admin" },
      { ...ARTICLE, blocks: [] },
      { ...ARTICLE, blocks: [{ id: "b1", type: "html", text: "<script>alert(1)</script>" }] },
      { ...ARTICLE, blocks: [{ id: "b1", type: "paragraph", text: "[x](javascript:alert(1))" }] },
      { ...ARTICLE, links: [{ label: "x", url: "javascript:alert(1)" }] },
      { ...ARTICLE, tags: ["a", "a"] },
      { ...ARTICLE, blocks: [{ id: "d", type: "details", summary: "s", blocks: [{ id: "d2", type: "details", summary: "s", blocks: [] }] }] },
    ];
    for (const args of cases) {
      const res = await callTool(args);
      assert.equal(res.json.result.isError, true, JSON.stringify(args).slice(0, 120));
    }
    assert.equal((await mcp(env, token, { method: "tools/call", params: { name: "create_library_draft", arguments: "not an object" } })).json.result.isError, true);
    assert.equal(env.LIBRARY_API.calls.length, 0);
  });

  test("Library answers are mapped to safe tool errors", async () => {
    const answers = [
      [422, { error: "Some fields are not valid", code: "validation", fields: { categoryId: "is not an existing category" } }, /categoryId: is not an existing category/],
      [429, { code: "quota_exceeded" }, /daily limit/i],
      [429, { code: "rate_limited" }, /Too many requests/],
      [413, { code: "too_large" }, /too large/],
      [401, { error: "Unauthorized" }, /could not create the draft right now/],
      [503, { error: "This integration is not enabled" }, /could not create the draft right now/],
      [500, { error: "Internal error" }, /could not create the draft right now/],
    ];
    for (const [status, body, expected] of answers) {
      env.LIBRARY_API.respond = () => new Response(JSON.stringify(body), { status });
      const res = await callTool(ARTICLE);
      assert.equal(res.json.result.isError, true, String(status));
      assert.match(res.json.result.content[0].text, expected);
      assert.ok(!/Unauthorized|not enabled|Internal error/.test(res.json.result.content[0].text), "no internal details");
    }
    // A 201 that is not a draft is never reported as success.
    env.LIBRARY_API.respond = () => new Response(JSON.stringify({ id: "itm_x", status: "published" }), { status: 201 });
    assert.equal((await callTool(ARTICLE)).json.result.isError, true);
    // Unreachable upstream.
    env.LIBRARY_API.respond = () => { throw new Error("network down"); };
    assert.match((await callTool(ARTICLE)).json.result.content[0].text, /could not be reached/);
  });

  test("server misconfiguration (token, binding, base URL) -> tool error, nothing sent", async () => {
    for (const overrides of [{ LIBRARY_INTEGRATION_TOKEN: "" }, { LIBRARY_INTEGRATION_TOKEN: "short" }, { LIBRARY_API: undefined }, { LIBRARY_API_URL: "http://insecure" }]) {
      const broken = { ...env, ...overrides };
      const res = await mcp(broken, token, { method: "tools/call", params: { name: "create_library_draft", arguments: ARTICLE } });
      assert.equal(res.json.result.isError, true, JSON.stringify(Object.keys(overrides)));
      assert.match(res.json.result.content[0].text, /not available right now/);
    }
    assert.equal(env.LIBRARY_API.calls.length, 0);
  });
});

describe("no other operations", () => {
  test("other tool names -> 'Unknown tool' error, Library never called", async () => {
    for (const name of ["publish_library_draft", "update_library_draft", "delete_library_draft", "list_library_drafts", "get_library_item", "create_library_item", "CREATE_LIBRARY_DRAFT", "", null]) {
      const res = await callTool(ARTICLE, name);
      assert.equal(res.json.error?.code, -32602, String(name));
      assert.match(res.json.error.message, /Unknown tool/);
    }
    assert.equal(env.LIBRARY_API.calls.length, 0);
  });

  test("resources, prompts, sampling, completion, logging and unknown methods -> Method not found", async () => {
    for (const method of ["resources/list", "resources/read", "resources/templates/list", "resources/subscribe", "prompts/list", "prompts/get", "sampling/createMessage", "completion/complete", "logging/setLevel", "roots/list", "elicitation/create", "tasks/list", "admin/publish", "items/delete"]) {
      const res = await mcp(env, token, { method, params: { uri: "library://drafts" } });
      assert.equal(res.json.error?.code, -32601, method);
    }
    assert.equal(env.LIBRARY_API.calls.length, 0);
  });

  test("the only upstream path ever used is POST /api/integrations/drafts", async () => {
    await callTool(ARTICLE);
    await callTool({ ...ARTICLE, title: "Second" });
    assert.ok(env.LIBRARY_API.calls.every((c) => c.method === "POST" && new URL(c.url).pathname === "/api/integrations/drafts"));
  });
});

describe("abuse limits on /mcp", () => {
  test("rate limiter: per user key; refusal -> 429; missing or failing binding -> 503", async () => {
    await mcp(env, token, { method: "ping" });
    assert.equal(env.MCP_RATE_LIMITER.keys.at(-1), "user:owner");
    env.MCP_RATE_LIMITER.allow = false;
    const limited = await mcp(env, token, { method: "ping" });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    for (const binding of [undefined, {}, { limit: async () => { throw new Error("down"); } }, { limit: async () => ({}) }]) {
      env.MCP_RATE_LIMITER = binding;
      assert.equal((await mcp(env, token, { method: "tools/list" })).status, 503);
    }
  });

  test("a token without the drafts:create scope is refused (403)", async () => {
    const response = await mcpHandler.fetch(
      new Request("https://mcp.test.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
      env,
      { auth: { scope: ["something:else"], userId: "owner" }, props: {} },
    );
    assert.equal(response.status, 403);
    assert.match(response.headers.get("www-authenticate"), /insufficient_scope/);
  });
});

before(() => {
  // The tool definition is static data the model sees: it must not mention any secret setting.
  assert.ok(!JSON.stringify(TOOL).match(/token|secret|password/i));
});
