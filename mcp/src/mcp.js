/**
 * MCP endpoint (Streamable HTTP, stateless, JSON responses). Only reached with
 * a valid OAuth access token: the OAuthProvider (index.js) checks it and puts
 * the grant's props in ctx.props and the token's details in ctx.auth.
 *
 *   POST /mcp   one JSON-RPC message -> application/json (or 202 for notifications)
 *   GET  /mcp   405 (no server-initiated stream; allowed by the transport spec)
 *
 * Methods: initialize, ping, tools/list, tools/call (create_library_draft only)
 * and notifications. Anything else: "Method not found". No resources, prompts,
 * sampling or sessions.
 */
import { createDraft, TOOL, TOOL_NAME } from "./tool.js";

export const SCOPE = "drafts:create";
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY_BYTES = 160 * 1024;
const SERVER_INFO = { name: "library-mcp", title: "Library drafts", version: "1.0.0" };
const INSTRUCTIONS =
  "Creates private article drafts in the owner's Library. One tool: create_library_draft. " +
  "Drafts are never published by this server; the owner reviews and publishes them.";
const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const reply = (status, body, extra) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/* ------------------------------------------------------------ request checks */

async function readBody(request) {
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return { tooLarge: true };
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
        return { tooLarge: true };
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
    return { message: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { invalid: true };
  }
}

/** "allowed", "limited" or "unavailable" (missing/failing binding: fail closed). */
async function rateLimit(env, key) {
  const limiter = env.MCP_RATE_LIMITER;
  if (typeof limiter?.limit !== "function") {
    console.error("MCP request refused: the MCP_RATE_LIMITER binding is missing or misconfigured");
    return "unavailable";
  }
  try {
    const outcome = await limiter.limit({ key });
    if (outcome?.success === true) return "allowed";
    if (outcome?.success === false) return "limited";
  } catch (error) {
    console.error("MCP rate limiter error:", error instanceof Error ? error.message : error);
  }
  return "unavailable";
}

/* ------------------------------------------------------------ methods */

function negotiate(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1];
}

async function dispatch(message, env) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: negotiate(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== TOOL_NAME) return rpcError(id, -32602, `Unknown tool: only ${TOOL_NAME} is available`);
      return rpcResult(id, await createDraft(params.arguments ?? {}, env));
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

/* ------------------------------------------------------------ entry point */

export const mcpHandler = {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return reply(405, rpcError(null, -32000, "Method not allowed"), { Allow: "POST" });

    // The token must carry this server's scope (ctx.auth is set by the OAuthProvider).
    const scopes = ctx?.auth?.scope ?? [];
    if (!scopes.includes(SCOPE)) {
      return reply(403, rpcError(null, -32001, "Insufficient scope"), {
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${SCOPE}"`,
      });
    }

    const outcome = await rateLimit(env, `user:${ctx?.auth?.userId ?? "unknown"}`);
    if (outcome === "limited") return reply(429, rpcError(null, -32000, "Too many requests"), { "Retry-After": "60" });
    if (outcome !== "allowed") return reply(503, rpcError(null, -32000, "Temporarily unavailable"));

    const version = request.headers.get("MCP-Protocol-Version");
    if (version && !PROTOCOL_VERSIONS.includes(version)) return reply(400, rpcError(null, -32600, "Unsupported MCP-Protocol-Version"));
    if (!/^application\/json\s*(;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
      return reply(415, rpcError(null, -32700, "Send application/json"));
    }

    const body = await readBody(request);
    if (body.tooLarge) return reply(413, rpcError(null, -32600, "Request too large"));
    if (body.invalid) return reply(400, rpcError(null, -32700, "Parse error"));
    const message = body.message;
    // One message per request (JSON-RPC batches were removed in MCP 2025-06-18).
    if (message === null || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      // A response from the client (no method) needs no answer.
      if (message && typeof message === "object" && !Array.isArray(message) && !("method" in message) && ("result" in message || "error" in message)) return reply(202, null);
      return reply(400, rpcError(null, -32600, "Invalid request"));
    }
    // Notifications (no id) are acknowledged without a body.
    if (!("id" in message)) return reply(202, null);
    if (!(typeof message.id === "string" || Number.isInteger(message.id))) return reply(400, rpcError(null, -32600, "Invalid request id"));

    try {
      return reply(200, await dispatch(message, env));
    } catch (error) {
      console.error(`MCP ${message.method} failed:`, error instanceof Error ? error.message : error);
      return reply(200, rpcError(message.id, -32603, "Internal error"));
    }
  },
};
