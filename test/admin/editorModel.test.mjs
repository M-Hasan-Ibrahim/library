// Unit tests for the inline editor's data model (src/admin/editorModel.js).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  blockProblems,
  changedFields,
  checkForm,
  collectBlockIds,
  convertBlock,
  createPayload,
  emptyBlock,
  emptyForm,
  formBlockProblems,
  formFromItem,
  fromEditorBlock,
  isDirty,
  newBlockId,
  payloadFromForm,
  parseTags,
  previewItem,
  reviveForm,
  sameJson,
  splitServerProblems,
  toEditorBlock,
  wrapText,
} from "../../src/admin/editorModel.js";

const root = new URL("../../src/content/", import.meta.url);
const items = JSON.parse(readFileSync(new URL("items.json", root), "utf8"));
const withBlocks = (item) => {
  try {
    return { ...item, blocks: JSON.parse(readFileSync(new URL(`bodies/${item.slug}.json`, root), "utf8")).blocks };
  } catch {
    return { ...item, blocks: [] };
  }
};

test("every existing item converts to a form and back unchanged", () => {
  assert.equal(items.length, 13);
  for (const item of items.map(withBlocks)) {
    const form = formFromItem(item);
    const payload = payloadFromForm(form);
    assert.deepEqual(payload.blocks, item.blocks, item.slug);
    assert.deepEqual(payload.tags, item.tags ?? [], item.slug);
    assert.deepEqual(payload.links, item.links ?? [], item.slug);
    assert.equal(payload.title, item.title);
    assert.equal(payload.description, item.description);
    assert.deepEqual(changedFields(form, formFromItem(item)), {}, item.slug);
    assert.equal(isDirty(form, formFromItem(item)), false);
    assert.equal(checkForm(form), null, item.slug);
  }
});

test("changedFields lists only what was edited", () => {
  const item = withBlocks(items.find((entry) => entry.slug === "fermi-problems"));
  const base = formFromItem(item);
  const form = { ...base, title: "  New title  ", tags: `${base.tags}, extra` };
  assert.deepEqual(Object.keys(changedFields(form, base)).sort(), ["tags", "title"]);
  assert.equal(changedFields(form, base).title, "New title");
  const blocks = base.blocks.map((block, i) => (i === 0 ? { ...block, text: `${block.text}!` } : block));
  assert.deepEqual(Object.keys(changedFields({ ...base, blocks }, base)), ["blocks"]);
});

test("tags, links and page counts are read like the server expects", () => {
  assert.deepEqual(parseTags(" physics, light ،ضوء\nwater,, "), ["physics", "light", "ضوء", "water"]);
  const form = { ...emptyForm("pdf"), links: [{ key: "a", label: " Docs ", url: " https://x.org " }, { key: "b", label: " ", url: "" }], pageCount: " 12 " };
  const payload = payloadFromForm(form);
  assert.deepEqual(payload.links, [{ label: "Docs", url: "https://x.org" }]);
  assert.equal(payload.pageCount, 12);
  assert.equal(payloadFromForm({ ...form, pageCount: "" }).pageCount, null);
  assert.equal(payloadFromForm({ ...form, pageCount: "12a" }).pageCount, "12a"); // rejected by validation
  assert.equal(Object.hasOwn(payloadFromForm(emptyForm("article")), "fileUrl"), false);
});

test("blocks: lists drop empty items, code drops an empty language, unknown blocks are kept", () => {
  const list = toEditorBlock({ id: "l1", type: "list", ordered: false, items: ["a", "b"] });
  assert.deepEqual(fromEditorBlock({ ...list, items: ["a", " ", "b", ""] }), { id: "l1", type: "list", ordered: false, items: ["a", "b"] });
  assert.deepEqual(fromEditorBlock(toEditorBlock({ id: "l2", type: "list", items: ["x"] })), { id: "l2", type: "list", items: ["x"] });
  const code = toEditorBlock({ id: "c1", type: "code", language: "js", text: "x()" });
  assert.deepEqual(fromEditorBlock({ ...code, language: "  " }), { id: "c1", type: "code", text: "x()" });
  const future = { id: "f1", type: "table", rows: [[1]] };
  assert.equal(fromEditorBlock(toEditorBlock(future)), future);
});

test("convertBlock keeps the id and text; sections are never converted away", () => {
  let n = 0;
  const makeId = () => `n${(n += 1)}`;
  const paragraph = { id: "p1", type: "paragraph", text: "one\ntwo" };
  assert.deepEqual(convertBlock(paragraph, "heading-3", makeId), { id: "p1", type: "heading", level: 3, text: "one two" });
  assert.deepEqual(convertBlock(paragraph, "list-numbered", makeId).items, ["one", "two"]);
  const list = toEditorBlock({ id: "l1", type: "list", ordered: false, items: ["a", "b"] });
  assert.deepEqual(convertBlock(list, "paragraph", makeId), { id: "l1", type: "paragraph", text: "a\nb" });
  const section = convertBlock(paragraph, "details", makeId);
  assert.equal(section.id, "p1");
  assert.deepEqual(section.blocks, [{ id: "n1", type: "paragraph", text: "one\ntwo" }]);
  assert.equal(convertBlock(section, "paragraph", makeId), section);
});

test("new block ids are unique across nested sections", () => {
  const blocks = [{ id: "b00000", type: "paragraph", text: "x" }, { id: "d", type: "details", summary: "s", blocks: [{ id: "b00001", type: "paragraph", text: "y" }] }];
  const values = [0.5, 1.5, 2.5].map((n) => n / 36 ** 5); // ids b00000 (used), b00001 (used), b00002
  let call = 0;
  const id = newBlockId(blocks, () => values[call++]);
  assert.equal(id, "b00002");
  assert.deepEqual([...collectBlockIds(blocks)], ["b00000", "d", "b00001"]);
  assert.equal(emptyBlock("details", () => "z").blocks[0].type, "paragraph");
});

test("wrapText formats the selection and selects the right part", () => {
  assert.deepEqual(wrapText("make it bold", 8, 12, "bold"), { value: "make it **bold**", start: 10, end: 14 });
  assert.deepEqual(wrapText("x", 1, 1, "italic"), { value: "x*italic text*", start: 2, end: 13 });
  assert.deepEqual(wrapText("run ls", 4, 6, "code"), { value: "run `ls`", start: 5, end: 7 });
  const link = wrapText("see docs", 4, 8, "link");
  assert.equal(link.value, "see [docs](https://)");
  assert.equal(link.value.slice(link.start, link.end), "https://");
  const empty = wrapText("", 0, 0, "link");
  assert.equal(empty.value.slice(empty.start, empty.end), "link text");
});

test("checkForm reports the server's own problems before anything is sent", () => {
  const article = emptyForm("article", { categoryId: "cat_science" });
  assert.deepEqual(Object.keys(checkForm(article)).sort(), ["blocks", "title"]);
  const unsafe = { ...article, title: "T", blocks: [{ id: "b1", type: "paragraph", text: "[x](javascript:alert(1))" }] };
  assert.match(checkForm(unsafe).blocks, /must be http\(s\), mailto or #\//);
  assert.deepEqual(Object.keys(checkForm({ ...article, title: "T", blocks: [] })), ["blocks"]);
  const pdf = { ...emptyForm("pdf", { categoryId: "cat_science" }), title: "P", fileUrl: "notes.pdf" };
  assert.deepEqual(Object.keys(checkForm(pdf)), ["fileUrl"]);
  assert.equal(checkForm({ ...pdf, fileUrl: "documents/notes.pdf" }), null);
  const video = { ...emptyForm("youtube", { categoryId: "cat_science" }), title: "V", videoUrl: "https://example.com" };
  assert.deepEqual(Object.keys(checkForm(video)), ["videoUrl"]);
  assert.match(checkForm({ ...video, videoUrl: "https://youtu.be/aircAruvnKk", tags: "a, a" }).tags, /appears twice/);
  assert.match(checkForm({ ...video, videoUrl: "aircAruvnKk", title: "x".repeat(201) }).title, /at most 200/);
  assert.deepEqual(Object.keys(checkForm({ ...video, videoUrl: "aircAruvnKk", slug: "Bad Slug" })), ["slug"]);
});

test("block problems are mapped to the blocks they concern", () => {
  const form = {
    ...emptyForm("article"),
    blocks: [
      { id: "a", type: "paragraph", text: "" },
      { id: "d", type: "details", summary: "S", blocks: [{ id: "n", type: "list", ordered: false, keepOrdered: true, items: ["ok", "[x](ftp://y)"] }] },
    ],
  };
  const { byId, general } = formBlockProblems(form);
  assert.deepEqual(byId.get("a"), ["Text must not be empty"]);
  assert.match(byId.get("n")[0], /^Item 2: link "ftp:\/\/y" must be/);
  assert.deepEqual(general, []);
  assert.deepEqual(blockProblems(["blocks[9].text: must not be empty", "blocks: at most 500 blocks in total"], form.blocks).general.length, 2);
  assert.deepEqual(splitServerProblems("blocks[0].text: a; b; blocks[1].id: c (+2 more)"), ["blocks[0].text: a; b", "blocks[1].id: c"]);
});

test("restored forms are checked before use", () => {
  const form = formFromItem(withBlocks(items[0]));
  const revived = reviveForm(JSON.parse(JSON.stringify(form)), form.type);
  assert.deepEqual(payloadFromForm(revived), payloadFromForm(form));
  assert.equal(reviveForm({ ...form, title: 5 }, form.type), null);
  assert.equal(reviveForm(form, "pdf"), null);
  assert.equal(reviveForm({ ...form, blocks: [{ id: "x", type: "list", items: "nope" }] }, form.type), null);
  assert.equal(reviveForm(null, form.type), null);
});

test("new items: address counts as a change; payload carries type and optional slug", () => {
  const base = emptyForm("link", { categoryId: "cat_other" });
  assert.equal(isDirty(base, base), false);
  assert.equal(isDirty({ ...base, slug: "x" }, base), true);
  assert.equal(createPayload({ ...base, title: "L", url: "https://x.org" }).slug, undefined);
  assert.equal(createPayload({ ...base, slug: " my-link " }).slug, "my-link");
  assert.equal(createPayload(base).type, "link");
});

test("preview: reading time for articles, stored identity kept", () => {
  const form = { ...emptyForm("article"), title: "T", blocks: [{ id: "a", type: "paragraph", text: "word ".repeat(450) }] };
  const preview = previewItem(form, { id: "itm_x", slug: "kept", updatedAt: "2026-01-01" });
  assert.equal(preview.readingMinutes, 3);
  assert.equal(preview.slug, "kept");
  assert.equal(preview.id, "itm_x");
  assert.equal(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameJson({ a: 1 }, { a: 1, b: undefined }), false);
});
