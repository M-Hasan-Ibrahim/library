import { inlineToPlainText } from "./inlineMarkup.js";

/**
 * Reading time in whole minutes for rich-text blocks: words ÷ 200, rounded
 * up, at least 1. This reproduces the readingMinutes of every existing
 * article, so edited and new articles stay consistent with them.
 */
export function readingMinutes(blocks) {
  const words = blockText(blocks).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

// List items are text, or { text, list } with a nested list.
function itemsText(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === "string") return inlineToPlainText(item);
      const own = typeof item?.text === "string" ? inlineToPlainText(item.text) : "";
      return `${own} ${itemsText(item?.list?.items)}`;
    })
    .join(" ");
}

function blockText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .flatMap((block) => [
      typeof block.text === "string" ? (block.type === "code" ? block.text : inlineToPlainText(block.text)) : "",
      typeof block.summary === "string" ? inlineToPlainText(block.summary) : "",
      itemsText(block.items),
      Array.isArray(block.blocks) ? blockText(block.blocks) : "",
    ])
    .join(" ");
}
