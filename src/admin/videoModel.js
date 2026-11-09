/**
 * YouTube video information -> the item form (no React; unit-tested).
 *
 * Nothing is invented: every value comes from YouTube's answer, only cleaned
 * to fit the site's rules (tags longer than 40 characters, with commas or
 * repeated are skipped; at most 20 tags; the card description is the first
 * paragraph of the video's description, cut at a word if it is long).
 *
 * New item: empty fields are filled at once. Existing item ("Refresh video
 * information"): reviewChanges() lists what YouTube says now; a field the
 * admin changed by hand (it differs from what was fetched last time) is
 * listed but not ticked, so it is only replaced if the admin chooses to.
 * Personal notes (the text blocks) are never touched.
 */
import { LIMITS, parseTags } from "./editorModel.js";

const CARD_DESCRIPTION_MAX = 280;
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Tags that fit the site's rules (in YouTube's order). */
export function cleanTags(tags) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!tag || tag.length > LIMITS.tag || /[,،\u0000-\u001F\u007F]/.test(tag)) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === LIMITS.tags) break;
  }
  return out;
}

/** The card description: the first paragraph, on one line, at most 280 characters. */
export function cardDescription(description) {
  const first = String(description ?? "")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!first) return "";
  if (first.length <= CARD_DESCRIPTION_MAX) return first;
  const cut = first.slice(0, CARD_DESCRIPTION_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 120 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** What is stored as the item's videoInfo (admin only). */
export function infoFromVideo(video, fetchedAt = new Date().toISOString()) {
  return {
    source: video.source,
    fetchedAt,
    videoId: video.videoId,
    title: video.title ?? "",
    description: video.description ?? "",
    tags: cleanTags(video.tags),
    channelTitle: video.channelTitle ?? null,
    channelUrl: video.channelUrl ?? null,
    thumbnailUrl: video.thumbnailUrl ?? null,
    publishedAt: video.publishedAt ?? null,
  };
}

const sameLink = (a, b) => a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/**
 * The changes YouTube's answer proposes for this form, each with whether it
 * is ticked by default: [{ field, label, current, incoming, edited, apply }].
 */
export function reviewChanges(form, video, previous = form.videoInfo) {
  const changes = [];
  const add = (field, label, current, incoming, lastFetched) => {
    if (!incoming || incoming === current) return;
    const edited = current.trim() !== "" && (lastFetched === undefined ? true : current !== lastFetched);
    changes.push({ field, label, current, incoming, edited, apply: !edited });
  };
  add("title", "Title", form.title, (video.title ?? "").trim(), previous ? previous.title : undefined);
  add("description", "Description (card)", form.description, cardDescription(video.description), previous ? cardDescription(previous.description) : undefined);
  add("videoDescription", "Video description", form.videoDescription, (video.description ?? "").trim(), previous ? previous.description : undefined);

  const current = parseTags(form.tags);
  const lower = new Set(current.map((tag) => tag.toLocaleLowerCase()));
  const added = cleanTags(video.tags).filter((tag) => !lower.has(tag.toLocaleLowerCase()));
  if (added.length) {
    const merged = [...current, ...added].slice(0, LIMITS.tags);
    changes.push({ field: "tags", label: "Tags (added to yours)", current: current.join(", "), incoming: merged.join(", "), edited: false, apply: true });
  }
  if (video.channelUrl && !form.links.some((link) => sameLink(link.url, video.channelUrl))) {
    const label = video.channelTitle ? `${video.channelTitle} on YouTube` : "Channel on YouTube";
    changes.push({ field: "channel", label: "Channel link", current: "", incoming: `${label} · ${video.channelUrl}`, edited: false, apply: true, link: { label, url: video.channelUrl } });
  }
  return changes;
}

/**
 * The form with the chosen changes applied, and the new videoInfo.
 * `rowKey` makes keys for new link rows.
 */
export function applyChanges(form, video, changes, rowKey, fetchedAt) {
  const next = { ...form, videoInfo: infoFromVideo(video, fetchedAt) };
  for (const change of changes) {
    if (!change.apply) continue;
    if (change.field === "channel") next.links = [...next.links, { key: rowKey(), ...change.link }];
    else next[change.field] = change.incoming;
  }
  return next;
}

/** For a new item: fill what is empty (and pick Arabic for an Arabic title). */
export function fillNewItem(form, video, rowKey, { languageTouched = false } = {}) {
  const changes = reviewChanges(form, video, null).map((change) => ({ ...change, apply: change.field === "tags" || change.field === "channel" || change.current.trim() === "" }));
  const next = applyChanges(form, video, changes, rowKey);
  const arabic = !languageTouched && form.language !== "ar" && ARABIC.test(video.title ?? "");
  if (arabic) next.language = "ar";
  return { form: next, filled: changes.filter((change) => change.apply).map((change) => change.field), arabic };
}
