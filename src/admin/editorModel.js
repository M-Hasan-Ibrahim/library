/**
 * The item editor's data model (no React here, so it can be unit-tested).
 *
 * A FORM is what the editor shows: plain strings for every input, list items
 * as one line each, links as rows. It converts to and from the admin API's
 * item shape:
 *   formFromItem(item)      stored item  -> form
 *   payloadFromForm(form)   form         -> API fields (as items.json names them)
 *   changedFields(form, base)             only what the admin changed (for PATCH)
 *
 * Unchanged content converts back to exactly what is stored (same blocks,
 * same tags), so opening and saving an item never rewrites what was not
 * touched. Validation uses the Worker's own input rules
 * (worker/src/itemInput.js), so the editor reports the same problems the
 * server would, before anything is sent. The server still checks everything.
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

/* ------------------------------------------------------------ blocks */

/** Block kinds offered in the editor (value of the block type menu). */
export const BLOCK_KINDS = [
  { value: "paragraph", label: "Paragraph" },
  { value: "heading-2", label: "Heading" },
  { value: "heading-3", label: "Subheading" },
  { value: "list-bulleted", label: "Bulleted list" },
  { value: "list-numbered", label: "Numbered list" },
  { value: "quote", label: "Quote" },
  { value: "code", label: "Code" },
  { value: "details", label: "Expandable section" },
];

export function blockKind(block) {
  if (block.type === "heading") return block.level === 3 ? "heading-3" : "heading-2";
  if (block.type === "list") return block.ordered ? "list-numbered" : "list-bulleted";
  return block.type;
}

export const blockKindLabel = (block) => BLOCK_KINDS.find((kind) => kind.value === blockKind(block))?.label ?? "Block";

/** Stored block -> editor block. Unknown types are kept untouched. */
export function toEditorBlock(block) {
  const id = String(block?.id ?? "");
  switch (block?.type) {
    case "paragraph":
    case "quote":
      return { id, type: block.type, text: String(block.text ?? "") };
    case "heading":
      return { id, type: "heading", level: block.level === 3 ? 3 : 2, text: String(block.text ?? "") };
    case "list":
      return {
        id,
        type: "list",
        ordered: block.ordered === true,
        keepOrdered: Object.hasOwn(block, "ordered"),
        items: (Array.isArray(block.items) ? block.items : []).map((item) => String(item)),
      };
    case "code":
      return { id, type: "code", language: String(block.language ?? ""), text: String(block.text ?? "") };
    case "details":
      return {
        id,
        type: "details",
        summary: String(block.summary ?? ""),
        blocks: (Array.isArray(block.blocks) ? block.blocks : []).map(toEditorBlock),
      };
    default:
      return { id, type: String(block?.type ?? "unknown"), unsupported: true, original: block };
  }
}

/** Editor block -> stored block (only the fields the renderer knows). */
export function fromEditorBlock(block) {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return { id: block.id, type: block.type, text: block.text };
    case "heading":
      return { id: block.id, type: "heading", level: block.level, text: block.text };
    case "list": {
      const items = block.items.filter((item) => item.trim() !== ""); // empty bullets are dropped
      return block.keepOrdered || block.ordered
        ? { id: block.id, type: "list", ordered: block.ordered, items }
        : { id: block.id, type: "list", items };
    }
    case "code": {
      const language = block.language.trim();
      return language ? { id: block.id, type: "code", language, text: block.text } : { id: block.id, type: "code", text: block.text };
    }
    case "details":
      return { id: block.id, type: "details", summary: block.summary, blocks: block.blocks.map(fromEditorBlock) };
    default:
      return block.original;
  }
}

/** Every block id in the tree (nested sections included). */
export function collectBlockIds(blocks, ids = new Set()) {
  for (const block of blocks) {
    ids.add(block.id);
    if (Array.isArray(block.blocks)) collectBlockIds(block.blocks, ids);
  }
  return ids;
}

/** A new id that is not used anywhere in `blocks` (e.g. "b7k2q"). */
export function newBlockId(blocks, random = Math.random) {
  const used = collectBlockIds(blocks);
  for (;;) {
    const id = `b${Math.floor(random() * 36 ** 5).toString(36).padStart(5, "0")}`;
    if (!used.has(id)) return id;
  }
}

/** An empty block of a menu kind. */
export function emptyBlock(kind, makeId) {
  const id = makeId();
  switch (kind) {
    case "heading-2":
    case "heading-3":
      return { id, type: "heading", level: kind === "heading-3" ? 3 : 2, text: "" };
    case "list-bulleted":
    case "list-numbered":
      return { id, type: "list", ordered: kind === "list-numbered", keepOrdered: true, items: [""] };
    case "quote":
      return { id, type: "quote", text: "" };
    case "code":
      return { id, type: "code", language: "", text: "" };
    case "details":
      return { id, type: "details", summary: "", blocks: [emptyBlock("paragraph", makeId)] };
    default:
      return { id, type: "paragraph", text: "" };
  }
}

const textOf = (block) => {
  if (block.type === "list") return block.items.join("\n");
  if (block.type === "details") return block.summary;
  return block.text ?? "";
};
const oneLine = (text) => text.replace(/\s*\n+\s*/g, " ");

/**
 * Changes a block's kind, keeping its id and text (list lines become
 * paragraph lines and back). Sections are not converted (their inner blocks
 * would be lost); a block that becomes a section moves inside it.
 */
export function convertBlock(block, kind, makeId) {
  if (block.type === "details" || block.unsupported || blockKind(block) === kind) return block;
  const text = textOf(block);
  switch (kind) {
    case "paragraph":
    case "quote":
      return { id: block.id, type: kind, text };
    case "heading-2":
    case "heading-3":
      return { id: block.id, type: "heading", level: kind === "heading-3" ? 3 : 2, text: oneLine(text) };
    case "list-bulleted":
    case "list-numbered":
      return {
        id: block.id,
        type: "list",
        ordered: kind === "list-numbered",
        keepOrdered: block.type === "list" ? block.keepOrdered : true,
        items: block.type === "list" ? block.items : text.split(/\n+/),
      };
    case "code":
      return { id: block.id, type: "code", language: "", text };
    case "details":
      return { id: block.id, type: "details", summary: "", blocks: [{ id: makeId(), type: "paragraph", text }] };
    default:
      return block;
  }
}

/**
 * Inline formatting for the selection in a text field: wraps it in
 * **bold**, *italic*, `code` or [label](https://). Returns the new text and
 * the range to select afterwards (the wrapped text, or for a link the
 * address to type, or the placeholder label when nothing was selected).
 */
export function wrapText(value, start, end, format) {
  const selected = value.slice(start, end);
  if (format === "link") {
    const label = selected || "link text";
    const address = "https://";
    const text = `${value.slice(0, start)}[${label}](${address})${value.slice(end)}`;
    const addressStart = start + label.length + 3;
    return selected
      ? { value: text, start: addressStart, end: addressStart + address.length }
      : { value: text, start: start + 1, end: start + 1 + label.length };
  }
  const mark = { bold: "**", italic: "*", code: "`" }[format];
  if (!mark) return { value, start, end };
  const inner = selected || { bold: "bold text", italic: "italic text", code: "code" }[format];
  return {
    value: `${value.slice(0, start)}${mark}${inner}${mark}${value.slice(end)}`,
    start: start + mark.length,
    end: start + mark.length + inner.length,
  };
}

/* ------------------------------------------------------------ forms */

const TYPE_FIELDS = {
  article: [],
  pdf: ["fileUrl", "pageCount"],
  youtube: ["videoUrl"],
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
    blocks: (item.blocks ?? []).map(toEditorBlock),
    fileUrl: item.fileUrl ?? "",
    pageCount: item.pageCount == null ? "" : String(item.pageCount),
    videoUrl: item.videoUrl ?? "",
    url: item.url ?? "",
  };
}

/** Form for a new item of `type`. Articles start with one empty paragraph. */
export function emptyForm(type, { categoryId = "", language = "en", makeId = () => "b01" } = {}) {
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
    blocks: type === "article" ? [{ id: makeId(), type: "paragraph", text: "" }] : [],
    fileUrl: "",
    pageCount: "",
    videoUrl: "",
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
    blocks: form.blocks.map(fromEditorBlock),
  };
  for (const field of TYPE_FIELDS[form.type] ?? []) {
    payload[field] = field === "pageCount" ? parsePageCount(form.pageCount) : String(form[field] ?? "").trim();
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
 */
export function checkForm(form) {
  const payload = createPayload(form);
  let errors = {};
  try {
    parseCreateInput(payload);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    errors = { ...error.fields };
  }
  if (form.type === "article" && payload.blocks.length === 0) errors.blocks ??= "an article needs at least one block of text";
  return Object.keys(errors).length ? errors : null;
}

/** Restored (sessionStorage) forms are checked before use; null if unusable. */
export function reviveForm(value, type) {
  if (!value || typeof value !== "object" || value.type !== type) return null;
  const strings = ["slug", "categoryId", "language", "addedAt", "title", "description", "tags", "fileUrl", "pageCount", "videoUrl", "url"];
  if (!strings.every((key) => typeof value[key] === "string")) return null;
  if (!Array.isArray(value.links) || !value.links.every((l) => l && typeof l.label === "string" && typeof l.url === "string")) return null;
  const blockOk = (block) =>
    block && typeof block.id === "string" && typeof block.type === "string" &&
    (block.unsupported ||
      (["paragraph", "quote", "heading", "code"].includes(block.type) && typeof block.text === "string") ||
      (block.type === "list" && Array.isArray(block.items) && block.items.length > 0 && block.items.every((item) => typeof item === "string")) ||
      (block.type === "details" && typeof block.summary === "string" && Array.isArray(block.blocks) && block.blocks.every(blockOk)));
  if (!Array.isArray(value.blocks) || !value.blocks.every(blockOk)) return null;
  return { ...value, links: value.links.map((link) => ({ ...link, key: newRowKey() })) };
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
  url: "Link URL",
  item: "Item",
  body: "Request",
  revision: "Revision",
};

const PROBLEM = /^blocks\[(\d+)\](?:\.blocks\[(\d+)\])?(?:\.([A-Za-z]+)(?:\[(\d+)\])?)?: (.*)$/;
const PART_LABELS = {
  text: "Text",
  summary: "Section title",
  items: "Item",
  blocks: "Section content",
  level: "Level",
  language: "Language",
  id: "Block id",
  type: "Type",
  ordered: "List style",
};
const READS_ON = /^(must|is|are|contains|at most)\b/;

/**
 * Maps block problems ("blocks[2].items[0]: must not be empty", from
 * validateBlocks or a 422 answer) to the blocks they concern.
 * @returns {{ byId: Map<string, string[]>, general: string[] }}
 */
export function blockProblems(problems, blocks) {
  const byId = new Map();
  const general = [];
  for (const problem of problems) {
    const match = PROBLEM.exec(problem.trim());
    const outer = match ? blocks[Number(match[1])] : undefined;
    const target = match && match[2] !== undefined ? outer?.blocks?.[Number(match[2])] : outer;
    if (!target) {
      general.push(problem);
      continue;
    }
    const [, , , part, index, message] = match;
    let what = "This block";
    if (part) {
      const label = PART_LABELS[part] ?? part;
      if (index !== undefined) what = `${label} ${Number(index) + 1}`;
      else what = part === "items" ? "Items" : label;
    }
    const list = byId.get(target.id) ?? [];
    list.push(READS_ON.test(message) ? `${what} ${message}` : `${what}: ${message}`);
    byId.set(target.id, list);
  }
  return { byId, general };
}

/** Block problems of a form, from the shared rules. */
export function formBlockProblems(form) {
  return blockProblems(validateBlocks(form.blocks.map(fromEditorBlock)), form.blocks);
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
