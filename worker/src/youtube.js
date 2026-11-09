/**
 * YouTube video information for the admin editor:
 *
 *   GET /api/admin/youtube/<videoId>    admin only (admin.js)
 *   -> { video: { videoId, source, title, description, tags, channelTitle,
 *                 channelId, channelUrl, thumbnailUrl, publishedAt, language,
 *                 missing: [...] } }
 *
 * With the YOUTUBE_API_KEY secret: the official YouTube Data API v3
 * (videos.list, part=snippet: 1 quota unit per lookup; the free daily quota
 * is 10,000 units). The key stays in the Worker; the browser never sees it.
 * Without the key: YouTube's public oEmbed endpoint, which only gives the
 * title, channel and thumbnail; description and tags are then reported in
 * `missing`, never guessed.
 *
 * Abuse protection: the route is behind Cloudflare Access + token checks
 * (admin only), video ids must be exactly 11 characters [A-Za-z0-9_-],
 * answers are cached for an hour (repeat lookups cost no quota), and each
 * Worker instance allows at most RATE_LIMIT lookups per minute.
 */
import { HttpError } from "./httpError.js";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DATA_API = "https://www.googleapis.com/youtube/v3/videos";
const OEMBED = "https://www.youtube.com/oembed";
const FIELDS = "items(id,snippet(title,description,tags,channelId,channelTitle,thumbnails,publishedAt,defaultLanguage,defaultAudioLanguage))";
const CACHE_SECONDS = 3600;
const TIMEOUT_MS = 8000;
export const RATE_LIMIT = 60; // lookups per minute per Worker instance
const recent = [];

export const isVideoId = (value) => typeof value === "string" && VIDEO_ID.test(value);

/** For tests: forget the rate-limit window. */
export const resetYouTubeRateLimit = () => recent.splice(0);

function takeSlot(now) {
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  return true;
}

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const httpsUrl = (value, pattern) => (typeof value === "string" && pattern.test(value) ? value : null);

function bestThumbnail(thumbnails) {
  for (const size of ["maxres", "standard", "high", "medium", "default"]) {
    const url = httpsUrl(thumbnails?.[size]?.url, /^https:\/\/[a-z0-9.-]*ytimg\.com\//);
    if (url) return url;
  }
  return null;
}

async function fetchJson(fetchImpl, url, init = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new HttpError(502, { error: "YouTube could not be reached. Try again in a moment.", code: "youtube_unreachable" });
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}

const notFound = () =>
  new HttpError(404, {
    error: "YouTube has no public video with this id (it may be private, deleted or mistyped).",
    code: "video_not_found",
  });

async function fromDataApi(videoId, key, fetchImpl) {
  const url = `${DATA_API}?part=snippet&id=${videoId}&fields=${encodeURIComponent(FIELDS)}&key=${encodeURIComponent(key)}`;
  const { response, data } = await fetchJson(fetchImpl, url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason ?? data?.error?.status ?? `HTTP ${response.status}`;
    // The reason is safe to log; the key is never logged.
    console.error(`YouTube Data API refused the lookup: ${reason}`);
    if (/quota/i.test(reason)) {
      throw new HttpError(503, { error: "The YouTube daily quota is used up. Try again after midnight (Pacific time).", code: "youtube_quota" });
    }
    throw new HttpError(502, { error: "The YouTube API key was refused. Check the Google Cloud setup.", code: "youtube_config" });
  }
  const item = Array.isArray(data?.items) ? data.items.find((entry) => entry?.id === videoId) : null;
  if (!item?.snippet) throw notFound();
  const s = item.snippet;
  const tags = Array.isArray(s.tags) ? s.tags.filter((tag) => typeof tag === "string" && tag.trim() !== "").map((tag) => tag.trim().slice(0, 100)).slice(0, 60) : [];
  const description = text(s.description, 5000).trim();
  const channelId = /^[A-Za-z0-9_-]{10,40}$/.test(s.channelId ?? "") ? s.channelId : null;
  const missing = [];
  if (!description) missing.push("description");
  if (tags.length === 0) missing.push("tags");
  return {
    videoId,
    source: "youtube-api",
    title: text(s.title, 200).trim(),
    description,
    tags,
    channelTitle: text(s.channelTitle, 200).trim() || null,
    channelId,
    channelUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : null,
    thumbnailUrl: bestThumbnail(s.thumbnails),
    publishedAt: text(s.publishedAt, 40) || null,
    language: text(s.defaultLanguage || s.defaultAudioLanguage, 20) || null,
    missing,
  };
}

async function fromOEmbed(videoId, fetchImpl) {
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  const { response, data } = await fetchJson(fetchImpl, `${OEMBED}?url=${encodeURIComponent(target)}&format=json`);
  if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 400) throw notFound();
  if (!response.ok || !data) throw new HttpError(502, { error: "YouTube did not answer as expected. Try again in a moment.", code: "youtube_unreachable" });
  return {
    videoId,
    source: "youtube-oembed",
    title: text(data.title, 200).trim(),
    description: "",
    tags: [],
    channelTitle: text(data.author_name, 200).trim() || null,
    channelId: null,
    channelUrl: httpsUrl(data.author_url, /^https:\/\/(www\.)?youtube\.com\/[^\s]+$/),
    thumbnailUrl: httpsUrl(data.thumbnail_url, /^https:\/\/[a-z0-9.-]*ytimg\.com\//),
    publishedAt: null,
    language: null,
    // Without the Data API key, YouTube does not provide these.
    missing: ["description", "tags"],
  };
}

/** Video information for `videoId` (throws HttpError). */
export async function youtubeInfo(videoId, env, { fetch: fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
  if (!isVideoId(videoId)) throw new HttpError(400, { error: "This is not a YouTube video id", code: "invalid_video" });
  const key = String(env.YOUTUBE_API_KEY ?? "").trim();
  const cache = typeof caches !== "undefined" ? caches.default : null;
  // A key on the API's own host (only a cache key: no route serves it).
  const origin = String(env.PUBLIC_API_URL ?? "https://api.library.mh-ibrahim.com").replace(/\/+$/, "");
  const cacheKey = new Request(`${origin}/__cache/youtube/v1/${key ? "api" : "oembed"}/${videoId}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }
  if (!takeSlot(now())) throw new HttpError(429, { error: "Too many video lookups. Wait a minute and try again.", code: "rate_limited" });

  const video = key ? await fromDataApi(videoId, key, fetchImpl) : await fromOEmbed(videoId, fetchImpl);
  const body = { video };
  if (cache) {
    await cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` } }));
  }
  return body;
}
