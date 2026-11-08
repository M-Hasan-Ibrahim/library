import { safeHref } from "./inlineMarkup.js";

/*
 * Rich-text block validation, shared by the admin API (authoritative, in the
 * Worker) and the future inline editor (instant feedback). It accepts exactly
 * what components/RichText.jsx can render:
 *
 *   { id, type: "paragraph", text }
 *   { id, type: "heading", level: 2 | 3, text }
 *   { id, type: "list", ordered?: boolean, items: string[] }
 *   { id, type: "quote", text }
 *   { id, type: "code", language?: string, text }
 *   { id, type: "details", summary, blocks: [...] }   (no details inside details)
 *
 * Text is plain text with the inline markup **bold**, *italic*, `code` and
 * [label](url); links must be http(s), mailto or in-app (#/...). Text is never
 * rendered as HTML, so these rules are about quality and safe links.
 */

export const BLOCK_LIMITS = Object.freeze({
  maxBlocks: 500, // all blocks, nested ones included
  maxTextLength: 20000, // per text field
  maxListItems: 200,
});

const BLOCK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/i;
const CODE_LANGUAGE = /^[a-z0-9+#._-]{1,30}$/i;
const INLINE_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
// Control characters other than tab, line feed and carriage return.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const ALLOWED_FIELDS = {
  paragraph: ["id", "type", "text"],
  heading: ["id", "type", "level", "text"],
  list: ["id", "type", "ordered", "items"],
  quote: ["id", "type", "text"],
  code: ["id", "type", "language", "text"],
  details: ["id", "type", "summary", "blocks"],
};
export const BLOCK_TYPES = Object.keys(ALLOWED_FIELDS);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Problems with one text field ("" when fine). */
function textProblem(value, { allowLinks = true } = {}) {
  if (typeof value !== "string") return "must be text";
  if (value.trim() === "") return "must not be empty";
  if (value.length > BLOCK_LIMITS.maxTextLength) return `must be at most ${BLOCK_LIMITS.maxTextLength} characters`;
  if (CONTROL_CHARS.test(value)) return "contains control characters";
  if (allowLinks) {
    for (const [, , href] of value.matchAll(INLINE_LINK)) {
      if (!safeHref(href)) return `link "${href.slice(0, 60)}" must be http(s), mailto or #/…`;
    }
  }
  return "";
}

/**
 * @param {unknown} blocks
 * @returns {string[]} readable problems, e.g. 'blocks[2].text: must not be empty' ([] when valid)
 */
export function validateBlocks(blocks) {
  const problems = [];
  const seenIds = new Set();
  let count = 0;

  const visit = (list, path, depth) => {
    if (!Array.isArray(list)) {
      problems.push(`${path}: must be a list of blocks`);
      return;
    }
    list.forEach((block, index) => {
      const at = `${path}[${index}]`;
      count += 1;
      if (!isPlainObject(block)) {
        problems.push(`${at}: must be an object`);
        return;
      }
      const allowed = ALLOWED_FIELDS[block.type];
      if (!allowed) {
        problems.push(`${at}.type: must be one of ${BLOCK_TYPES.join(", ")}`);
        return;
      }
      for (const key of Object.keys(block)) {
        if (!allowed.includes(key)) problems.push(`${at}.${key}: not allowed in a ${block.type} block`);
      }
      if (typeof block.id !== "string" || !BLOCK_ID.test(block.id)) {
        problems.push(`${at}.id: must be 1-40 letters, digits or hyphens`);
      } else if (seenIds.has(block.id)) {
        problems.push(`${at}.id: "${block.id}" is used twice`);
      } else {
        seenIds.add(block.id);
      }
      const check = (field, value, options) => {
        const problem = textProblem(value, options);
        if (problem) problems.push(`${at}.${field}: ${problem}`);
      };

      switch (block.type) {
        case "paragraph":
        case "quote":
          check("text", block.text);
          break;
        case "heading":
          if (block.level !== 2 && block.level !== 3) problems.push(`${at}.level: must be 2 or 3`);
          check("text", block.text);
          break;
        case "list":
          if (block.ordered !== undefined && typeof block.ordered !== "boolean") problems.push(`${at}.ordered: must be true or false`);
          if (!Array.isArray(block.items) || block.items.length === 0) {
            problems.push(`${at}.items: must be a non-empty list`);
          } else if (block.items.length > BLOCK_LIMITS.maxListItems) {
            problems.push(`${at}.items: at most ${BLOCK_LIMITS.maxListItems} items`);
          } else {
            block.items.forEach((item, i) => check(`items[${i}]`, item));
          }
          break;
        case "code":
          if (block.language !== undefined && (typeof block.language !== "string" || !CODE_LANGUAGE.test(block.language))) {
            problems.push(`${at}.language: must be a short name such as "shell" or "js"`);
          }
          check("text", block.text, { allowLinks: false }); // shown as-is, never parsed
          break;
        case "details":
          check("summary", block.summary);
          if (depth >= 1) problems.push(`${at}: an expandable section cannot contain another one`);
          else if (!Array.isArray(block.blocks) || block.blocks.length === 0) problems.push(`${at}.blocks: must be a non-empty list of blocks`);
          else visit(block.blocks, `${at}.blocks`, depth + 1);
          break;
        default:
          break;
      }
    });
  };

  visit(blocks, "blocks", 0);
  if (count > BLOCK_LIMITS.maxBlocks) problems.push(`blocks: at most ${BLOCK_LIMITS.maxBlocks} blocks in total`);
  return problems;
}
