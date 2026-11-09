// Unit tests for stored blocks <-> the document editor's model (src/admin/docModel.js).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { blocksToDoc, collectOriginals, defaultIdMaker, docToBlocks } from "../../src/admin/docModel.js";
import { validateBlocks } from "../../src/lib/validateBlocks.js";

const bodies = new URL("../../src/content/bodies/", import.meta.url);
const existing = readdirSync(bodies).map((file) => [file, JSON.parse(readFileSync(new URL(file, bodies), "utf8")).blocks]);
const ids = (() => {
  let n = 0;
  return () => `new${(n += 1)}`;
})();

test("every existing article goes through the editor model unchanged (key order included)", () => {
  assert.equal(existing.length, 9);
  for (const [file, blocks] of existing) {
    const back = docToBlocks(blocksToDoc(blocks));
    assert.equal(JSON.stringify(back), JSON.stringify(blocks), file);
  }
});

test("untouched blocks are returned exactly as stored, even if the serializer would differ", () => {
  const odd = [{ id: "p1", type: "paragraph", text: "5 * 3 and a * b" }, { id: "p2", type: "paragraph", text: "x" }];
  const doc = blocksToDoc(odd);
  const originals = collectOriginals(doc, odd);
  assert.equal(docToBlocks(doc, { originals })[0], odd[0], "the stored object itself");
  doc.content[1].content[0].text = "y"; // edit the second block only
  const saved = docToBlocks(doc, { originals });
  assert.equal(saved[0], odd[0]);
  assert.deepEqual(saved[1], { id: "p2", type: "paragraph", text: "y" });
});

test("all block kinds, nested lists and sections", () => {
  const blocks = [
    { id: "h1", type: "heading", level: 2, text: "One" },
    { id: "h2", type: "heading", level: 3, text: "Two" },
    { id: "h3", type: "heading", level: 4, text: "Three" },
    { id: "p", type: "paragraph", text: "**bold** *italic* ***both*** `code` [link](https://x.org) \\*literal\\*" },
    { id: "l", type: "list", ordered: false, items: ["a", { text: "b", list: { ordered: true, items: ["c", { text: "d", list: { ordered: false, items: ["e"] } }] } }] },
    { id: "q", type: "quote", text: "Quoted" },
    { id: "c", type: "code", language: "js", text: "const x = 1;\n  return x;" },
    { id: "hr", type: "divider" },
    { id: "s", type: "details", summary: "More", blocks: [{ id: "s1", type: "paragraph", text: "Inside" }, { id: "s2", type: "divider" }] },
  ];
  assert.deepEqual(validateBlocks(blocks), []);
  assert.deepEqual(docToBlocks(blocksToDoc(blocks)), blocks);
  // An escape that changes nothing is dropped when the block is rewritten (same reading).
  const [rewritten] = docToBlocks(blocksToDoc([{ id: "x", type: "paragraph", text: "a \\* b" }]));
  assert.equal(rewritten.text, "a * b");
});

test("blank lines, empty headings and empty list items are not saved", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { blockId: "a" }, content: [{ type: "text", text: "Text" }] },
      { type: "paragraph", attrs: { blockId: null } },
      { type: "heading", attrs: { blockId: null, level: 3 }, content: [] },
      { type: "bulletList", attrs: { blockId: "l" }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }, { type: "listItem", content: [{ type: "paragraph" }] }] },
      { type: "codeBlock", attrs: { blockId: null, language: null }, content: [{ type: "text", text: "   " }] },
    ],
  };
  assert.deepEqual(docToBlocks(doc, { makeId: ids }), [
    { id: "a", type: "paragraph", text: "Text" },
    { id: "l", type: "list", ordered: false, items: ["one"] },
  ]);
});

test("new and duplicated blocks get fresh ids; ids stay unique", () => {
  const paragraph = (blockId, text) => ({ type: "paragraph", attrs: { blockId }, content: [{ type: "text", text }] });
  const blocks = docToBlocks({ type: "doc", content: [paragraph("x", "1"), paragraph("x", "2"), paragraph(null, "3"), paragraph("bad id!", "4")] }, { makeId: defaultIdMaker(() => 0.5) });
  const used = blocks.map((block) => block.id);
  assert.equal(used[0], "x");
  assert.equal(new Set(used).size, 4);
  assert.deepEqual(validateBlocks(blocks), []);
});

test("quotes with several paragraphs become several quotes; marks become markup", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "blockquote", attrs: { blockId: "q" }, content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }, { type: "paragraph", content: [{ type: "text", text: "second" }] }] },
      {
        type: "paragraph",
        attrs: { blockId: "p" },
        content: [
          { type: "text", text: "a " },
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: " and ", marks: [] },
          { type: "text", text: "site", marks: [{ type: "link", attrs: { href: "https://x.org/a (b)" } }] },
          { type: "text", text: " bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
        ],
      },
    ],
  };
  const blocks = docToBlocks(doc, { makeId: ids });
  assert.equal(blocks[0].text, "first");
  assert.equal(blocks[1].type, "quote");
  assert.equal(blocks[1].text, "second");
  assert.equal(blocks[2].text, "a **bold** and [site](https://x.org/a%20%28b%29) bad");
});

test("lists deeper than three levels and sections inside sections are flattened, not lost", () => {
  const item = (text, nested) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...(nested ? [nested] : [])] });
  const list = (...items) => ({ type: "bulletList", content: items });
  const doc = { type: "doc", content: [{ ...list(item("1", list(item("2", list(item("3", list(item("4")))))))), attrs: { blockId: "l" } }] };
  const [block] = docToBlocks(doc);
  assert.deepEqual(block.items, [{ text: "1", list: { ordered: false, items: [{ text: "2", list: { ordered: false, items: ["3", "4"] } }] } }]);
  assert.deepEqual(validateBlocks([block]), []);
  const inner = { type: "details", attrs: { blockId: "in" }, content: [{ type: "detailsSummary", content: [{ type: "text", text: "Inner" }] }, { type: "detailsContent", content: [{ type: "paragraph", content: [{ type: "text", text: "deep" }] }] }] };
  const outer = { type: "details", attrs: { blockId: "out" }, content: [{ type: "detailsSummary", content: [{ type: "text", text: "Outer" }] }, { type: "detailsContent", content: [inner] }] };
  const [section] = docToBlocks({ type: "doc", content: [outer] }, { makeId: ids });
  assert.deepEqual(section.blocks.map((b) => b.text), ["Inner", "deep"]);
  assert.deepEqual(validateBlocks([section]), []);
});

test("an unknown stored block is kept as it is", () => {
  const blocks = [{ id: "t", type: "table", rows: [[1, 2]] }, { id: "p", type: "paragraph", text: "x" }];
  assert.deepEqual(docToBlocks(blocksToDoc(blocks)), blocks);
});
