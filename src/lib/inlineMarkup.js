/**
 * A tiny, safe inline formatting syntax for rich text stored as plain strings
 * (in JSON today, in D1 later). Parsed into a tree and rendered as React
 * elements — never as raw HTML, so content cannot inject markup or scripts.
 *
 *   **bold**   *italic*   `code`   [label](https://example.com)
 *
 * Link targets are limited to http(s), mailto, and internal "#/" links;
 * anything else is shown as plain text. Bold, italic and link labels may
 * contain further formatting, e.g. "**bold *and italic* text**" (italic must
 * not end exactly where bold ends: "***" is ambiguous). Link URLs cannot
 * contain spaces or parentheses; percent-encode them ("%28", "%29").
 */

const TOKEN = /`([^`]+)`|\[([^\]]+)\]\(([^()\s]+)\)|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*/g;

export function safeHref(href) {
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  if (/^#\/[^\s]*$/.test(href)) return href;
  return null;
}

/**
 * @returns {Array<
 *   { type: "text", value: string } |
 *   { type: "code", value: string } |
 *   { type: "strong" | "em", children: any[] } |
 *   { type: "link", href: string, children: any[] }
 * >}
 */
export function parseInline(text) {
  if (typeof text !== "string" || text === "") return [];

  const nodes = [];
  let cursor = 0;

  for (const match of text.matchAll(TOKEN)) {
    if (match.index > cursor) nodes.push({ type: "text", value: text.slice(cursor, match.index) });

    const [whole, code, label, href, strong, em] = match;
    if (code !== undefined) {
      nodes.push({ type: "code", value: code });
    } else if (label !== undefined) {
      const target = safeHref(href);
      nodes.push(
        target
          ? { type: "link", href: target, children: parseInline(label) }
          : { type: "text", value: label },
      );
    } else if (strong !== undefined) {
      nodes.push({ type: "strong", children: parseInline(strong) });
    } else if (em !== undefined) {
      nodes.push({ type: "em", children: parseInline(em) });
    }
    cursor = match.index + whole.length;
  }

  if (cursor < text.length) nodes.push({ type: "text", value: text.slice(cursor) });
  return nodes;
}

/** Plain text with the markup removed (e.g. to count words for reading time). */
export function inlineToPlainText(text) {
  const flatten = (nodes) =>
    nodes.map((node) => ("value" in node ? node.value : flatten(node.children))).join("");
  return flatten(parseInline(text));
}
