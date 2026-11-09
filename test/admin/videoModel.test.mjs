// YouTube information -> the item form (src/admin/videoModel.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyForm, formFromItem } from "../../src/admin/editorModel.js";
import { applyChanges, cardDescription, cleanTags, fillNewItem, infoFromVideo, reviewChanges } from "../../src/admin/videoModel.js";

let n = 0;
const rowKey = () => `k${(n += 1)}`;
const VIDEO = {
  videoId: "aircAruvnKk",
  source: "youtube-api",
  title: "But what is a neural network?",
  description: "What are the neurons?\nWhy layers?\n\nSupport: https://patreon.com/x",
  tags: ["neural networks", "Neural Networks", "a, b", "x".repeat(41), "  deep   learning "],
  channelTitle: "3Blue1Brown",
  channelUrl: "https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw",
  thumbnailUrl: "https://i.ytimg.com/vi/aircAruvnKk/hqdefault.jpg",
  missing: [],
};

test("tags are cleaned to the site's rules, never changed", () => {
  assert.deepEqual(cleanTags(VIDEO.tags), ["neural networks", "deep learning"]);
  assert.equal(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20);
  assert.deepEqual(cleanTags(undefined), []);
});

test("the card description is the first paragraph, on one line, cut at a word", () => {
  assert.equal(cardDescription(VIDEO.description), "What are the neurons? Why layers?");
  assert.equal(cardDescription(""), "");
  const long = cardDescription(`${"word ".repeat(100)}\n\nmore`);
  assert.ok(long.length <= 280 && long.endsWith("…") && !long.includes("  "));
});

test("a new item is filled where empty; Arabic titles choose Arabic", () => {
  const { form, filled, arabic } = fillNewItem(emptyForm("youtube"), VIDEO, rowKey);
  assert.equal(form.title, VIDEO.title);
  assert.equal(form.description, "What are the neurons? Why layers?");
  assert.equal(form.videoDescription, VIDEO.description);
  assert.equal(form.tags, "neural networks, deep learning");
  assert.deepEqual(form.links.map(({ label, url }) => ({ label, url })), [{ label: "3Blue1Brown on YouTube", url: VIDEO.channelUrl }]);
  assert.equal(form.videoInfo.videoId, "aircAruvnKk");
  assert.deepEqual(filled.sort(), ["channel", "description", "tags", "title", "videoDescription"]);
  assert.equal(arabic, false);
  const typed = fillNewItem({ ...emptyForm("youtube"), title: "My own title" }, VIDEO, rowKey);
  assert.equal(typed.form.title, "My own title", "what the admin typed is kept");
  const ar = fillNewItem(emptyForm("youtube"), { ...VIDEO, title: "كيف يعمل الدماغ؟" }, rowKey);
  assert.equal(ar.form.language, "ar");
  assert.equal(fillNewItem(emptyForm("youtube"), { ...VIDEO, title: "كيف" }, rowKey, { languageTouched: true }).form.language, "en");
});

test("nothing is invented: missing description and tags leave the fields as they are", () => {
  const { form } = fillNewItem({ ...emptyForm("youtube"), description: "kept" }, { ...VIDEO, description: "", tags: [], channelUrl: null }, rowKey);
  assert.equal(form.description, "kept");
  assert.equal(form.videoDescription, "");
  assert.equal(form.tags, "");
  assert.equal(form.links.length, 0);
});

test("refresh: fields changed by hand are listed but not ticked; unchanged ones are", () => {
  const saved = fillNewItem(emptyForm("youtube"), VIDEO, rowKey).form;
  const edited = { ...saved, title: "My better title" };
  const newer = { ...VIDEO, title: "Neural networks, chapter 1", description: "New description.", tags: ["ai"] };
  const changes = reviewChanges(edited, newer);
  const byField = Object.fromEntries(changes.map((change) => [change.field, change]));
  assert.equal(byField.title.edited, true);
  assert.equal(byField.title.apply, false);
  assert.equal(byField.description.apply, true, "the card description was not changed by hand");
  assert.equal(byField.videoDescription.apply, true);
  assert.equal(byField.tags.incoming, "neural networks, deep learning, ai");
  assert.equal(byField.channel, undefined, "the channel link is already there");
  const applied = applyChanges(edited, newer, changes, rowKey, "2026-11-08T12:00:00.000Z");
  assert.equal(applied.title, "My better title");
  assert.equal(applied.videoDescription, "New description.");
  assert.equal(applied.videoInfo.fetchedAt, "2026-11-08T12:00:00.000Z");
  assert.deepEqual(applied.blocks, edited.blocks, "notes are never touched");
});

test("refresh of an item saved before video information existed: filled fields count as the admin's", () => {
  const old = formFromItem({ type: "youtube", slug: "x", title: "Old title", description: "", tags: [], links: [], blocks: [], videoUrl: "aircAruvnKk" });
  const changes = reviewChanges(old, VIDEO);
  assert.equal(changes.find((c) => c.field === "title").apply, false);
  assert.equal(changes.find((c) => c.field === "description").apply, true);
  assert.equal(infoFromVideo(VIDEO, "t").tags.length, 2);
});
