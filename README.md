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

Without further configuration (no API address) the site uses the content
bundled in `src/content/`, for local development.

## How it works

- **One collection.** Every item appears in the same grid with the same card.
  Search plus category, type and language filters live in the URL
  (`#/?q=git&category=science&type=pdf&lang=en`), so views can be shared.
- **Reading panel.** Clicking a card opens it in a bottom sheet that rises like
  the portfolio's project modal. Escape, the close button, a click above the
  sheet, or the browser Back button closes it. `#/?item=<slug>` links open an
  item directly.
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
`pdf` → `fileUrl` (e.g. `documents/file.pdf`, or an uploaded file served by
the API under `/files/`), `pageCount`;
`youtube` → `videoUrl` (`youtube.com/watch?v=`, `youtu.be/`, `/embed/`,
`/shorts/`, `/live/` or a bare ID) and an optional `videoDescription` (plain
text, shown in a collapsed "Video description" section); `link` → `url`.

Invalid entries are hidden and listed as a console warning during
`npm run dev` (rules in `src/lib/validateContent.js`).

### Rich text (`bodies/<slug>.json`)

```json
{
  "blocks": [
    { "id": "b01", "type": "paragraph", "text": "Text with **bold**, *italic*, `code` and [a link](https://example.com)." },
    { "id": "b02", "type": "heading", "level": 2, "text": "A section" },
    { "id": "b03", "type": "list", "ordered": false, "items": ["One", { "text": "Two", "list": { "ordered": true, "items": ["Nested"] } }] },
    { "id": "b04", "type": "quote", "text": "…" },
    { "id": "b05", "type": "code", "language": "shell", "text": "git log" },
    { "id": "b06", "type": "divider" },
    { "id": "b07", "type": "details", "summary": "Expandable section", "blocks": [ … ] }
  ]
}
```

Headings use levels 2–4. Lists nest up to three levels. Inline text also
supports `***bold italic***`, and `\*` (likewise `` \` ``, `\[`, `\]`, `\(`,
`\)`, `\\`) writes the character itself. Link to another item with
`[label](#/?item=<slug>)`. Only http(s), mailto and `#/` links are allowed;
text is never rendered as HTML.

### Arabic

Set `"language": "ar"`. Cards and the reader switch to right-to-left
automatically (accent rules, lists and quotes mirror). Search ignores harakat,
hamza forms, and the attached article "ال".

## Code map

```
src/
  contentTypes.js              Type registry (article, pdf, youtube, link)
  router.js                    URL state: filters, open/close item, Back button
  services/                    Data access (the API, or the bundled JSON without one)
  lib/                         Pure helpers: YouTube URLs, inline markup, search,
                               content validation, formatting
  components/, pages/          Interface
  styles/                      Palette, layout and the panel animation
worker/                        API (Cloudflare Worker) and its tests
migrations/                    Versioned database migrations
db/                            Schema reference and initial data import
```

## Public API

The site reads its content from a read-only JSON API (a Cloudflare Worker
backed by a D1 database), its single source of content:

| Endpoint | Response (same shapes as `src/content/`) |
| -------- | ---------------------------------------- |
| `GET /api/library` | `{ categories, languages, items }` |
| `GET /api/categories` | `categories.json` |
| `GET /api/languages` | `languages.json` |
| `GET /api/items` | `items.json` (without bodies) |
| `GET /api/items/:slug` | one `items.json` entry plus `blocks` (and a video's `videoDescription`) |
| `GET /files/<key>` | an uploaded PDF of a published item (`?download=1` to save it) |

Only published content is returned, uploaded PDFs included. If the API is
unavailable, the site says so and offers a Retry button; it never shows other
content in its place (the bundled JSON is only used by builds without an API
address).

## Tests

```bash
npm run test:worker   # API tests (run locally, no network)
npm run test:admin    # editor model tests
```

## Database changes

Schema changes are versioned files in `migrations/`. Never edit a migration
that has been applied; add a new numbered file instead.
