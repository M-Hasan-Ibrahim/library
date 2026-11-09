/**
 * The item editor's data model (no React here, so it can be unit-tested).
 *
 * A FORM is what the editor holds: plain strings for the inputs, links as
 * rows, and the text as stored blocks (the document editor converts its
 * document to blocks itself, see docModel.js). It converts to and from the
 * admin API's item shape:
 *   formFromItem(item)      stored item  -> form
 *   payloadFromForm(form)   form         -> API fields (as items.json names them)
 *   changedFields(form, base)             only what the admin changed (for PATCH)
 *
 * Unchanged content converts back to exactly what is stored, so opening and
 * saving an item never rewrites what was not touched. Validation uses the
 * Worker's own input rules (worker/src/itemInput.js), so the editor reports
 * the same problems the server would, before anything is sent. The server
 * still checks everything.
 */
import { CONTENT_TYPES } from "../contentTypes.js";
import { readingMinutes } from "../lib/readingTime.js";
import { validateBlocks } from "../lib/validateBlocks.js";
import { parseCreateInput, ValidationError } from "../../worker/src/itemInput.js";

export { LIMITS, slugify } from "../../worker/src/itemInput.js";

/* ------------------------------------------------------------ helpers */

/** Deep equality on JSON values, ignoring object key order. */
export function sameJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, i) => sameJson(value, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
  }
  return false;
}

const today = () => new Date().toISOString().slice(0, 10);
let rowCounter = 0;
/** Stable React keys for link rows (never sent to the API). */
export const newRowKey = () => `row-${(rowCounter += 1)}`;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Tags from "physics, light, …" (Arabic comma and new lines also separate). */
export function parseTags(text) {
  return String(text ?? "")
    .split(/[,،\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parsePageCount(text) {
  const value = String(text ?? "").trim();
  if (value === "") return null;
  return /^\d+$/.test(value) ? Number(value) : value; // anything else fails validation with a clear message
}

/* ------------------------------------------------------------ forms */

const TYPE_FIELDS = {
  article: [],
  pdf: ["fileUrl", "pageCount"],
  youtube: ["videoUrl", "videoDescription", "videoInfo"],
  link: ["url"],
};

/** Form for a stored item (the admin API's item, with blocks). */
export function formFromItem(item) {
  return {
    type: item.type,
    slug: item.slug ?? "",
    categoryId: item.categoryId ?? "",
    language: item.language ?? "",
    addedAt: item.addedAt ?? today(),
    title: item.title ?? "",
    description: item.description ?? "",
    tags: (item.tags ?? []).join(", "),
    links: (item.links ?? []).map((link) => ({ key: newRowKey(), label: link.label ?? "", url: link.url ?? "" })),
    blocks: clone(item.blocks ?? []),
    fileUrl: item.fileUrl ?? "",
    pageCount: item.pageCount == null ? "" : String(item.pageCount),
    videoUrl: item.videoUrl ?? "",
    videoDescription: item.videoDescription ?? "",
    videoInfo: clone(item.videoInfo ?? null),
    url: item.url ?? "",
  };
}

/** Form for a new item of `type`. */
export function emptyForm(type, { categoryId = "", language = "en" } = {}) {
  return {
    type,
    slug: "",
    categoryId,
    language,
    addedAt: today(),
    title: "",
    description: "",
    tags: "",
    links: [],
    blocks: [],
    fileUrl: "",
    pageCount: "",
    videoUrl: "",
    videoDescription: "",
    videoInfo: null,
    url: "",
  };
}

/** The API fields a form describes (type and slug excluded). */
export function payloadFromForm(form) {
  const payload = {
    categoryId: form.categoryId,
    language: form.language,
    title: form.title.trim(),
    description: form.description.trim(),
    tags: parseTags(form.tags),
    links: form.links
      .filter((link) => link.label.trim() !== "" || link.url.trim() !== "")
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() })),
    addedAt: form.addedAt,
    blocks: form.blocks,
  };
  for (const field of TYPE_FIELDS[form.type] ?? []) {
    if (field === "pageCount") payload.pageCount = parsePageCount(form.pageCount);
    else if (field === "videoInfo") payload.videoInfo = form.videoInfo ?? null;
    else if (field === "videoDescription") payload.videoDescription = String(form.videoDescription ?? "").replace(/\r\n?/g, "\n").trim();
    else payload[field] = String(form[field] ?? "").trim();
  }
  return payload;
}

/** Fields whose value differs from `base` (what a PATCH sends). */
export function changedFields(form, base) {
  const now = payloadFromForm(form);
  const before = payloadFromForm(base);
  return Object.fromEntries(Object.entries(now).filter(([field, value]) => !sameJson(value, before[field])));
}

/** True when the form differs from `base` (a new item's address counts too). */
export function isDirty(form, base) {
  return Object.keys(changedFields(form, base)).length > 0 || form.slug.trim() !== base.slug.trim();
}

/** Body of POST /api/admin/items. */
export function createPayload(form) {
  const slug = form.slug.trim();
  return { type: form.type, ...(slug ? { slug } : {}), ...payloadFromForm(form) };
}

/**
 * Checks the whole form with the server's rules. Returns field -> reason
 * (the server's wording, e.g. { title: "must not be empty" }), or null.
 * options: as for the server (INPUT_OPTIONS in client.js).
 */
export function checkForm(form, options = {}) {
  const payload = createPayload(form);
  let errors = {};
  try {
    parseCreateInput(payload, options);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    errors = { ...error.fields };
  }
  if (form.type === "article" && payload.blocks.length === 0) errors.blocks ??= "an article needs some text";
  return Object.keys(errors).length ? errors : null;
}

/** Restored (sessionStorage) forms are checked before use; null if unusable. */
export function reviveForm(value, type) {
  if (!value || typeof value !== "object" || value.type !== type) return null;
  const strings = ["slug", "categoryId", "language", "addedAt", "title", "description", "tags", "fileUrl", "pageCount", "videoUrl", "url"];
  if (!strings.every((key) => typeof value[key] === "string")) return null;
  if (!Array.isArray(value.links) || !value.links.every((l) => l && typeof l.label === "string" && typeof l.url === "string")) return null;
  if (!Array.isArray(value.blocks) || !value.blocks.every((b) => b && typeof b === "object" && typeof b.id === "string" && typeof b.type === "string")) return null;
  if (value.videoInfo !== undefined && value.videoInfo !== null && typeof value.videoInfo !== "object") return null;
  return {
    ...value,
    videoDescription: typeof value.videoDescription === "string" ? value.videoDescription : "",
    videoInfo: value.videoInfo ?? null,
    links: value.links.map((link) => ({ ...link, key: newRowKey() })),
  };
}

/* ------------------------------------------------------------ errors */

export const FIELD_LABELS = {
  type: "Type",
  slug: "Item address",
  categoryId: "Category",
  language: "Language",
  title: "Title",
  description: "Description",
  tags: "Tags",
  links: "Links",
  addedAt: "Date",
  blocks: "Text",
  fileUrl: "PDF file",
  pageCount: "Pages",
  videoUrl: "YouTube video",
  videoDescription: "Video description",
  videoInfo: "Video information",
  url: "Link URL",
  item: "Item",
  body: "Request",
  revision: "Revision",
};

// "blocks[2].text: …", "blocks[1].blocks[0].items[3].list.items[0]: …"
const PROBLEM = /^blocks\[(\d+)\](?:\.blocks\[(\d+)\])?((?:\.[A-Za-z]+(?:\[\d+\])?)*): (.*)$/;
const PART_LABELS = { text: "Text", summary: "Section title", blocks: "Section content", level: "Level", language: "Language", id: "Block id", type: "Type", ordered: "List style" };
const READS_ON = /^(must|is|are|contains|at most|lists nest)\b/;

function describePart(path) {
  if (!path) return "This block";
  const items = [...path.matchAll(/\.items\[(\d+)\]/g)];
  if (items.length === 1) return `List item ${Number(items[0][1]) + 1}`;
  if (items.length > 1) return "A nested list item";
  if (/^\.items$/.test(path)) return "The list";
  const part = /^\.([A-Za-z]+)/.exec(path)?.[1];
  return PART_LABELS[part] ?? part;
}

/**
 * Maps block problems (from validateBlocks or a 422 answer) to the blocks
 * they concern.
 * @returns {{ byId: Map<string, string[]>, general: string[] }}
 */
export function blockProblems(problems, blocks) {
  const byId = new Map();
  const general = [];
  for (const problem of problems) {
    const match = PROBLEM.exec(problem.trim());
    const outer = match ? blocks[Number(match[1])] : undefined;
    const target = match && match[2] !== undefined ? outer?.blocks?.[Number(match[2])] : outer;
    if (!target?.id) {
      general.push(problem);
      continue;
    }
    const [, , , path, message] = match;
    const what = describePart(path);
    const list = byId.get(target.id) ?? [];
    list.push(READS_ON.test(message) ? `${what} ${message}` : `${what}: ${message}`);
    byId.set(target.id, list);
  }
  return { byId, general };
}

/** Block problems of a form, from the shared rules. */
export function formBlockProblems(form) {
  return blockProblems(validateBlocks(form.blocks), form.blocks);
}

/** Splits a 422 "blocks" message ("a; b; c (+2 more)") into problems. */
export const splitServerProblems = (message) =>
  String(message ?? "")
    .replace(/\s*\(\+\d+ more\)$/, "")
    .split(/;\s+(?=blocks)/)
    .filter(Boolean);

/* ------------------------------------------------------------ preview */

/** The item the reading view shows for a form (unsaved preview). */
export function previewItem(form, stored = null) {
  const payload = payloadFromForm(form);
  return {
    id: stored?.id ?? "preview",
    slug: stored?.slug ?? (form.slug.trim() || "preview"),
    type: form.type,
    ...payload,
    pageCount: typeof payload.pageCount === "number" ? payload.pageCount : undefined,
    readingMinutes: form.type === "article" ? readingMinutes(payload.blocks) : stored?.readingMinutes,
    updatedAt: stored?.updatedAt ?? today(),
  };
}

export const typeLabel = (type) => CONTENT_TYPES[type]?.label ?? type;
