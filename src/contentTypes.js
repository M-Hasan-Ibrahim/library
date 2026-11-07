/**
 * Content TYPES decide how an item is rendered (article text, PDF pages,
 * video player, outbound link). They are code, not data.
 *
 * CATEGORIES are a different concept: they organise items by subject and
 * live in src/content/categories.json, so they can be managed later without
 * code changes. Any category can contain any type.
 */
export const CONTENT_TYPES = {
  article: { label: "Article", plural: "Articles" },
  pdf: { label: "PDF", plural: "PDFs" },
  youtube: { label: "Video", plural: "Videos" },
  link: { label: "Link", plural: "Links" },
};

export const CONTENT_TYPE_IDS = Object.keys(CONTENT_TYPES);
