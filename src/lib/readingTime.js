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

function blockText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .flatMap((block) => [
      typeof block.text === "string" ? (block.type === "code" ? block.text : inlineToPlainText(block.text)) : "",
      typeof block.summary === "string" ? inlineToPlainText(block.summary) : "",
      ...(Array.isArray(block.items) ? block.items.map((item) => (typeof item === "string" ? inlineToPlainText(item) : "")) : []),
      Array.isArray(block.blocks) ? blockText(block.blocks) : "",
    ])
    .join(" ");
}
