/**
 * YouTube URL helpers. Videos stay hosted on YouTube; we only build embed URLs.
 *
 * Accepted inputs:
 *   https://www.youtube.com/watch?v=ID   (also m., music., and extra params)
 *   https://youtu.be/ID
 *   https://www.youtube.com/embed/ID      (also youtube-nocookie.com)
 *   https://www.youtube.com/shorts/ID
 *   https://www.youtube.com/live/ID
 *   ID                                    (a bare 11-character video ID)
 * A start time is read from `t` or `start` ("90", "90s", "1m30s", "1h2m3s").
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export const isValidVideoId = (value) => typeof value === "string" && VIDEO_ID.test(value);

/** "90" | "90s" | "1m30s" | "1h2m3s" -> seconds, or 0 when absent/invalid. */
export function parseStartTime(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || match[0] === "") return 0;
  const [, hours = 0, minutes = 0, seconds = 0] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * @param {string} input  A YouTube URL or a bare video ID.
 * @returns {{ id: string, start: number, isShort: boolean } | null}  null when not a valid YouTube video.
 */
export function parseYouTubeUrl(input) {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (isValidVideoId(value)) return { id: value, start: 0, isShort: false };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  let id = null;
  let isShort = false;

  if (host === "youtu.be") {
    id = segments[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments[0] === "watch") {
      id = url.searchParams.get("v");
    } else if (["embed", "shorts", "live", "v"].includes(segments[0])) {
      id = segments[1] ?? null;
      isShort = segments[0] === "shorts";
    }
  }

  if (!isValidVideoId(id)) return null;
  const start = parseStartTime(url.searchParams.get("t") ?? url.searchParams.get("start"));
  return { id, start, isShort };
}

/** Privacy-enhanced embed URL (no cookies until the visitor plays the video). */
export function youTubeEmbedUrl({ id, start }) {
  const params = new URLSearchParams({ rel: "0" });
  if (start > 0) params.set("start", String(start));
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}

export function youTubeWatchUrl({ id, start }) {
  return `https://www.youtube.com/watch?v=${id}${start > 0 ? `&t=${start}s` : ""}`;
}
