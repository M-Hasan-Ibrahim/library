# library-mcp

A remote MCP server (Cloudflare Worker) that lets the Library owner's **Claude.ai custom connector**
create **private article drafts** in the Library — and nothing else.

```
Claude.ai ──HTTPS / Streamable HTTP / OAuth token──> library-mcp (mcp.library.mh-ibrahim.com)
                                                       ├─ /mcp         one tool: create_library_draft
                                                       ├─ /authorize   Cloudflare Access sign-in + consent page
                                                       ├─ /token, /.well-known/*   OAuth (workers-oauth-provider)
                                                       ├─ KV OAUTH_KV  OAuth client, grants, tokens (hashed/encrypted)
                                                       └─ service binding LIBRARY_API ──> library-api
                                                              POST /api/integrations/drafts (integration token)
```

## Security model

- **One tool**, `create_library_draft`. No resources, prompts or other methods. The Library API itself only
  lets the integration token create drafts (no publish, edit, delete, list or read), so draft-only does not
  depend on this server.
- **OAuth 2.1** (authorization code + PKCE S256) with **one pre-registered confidential client** (Claude.ai,
  redirect `https://claude.ai/api/mcp/auth_callback`). Dynamic client registration is off.
- **Who can approve:** only the owner. `/authorize` sits behind its own Cloudflare Access application, and
  the Worker re-verifies the Access JWT (signature, issuer, audience, expiry, exact `ADMIN_EMAIL`) with the
  Library's verifier (`worker/src/access.js`). A consent page (CSRF nonce in a `__Host-` cookie, Origin
  check, no framing) grants only the `drafts:create` scope.
- **The integration token** is a Worker secret (`LIBRARY_INTEGRATION_TOKEN`), sent only in the
  `Authorization` header of the service-binding request to the Library API. It never reaches Claude, MCP
  responses, error messages or logs (tests check this).
- **Abuse limits:** `/mcp` and `/token` (MCP calls, code exchange, refresh, revocation) only from Anthropic's
  published outbound IPv4 ranges, `160.79.104.0/21` and `153.61.208.0/20` (`ALLOWED_CLIENT_CIDRS`; source:
  platform.claude.com/docs/en/api/ip-addresses — update it if Anthropic announces a change; refused
  addresses are logged). Discovery metadata and `/authorize` (your browser) are not restricted;
  browser Origins other than Claude's refused on `/mcp`; 160 KB request limit; required rate-limit binding
  (20 requests/minute per user, fail closed); plus the Library API's own limits (10/minute, 50 drafts/day,
  128 KB). Access tokens last 1 hour; refresh tokens 30 days.

## Tests

```bash
npm --prefix mcp install
npm --prefix mcp test        # or, from the repository root: npm run test:mcp
```

The tests run the real Worker and OAuth library in Node (in-memory KV, fake Library API, throwaway keys),
including the official MCP SDK client over Streamable HTTP.

## Deployment (each step changes production: do it deliberately)

Run from the repository root unless noted. Secrets are typed at Wrangler prompts or piped from files; never
on the command line.

1. **KV namespace:** `npx wrangler@4 kv namespace create library-mcp-oauth` → put the printed id in
   `mcp/wrangler.jsonc` (`kv_namespaces[0].id`).
2. **Access application** (Zero Trust → Access → Applications → Add → Self-hosted): name
   "Library MCP authorize", domain `mcp.library.mh-ibrahim.com`, path `authorize`, identity provider Google,
   policy *Allow* for the owner's email only. Copy its **Application Audience (AUD) Tag** into
   `mcp/wrangler.jsonc` (`ACCESS_AUD`). Do not put `/mcp`, `/token` or `/.well-known` behind Access.
3. **Deploy:** `cd mcp && npx wrangler@4 deploy` (creates the custom domain and its DNS record).
4. **Secrets** (each creates a new Worker version):
   - `npx wrangler@4 secret put ADMIN_EMAIL --name library-mcp` (the owner's Google address)
   - the integration token, piped from the private file:
     `npx wrangler@4 secret put LIBRARY_INTEGRATION_TOKEN --name library-mcp < <private token file>`
5. **OAuth client:** `node mcp/tools/oauth-client.mjs <private folder>` → then
   `npx wrangler@4 kv key put "client:<client ID>" --path <private folder>/library-mcp-client-record.json --namespace-id <KV id> --remote`
6. **Claude.ai:** Settings → Connectors → Add custom connector → URL
   `https://mcp.library.mh-ibrahim.com/mcp`; under the OAuth client option enter the client ID and secret from
   the private file → Add → Connect → Google sign-in (Access) → **Allow**.
7. **Check:** ask Claude to create a test draft; confirm it in the Library admin, then delete it.

**Revoke Claude's access:** delete the KV keys starting with `grant:owner:` and `token:owner:` (or the client,
`client:<id>`, to stop new sign-ins too), or remove the connector in Claude.ai. **Cut off the Library itself:**
rotate or delete the integration token on the Library API (`INTEGRATION_TOKEN_SHA256` on `library-api`). **Roll back:** `npx wrangler@4 rollback <version> --name library-mcp`,
or `npx wrangler@4 delete --name library-mcp` to remove the server entirely.
