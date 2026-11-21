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

The server is deployed at `https://mcp.library.mh-ibrahim.com/mcp`. These steps rebuild it from scratch.
Run from the repository root unless noted. Secrets are typed at Wrangler prompts or piped from files; never
on the command line.

0. **DNS CAA record (before the first deploy):** in the `mh-ibrahim.com` zone add a CAA record on
   `mcp.library`: flags `0`, tag `issue`, value `pki.goog` (the same as `api.library` has). Without it the
   certificate cannot be issued: `library.mh-ibrahim.com` is a CNAME to GitHub Pages, so names under it inherit
   GitHub's CAA policy (DigiCert, Let's Encrypt, Sectigo), which excludes Cloudflare's certificate authority
   (Google Trust Services). Any new `*.library.mh-ibrahim.com` hostname needs the same record.
1. **KV namespace:** `npx wrangler@4 kv namespace create library-mcp-oauth --config mcp/wrangler.jsonc`
   (answer *No* if asked to edit the config) → put the printed id in `mcp/wrangler.jsonc` (`kv_namespaces[0].id`).
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

Read-only health check after any change: `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server` answer 200; `/authorize` redirects to the Cloudflare Access login;
`/mcp` and `/token` answer 403 from outside Claude's ranges; `/register` answers 404.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| HTTPS handshake fails right after the first deploy; the certificate shows "Pending Validation (Error)" | The CAA record (step 0) is missing. After adding it, a "multiple perspective CAA check error" can persist for up to about an hour (resolvers cache the earlier "no CAA" answer for 30 minutes); Cloudflare retries by itself. |
| Consent page says "Cross-site request refused" | The browser sent no matching `Origin`. The page must keep `Referrer-Policy: same-origin`: under `no-referrer` browsers send `Origin: null` on the form's POST (regression-tested). |
| `/authorize` answers 503 | `ADMIN_EMAIL` or `ACCESS_AUD` is missing or malformed. |
| Claude cannot connect or refresh; logs show "source address … not allowed" | Anthropic changed its outbound ranges: update `ALLOWED_CLIENT_CIDRS` from platform.claude.com/docs/en/api/ip-addresses and redeploy. |
| The tool answers "not available right now" | `LIBRARY_INTEGRATION_TOKEN` is missing, or no longer matches the digest on `library-api`. |

## Recovery

- **Revoke Claude's access:** remove the connector in Claude.ai, or delete the KV keys starting with
  `grant:owner:` and `token:owner:`; delete the client (`client:<id>`) to stop new sign-ins too.
- **Cut off the Library itself:** rotate or delete the integration token's digest on the Library API
  (`INTEGRATION_TOKEN_SHA256` on `library-api`); this server then fails closed.
- **Roll back the server:** `npx wrangler@4 rollback <version-id> --name library-mcp`
  (`npx wrangler@4 versions list --name library-mcp` lists versions), or
  `npx wrangler@4 delete --name library-mcp` to remove it entirely.
- **Rotate the OAuth client:** create a new one (step 5), update the connector in Claude.ai (remove and
  re-add it), then delete the old `client:<id>` key.
- KV holds only OAuth state; it can always be recreated (clients from step 5, grants by reconnecting).
