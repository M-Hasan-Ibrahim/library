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
 * While the admin is signed in, the admin layer (src/admin/) plugs in a third
 * source with setAdminSource(): the admin API (never cached, drafts included
 * in Edit mode). If it fails, the public sources above are used and the admin
 * layer disables editing. After the admin saves anything, refreshLibrary()
 * makes every view read the data again. Visitors never use either.
 */
import categoriesData from "../content/categories.json";
import itemsData from "../content/items.json";
import languagesData from "../content/languages.json";
import { validateLibrary } from "../lib/validateContent.js";
import { API_URL } from "./apiConfig.js";

const API_TIMEOUT_MS = 8000;

// Bundled item text is split into separate chunks and only downloaded when opened.
const bodyLoaders = import.meta.glob("../content/bodies/*.json", { import: "default" });

/* ---------------------------------------------------------------- sources */

const jsonSource = {
  name: "json",
  async loadLibrary() {
    return { categories: categoriesData, languages: languagesData, items: itemsData };
  },
  /** Details for one item (no blocks when it has no body file). */
  async loadDetails(slug) {
    const loadBody = bodyLoaders[`../content/bodies/${slug}.json`];
    return itemDetails(loadBody ? await loadBody() : null);
  },
};

/**
 * The fields only the single-item answer carries (the library list leaves
 * them out): the text blocks, and a YouTube item's original description.
 */
export function itemDetails(data) {
  const details = { blocks: Array.isArray(data?.blocks) ? data.blocks : [] };
  if (typeof data?.videoDescription === "string" && data.videoDescription.trim()) details.videoDescription = data.videoDescription;
  return details;
}

// Set once the admin has been signed in in this tab: public responses may be
// cached by the browser for a minute, so from then on they are revalidated
// (the admin must never see content older than what was just saved).
let revalidatePublic = false;

async function fetchApi(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      ...(revalidatePublic ? { cache: "no-cache" } : {}),
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
  async loadDetails(slug) {
    const data = await fetchApi(`/api/items/${encodeURIComponent(slug)}`);
    if (data === null) throw new Error(`Item "${slug}" is missing from the API`);
    if (!Array.isArray(data.blocks)) throw new Error(`Unexpected /api/items/${slug} response`);
    return itemDetails(data);
  },
};

const warnFallback = (what, error) =>
  console.warn(`Library API unavailable (${what}); using the bundled content instead.`, error);

/* ---------------------------------------------------------------- catalog */

/**
 * The shape the views use: raw item + category summary, text direction and a
 * resolved file address. Unknown categories/languages (only possible for an
 * unsaved admin preview) fall back to neutral values.
 */
export function shapeItem(item, { categories, languages }) {
  const category = categories.find((entry) => entry.id === item.categoryId);
  const language = languages.find((entry) => entry.code === item.language);
  return {
    ...item,
    category: category
      ? { id: category.id, slug: category.slug, name: category.name }
      : { id: item.categoryId, slug: "", name: String(item.categoryId ?? "") },
    dir: language?.dir ?? "ltr",
    fileUrl: item.fileUrl ? resolveFileUrl(item.fileUrl) : undefined,
  };
}

/** Validates and indexes raw data. Invalid entries are skipped. */
function buildCatalog(raw, source) {
  const { categories, languages, items, problems } = validateLibrary(raw);
  if (problems.length > 0 && import.meta.env.DEV) {
    console.warn(`Library content problems (these entries are hidden):\n- ${problems.join("\n- ")}`);
  }

  const summaries = items
    .map((item) => shapeItem(item, { categories, languages }))
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
let adminSource = null;
let version = 0;
const listeners = new Set();

function loadCatalog() {
  catalogPromise ??= (async () => {
    const source = adminSource;
    if (source) {
      try {
        return buildCatalog(await source.loadLibrary(), source);
      } catch (error) {
        source.reportFailure?.(error);
        warnFallback("admin library", error);
      }
    }
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
 * One item plus its details: text blocks (articles always have blocks; other
 * types may carry optional extra text) and, for a video, its original
 * description. Resolves to null when the item does not exist.
 */
export async function getItem(slug) {
  const catalog = await loadCatalog();
  const summary = catalog.items.find((item) => item.slug === slug);
  if (!summary) return null;

  let details;
  try {
    details = await catalog.source.loadDetails(slug);
  } catch (error) {
    // Only the public API falls back to the bundled text; the admin never
    // reads (possibly outdated) bundled text in place of the database.
    if (catalog.source !== apiSource) throw error;
    warnFallback(`item "${slug}"`, error);
    details = await jsonSource.loadDetails(slug);
  }
  return { ...summary, ...details };
}

/* ---------------------------------------------------------------- admin hooks */

export const subscribeLibrary = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getLibraryVersion = () => version;

/** Forgets the loaded data; every view reads it again (keeping what it shows meanwhile). */
export function refreshLibrary() {
  catalogPromise = null;
  version += 1;
  listeners.forEach((listener) => listener());
}

/**
 * Plugs in (or removes, with null) the admin data source. It must offer
 * loadLibrary() and loadDetails(slug) like the sources above, and may offer
 * reportFailure(error).
 */
export function setAdminSource(source) {
  if (source === adminSource) return;
  adminSource = source;
  revalidatePublic = true;
  refreshLibrary();
}

/** Categories and languages straight from the public API (revalidated). */
export async function loadPublicLibrary() {
  return apiSource.loadLibrary();
}
