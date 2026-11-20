// Creates the ONE pre-registered OAuth client for Claude.ai (no dynamic registration).
//
//   node mcp/tools/oauth-client.mjs <private-folder>
//
// Writes into <private-folder> (which must already exist, outside Git):
//   library-mcp-oauth-client.txt   client ID + client SECRET  (enter both in Claude.ai; keep private)
//   library-mcp-client-record.json the KV record (client ID, redirect URI, SHA-256 of the secret; no secret)
// Prints only the client ID and the file paths. Upload the record with:
//   npx wrangler@4 kv key put "client:<client ID>" --path <record.json> --binding OAUTH_KV --remote
// The record format is the one @cloudflare/workers-oauth-provider 1.2.4 stores for clients
// (test/oauth.test.mjs checks that the library accepts it).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** The KV record for a confidential client (secret stored as its SHA-256 hex digest). */
export function clientRecord(clientId, clientSecret, now = Math.floor(Date.now() / 1000)) {
  return {
    clientId,
    redirectUris: [CLAUDE_CALLBACK],
    clientName: "Claude",
    tokenEndpointAuthMethod: "client_secret_basic", // client_secret_post is accepted too (not "explicit")
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    registrationDate: now,
    clientSecret: createHash("sha256").update(clientSecret, "utf8").digest("hex"),
  };
}

export function newClientCredentials() {
  return { clientId: `library-claude-${randomBytes(9).toString("base64url")}`, clientSecret: randomBytes(32).toString("base64url") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const folder = process.argv[2];
  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) {
    console.error("usage: node mcp/tools/oauth-client.mjs <existing private folder outside the repository>");
    process.exit(1);
  }
  const { clientId, clientSecret } = newClientCredentials();
  const secretFile = join(folder, "library-mcp-oauth-client.txt");
  const recordFile = join(folder, "library-mcp-client-record.json");
  if (existsSync(secretFile) || existsSync(recordFile)) {
    console.error("A client file already exists in that folder; refusing to overwrite it (move or delete it first).");
    process.exit(1);
  }
  writeFileSync(secretFile, `client_id=${clientId}\nclient_secret=${clientSecret}\n`, { flag: "wx" });
  writeFileSync(recordFile, JSON.stringify(clientRecord(clientId, clientSecret)), { flag: "wx" });
  console.log(`Client ID: ${clientId}`);
  console.log(`Client ID and SECRET saved to: ${secretFile}`);
  console.log(`KV record (no secret) saved to: ${recordFile}`);
}
