/**
 * Library data access.
 *
 * This module is the ONLY place the UI gets content from. It has two sources
 * that return the same raw shapes (categories.json, languages.json,
 * items.json and bodies/<slug>.json):
 *
 *   1. The read-only API Worker backed by Cloudflare D1 (worker/), used only
 *      when the build sets VITE_LIBRARY_API_URL, e.g.
 *        VITE_LIBRARY_API_URL=https://api.library.mh-ibrahim.com
 *        GET /api/library        categories, languages, items
 *        GET /api/items/:slug    one item + its rich-text "blocks"
 *   2. The JSON files bundled with the site (src/content/). Always available:
 *      it is the default today and the fallback whenever the API fails.
 *
 * Both sources go through the same validation and shaping below, so the UI
 * receives identical objects either way.
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

const API_URL = String(import.meta.env.VITE_LIBRARY_API_URL ?? "").trim().replace(/\/+$/, "");
const API_TIMEOUT_MS = 8000;

// Bundled item text is split into separate chunks and only downloaded when opened.
const bodyLoaders = import.meta.glob("../content/bodies/*.json", { import: "default" });

/* ---------------------------------------------------------------- sources */

const jsonSource = {
  name: "json",
  async loadLibrary() {
    return { categories: categoriesData, languages: languagesData, items: itemsData };
  },
  /** Blocks for one item ([] when it has no body file). */
  async loadBlocks(slug) {
    const loadBody = bodyLoaders[`../content/bodies/${slug}.json`];
    if (!loadBody) return [];
    const body = await loadBody();
    return Array.isArray(body?.blocks) ? body.blocks : [];
  },
};

async function fetchApi(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const apiSource = {
  name: "api",
  async loadLibrary() {
    const data = await fetchApi("/api/library");
    if (!data || !Array.isArray(data.categories) || !Array.isArray(data.languages) || !Array.isArray(data.items)) {
      throw new Error("Unexpected /api/library response");
    }
    return data;
  },
  async loadBlocks(slug) {
    const data = await fetchApi(`/api/items/${encodeURIComponent(slug)}`);
    if (data === null) throw new Error(`Item "${slug}" is missing from the API`);
    if (!Array.isArray(data.blocks)) throw new Error(`Unexpected /api/items/${slug} response`);
    return data.blocks;
  },
};

const warnFallback = (what, error) =>
  console.warn(`Library API unavailable (${what}); using the bundled content instead.`, error);

/* ---------------------------------------------------------------- catalog */

/** Validates and indexes raw data. Invalid entries are skipped. */
function buildCatalog(raw, source) {
  const { categories, languages, items, problems } = validateLibrary(raw);
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
      };
    })
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));

  return {
    source,
    categories: [...categories]
      .sort((a, b) => a.position - b.position)
      .map((category) => ({
        ...category,
        itemCount: summaries.filter((item) => item.categoryId === category.id).length,
      })),
    languages,
    items: summaries,
  };
}

function resolveFileUrl(fileUrl) {
  return /^https?:\/\//.test(fileUrl)
    ? fileUrl
    : `${import.meta.env.BASE_URL}${fileUrl.replace(/^\/+/, "")}`;
}

let catalogPromise = null;

function loadCatalog() {
  catalogPromise ??= (async () => {
    if (API_URL) {
      try {
        return buildCatalog(await apiSource.loadLibrary(), apiSource);
      } catch (error) {
        warnFallback("library", error);
      }
    }
    return buildCatalog(await jsonSource.loadLibrary(), jsonSource);
  })();
  return catalogPromise;
}

/* ---------------------------------------------------------------- public API */

/**
 * Everything the library view needs, newest items first.
 * @returns {Promise<{ categories: object[], languages: object[], items: object[] }>}
 */
export async function getLibrary() {
  const { categories, languages, items } = await loadCatalog();
  return { categories, languages, items };
}

/**
 * One item plus its text blocks (articles always have blocks; other types may
 * carry optional extra text). Resolves to null when the item does not exist.
 */
export async function getItem(slug) {
  const catalog = await loadCatalog();
  const summary = catalog.items.find((item) => item.slug === slug);
  if (!summary) return null;

  let blocks;
  try {
    blocks = await catalog.source.loadBlocks(slug);
  } catch (error) {
    if (catalog.source === jsonSource) throw error;
    warnFallback(`item "${slug}"`, error);
    blocks = await jsonSource.loadBlocks(slug);
  }
  return { ...summary, blocks };
}
