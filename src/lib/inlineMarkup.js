/**
 * A tiny, safe inline formatting syntax for rich text stored as plain strings
 * (in JSON and in D1). Parsed into a tree and rendered as React elements —
 * never as raw HTML, so content cannot inject markup or scripts.
 *
 *   **bold**   *italic*   ***bold italic***   `code`   [label](https://example.com)
 *
 * Link targets are limited to http(s), mailto, and internal "#/" links;
 * anything else is shown as plain text. Bold, italic and link labels may
 * contain further formatting, e.g. "**bold *and italic* text**". Link URLs
 * cannot contain spaces or parentheses; percent-encode them ("%28", "%29").
 *
 * A backslash makes the next special character literal: \* \` \[ \] \( \) \\
 * (the admin editor writes these, so text typed there is never mistaken for
 * formatting). A backslash before any other character is kept as typed.
 * Text without backslashes or "***" parses exactly as before these were added.
 */

// Escapable characters, an escape pair, and a backslash that escapes nothing.
const SPECIAL = "\\\\`*[\\]()";
const ESC = `\\\\[${SPECIAL}]`;
const LONE = `\\\\(?![${SPECIAL}])`;

const TOKEN = new RegExp(
  [
    `\\\\([${SPECIAL}])`, // 1 escaped character
    "`([^`]+)`", // 2 code (taken as-is)
    `\\[((?:${ESC}|${LONE}|[^\\]\\\\])+)\\]\\(([^()\\s]+)\\)`, // 3 label, 4 href
    `\\*\\*\\*((?:${ESC}|${LONE}|[^*\\\\\\n])+?)\\*\\*\\*`, // 5 bold italic
    `\\*\\*((?:${ESC}|${LONE}|[^\\\\\\n\\r\\u2028\\u2029])+?)\\*\\*`, // 6 bold
    `\\*((?:${ESC}|${LONE}|[^*\\s\\\\])(?:${ESC}|${LONE}|[^*\\\\])*?)\\*`, // 7 italic
  ].join("|"),
  "g",
);

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

    const [whole, escaped, code, label, href, strongEm, strong, em] = match;
    if (escaped !== undefined) {
      nodes.push({ type: "text", value: escaped });
    } else if (code !== undefined) {
      nodes.push({ type: "code", value: code });
    } else if (label !== undefined) {
      const target = safeHref(href);
      nodes.push(
        target
          ? { type: "link", href: target, children: parseInline(label) }
          : { type: "text", value: label },
      );
    } else if (strongEm !== undefined) {
      nodes.push({ type: "strong", children: [{ type: "em", children: parseInline(strongEm) }] });
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

/* ------------------------------------------------------------ runs (admin editor) */

/**
 * Formatted text as a flat list of runs: { text, bold?, italic?, code?, href? }.
 * This is what a rich-text editor holds (text with marks); the markup and
 * the runs convert both ways (inlineToRuns / runsToInline).
 */
export function inlineToRuns(text) {
  const runs = [];
  const walk = (nodes, marks) => {
    for (const node of nodes) {
      if (node.type === "text") runs.push({ ...marks, text: node.value });
      else if (node.type === "code") runs.push({ ...marks, code: true, text: node.value });
      else if (node.type === "strong") walk(node.children, { ...marks, bold: true });
      else if (node.type === "em") walk(node.children, { ...marks, italic: true });
      else if (node.type === "link") walk(node.children, { ...marks, href: node.href });
    }
  };
  walk(parseInline(text), {});
  return normalizeRuns(runs);
}

const sameMarks = (a, b) =>
  Boolean(a.bold) === Boolean(b.bold) &&
  Boolean(a.italic) === Boolean(b.italic) &&
  Boolean(a.code) === Boolean(b.code) &&
  (a.href ?? null) === (b.href ?? null);

const sameRuns = (a, b) => a.length === b.length && a.every((run, i) => run.text === b[i].text && sameMarks(run, b[i]));

const encodeHref = (href) =>
  String(href ?? "")
    .trim()
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/ /g, "%20");

function joinRuns(list) {
  const runs = [];
  for (const run of list) {
    if (run.text === "") continue;
    const last = runs[runs.length - 1];
    if (last && sameMarks(last, run)) last.text += run.text;
    else runs.push({ ...run });
  }
  return runs;
}

/**
 * Canonical runs: no empty runs, neighbours with the same marks joined,
 * unsafe links and impossible code spans reduced to plain text, and italic
 * text never starting with a space (the syntax cannot say that: the space
 * stays, without the italic).
 */
export function normalizeRuns(input) {
  let runs = joinRuns(
    input
      .filter((raw) => typeof raw?.text === "string" && raw.text !== "")
      .map((raw) => {
        const run = { text: raw.text };
        if (raw.code && !raw.text.includes("`")) run.code = true;
        if (raw.bold) run.bold = true;
        if (raw.italic) run.italic = true;
        if (raw.href) {
          const href = safeHref(encodeHref(raw.href));
          if (href) run.href = href;
        }
        return run;
      }),
  );
  for (let pass = 0; pass < 8; pass += 1) {
    const out = [];
    runs.forEach((run, i) => {
      const lead = run.italic && !run.code && !runs[i - 1]?.italic ? /^\s+/.exec(run.text)?.[0] : "";
      if (!lead) {
        out.push(run);
        return;
      }
      const { italic: _italic, ...plain } = run;
      out.push({ ...plain, text: lead }, { ...run, text: run.text.slice(lead.length) });
    });
    const next = joinRuns(out);
    if (sameRuns(next, runs)) break;
    runs = next;
  }
  return runs;
}

// Parentheses need no escape: with "[" and "]" escaped, no link can form.
const escapeAll = (text) => text.replace(/[\\`*[\]]/g, (c) => `\\${c}`);
const escapeNone = (text) => text;
const codeSpan = (text) => "`" + text + "`";

function group(runs, key) {
  const groups = [];
  for (const run of runs) {
    const value = key(run);
    const last = groups[groups.length - 1];
    if (last && last.value === value) last.runs.push(run);
    else groups.push({ value, runs: [run] });
  }
  return groups;
}

// Writers: links outside, then bold, then italic; code innermost.
function writeNested(runs, esc) {
  const plain = (list) => list.map((run) => (run.code ? codeSpan(run.text) : esc(run.text))).join("");
  const italic = (list) =>
    group(list, (run) => Boolean(run.italic))
      .map((g) => (g.value ? `*${plain(g.runs)}*` : plain(g.runs)))
      .join("");
  const bold = (list) =>
    group(list, (run) => Boolean(run.bold))
      .map((g) => {
        if (!g.value) return italic(g.runs);
        const inner = g.runs.map(({ bold: _bold, ...run }) => run);
        // "**a *b***" cannot be read back: italic that ends the bold text is
        // written as its own ***bold italic*** part.
        const end = [];
        while (inner.length && inner[inner.length - 1].italic) end.unshift(inner.pop());
        return (
          (inner.length ? `**${italic(inner)}**` : "") +
          (end.length ? `***${plain(end.map(({ italic: _italic, ...run }) => run))}***` : "")
        );
      })
      .join("");
  return group(runs, (run) => run.href ?? "")
    .map((g) => (g.value ? `[${bold(g.runs)}](${g.value})` : bold(g.runs)))
    .join("");
}

// Fallback: every run on its own (always readable back, if less tidy).
function writeSeparate(runs, esc) {
  return group(runs, (run) => run.href ?? "")
    .map((g) => {
      const inner = g.runs
        .map((run) => {
          const text = run.code ? codeSpan(run.text) : esc(run.text);
          if (run.bold && run.italic) return `***${text}***`;
          if (run.bold) return `**${text}**`;
          if (run.italic) return `*${text}*`;
          return text;
        })
        .join("");
      return g.value ? `[${inner}](${g.value})` : inner;
    })
    .join("");
}

/**
 * Runs -> inline markup that parseInline reads back to the same runs.
 * Candidates go from the tidiest (no escapes) to the safest; each is checked
 * by parsing it again. If formatting cannot be expressed, the text is kept
 * and only the formatting is dropped.
 */
export function runsToInline(input) {
  const runs = normalizeRuns(input);
  const candidates = [
    [writeNested, escapeNone],
    [writeNested, escapeAll],
    [writeSeparate, escapeAll],
  ];
  for (const [write, esc] of candidates) {
    const text = write(runs, esc);
    if (sameRuns(inlineToRuns(text), runs)) return text;
  }
  return escapeAll(runs.map((run) => run.text).join(""));
}
