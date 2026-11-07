import { CONTENT_TYPE_IDS } from "../contentTypes.js";
import { safeHref } from "./inlineMarkup.js";
import { parseYouTubeUrl } from "./youtube.js";

/*
 * Content validation shared by the app today and the admin editor later
 * (the same rules can run on the form before saving, and in the Worker).
 * Invalid items are left out of the library instead of breaking the page.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isDay = (value) => DAY.test(value ?? "") && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const isWebUrl = (value) => typeof value === "string" && /^https?:\/\/\S+$/i.test(value);

export function validateCategory(category) {
  const errors = [];
  if (!isText(category?.id)) errors.push("id is required");
  if (!SLUG.test(category?.slug ?? "")) errors.push("slug must be lowercase words separated by hyphens");
  if (!isText(category?.name)) errors.push("name is required");
  return errors;
}

export function validateLanguage(language) {
  const errors = [];
  if (!/^[a-z]{2,3}$/.test(language?.code ?? "")) errors.push("code must be an ISO 639 code such as 'en'");
  if (!isText(language?.name)) errors.push("name is required");
  if (!["ltr", "rtl"].includes(language?.dir)) errors.push("dir must be 'ltr' or 'rtl'");
  return errors;
}

/**
 * @param {object} item
 * @param {{ categoryIds: Set<string>, languageCodes: Set<string> }} context
 */
export function validateItem(item, { categoryIds, languageCodes }) {
  const errors = [];
  if (!isText(item?.id)) errors.push("id is required");
  if (!SLUG.test(item?.slug ?? "")) errors.push("slug must be lowercase words separated by hyphens");
  if (!CONTENT_TYPE_IDS.includes(item?.type)) errors.push(`type must be one of: ${CONTENT_TYPE_IDS.join(", ")}`);
  if (!categoryIds.has(item?.categoryId)) errors.push(`unknown categoryId "${item?.categoryId}"`);
  if (!languageCodes.has(item?.language)) errors.push(`unknown language "${item?.language}"`);
  if (!isText(item?.title)) errors.push("title is required");
  if (typeof item?.description !== "string") errors.push("description must be a string");
  if (!isDay(item?.addedAt)) errors.push("addedAt must be a date like 2026-10-30");
  if (item?.tags !== undefined && !(Array.isArray(item.tags) && item.tags.every(isText))) {
    errors.push("tags must be a list of words");
  }
  if (item?.links !== undefined) {
    const linksOk =
      Array.isArray(item.links) && item.links.every((link) => isText(link?.label) && safeHref(link?.url ?? ""));
    if (!linksOk) errors.push("links must be a list of { label, url } with http(s) or #/ URLs");
  }

  switch (item?.type) {
    case "pdf":
      if (!isText(item.fileUrl)) errors.push("PDF items need a fileUrl");
      break;
    case "youtube":
      if (!parseYouTubeUrl(item.videoUrl)) errors.push(`"${item.videoUrl}" is not a valid YouTube URL`);
      break;
    case "link":
      if (!isWebUrl(item.url)) errors.push("link items need an http(s) url");
      break;
    default:
      break;
  }
  return errors;
}

/**
 * Validates the whole library. Returns the valid entries plus readable
 * problem descriptions (shown as console warnings during development).
 */
export function validateLibrary({ categories, languages, items }) {
  const problems = [];

  const validLanguages = languages.filter((language) => {
    const errors = validateLanguage(language);
    errors.forEach((error) => problems.push(`Language "${language?.code}": ${error}`));
    return errors.length === 0;
  });

  const validCategories = categories.filter((category) => {
    const errors = validateCategory(category);
    errors.forEach((error) => problems.push(`Category "${category?.id}": ${error}`));
    return errors.length === 0;
  });

  const context = {
    categoryIds: new Set(validCategories.map((category) => category.id)),
    languageCodes: new Set(validLanguages.map((language) => language.code)),
  };
  const seenIds = new Set();
  const seenSlugs = new Set();

  const validItems = items.filter((item) => {
    const errors = validateItem(item, context);
    if (seenIds.has(item?.id)) errors.push("duplicate id");
    if (seenSlugs.has(item?.slug)) errors.push("duplicate slug");
    seenIds.add(item?.id);
    seenSlugs.add(item?.slug);
    errors.forEach((error) => problems.push(`Item "${item?.id ?? item?.slug}": ${error}`));
    return errors.length === 0;
  });

  return { categories: validCategories, languages: validLanguages, items: validItems, problems };
}
