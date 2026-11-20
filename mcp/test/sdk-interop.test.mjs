// Interoperability: the official MCP TypeScript SDK client (Streamable HTTP
// transport) against this Worker, with an OAuth access token from the real flow.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker from "../src/index.js";
import { CLAUDE_IP, createEnv, installAccessKeys, RESOURCE, restoreFetch, signIn } from "./support/harness.mjs";

let env;
beforeEach(() => {
  installAccessKeys();
  env = createEnv();
});
afterEach(restoreFetch);

function transportFor(accessToken) {
  // Route the SDK's HTTP requests to the Worker, as if they came from Claude's network.
  const fetchToWorker = async (url, init) => {
    const request = new Request(url, init);
    const headers = new Headers(request.headers);
    headers.set("CF-Connecting-IP", CLAUDE_IP);
    return worker.fetch(new Request(request, { headers }), env, { waitUntil() {}, passThroughOnException() {} });
  };
  return new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: fetchToWorker,
    requestInit: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  });
}

test("SDK client: connect, list the one tool, create a draft", async () => {
  const { tokens } = await signIn(env);
  const client = new Client({ name: "interop-test", version: "1.0.0" });
  await client.connect(transportFor(tokens.access_token));
  assert.equal(client.getServerVersion().name, "library-mcp");
  assert.ok(client.getServerCapabilities().tools);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["create_library_draft"]);

  const result = await client.callTool({
    name: "create_library_draft",
    arguments: { title: "From the SDK", language: "en", categoryId: "cat_science", blocks: [{ id: "b1", type: "paragraph", text: "Hi." }] },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { id: "itm_abcdefghijklmnop", status: "draft" });

  const unknown = await client.callTool({ name: "publish_library_draft", arguments: {} }).catch((error) => error);
  assert.match(String(unknown?.message ?? unknown), /Unknown tool/);
  await assert.rejects(client.listResources(), /Method not found/);
  await client.close();
  assert.equal(env.LIBRARY_API.calls.length, 1);
});

test("SDK client without a token cannot connect", async () => {
  const client = new Client({ name: "interop-test", version: "1.0.0" });
  await assert.rejects(client.connect(transportFor(null)));
  assert.equal(env.LIBRARY_API.calls.length, 0);
});
