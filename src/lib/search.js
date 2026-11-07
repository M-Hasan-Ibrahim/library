import { CONTENT_TYPES } from "../contentTypes.js";

/**
 * Case-, accent- and Arabic-spelling-insensitive normalisation:
 * "Résumé" -> "resume"; "أحمد" / "إحمد" / "احمد" all match; harakat ignored;
 * ة ~ ه and ى ~ ي are treated as equal.
 */
export function normalise(value) {
  return String(value)
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // accents, Arabic harakat and hamza marks
    .replace(/ٱ/g, "ا") // alef wasla -> alef
    .replace(/ة/g, "ه") // taa marbuta -> haa
    .replace(/ى/g, "ي") // alef maqsura -> yaa
    .replace(/ـ/g, ""); // tatweel
}

const toWords = (value) => normalise(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Arabic attaches the definite article (and some particles) to the word:
// "المرمى", "والضوء", "بالماء". Index the bare word too, so "مرمى" matches.
const ARABIC_ARTICLE = /^(?:[وفبكل]?ال|لل)(?=\p{L}{2})/u;

function searchableWords(item) {
  const type = CONTENT_TYPES[item.type];
  const words = toWords(
    [
      item.title,
      item.description,
      item.category?.name ?? "",
      type ? `${type.label} ${type.plural}` : "",
      ...(item.tags ?? []),
    ].join(" "),
  );
  return words.flatMap((word) => {
    const bare = word.replace(ARABIC_ARTICLE, "");
    return bare === word ? [word] : [word, bare];
  });
}

/** Every query word must match the START of some word ("git" finds "Git", not "digits"). */
export function matchesQuery(item, query) {
  const terms = toWords(query);
  if (terms.length === 0) return true;
  const words = searchableWords(item);
  return terms.every((term) => words.some((word) => word.startsWith(term)));
}

/**
 * Pure filter used by the library view. Empty values mean "no filter".
 * Phase 2 can move the same filters to the API as query parameters.
 *
 * @param {object[]} items  Item summaries (with `category.slug`).
 * @param {{ query?: string, category?: string, type?: string, language?: string }} filters
 */
export function filterItems(items, { query = "", category = "", type = "", language = "" } = {}) {
  return items.filter(
    (item) =>
      (!category || item.category?.slug === category) &&
      (!type || item.type === type) &&
      (!language || item.language === language) &&
      matchesQuery(item, query),
  );
}
