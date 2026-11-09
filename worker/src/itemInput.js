/**
 * Admin item input: field whitelist, types, limits and normalisation, then the
 * shared content rules (src/lib) on the complete resulting item.
 *
 * Create:  { type, slug?, categoryId, language, title, description?, tags?,
 *            links?, addedAt?, blocks?, fileUrl?, pageCount?, videoUrl?,
 *            videoDescription?, videoInfo?, url? }
 *          (videoDescription: the video's original description, shown to
 *           visitors; videoInfo: what was last fetched from YouTube, admin only)
 * Update:  { revision, <any editable field> }   (only the fields sent change)
 *
 * Never accepted from the client: id, status (publish/unpublish endpoints),
 * revision changes, updatedAt and readingMinutes (set by the server).
 * Immutable after creation: id, slug (shared links), type.
 */
import { CONTENT_TYPE_IDS } from "../../src/contentTypes.js";
import { safeHref } from "../../src/lib/inlineMarkup.js";
import { readingMinutes } from "../../src/lib/readingTime.js";
import { validateBlocks } from "../../src/lib/validateBlocks.js";
import { validateItem } from "../../src/lib/validateContent.js";
import { parseYouTubeUrl } from "../../src/lib/youtube.js";

export const LIMITS = Object.freeze({
  title: 200,
  description: 2000,
  tags: 20,
  tag: 40,
  links: 20,
  linkLabel: 120,
  url: 2000,
  slug: 80,
  fileUrl: 500,
  pageCount: 5000,
  bodyBytes: 200_000, // serialized rich text
  videoDescription: 5000, // YouTube's own maximum
  videoInfoBytes: 20_000,
});

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z0-9_]{1,64}$/; // category ids / language codes (existence checked against D1)
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/; // single-line fields: no control characters at all
const LOCAL_PDF = /^documents\/[a-z0-9][a-z0-9._-]{0,150}\.pdf$/;
const WEB_URL = /^https?:\/\/[^\s]+$/i;

const COMMON_FIELDS = ["categoryId", "language", "title", "description", "tags", "links", "addedAt", "blocks"];
const TYPE_FIELDS = { article: [], pdf: ["fileUrl", "pageCount"], youtube: ["videoUrl", "videoDescription", "videoInfo"], link: ["url"] };
const MULTILINE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/; // tab and new lines allowed
const YOUTUBE_PAGE = /^https:\/\/(www\.)?youtube\.com\/[^\s]*$/;
const YOUTUBE_IMAGE = /^https:\/\/([a-z0-9-]+\.)*(ytimg|ggpht|googleusercontent)\.com\/[^\s]*$/;

/** The video information last fetched from YouTube (or null to clear it). */
function videoInfoRule(v) {
  if (v === null) return [null, ""];
  if (!isPlainObject(v)) return [undefined, "must be an object or null"];
  const allowed = ["source", "fetchedAt", "videoId", "title", "description", "tags", "channelTitle", "channelUrl", "thumbnailUrl", "publishedAt"];
  const extra = Object.keys(v).filter((key) => !allowed.includes(key));
  if (extra.length) return [undefined, `${extra[0]} is not an accepted field`];
  if (!["youtube-api", "youtube-oembed"].includes(v.source)) return [undefined, "source must be youtube-api or youtube-oembed"];
  if (typeof v.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(v.videoId)) return [undefined, "videoId must be a YouTube video id"];
  if (typeof v.fetchedAt !== "string" || Number.isNaN(Date.parse(v.fetchedAt))) return [undefined, "fetchedAt must be a date"];
  const text = (key, max, multiline = false) => {
    if (v[key] === undefined || v[key] === null) return "";
    if (typeof v[key] !== "string" || v[key].length > max) return `${key} must be text of at most ${max} characters`;
    if ((multiline ? MULTILINE_CONTROL : CONTROL_CHARS).test(v[key])) return `${key} contains control characters`;
    return "";
  };
  const problem =
    text("title", LIMITS.title) || text("description", LIMITS.videoDescription, true) || text("channelTitle", 200) || text("publishedAt", 40);
  if (problem) return [undefined, problem];
  if (v.tags !== undefined && !(Array.isArray(v.tags) && v.tags.length <= 60 && v.tags.every((tag) => typeof tag === "string" && tag.length <= 100 && !CONTROL_CHARS.test(tag)))) {
    return [undefined, "tags must be a list of at most 60 short words"];
  }
  if (v.channelUrl != null && !(typeof v.channelUrl === "string" && v.channelUrl.length <= 300 && YOUTUBE_PAGE.test(v.channelUrl))) return [undefined, "channelUrl must be a youtube.com address"];
  if (v.thumbnailUrl != null && !(typeof v.thumbnailUrl === "string" && v.thumbnailUrl.length <= 500 && YOUTUBE_IMAGE.test(v.thumbnailUrl))) return [undefined, "thumbnailUrl must be a YouTube image address"];
  if (new TextEncoder().encode(JSON.stringify(v)).length > LIMITS.videoInfoBytes) return [undefined, "is too large"];
  return [v, ""];
}

/** A request that cannot be saved; `fields` maps a field (path) to a readable reason. */
export class ValidationError extends Error {
  constructor(fields) {
    super("Validation failed");
    this.name = "ValidationError";
    this.fields = fields;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------ field rules */

function singleLine(value, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string") return [undefined, "must be text"];
  const text = value.trim();
  if (!allowEmpty && text === "") return [undefined, "must not be empty"];
  if (text.length > max) return [undefined, `must be at most ${max} characters`];
  if (CONTROL_CHARS.test(text)) return [undefined, "must be a single line without control characters"];
  return [text, ""];
}

const RULES = {
  type: (v) => (CONTENT_TYPE_IDS.includes(v) ? [v, ""] : [undefined, `must be one of ${CONTENT_TYPE_IDS.join(", ")}`]),
  slug: (v) => (typeof v === "string" && v.length <= LIMITS.slug && SLUG.test(v) ? [v, ""] : [undefined, "must be lowercase words separated by hyphens (a-z, 0-9), at most 80 characters"]),
  categoryId: (v) => (typeof v === "string" && KEY.test(v) ? [v, ""] : [undefined, "must be a category id"]),
  language: (v) => (typeof v === "string" && KEY.test(v) ? [v, ""] : [undefined, "must be a language code"]),
  title: (v) => singleLine(v, LIMITS.title),
  description: (v) => singleLine(v, LIMITS.description, { allowEmpty: true }),
  addedAt: (v) => (typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)
    ? [v, ""]
    : [undefined, "must be a real date like 2026-11-08"]),
  tags: (v) => {
    if (!Array.isArray(v)) return [undefined, "must be a list of words"];
    if (v.length > LIMITS.tags) return [undefined, `at most ${LIMITS.tags} tags`];
    const tags = [];
    for (const tag of v) {
      const [text, problem] = singleLine(tag, LIMITS.tag);
      if (problem) return [undefined, `each tag ${problem}`];
      if (tags.includes(text)) return [undefined, `"${text}" appears twice`];
      tags.push(text);
    }
    return [tags, ""];
  },
  links: (v) => {
    if (!Array.isArray(v)) return [undefined, "must be a list of { label, url }"];
    if (v.length > LIMITS.links) return [undefined, `at most ${LIMITS.links} links`];
    const links = [];
    for (const link of v) {
      if (!isPlainObject(link) || Object.keys(link).some((k) => k !== "label" && k !== "url")) return [undefined, "each link must be exactly { label, url }"];
      const [label, labelProblem] = singleLine(link.label, LIMITS.linkLabel);
      if (labelProblem) return [undefined, `each link label ${labelProblem}`];
      const url = typeof link.url === "string" ? link.url.trim() : "";
      if (!url || url.length > LIMITS.url || !safeHref(url)) return [undefined, "each link url must be http(s), mailto or #/… (at most 2000 characters)"];
      links.push({ label, url });
    }
    return [links, ""];
  },
  blocks: (v) => {
    const problems = validateBlocks(v);
    if (problems.length) return [undefined, problems.slice(0, 5).join("; ") + (problems.length > 5 ? ` (+${problems.length - 5} more)` : "")];
    if (new TextEncoder().encode(JSON.stringify({ blocks: v })).length > LIMITS.bodyBytes) return [undefined, "text is too long (200 KB maximum)"];
    return [v, ""];
  },
  // ownFiles: this API's own /files/ address. An upload there is accepted as
  // is (its key and record are checked when the item is saved), so a local
  // http:// test API works too.
  fileUrl: (v, { ownFiles } = {}) => {
    const url = typeof v === "string" ? v.trim() : "";
    return url && url.length <= LIMITS.fileUrl && (LOCAL_PDF.test(url) || /^https:\/\/[^\s]+$/i.test(url) || Boolean(ownFiles && url.startsWith(ownFiles)))
      ? [url, ""]
      : [undefined, 'must be a site file like "documents/name.pdf" or an https:// URL'];
  },
  pageCount: (v) => (v === null || (Number.isInteger(v) && v >= 1 && v <= LIMITS.pageCount) ? [v, ""] : [undefined, `must be a whole number from 1 to ${LIMITS.pageCount}, or null`]),
  videoUrl: (v) => {
    const url = typeof v === "string" ? v.trim() : "";
    return url && url.length <= 500 && parseYouTubeUrl(url) ? [url, ""] : [undefined, "must be a YouTube video URL or video id"];
  },
  url: (v) => {
    const url = typeof v === "string" ? v.trim() : "";
    return url && url.length <= LIMITS.url && WEB_URL.test(url) ? [url, ""] : [undefined, "must be an http(s) URL"];
  },
  videoDescription: (v) => {
    if (typeof v !== "string") return [undefined, "must be text"];
    const text = v.replace(/\r\n?/g, "\n").trim();
    if (text.length > LIMITS.videoDescription) return [undefined, `must be at most ${LIMITS.videoDescription} characters`];
    if (MULTILINE_CONTROL.test(text)) return [undefined, "contains control characters"];
    return [text, ""];
  },
  videoInfo: videoInfoRule,
};

function readFields(input, allowed, errors, options = {}) {
  const fields = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key)) {
      errors[key] = "is not an accepted field here";
      continue;
    }
    const [normalised, problem] = RULES[key](value, options);
    if (problem) errors[key] = problem;
    else fields[key] = normalised;
  }
  return fields;
}

/* ------------------------------------------------------------ create / update input */

/**
 * @param {{ ownFiles?: string }} options  see RULES.fileUrl
 * @returns {{ type: string, slug?: string, fields: object }}
 */
export function parseCreateInput(input, options = {}) {
  if (!isPlainObject(input)) throw new ValidationError({ body: "must be a JSON object" });
  const errors = {};
  const type = CONTENT_TYPE_IDS.includes(input.type) ? input.type : null;
  if (!type) errors.type = `is required: one of ${CONTENT_TYPE_IDS.join(", ")}`;
  const allowed = ["type", "slug", ...COMMON_FIELDS, ...(type ? TYPE_FIELDS[type] : [])];
  const fields = readFields(input, allowed, errors, options);
  for (const required of ["categoryId", "language", "title"]) {
    if (!(required in input)) errors[required] ??= "is required";
  }
  if (type === "article" && !("blocks" in input)) errors.blocks ??= "is required for articles";
  if (type === "pdf" && !("fileUrl" in input)) errors.fileUrl ??= "is required for PDFs";
  if (type === "youtube" && !("videoUrl" in input)) errors.videoUrl ??= "is required for videos";
  if (type === "link" && !("url" in input)) errors.url ??= "is required for links";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const { type: _t, slug, ...rest } = fields;
  return { type, slug, fields: rest };
}

/** @returns {{ revision: number, fields: object }} */
export function parseUpdateInput(input, type, options = {}) {
  if (!isPlainObject(input)) throw new ValidationError({ body: "must be a JSON object" });
  const errors = {};
  const { revision, ...changes } = input;
  if (!Number.isInteger(revision) || revision < 1) errors.revision = "is required: the revision your edit is based on";
  for (const key of ["id", "slug", "type", "status", "updatedAt", "readingMinutes"]) {
    if (key in changes) errors[key] = key === "status" ? "use the publish / unpublish endpoints" : "cannot be changed";
  }
  const editable = [...COMMON_FIELDS, ...TYPE_FIELDS[type]];
  const fields = readFields(
    Object.fromEntries(Object.entries(changes).filter(([key]) => !(key in errors))),
    editable,
    errors,
    options,
  );
  if (!Object.keys(errors).length && Object.keys(fields).length === 0) errors.body = "contains no changes";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { revision, fields };
}

/** { revision } for delete / publish / unpublish; { revision, fromRevision } for restore. */
export function parseRevisionInput(input, { withFrom = false } = {}) {
  if (!isPlainObject(input)) throw new ValidationError({ body: "must be a JSON object" });
  const errors = {};
  const allowed = withFrom ? ["revision", "fromRevision"] : ["revision"];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) errors[key] = "is not an accepted field here";
  if (!Number.isInteger(input.revision) || input.revision < 1) errors.revision = "is required: the current revision you are acting on";
  if (withFrom && (!Number.isInteger(input.fromRevision) || input.fromRevision < 1)) errors.fromRevision = "is required: the revision to restore";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return withFrom ? { revision: input.revision, fromRevision: input.fromRevision } : { revision: input.revision };
}

/* ------------------------------------------------------------ rows */

/** Applies validated fields to a database row (unchanged columns keep their exact stored value). */
export function applyFields(row, fields, type) {
  const next = { ...row };
  if ("categoryId" in fields) next.category_id = fields.categoryId;
  if ("language" in fields) next.language = fields.language;
  if ("title" in fields) next.title = fields.title;
  if ("description" in fields) next.description = fields.description;
  if ("tags" in fields) next.tags_json = JSON.stringify(fields.tags);
  if ("links" in fields) next.links_json = JSON.stringify(fields.links);
  if ("addedAt" in fields) next.added_at = fields.addedAt;
  if ("blocks" in fields) {
    next.body_json = fields.blocks.length > 0 || type === "article" ? JSON.stringify({ blocks: fields.blocks }) : null;
    next.reading_minutes = type === "article" ? readingMinutes(fields.blocks) : row.reading_minutes ?? null;
  }
  if ("fileUrl" in fields) next.file_url = fields.fileUrl;
  if ("pageCount" in fields) next.page_count = fields.pageCount;
  if ("videoUrl" in fields) next.video_url = fields.videoUrl;
  if ("url" in fields) next.url = fields.url;
  if ("videoDescription" in fields) next.video_description = fields.videoDescription === "" ? null : fields.videoDescription;
  if ("videoInfo" in fields) next.media_json = fields.videoInfo === null ? null : JSON.stringify(fields.videoInfo);
  return next;
}

/** A new draft row. */
export function newRow({ id, slug, type, fields }) {
  const base = {
    id,
    slug,
    type,
    category_id: null,
    language: null,
    title: null,
    description: "",
    tags_json: "[]",
    links_json: "[]",
    added_at: today(),
    updated_at: today(),
    body_json: null,
    reading_minutes: null,
    file_url: null,
    page_count: null,
    video_url: null,
    url: null,
    video_description: null,
    media_json: null,
    status: "draft",
    revision: 1,
  };
  return applyFields(base, { blocks: [], ...fields }, type);
}

/**
 * Final check of a complete row with the shared content rules (the same ones
 * the website applies), plus "articles need text". Throws ValidationError.
 */
export function assertValidRow(row, { categoryIds, languageCodes }, toItem) {
  const item = toItem(row);
  const problems = validateItem(item, { categoryIds, languageCodes });
  const errors = {};
  for (const problem of problems) {
    if (/categoryId/.test(problem)) errors.categoryId = "is not an existing category";
    else if (/language/.test(problem)) errors.language = "is not an existing language";
    else errors.item = errors.item ? `${errors.item}; ${problem}` : problem;
  }
  if (row.type === "article") {
    let blocks = [];
    try {
      blocks = JSON.parse(row.body_json ?? "{}").blocks ?? [];
    } catch {}
    if (!Array.isArray(blocks) || blocks.length === 0) errors.blocks = "an article needs at least one block of text";
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

/* ------------------------------------------------------------ ids and slugs */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomToken(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export const newItemId = () => `itm_${randomToken(16)}`;

/** Latin slug from a title ("" for titles without Latin letters, e.g. Arabic). */
export function slugify(title) {
  return String(title)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}
