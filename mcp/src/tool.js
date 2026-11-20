/**
 * The one MCP tool: create_library_draft.
 *
 * Validation is the Library's own (worker/src/itemInput.js parseCreateInput and
 * src/lib/validateBlocks.js, imported, not copied), so the rules cannot drift.
 * The Library API validates again and always creates a draft; this server adds
 * nothing that could publish, edit, delete or read anything.
 *
 * The integration token (secret LIBRARY_INTEGRATION_TOKEN) is only placed in
 * the Authorization header of the request to the Library API, sent through
 * the service binding LIBRARY_API. It is never returned, logged or echoed.
 */
import { parseCreateInput, ValidationError } from "../../worker/src/itemInput.js";

export const TOOL_NAME = "create_library_draft";
export const CATEGORY_IDS = ["cat_science", "cat_thoughts", "cat_personal", "cat_interesting_finds", "cat_other"];
export const LANGUAGES = ["en", "ar"];
const ACCEPTED = new Set(["title", "description", "language", "categoryId", "tags", "links", "blocks"]);
const UPSTREAM_PATH = "/api/integrations/drafts";
const UPSTREAM_TIMEOUT_MS = 20_000;

const text = (description, extra = {}) => ({ type: "string", description, ...extra });
const BLOCK_ID = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,39}$", description: "Unique id within the article, e.g. b1, b2…" };
const INLINE = "Plain text with inline markup **bold**, *italic*, `code` and [label](https://…). Never HTML.";
const listItem = {
  anyOf: [
    { type: "string", minLength: 1 },
    {
      type: "object",
      additionalProperties: false,
      required: ["text", "list"],
      properties: {
        text: { type: "string", minLength: 1 },
        list: { type: "object", description: "Nested list (max 3 levels).", required: ["items"], properties: { ordered: { type: "boolean" }, items: { type: "array" } } },
      },
    },
  ],
};
const simpleBlocks = [
  { type: "object", additionalProperties: false, required: ["id", "type", "text"], properties: { id: BLOCK_ID, type: { const: "paragraph" }, text: text(INLINE, { minLength: 1, maxLength: 20000 }) } },
  { type: "object", additionalProperties: false, required: ["id", "type", "level", "text"], properties: { id: BLOCK_ID, type: { const: "heading" }, level: { enum: [2, 3, 4] }, text: text(INLINE, { minLength: 1, maxLength: 20000 }) } },
  { type: "object", additionalProperties: false, required: ["id", "type", "items"], properties: { id: BLOCK_ID, type: { const: "list" }, ordered: { type: "boolean" }, items: { type: "array", minItems: 1, maxItems: 200, items: listItem } } },
  { type: "object", additionalProperties: false, required: ["id", "type", "text"], properties: { id: BLOCK_ID, type: { const: "quote" }, text: text(INLINE, { minLength: 1, maxLength: 20000 }) } },
  { type: "object", additionalProperties: false, required: ["id", "type", "text"], properties: { id: BLOCK_ID, type: { const: "code" }, language: { type: "string", pattern: "^[A-Za-z0-9+#._-]{1,30}$" }, text: { type: "string", minLength: 1, maxLength: 20000 } } },
  { type: "object", additionalProperties: false, required: ["id", "type"], properties: { id: BLOCK_ID, type: { const: "divider" } } },
];
const detailsBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "summary", "blocks"],
  description: "Expandable section; cannot contain another one.",
  properties: { id: BLOCK_ID, type: { const: "details" }, summary: text("Section title", { minLength: 1 }), blocks: { type: "array", minItems: 1, items: { anyOf: simpleBlocks } } },
};

export const TOOL = Object.freeze({
  name: TOOL_NAME,
  title: "Create Library draft",
  description:
    "Create ONE article draft in the owner's Library (library.mh-ibrahim.com). The draft is private: it is never " +
    "published by this tool and only the owner can publish it from the Library admin. This tool cannot publish, edit, " +
    "delete, list or read articles. Returns the new draft's id.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "language", "categoryId", "blocks"],
    properties: {
      title: text("Article title (one line, at most 200 characters).", { minLength: 1, maxLength: 200 }),
      description: text("Short summary shown in the list (at most 2000 characters).", { maxLength: 2000 }),
      language: { type: "string", enum: LANGUAGES, description: "en = English, ar = Arabic (right-to-left)." },
      categoryId: { type: "string", enum: CATEGORY_IDS, description: "Science, Thoughts, Personal, Interesting Finds or Other." },
      tags: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } },
      links: {
        type: "array",
        maxItems: 20,
        description: "Related links shown under the article.",
        items: { type: "object", additionalProperties: false, required: ["label", "url"], properties: { label: { type: "string", minLength: 1, maxLength: 120 }, url: { type: "string", format: "uri", maxLength: 2000 } } },
      },
      blocks: { type: "array", minItems: 1, maxItems: 500, description: "The article body as rich-text blocks.", items: { anyOf: [...simpleBlocks, detailsBlock] } },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "status"],
    properties: { id: { type: "string" }, status: { const: "draft" } },
  },
  annotations: { title: "Create Library draft", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
});

/* ------------------------------------------------------------ validation */

/** The draft fields to send, or a ValidationError with readable reasons per field. */
export function validateArguments(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ValidationError({ arguments: "must be an object" });
  const errors = {};
  for (const key of Object.keys(args)) {
    if (!ACCEPTED.has(key)) errors[key] = /^(status|published?|visibility|publishedAt)$/i.test(key)
      ? "this tool only creates drafts; the owner publishes them"
      : "is not an accepted field";
  }
  if ("language" in args && !LANGUAGES.includes(args.language)) errors.language = `must be one of ${LANGUAGES.join(", ")}`;
  if ("categoryId" in args && !CATEGORY_IDS.includes(args.categoryId)) errors.categoryId = `must be one of ${CATEGORY_IDS.join(", ")}`;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const fields = Object.fromEntries(Object.entries(args).filter(([key]) => ACCEPTED.has(key)));
  // The Library's create rules: required fields, types, limits, blocks, safe links. Throws ValidationError.
  parseCreateInput({ type: "article", ...fields });
  if (!Array.isArray(fields.blocks) || fields.blocks.length === 0) throw new ValidationError({ blocks: "an article needs at least one block" });
  return { type: "article", ...fields };
}

/* ------------------------------------------------------------ upstream */

const result = (message, structured, isError = false) => ({
  content: [{ type: "text", text: message }],
  ...(structured ? { structuredContent: structured } : {}),
  ...(isError ? { isError: true } : {}),
});

const describeFields = (fields) =>
  Object.entries(fields ?? {})
    .slice(0, 20)
    .map(([key, reason]) => `- ${key}: ${String(reason).slice(0, 300)}`)
    .join("\n");

/** Never lets a secret through, whatever an upstream message contains. */
function scrub(message, env) {
  const token = String(env.LIBRARY_INTEGRATION_TOKEN ?? "");
  return token && message.includes(token) ? message.split(token).join("[redacted]") : message;
}

/** Runs the tool; always resolves to an MCP CallToolResult. */
export async function createDraft(args, env) {
  let draft;
  try {
    draft = validateArguments(args);
  } catch (error) {
    if (error instanceof ValidationError) return result(`The draft was not created. Fix these fields and try again:\n${describeFields(error.fields)}`, null, true);
    throw error;
  }

  const token = String(env.LIBRARY_INTEGRATION_TOKEN ?? "");
  const api = env.LIBRARY_API;
  const base = String(env.LIBRARY_API_URL ?? "");
  if (!/^lib_int_[A-Za-z0-9_-]{43}$/.test(token) || typeof api?.fetch !== "function" || !/^https:\/\/[^/]+$/.test(base)) {
    console.error("create_library_draft: the server is not configured (LIBRARY_INTEGRATION_TOKEN, LIBRARY_API or LIBRARY_API_URL)");
    return result("The Library is not available right now (server configuration). No draft was created.", null, true);
  }

  let response;
  try {
    response = await api.fetch(
      new Request(`${base}${UPSTREAM_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "library-mcp" },
        body: JSON.stringify(draft),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }),
    );
  } catch (error) {
    console.error("create_library_draft: Library API unreachable:", error instanceof Error ? error.name : "error");
    return result("The Library could not be reached. No draft was confirmed; try again later.", null, true);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {}

  if (response.status === 201 && typeof data?.id === "string" && data.status === "draft") {
    console.log(`create_library_draft: draft ${data.id} created`);
    return result(
      `Draft created (id ${data.id}). It is private: the owner can review and publish it from the Library admin.`,
      { id: data.id, status: "draft" },
    );
  }
  console.warn(`create_library_draft: Library API answered ${response.status}`);
  switch (response.status) {
    case 422:
      return result(scrub(`The Library refused the draft. Fix these fields and try again:\n${describeFields(data?.fields)}`, env), null, true);
    case 429:
      return result(data?.code === "quota_exceeded"
        ? "The daily limit of drafts has been reached. No draft was created; try again tomorrow."
        : "Too many requests. No draft was created; wait a minute and try again.", null, true);
    case 413:
      return result("The article is too large for one draft. No draft was created.", null, true);
    default:
      // 401/403/503 mean a server-side configuration problem; details stay in the logs.
      return result("The Library could not create the draft right now. No draft was created.", null, true);
  }
}
