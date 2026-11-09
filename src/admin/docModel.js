/**
 * Stored rich-text blocks <-> the document editor's model (ProseMirror JSON,
 * as used by Tiptap). No DOM and no editor here, so it can be unit-tested.
 *
 *   blocksToDoc(blocks)                       for loading an item
 *   docToBlocks(doc, { originals })           for saving it
 *
 * Mapping (stored block -> editor node):
 *   paragraph            -> paragraph
 *   heading level 2/3/4  -> heading level 2/3/4 (shown as Heading 1/2/3)
 *   list                 -> bulletList / orderedList (items nest: { text, list })
 *   quote                -> blockquote with one paragraph
 *   code                 -> codeBlock (language)
 *   divider              -> horizontalRule
 *   details              -> details (detailsSummary + detailsContent)
 * Inline text: **bold**, *italic*, `code`, [label](url) <-> bold, italic,
 * code and link marks (src/lib/inlineMarkup.js converts both ways).
 *
 * Every block node carries its stored id (attribute blockId). A block whose
 * editor node is exactly as it was when the item was opened is saved as its
 * ORIGINAL stored block, byte for byte, so untouched content never changes.
 * Empty paragraphs (blank lines), empty headings and empty list items are
 * not content and are left out.
 */
import { inlineToRuns, runsToInline } from "../lib/inlineMarkup.js";

export const BLOCK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/i;
const CODE_LANGUAGE = /^[a-z0-9+#._-]{1,30}$/i;
export const MAX_LIST_DEPTH = 3;

/* ------------------------------------------------------------ inline */

function inlineToNodes(text) {
  return inlineToRuns(text ?? "").map((run) => {
    const marks = [];
    if (run.href) marks.push({ type: "link", attrs: { href: run.href } });
    if (run.bold) marks.push({ type: "bold" });
    if (run.italic) marks.push({ type: "italic" });
    if (run.code) marks.push({ type: "code" });
    const node = { type: "text", text: run.text };
    if (marks.length) node.marks = marks;
    return node;
  });
}

function nodesToInline(content) {
  const runs = [];
  for (const node of content ?? []) {
    if (node.type === "text") {
      const has = (type) => (node.marks ?? []).find((mark) => mark.type === type);
      runs.push({ text: node.text ?? "", bold: Boolean(has("bold")), italic: Boolean(has("italic")), code: Boolean(has("code")), href: has("link")?.attrs?.href ?? null });
    } else if (node.type === "hardBreak") {
      runs.push({ text: " " });
    }
  }
  return runsToInline(runs);
}

const plainText = (content) => (content ?? []).map((node) => node.text ?? "").join("");

/* ------------------------------------------------------------ blocks -> doc */

function listToNode(items, ordered, blockId = null) {
  return {
    type: ordered ? "orderedList" : "bulletList",
    attrs: ordered ? { blockId, start: 1 } : { blockId },
    content: (items ?? []).map((item) => {
      const text = typeof item === "string" ? item : item?.text ?? "";
      const content = [{ type: "paragraph", attrs: { blockId: null }, content: inlineToNodes(text) }];
      if (item && typeof item === "object" && item.list) content.push(listToNode(item.list.items, item.list.ordered === true));
      return { type: "listItem", content };
    }),
  };
}

export function blockToNode(block) {
  const blockId = typeof block?.id === "string" ? block.id : null;
  switch (block?.type) {
    case "paragraph":
      return { type: "paragraph", attrs: { blockId }, content: inlineToNodes(block.text) };
    case "heading":
      return { type: "heading", attrs: { blockId, level: [2, 3, 4].includes(block.level) ? block.level : 2 }, content: inlineToNodes(block.text) };
    case "list":
      return listToNode(block.items, block.ordered === true, blockId);
    case "quote":
      return { type: "blockquote", attrs: { blockId }, content: [{ type: "paragraph", attrs: { blockId: null }, content: inlineToNodes(block.text) }] };
    case "code":
      return { type: "codeBlock", attrs: { blockId, language: block.language ?? null }, content: block.text ? [{ type: "text", text: block.text }] : [] };
    case "divider":
      return { type: "horizontalRule", attrs: { blockId } };
    case "details":
      return {
        type: "details",
        attrs: { blockId },
        content: [
          { type: "detailsSummary", content: inlineToNodes(block.summary) },
          { type: "detailsContent", content: (block.blocks ?? []).map(blockToNode) },
        ],
      };
    default:
      // A block kind this editor does not know: kept as it is.
      return { type: "rawBlock", attrs: { blockId, json: JSON.stringify(block) } };
  }
}

export function blocksToDoc(blocks) {
  const content = (Array.isArray(blocks) ? blocks : []).map(blockToNode);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph", attrs: { blockId: null } }] };
}

/* ------------------------------------------------------------ doc -> blocks */

function nodeToItems(listNode, level) {
  const items = [];
  for (const item of listNode.content ?? []) {
    const paragraph = (item.content ?? []).find((child) => child.type === "paragraph");
    const nested = (item.content ?? []).find((child) => child.type === "bulletList" || child.type === "orderedList");
    const text = paragraph ? nodesToInline(paragraph.content) : "";
    const hasText = text.trim() !== "";
    const children = nested ? nodeToItems(nested, level + 1) : [];
    if (!children.length) {
      if (hasText) items.push(text);
    } else if (!hasText) {
      items.push(...children); // an empty item's sub-items move up a level
    } else if (level < MAX_LIST_DEPTH) {
      items.push({ text, list: { ordered: nested.type === "orderedList", items: children } });
    } else {
      items.push(text, ...flattenItems(children)); // deeper than allowed: same level
    }
  }
  return items;
}

const flattenItems = (items) => items.flatMap((item) => (typeof item === "string" ? [item] : [item.text, ...flattenItems(item.list.items)]));

/**
 * @param {object} doc  ProseMirror JSON ({ type: "doc", content })
 * @param {{ originals?: Map<string, { json: string, block: object }>, makeId?: () => string }} options
 *   originals: per block id, the node as first loaded and the stored block.
 */
export function docToBlocks(doc, { originals = new Map(), makeId = defaultIdMaker() } = {}) {
  const used = new Set();
  const takeId = (candidate) => {
    let id = typeof candidate === "string" && BLOCK_ID.test(candidate) && !used.has(candidate) ? candidate : null;
    while (!id || used.has(id)) id = makeId();
    used.add(id);
    return id;
  };

  const convert = (nodes, inSection) => {
    const out = [];
    for (const node of nodes ?? []) {
      const original = node.attrs?.blockId ? originals.get(node.attrs.blockId) : undefined;
      if (original && !used.has(node.attrs.blockId) && original.json === JSON.stringify(node)) {
        used.add(node.attrs.blockId);
        out.push(original.block);
        continue;
      }
      switch (node.type) {
        case "paragraph": {
          const text = nodesToInline(node.content);
          if (text.trim()) out.push({ id: takeId(node.attrs?.blockId), type: "paragraph", text });
          break;
        }
        case "heading": {
          const text = nodesToInline(node.content);
          const level = Math.min(4, Math.max(2, Number(node.attrs?.level) || 2));
          if (text.trim()) out.push({ id: takeId(node.attrs?.blockId), type: "heading", level, text });
          break;
        }
        case "bulletList":
        case "orderedList": {
          const items = nodeToItems(node, 1);
          if (items.length) out.push({ id: takeId(node.attrs?.blockId), type: "list", ordered: node.type === "orderedList", items });
          break;
        }
        case "blockquote": {
          // Each paragraph of a quote is one stored quote.
          let first = true;
          for (const child of node.content ?? []) {
            const text = child.type === "paragraph" ? nodesToInline(child.content) : plainText(child.content);
            if (!text.trim()) continue;
            out.push({ id: takeId(first ? node.attrs?.blockId : null), type: "quote", text });
            first = false;
          }
          break;
        }
        case "codeBlock": {
          const text = plainText(node.content);
          if (!text.trim()) break;
          const language = typeof node.attrs?.language === "string" && CODE_LANGUAGE.test(node.attrs.language.trim()) ? node.attrs.language.trim() : null;
          out.push(language ? { id: takeId(node.attrs?.blockId), type: "code", language, text } : { id: takeId(node.attrs?.blockId), type: "code", text });
          break;
        }
        case "horizontalRule":
          out.push({ id: takeId(node.attrs?.blockId), type: "divider" });
          break;
        case "details": {
          const summaryNode = (node.content ?? []).find((child) => child.type === "detailsSummary");
          const contentNode = (node.content ?? []).find((child) => child.type === "detailsContent");
          const summary = nodesToInline(summaryNode?.content);
          if (inSection) {
            // No section inside a section: its parts stay, in place.
            if (summary.trim()) out.push({ id: takeId(null), type: "paragraph", text: summary });
            out.push(...convert(contentNode?.content, true));
            break;
          }
          const id = takeId(node.attrs?.blockId);
          const blocks = convert(contentNode?.content, true);
          if (summary.trim() || blocks.length) out.push({ id, type: "details", summary, blocks });
          break;
        }
        case "rawBlock": {
          try {
            const block = JSON.parse(node.attrs?.json ?? "null");
            if (block && typeof block === "object") {
              used.add(block.id);
              out.push(block);
            }
          } catch {
            // unreadable: nothing to keep
          }
          break;
        }
        default:
          break;
      }
    }
    return out;
  };

  return convert(doc?.content, false);
}

/** Block ids like "b7k2q", never repeating within one editor session. */
export function defaultIdMaker(random = Math.random) {
  const issued = new Set();
  let counter = 0;
  return () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = `b${Math.floor(random() * 36 ** 5).toString(36).padStart(5, "0")}`;
      if (!issued.has(id)) {
        issued.add(id);
        return id;
      }
    }
    // A poor random source: fall back to a counter (never loops forever).
    let id;
    do id = `b${(counter += 1).toString(36)}x`;
    while (issued.has(id));
    issued.add(id);
    return id;
  };
}

/**
 * The originals map for docToBlocks: every block node of the document as
 * the editor first holds it, with the stored block it came from.
 */
export function collectOriginals(doc, blocks) {
  const stored = new Map();
  const walkBlocks = (list) =>
    (list ?? []).forEach((block) => {
      if (typeof block?.id === "string") stored.set(block.id, block);
      if (Array.isArray(block?.blocks)) walkBlocks(block.blocks);
    });
  walkBlocks(blocks);
  const originals = new Map();
  const walkNodes = (nodes) =>
    (nodes ?? []).forEach((node) => {
      const id = node.attrs?.blockId;
      if (id && stored.has(id) && !originals.has(id)) originals.set(id, { json: JSON.stringify(node), block: stored.get(id) });
      if (node.type === "details") walkNodes(node.content?.find((child) => child.type === "detailsContent")?.content);
    });
  walkNodes(doc?.content);
  return originals;
}
