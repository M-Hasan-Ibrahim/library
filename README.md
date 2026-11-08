# Library

A personal collection of knowledge, ideas and interesting discoveries
(articles, PDFs, YouTube videos and links, in English and Arabic), designed
to match the [portfolio](https://mh-ibrahim.com) visually.

## Run locally

```bash
npm install
npm run dev       # http://127.0.0.1:5173/
npm run build     # production build in dist/
npm run preview   # serve the production build: http://127.0.0.1:4173/
```

## How it works

- **One collection.** Every item appears in the same grid with the same card.
  Search plus category, type and language filters live in the URL
  (`#/?q=git&category=science&type=pdf&lang=en`), so views can be shared.
- **Reading panel.** Clicking a card opens it in a bottom sheet that rises like
  the portfolio's project modal (same CSS values and keyframes). Escape, the
  close button, a click above the sheet, or the browser Back button closes it.
  `#/?item=<slug>` links open an item directly.
- **One reader for all types.** Same centred header and container; PDFs add a
  small Download button, videos a small "YouTube" link.
- **No other motion.** The panel's rise is the only animation on the site.

## Content model

```
src/content/
  categories.json        Subjects (Science, Thoughts, …) — data, not code
  languages.json         en / ar with text direction
  items.json             Every item (metadata)
  bodies/<slug>.json     Optional rich text for any item (required for articles)
public/documents/        PDF files
```

Common fields on every item:

| Field         | Notes                                                        |
| ------------- | ------------------------------------------------------------ |
| `id`, `slug`  | Unique. Slug is lowercase-with-hyphens, used in URLs         |
| `type`        | `article` · `pdf` · `youtube` · `link` (how it is rendered)  |
| `categoryId`  | An `id` from `categories.json` (what it is about)            |
| `language`    | A `code` from `languages.json` (`en`, `ar`)                  |
| `title`, `description`, `tags` | Shown on cards and searched                 |
| `addedAt`, `updatedAt` | `YYYY-MM-DD`                                        |
| `links`       | Optional `[{ "label", "url" }]`                              |

Type-specific fields: `article` → `readingMinutes` (≈ words ÷ 200);
`pdf` → `fileUrl` (e.g. `documents/file.pdf`), `pageCount`;
`youtube` → `videoUrl` (`youtube.com/watch?v=`, `youtu.be/`, `/embed/`,
`/shorts/` or a bare ID); `link` → `url`.

Invalid entries are hidden and listed as a console warning during
`npm run dev` (rules in `src/lib/validateContent.js`).

### Rich text (`bodies/<slug>.json`)

```json
{
  "blocks": [
    { "id": "b01", "type": "paragraph", "text": "Text with **bold**, *italic*, `code` and [a link](https://example.com)." },
    { "id": "b02", "type": "heading", "level": 2, "text": "A section" },
    { "id": "b03", "type": "list", "ordered": false, "items": ["One", "Two"] },
    { "id": "b04", "type": "quote", "text": "…" },
    { "id": "b05", "type": "code", "language": "shell", "text": "git log" },
    { "id": "b06", "type": "details", "summary": "Expandable section", "blocks": [ … ] }
  ]
}
```

Link to another item with `[label](#/?item=<slug>)`. Only http(s), mailto and
`#/` links are allowed; text is never rendered as HTML.

### Arabic

Set `"language": "ar"`. Cards and the reader switch to right-to-left
automatically (accent rules, lists and quotes mirror). Search ignores harakat,
hamza forms, and the attached article "ال".

## Code map

```
src/
  contentTypes.js              Type registry (article, pdf, youtube, link)
  router.js                    URL state: filters, open/close item, Back button
  services/libraryRepository.js  The ONLY data access module (async)
  services/apiConfig.js        API address (VITE_LIBRARY_API_URL)
  services/adminSession.js     Admin sign-in state (Cloudflare Access)
  admin/                       Admin-only UI, a separate chunk loaded after sign-in
  lib/                         youtube.js, inlineMarkup.js, search.js,
                               validateContent.js, format.js (pure, testable)
  components/
    ItemCard.jsx               One card for every type
    LibraryFilters.jsx         Category chips, type & language selects
    ItemPanel.jsx              The bottom sheet (<dialog>)
    ItemView.jsx               Shared reader layout
    RichText.jsx, PdfViewer.jsx, YouTubeEmbed.jsx, LinkPreview.jsx, RelatedLinks.jsx
    SiteLayout.jsx, GlobeIcon.jsx  Header (admin login icon, Portfolio) and footer
  pages/LibraryPage.jsx, NotFoundPage.jsx, AdminSignInPage.jsx (#/admin)
  styles/tokens.css            Exact portfolio palette
  styles/library.css           Layout (no motion)
  styles/panel.css             The panel and its two animations
worker/src/index.js            API Worker entry: public routing, CORS, responses
worker/src/content.js          D1 queries (bound parameters only) and JSON mapping
worker/src/admin.js            Admin API (/api/admin/*): session, login redirect
worker/src/access.js           Cloudflare Access token verification
worker/src/http.js             Shared JSON responses and CORS origin checks
worker/test/                   Worker tests: npm run test:worker
wrangler.jsonc                 Worker + D1 configuration (binding DB -> library-db)
migrations/                    Versioned Cloudflare D1 migrations (source of truth)
db/schema.sql                  Reference snapshot of the D1 schema (do not execute)
db/seed.sql                    One-time import of the 13 items (already loaded)
```

## Read-only API (Cloudflare Worker)

| Endpoint | Response (same shapes as `src/content/`) |
| -------- | ---------------------------------------- |
| `GET /api/library` | `{ categories, languages, items }` — used by the site, one request |
| `GET /api/categories` | `categories.json` |
| `GET /api/languages` | `languages.json` |
| `GET /api/items` | `items.json` (without bodies) |
| `GET /api/items/:slug` | one `items.json` entry plus `blocks` (rich text, `[]` if none) |

Only `GET`/`HEAD`/`OPTIONS`; anything else is `405`. Unknown paths and
invalid slugs are `404`. Browser access (CORS) is limited to the origins in
`ALLOWED_ORIGINS` (`wrangler.jsonc`).

### Run it locally

```bash
# 1. A local copy of the database (stored in .wrangler/, never production)
npx wrangler@4 d1 migrations apply library-db --local
npx wrangler@4 d1 execute library-db --local --file=db/seed.sql

# 2. The Worker on http://127.0.0.1:8787, allowing the Vite dev server
#    (admin endpoints don't work locally: there is no Cloudflare Access there)
npx wrangler@4 dev --local --var "ALLOWED_ORIGINS:http://127.0.0.1:5173"

# 3. The site, reading from the local Worker
npm run dev
```

For step 3, first create a file named `.env.local` (gitignored) in the project
root containing this single line:

```
VITE_LIBRARY_API_URL=http://127.0.0.1:8787
```

Delete `.env.local` to go back to the bundled JSON.

### Data source switch

The site reads the API only when it is built with `VITE_LIBRARY_API_URL`.
Without it (the current GitHub Pages build) it uses the bundled JSON. When the
API is set but unreachable or returns an error, the site falls back to the
bundled JSON and logs a console warning.

The deploy workflow passes the GitHub repository variable `LIBRARY_API_URL`
to the build. To switch the live site to D1, create that variable
(Settings → Secrets and variables → Actions → Variables) with the value
`https://api.library.mh-ibrahim.com` and re-run the workflow. Delete it to
switch back.

### Deploy the Worker

Public address: `https://api.library.mh-ibrahim.com` (Custom Domain;
`workers.dev` and preview URLs are disabled in `wrangler.jsonc`). Workers Logs
(`observability`) are enabled: error details appear only in the Cloudflare
dashboard (Workers → library-api → Logs), never in API responses.

The hostname has a CAA record (`0 issue "pki.goog"`) in the `mh-ibrahim.com`
DNS zone. Without it, certificate issuance inherits GitHub's CAA policy through
the `library` CNAME, which does not allow Cloudflare's certificate authority.

```bash
npm run test:worker               # Worker tests (no network, no Cloudflare)
npx wrangler@4 deploy --dry-run   # validates and bundles, uploads nothing
npx wrangler@4 deploy --secrets-file <file>   # publishes a new version of library-api
npx wrangler@4 deployments list --name library-api
npx wrangler@4 rollback <version-id>   # return to any previous version
```

`<file>` is a JSON file kept outside the repository, e.g.
`{ "ADMIN_EMAIL": "you@example.com" }` (see "Admin sign-in"). Secrets persist
between deployments, so later deploys can omit `--secrets-file`.

## Admin sign-in (Cloudflare Access)

The website stays public. Only the API's `/api/admin/*` paths are protected:

1. **Cloudflare Access** (Zero Trust team `mh-ibrahim`, application "Library
   Admin", path `api.library.mh-ibrahim.com/api/admin/*`) signs the admin in
   with Google and allows a single email. It forwards each allowed request
   with a signed token (`Cf-Access-Jwt-Assertion`). Access also lets `OPTIONS`
   preflights through to the Worker.
2. **The Worker verifies that token on every admin request**
   (`worker/src/access.js`): RS256 signature with the team's public keys,
   issuer, application audience (`ACCESS_AUD`), expiry and the exact admin
   email. Anything else is `401` (keys unreachable: `503`), so a gap in the
   Access configuration cannot expose admin endpoints.

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/admin/session` | `{ email, expiresAt }` for the signed-in admin |
| `GET /api/admin/login` | After Access sign-in, `302` to `SITE_URL` + `?admin=signed-in#/` (the site removes the marker); the target never comes from the request |
| `GET /api/admin/`, `/api/admin/*` | Same as `/api/admin/login`: where Access lands logins started by Cloudflare itself (its logout page's "Log in" button, App Launcher) while the application's primary destination is the wildcard path |

Admin responses are `no-store` and allow credentialed CORS only for
`ALLOWED_ORIGINS`; public endpoints never allow credentials.

Access application destinations (recommended order): first
`api.library.mh-ibrahim.com/api/admin/login` (the application's primary
domain, used by Cloudflare's own "Log in" button and the App Launcher), then
`api.library.mh-ibrahim.com/api/admin/*` (protects every admin path). With
only the wildcard destination, Cloudflare-started logins return to the literal
`/api/admin/*`, which the Worker also accepts as a login landing path.

Configuration: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `SITE_URL` are plain
variables in `wrangler.jsonc`; `ADMIN_EMAIL` is a Worker secret (not stored in
this repository). If any is missing, admin requests return `503` and the
public API keeps working.

On the website:

- **Header:** signed out — globe ("Admin login") + Portfolio; signed in —
  "Admin · Sign out" + Portfolio (the globe is hidden). The globe opens
  `#/admin`, which first asks the API: signed in → a confirmation, no new
  login; signed out → Google through Access. The globe is only a link: Access
  and the Worker decide who gets in.
- **After any successful login** (globe, `/api/admin/login` opened directly,
  or Cloudflare's own "Log in" button) the Worker redirects to
  `https://library.mh-ibrahim.com/?admin=signed-in#/`. The site removes the
  marker (leaving `/#/`) and asks `GET /api/admin/session` immediately, so
  "Admin · Sign out" appears without any click. The marker grants nothing.
- **Sign out:** the "Sign out" button ends the Access session
  (`/cdn-cgi/access/logout` on the API host). Cloudflare revokes it for all
  Access applications (old tokens can still be accepted for 20–30 s). Google
  itself stays signed in, so the next sign-in may not ask for a password.
- Visitors make no admin requests (so Access never sets a cookie for them).
  The site asks the API only after a login (marker), in a browser whose last
  confirmed state was "signed in" (`library.admin` in localStorage, a UI hint
  that grants nothing), on `#/admin`, when another tab signs in, or when an
  admin tab becomes visible again. The admin interface (`src/admin/`) is a
  separate chunk loaded after the API confirms the session.
- Only a definite answer means "signed out" (401/403 or a redirect to the
  Access login). Temporary problems (5xx, network) keep the current state and
  retry; `#/admin` then shows "Sign-in unavailable" with "Try again" instead of
  redirecting in a loop. Open tabs stay in sync (sign-out and sign-in in one
  tab update the others), and a tab re-checks when it becomes visible.
- The Worker shares one key fetch between simultaneous requests, retries a
  failed fetch once, and after a failure tries again within seconds, so a
  brief problem fetching Access's public keys cannot block sign-in for long.

## Database migrations (Cloudflare D1)

The `library-db` schema is managed with numbered files in `migrations/`:

| File | Contents |
| ---- | -------- |
| `0001_initial_schema.sql` | `languages`, `categories`, `items` tables and 4 indexes |
| `0002_seed_languages_and_categories.sql` | 2 languages, 5 categories (same IDs as `src/content/*.json`) |

Both are idempotent (`IF NOT EXISTS`, `INSERT OR IGNORE`), so they are safe on
a database that already has these objects. Wrangler records applied files in
the `d1_migrations` table and never runs a recorded file again.

Rules for future changes:

- Never edit a migration that has been applied; add a new numbered file
  (`npx wrangler d1 migrations create library-db <name>`).
- Never run `db/schema.sql` against production; update it to match after
  adding a migration.
- Apply with `npx wrangler d1 migrations apply library-db --remote` after
  checking `npx wrangler d1 migrations list library-db --remote`.

## Roadmap

- **Done:** the live site reads from D1 through the Worker (JSON fallback
  kept); admin sign-in with Cloudflare Access (no editing yet).
- **Next: inline admin editing.** Same pages with small edit controls. The
  pieces are ready for it: every item and text block has a stable `id`; each
  reader section (header, media, text, links) is a separate element;
  validation rules are shared; categories and languages are data with
  create/rename/delete-when-unused supported by the schema.
