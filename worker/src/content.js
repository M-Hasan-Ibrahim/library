/**
 * Read-only D1 queries and row -> JSON mapping.
 *
 * Responses use EXACTLY the shapes of the frontend's content files
 * (src/content/categories.json, languages.json, items.json and
 * bodies/<slug>.json), so the frontend can treat the API and the bundled JSON
 * as interchangeable sources and run them through the same validation.
 *
 * Security: every SQL statement is a constant string. The only user input
 * (an item slug) is validated by the router and passed with .bind(), never
 * concatenated into SQL.
 */

const CATEGORIES_SQL =
  "SELECT id, slug, name, description, position FROM categories ORDER BY position, id";

// rowid = insertion order (English, then Arabic), matching languages.json.
const LANGUAGES_SQL = "SELECT code, name, native_name, dir FROM languages ORDER BY rowid";

// The list never includes body_json: bodies are only sent for a single item.
const ITEMS_SQL =
  "SELECT id, slug, type, category_id, language, title, description, tags_json, links_json, " +
  "added_at, updated_at, reading_minutes, file_url, page_count, video_url, url " +
  "FROM items ORDER BY added_at DESC, id";

const ITEM_BY_SLUG_SQL =
  "SELECT id, slug, type, category_id, language, title, description, tags_json, links_json, " +
  "added_at, updated_at, reading_minutes, file_url, page_count, video_url, url, body_json " +
  "FROM items WHERE slug = ?1 LIMIT 1";

function parseJson(text, fallback) {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    console.error("Invalid JSON stored in D1 column");
    return fallback;
  }
}

export const toCategory = (row) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  position: row.position,
});

export const toLanguage = (row) => ({
  code: row.code,
  name: row.name,
  nativeName: row.native_name,
  dir: row.dir,
});

/** One items.json entry. Optional fields are omitted when empty, as in the JSON files. */
export function toItem(row) {
  const item = {
    id: row.id,
    slug: row.slug,
    type: row.type,
    categoryId: row.category_id,
    language: row.language,
    title: row.title,
    description: row.description,
    tags: parseJson(row.tags_json, []),
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
  const links = parseJson(row.links_json, []);
  if (Array.isArray(links) && links.length > 0) item.links = links;
  if (row.reading_minutes !== null) item.readingMinutes = row.reading_minutes;
  if (row.file_url !== null) item.fileUrl = row.file_url;
  if (row.page_count !== null) item.pageCount = row.page_count;
  if (row.video_url !== null) item.videoUrl = row.video_url;
  if (row.url !== null) item.url = row.url;
  return item;
}

export async function getCategories(db) {
  const { results } = await db.prepare(CATEGORIES_SQL).all();
  return results.map(toCategory);
}

export async function getLanguages(db) {
  const { results } = await db.prepare(LANGUAGES_SQL).all();
  return results.map(toLanguage);
}

export async function getItems(db) {
  const { results } = await db.prepare(ITEMS_SQL).all();
  return results.map(toItem);
}

/** Everything the library view needs, in one round trip to D1. */
export async function getLibrary(db) {
  const [categories, languages, items] = await db.batch([
    db.prepare(CATEGORIES_SQL),
    db.prepare(LANGUAGES_SQL),
    db.prepare(ITEMS_SQL),
  ]);
  return {
    categories: categories.results.map(toCategory),
    languages: languages.results.map(toLanguage),
    items: items.results.map(toItem),
  };
}

/** One item plus its rich-text blocks ([] when it has no body); undefined if absent. */
export async function getItem(db, slug) {
  const row = await db.prepare(ITEM_BY_SLUG_SQL).bind(slug).first();
  if (!row) return undefined;
  const body = parseJson(row.body_json, null);
  return { ...toItem(row), blocks: Array.isArray(body?.blocks) ? body.blocks : [] };
}
