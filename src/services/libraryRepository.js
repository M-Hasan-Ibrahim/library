/**
 * Library data access.
 *
 * This module is the ONLY place the UI gets content from. Every function is
 * async and returns plain objects, so a later phase can replace the local
 * JSON with `fetch("/api/...")` calls to a Cloudflare Worker backed by D1
 * (see db/schema.sql) without touching components.
 *
 * Read endpoints (planned):
 *   getLibrary()   -> GET  /api/library        categories, languages, item summaries
 *   getItem(slug)  -> GET  /api/items/:slug    one item with its text blocks
 *
 * Write endpoints for the future admin mode (not implemented, no auth yet):
 *   POST   /api/items                 add an article / PDF / video / link
 *   PATCH  /api/items/:id             edit fields or text blocks
 *   DELETE /api/items/:id
 *   POST   /api/uploads               PDF upload (e.g. to R2), returns fileUrl
 *   POST   /api/categories            create a category
 *   PATCH  /api/categories/:id        rename / reorder
 *   DELETE /api/categories/:id        only when it has no items
 * Writes must pass the same rules as src/lib/validateContent.js.
 */
import categoriesData from "../content/categories.json";
import itemsData from "../content/items.json";
import languagesData from "../content/languages.json";
import { validateLibrary } from "../lib/validateContent.js";

// Item text is split into separate chunks and only downloaded when opened.
const bodyLoaders = import.meta.glob("../content/bodies/*.json", { import: "default" });
const bodyPath = (slug) => `../content/bodies/${slug}.json`;

let catalogCache = null;

/** Validates and indexes the raw data once. Invalid entries are skipped. */
function loadCatalog() {
  if (catalogCache) return catalogCache;

  const { categories, languages, items, problems } = validateLibrary({
    categories: categoriesData,
    languages: languagesData,
    items: itemsData,
  });
  if (problems.length > 0 && import.meta.env.DEV) {
    console.warn(`Library content problems (these entries are hidden):\n- ${problems.join("\n- ")}`);
  }

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const languageByCode = new Map(languages.map((language) => [language.code, language]));

  const summaries = items
    .map((item) => {
      const category = categoryById.get(item.categoryId);
      const language = languageByCode.get(item.language);
      return {
        ...item,
        category: { id: category.id, slug: category.slug, name: category.name },
        dir: language.dir,
        fileUrl: item.fileUrl ? resolveFileUrl(item.fileUrl) : undefined,
        hasBody: bodyPath(item.slug) in bodyLoaders,
      };
    })
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));

  catalogCache = {
    categories: [...categories]
      .sort((a, b) => a.position - b.position)
      .map((category) => ({
        ...category,
        itemCount: summaries.filter((item) => item.categoryId === category.id).length,
      })),
    languages,
    items: summaries,
  };
  return catalogCache;
}

function resolveFileUrl(fileUrl) {
  return /^https?:\/\//.test(fileUrl)
    ? fileUrl
    : `${import.meta.env.BASE_URL}${fileUrl.replace(/^\/+/, "")}`;
}

/**
 * Everything the library view needs, newest items first.
 * @returns {Promise<{ categories: object[], languages: object[], items: object[] }>}
 */
export async function getLibrary() {
  return loadCatalog();
}

/**
 * One item plus its text blocks (articles always have blocks; other types may
 * carry optional extra text). Resolves to null when the item does not exist.
 */
export async function getItem(slug) {
  const summary = loadCatalog().items.find((item) => item.slug === slug);
  if (!summary) return null;

  const loadBody = bodyLoaders[bodyPath(slug)];
  if (!loadBody) return { ...summary, blocks: [] };

  const body = await loadBody();
  return { ...summary, blocks: Array.isArray(body?.blocks) ? body.blocks : [] };
}
