// Generates a new integration API token and the SHA-256 digest the Worker stores.
//   node worker/tools/integration-token.mjs
// The token (256 random bits) goes to the external client only; the digest is
// uploaded as the Worker secret INTEGRATION_TOKEN_SHA256. Nothing is written
// to disk: copy both values from the terminal, then clear it.
import { createHash, randomBytes } from "node:crypto";

const token = `lib_int_${randomBytes(32).toString("base64url")}`;
const digest = createHash("sha256").update(token, "utf8").digest("hex");

console.log(`Token (give ONLY to the integration client):\n  ${token}\n`);
console.log(`SHA-256 digest (Worker secret INTEGRATION_TOKEN_SHA256):\n  ${digest}`);
