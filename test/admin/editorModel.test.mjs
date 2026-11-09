// Unit tests for the item editor's form model (src/admin/editorModel.js).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  blockProblems,
  changedFields,
  checkForm,
  createPayload,
  emptyForm,
  formBlockProblems,
  formFromItem,
  isDirty,
  payloadFromForm,
  parseTags,
  previewItem,
  reviveForm,
  sameJson,
  splitServerProblems,
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

test("the form keeps its own copy of the blocks", () => {
  const item = withBlocks(items.find((entry) => entry.type === "article"));
  const form = formFromItem(item);
  form.blocks[0].text = "changed";
  assert.notEqual(item.blocks[0].text, "changed");
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

test("videos carry the original description and the fetched information", () => {
  const video = withBlocks(items.find((entry) => entry.type === "youtube"));
  const base = formFromItem(video);
  assert.equal(base.videoDescription, "");
  assert.equal(base.videoInfo, null);
  const payload = payloadFromForm({ ...base, videoDescription: " line 1\r\nline 2 " });
  assert.equal(payload.videoDescription, "line 1\nline 2");
  assert.equal(payload.videoInfo, null);
  assert.deepEqual(Object.keys(changedFields({ ...base, videoDescription: "x" }, base)), ["videoDescription"]);
  assert.equal("videoDescription" in payloadFromForm(emptyForm("article")), false);
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

test("checkForm reports the server's own problems before anything is sent", () => {
  const article = emptyForm("article", { categoryId: "cat_science" });
  assert.deepEqual(Object.keys(checkForm(article)).sort(), ["blocks", "title"]);
  const unsafe = { ...article, title: "T", blocks: [{ id: "b1", type: "paragraph", text: "[x](javascript:alert(1))" }] };
  assert.match(checkForm(unsafe).blocks, /must be http\(s\), mailto or #\//);
  const pdf = { ...emptyForm("pdf", { categoryId: "cat_science" }), title: "P", fileUrl: "notes.pdf" };
  assert.deepEqual(Object.keys(checkForm(pdf)), ["fileUrl"]);
  assert.equal(checkForm({ ...pdf, fileUrl: "documents/notes.pdf" }), null);
  assert.equal(checkForm({ ...pdf, fileUrl: "https://api.library.mh-ibrahim.com/files/pdf/2026/11/abcdefghijklmnop-notes.pdf" }), null);
  const local = { ...pdf, fileUrl: "http://127.0.0.1:8788/files/pdf/2026/11/abcdefghijklmnop-notes.pdf" };
  assert.deepEqual(Object.keys(checkForm(local)), ["fileUrl"], "plain http only for this API's own files");
  assert.equal(checkForm(local, { ownFiles: "http://127.0.0.1:8788/files/" }), null);
  const video = { ...emptyForm("youtube", { categoryId: "cat_science" }), title: "V", videoUrl: "https://example.com" };
  assert.deepEqual(Object.keys(checkForm(video)), ["videoUrl"]);
  assert.match(checkForm({ ...video, videoUrl: "https://youtu.be/aircAruvnKk", tags: "a, a" }).tags, /appears twice/);
  assert.match(checkForm({ ...video, videoUrl: "aircAruvnKk", videoDescription: "x".repeat(5001) }).videoDescription, /5000/);
  assert.match(checkForm({ ...video, videoUrl: "aircAruvnKk", videoInfo: { source: "elsewhere" } }).videoInfo, /source/);
  assert.deepEqual(Object.keys(checkForm({ ...video, videoUrl: "aircAruvnKk", slug: "Bad Slug" })), ["slug"]);
});

test("block problems are mapped to the blocks they concern, nested lists included", () => {
  const form = {
    ...emptyForm("article"),
    blocks: [
      { id: "a", type: "paragraph", text: "" },
      { id: "d", type: "details", summary: "S", blocks: [{ id: "n", type: "list", ordered: false, items: ["ok", "[x](ftp://y)"] }] },
      { id: "l", type: "list", ordered: true, items: [{ text: "x", list: { ordered: false, items: [""] } }] },
    ],
  };
  const { byId, general } = formBlockProblems(form);
  assert.deepEqual(byId.get("a"), ["Text must not be empty"]);
  assert.match(byId.get("n")[0], /^List item 2: link "ftp:\/\/y" must be/);
  assert.equal(byId.get("l")[0], "A nested list item must not be empty");
  assert.deepEqual(general, []);
  assert.equal(blockProblems(["blocks[9].text: must not be empty", "blocks: at most 500 blocks in total"], form.blocks).general.length, 2);
  assert.deepEqual(splitServerProblems("blocks[0].text: a; b; blocks[1].id: c (+2 more)"), ["blocks[0].text: a; b", "blocks[1].id: c"]);
});

test("restored forms are checked before use", () => {
  const form = formFromItem(withBlocks(items[0]));
  const revived = reviveForm(JSON.parse(JSON.stringify(form)), form.type);
  assert.deepEqual(payloadFromForm(revived), payloadFromForm(form));
  assert.equal(reviveForm({ ...form, title: 5 }, form.type), null);
  assert.equal(reviveForm(form, "pdf"), null);
  assert.equal(reviveForm({ ...form, blocks: [{ type: "paragraph" }] }, form.type), null);
  assert.equal(reviveForm({ ...form, blocks: "nope" }, form.type), null);
  assert.equal(reviveForm(null, form.type), null);
  const { videoDescription: _v, videoInfo: _i, ...older } = form; // saved before these fields existed
  assert.equal(reviveForm(older, form.type).videoDescription, "");
});

test("new items: address counts as a change; payload carries type and optional slug", () => {
  const base = emptyForm("link", { categoryId: "cat_other" });
  assert.equal(isDirty(base, base), false);
  assert.equal(isDirty({ ...base, slug: "x" }, base), true);
  assert.equal(createPayload({ ...base, title: "L", url: "https://x.org" }).slug, undefined);
  assert.equal(createPayload({ ...base, slug: " my-link " }).slug, "my-link");
  assert.equal(createPayload(base).type, "link");
  assert.deepEqual(emptyForm("article").blocks, []);
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
