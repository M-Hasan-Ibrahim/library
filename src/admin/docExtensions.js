/**
 * The document editor's schema and keyboard behaviour (Tiptap / ProseMirror).
 * Only what the stored format can hold exists here, so nothing pasted or
 * typed can produce content the site cannot render: no HTML is ever kept.
 *
 *  - BlockIds: every block keeps a stable id (new and duplicated blocks get
 *    a fresh one), so saving unchanged blocks rewrites nothing.
 *  - Headings render one level lower (h3/h4/h5) exactly like the reading
 *    view, under the panel's h2 title; they are offered as Heading 1/2/3.
 *  - Quotes hold paragraphs only; list items hold text plus one nested list;
 *    lists nest at most 3 deep.
 *  - Details (expandable section): a title line and content (no sections
 *    inside sections), shown open while editing.
 *  - RawBlock: a block kind this editor does not know is kept as it is.
 */
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
import Heading from "@tiptap/extension-heading";
import { ListItem } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { safeHref } from "../lib/inlineMarkup.js";
import { BLOCK_ID, MAX_LIST_DEPTH } from "./docModel.js";

const BLOCK_TYPES = ["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule", "details", "rawBlock"];
const CONTAINERS = new Set(["doc", "detailsContent"]);
export const SECTION_CONTENT = "(paragraph | heading | bulletList | orderedList | blockquote | codeBlock | horizontalRule)+";

/* ------------------------------------------------------------ block ids */

const BlockIds = Extension.create({
  name: "blockIds",
  addOptions() {
    return { makeId: () => "b00000" };
  },
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => element.getAttribute("data-block-id"),
            renderHTML: (attributes) => (attributes.blockId ? { "data-block-id": attributes.blockId } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    const { makeId } = this.options;
    return [
      new Plugin({
        key: new PluginKey("blockIds"),
        // After any change: give blocks without an id (new, split, pasted
        // twice) a fresh one. Not an undo step of its own.
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const all = new Set();
          state.doc.descendants((node) => {
            if (node.attrs?.blockId) all.add(node.attrs.blockId);
          });
          const seen = new Set();
          let tr = null;
          state.doc.descendants((node, pos, parent) => {
            if (parent && CONTAINERS.has(parent.type.name) && BLOCK_TYPES.includes(node.type.name)) {
              const id = node.attrs.blockId;
              if (!id || seen.has(id) || !BLOCK_ID.test(id)) {
                let fresh = makeId();
                while (all.has(fresh) || seen.has(fresh)) fresh = makeId();
                tr ??= state.tr;
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: fresh });
                seen.add(fresh);
              } else {
                seen.add(id);
              }
              return node.type.name === "details";
            }
            return node.type.name === "detailsContent";
          });
          return tr ? tr.setMeta("addToHistory", false) : null;
        },
      }),
    ];
  },
});

/* ------------------------------------------------------------ sections */

const Details = Node.create({
  name: "details",
  group: "block",
  content: "detailsSummary detailsContent",
  defining: true,
  parseHTML: () => [{ tag: 'div[data-type="details"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "details", class: "doc-details" }), 0],
});

const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "text*",
  marks: "_",
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="details-summary"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "details-summary", class: "doc-details__summary" }), 0],
});

const DetailsContent = Node.create({
  name: "detailsContent",
  content: SECTION_CONTENT,
  defining: true,
  parseHTML: () => [{ tag: 'div[data-type="details-content"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-type": "details-content", class: "doc-details__content" }), 0],
});

const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({ json: { default: "null" } }),
  parseHTML: () => [{ tag: 'div[data-type="raw-block"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-type": "raw-block", class: "doc-raw", contenteditable: "false" }),
    "A block this editor cannot show (kept unchanged).",
  ],
});

/* ------------------------------------------------------------ helpers */

function ancestor($pos, name) {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === name) return { node: $pos.node(depth), depth, start: $pos.before(depth) };
  }
  return null;
}

const listDepth = ($pos) => {
  let depth = 0;
  for (let d = $pos.depth; d > 0; d -= 1) if (["bulletList", "orderedList"].includes($pos.node(d).type.name)) depth += 1;
  return depth;
};

/** The block (at document or section level) that holds the cursor. */
function containerBlock($pos) {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (CONTAINERS.has($pos.node(depth - 1).type.name)) {
      return { depth, node: $pos.node(depth), parent: $pos.node(depth - 1), index: $pos.index(depth - 1), start: $pos.before(depth), end: $pos.after(depth) };
    }
  }
  return null;
}

/** Moves the current block one place up (-1) or down (+1) among its neighbours. */
export function moveBlock(editor, direction) {
  const { state, view } = editor;
  const { $from, from } = state.selection;
  const block = containerBlock($from);
  if (!block) return false;
  const target = block.index + direction;
  if (target < 0 || target >= block.parent.childCount) return false;
  const neighbour = block.parent.child(target);
  const tr = state.tr.delete(block.start, block.end);
  const insertAt = direction < 0 ? block.start - neighbour.nodeSize : block.start + neighbour.nodeSize;
  tr.insert(insertAt, block.node);
  const offset = direction < 0 ? -neighbour.nodeSize : neighbour.nodeSize;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, Math.min(tr.doc.content.size - 1, from + offset)))));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Wraps the selected blocks in an expandable section (cursor in its title). */
export function wrapInSection(editor) {
  const { state, view } = editor;
  const { $from, $to } = state.selection;
  if (ancestor($from, "details") || ancestor($to, "details")) return false;
  const range = $from.blockRange($to, (node) => node.type.name === "doc");
  if (!range) return false;
  const blocks = [];
  for (let i = range.startIndex; i < range.endIndex; i += 1) blocks.push(range.parent.child(i));
  const { schema } = state;
  if (blocks.some((node) => !schema.nodes.detailsContent.contentMatch.matchType(node.type))) return false;
  const content = blocks.length ? blocks : [schema.nodes.paragraph.create()];
  const section = schema.nodes.details.create(null, [schema.nodes.detailsSummary.create(), schema.nodes.detailsContent.create(null, content)]);
  const tr = state.tr.replaceWith(range.start, range.end, section);
  tr.setSelection(TextSelection.create(tr.doc, range.start + 2));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export const canWrapInSection = (editor) => {
  const { $from, $to } = editor.state.selection;
  if (ancestor($from, "details") || ancestor($to, "details")) return false;
  return Boolean($from.blockRange($to, (node) => node.type.name === "doc"));
};

export const isInSection = (editor) => Boolean(ancestor(editor.state.selection.$from, "details"));
export const currentListDepth = (editor) => listDepth(editor.state.selection.$from);

/* ------------------------------------------------------------ keys */

const DocumentKeys = Extension.create({
  name: "documentKeys",
  priority: 1000,
  addOptions() {
    return { onLink: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      // Section title: Enter goes into the section.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        const summary = ancestor($from, "detailsSummary");
        if (summary) {
          const details = ancestor($from, "details");
          const contentStart = details.start + 1 + summary.node.nodeSize + 1;
          editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(contentStart + 1))));
          return true;
        }
        // Enter on an empty last line of a section leaves the section.
        const parent = $from.parent;
        if (empty && parent.type.name === "paragraph" && parent.content.size === 0 && $from.depth >= 2) {
          const container = $from.node($from.depth - 1);
          if (container.type.name === "detailsContent" && $from.index($from.depth - 1) === container.childCount - 1) {
            const details = ancestor($from, "details");
            const { state } = editor;
            let tr = state.tr;
            let after = details.start + details.node.nodeSize;
            if (container.childCount > 1) {
              tr = tr.delete($from.before(), $from.after());
              after -= parent.nodeSize;
            }
            tr.insert(after, state.schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, after + 1));
            editor.view.dispatch(tr.scrollIntoView());
            return true;
          }
        }
        return false;
      },
      // Backspace in an empty section title removes the section, keeping its content.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        const summary = ancestor($from, "detailsSummary");
        if (!summary || !empty || summary.node.content.size !== 0) return false;
        const details = ancestor($from, "details");
        const content = details.node.child(1).content;
        const tr = editor.state.tr.replaceWith(details.start, details.start + details.node.nodeSize, content);
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(details.start + 1, tr.doc.content.size))));
        editor.view.dispatch(tr);
        return true;
      },
      // Lists nest at most 3 deep (the stored format's limit).
      Tab: ({ editor }) => editor.isActive("listItem") && listDepth(editor.state.selection.$from) >= MAX_LIST_DEPTH,
      "Alt-Shift-ArrowUp": ({ editor }) => moveBlock(editor, -1),
      "Alt-Shift-ArrowDown": ({ editor }) => moveBlock(editor, 1),
      "Mod-k": () => {
        this.options.onLink();
        return true;
      },
    };
  },
});

/* ------------------------------------------------------------ the extension list */

const LEVEL_TAGS = { 2: "h3", 3: "h4", 4: "h5" };

export function documentExtensions({ makeId, onLink, placeholder }) {
  return [
    StarterKit.configure({
      heading: false,
      blockquote: false,
      listItem: false,
      strike: false,
      underline: false,
      hardBreak: false,
      code: { HTMLAttributes: { spellcheck: "false" } },
      codeBlock: { enableTabIndentation: true, tabSize: 2, HTMLAttributes: { dir: "ltr", spellcheck: "false" } },
      link: {
        openOnClick: false,
        enableClickSelection: true,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        HTMLAttributes: { rel: "noreferrer", target: null },
        isAllowedUri: (url) => Boolean(safeHref(String(url ?? ""))),
        shouldAutoLink: (url) => Boolean(safeHref(String(url ?? ""))),
      },
    }),
    // Stored levels 2/3/4 ("Heading 1/2/3") render as h3/h4/h5, like the
    // reading view; "## ", "### ", "#### " at a line start make headings.
    Heading.extend({
      parseHTML() {
        return [
          { tag: "[data-level]", getAttrs: (el) => ({ level: Math.min(4, Math.max(2, Number(el.getAttribute("data-level")) || 2)) }) },
          { tag: "h1", attrs: { level: 2 } },
          { tag: "h2", attrs: { level: 2 } },
          { tag: "h3", attrs: { level: 2 } },
          { tag: "h4", attrs: { level: 3 } },
          { tag: "h5", attrs: { level: 4 } },
          { tag: "h6", attrs: { level: 4 } },
        ];
      },
      renderHTML({ node, HTMLAttributes }) {
        return [LEVEL_TAGS[node.attrs.level] ?? "h3", mergeAttributes(HTMLAttributes, { "data-level": node.attrs.level }), 0];
      },
      // Ctrl+Alt+1/2/3 = Heading 1/2/3, as the menu names them.
      addKeyboardShortcuts() {
        return {
          "Mod-Alt-1": () => this.editor.commands.toggleHeading({ level: 2 }),
          "Mod-Alt-2": () => this.editor.commands.toggleHeading({ level: 3 }),
          "Mod-Alt-3": () => this.editor.commands.toggleHeading({ level: 4 }),
        };
      },
    }).configure({ levels: [2, 3, 4] }),
    Blockquote.extend({ content: "paragraph+" }),
    ListItem.extend({ content: "paragraph (bulletList | orderedList)?" }),
    Details,
    DetailsSummary,
    DetailsContent,
    RawBlock,
    BlockIds.configure({ makeId }),
    DocumentKeys.configure({ onLink }),
    Placeholder.configure({
      includeChildren: true,
      placeholder: ({ node, editor }) => {
        if (node.type.name === "detailsSummary") return "Section title";
        if (node.type.name === "heading") return "Heading";
        return editor.isEmpty ? placeholder : "";
      },
    }),
  ];
}
