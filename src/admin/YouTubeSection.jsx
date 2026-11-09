import { useEffect, useRef, useState } from "react";
import { parseYouTubeUrl } from "../lib/youtube.js";
import { describeError } from "./api.js";
import { adminApi } from "./client.js";
import { newRowKey } from "./editorModel.js";
import { RefreshIcon } from "./icons.jsx";
import { AutoTextarea, ErrorNotice } from "./ui.jsx";
import { applyChanges, fillNewItem, infoFromVideo, reviewChanges } from "./videoModel.js";

/**
 * The video part of the editor: the YouTube address, the information
 * fetched from YouTube (automatically for a new item; "Refresh video
 * information" for an existing one, with a review so nothing changed by hand
 * is replaced without asking), and the original video description.
 */
export default function YouTubeSection({ kind, form, onForm, errors, ids, languageTouched }) {
  const [lookup, setLookup] = useState({ status: "idle" });
  const [review, setReview] = useState(null); // { video, changes }
  const lastFetched = useRef(form.videoInfo?.videoId ?? null);
  const parsed = parseYouTubeUrl(form.videoUrl.trim());
  const shown = lookup.video ?? form.videoInfo;

  const fetchInfo = async (automatic) => {
    if (!parsed) return;
    setLookup((previous) => ({ ...previous, status: "loading", error: null }));
    setReview(null);
    try {
      const { video } = await adminApi.youtubeInfo(parsed.id);
      lastFetched.current = parsed.id;
      if (kind === "new" && automatic) {
        let filled = [];
        let arabic = false;
        onForm((current) => {
          const result = fillNewItem(current, video, newRowKey, { languageTouched });
          filled = result.filled;
          arabic = result.arabic;
          return result.form;
        });
        setLookup({ status: "ready", video, filled, arabic });
        return;
      }
      const changes = reviewChanges(form, video);
      if (changes.length === 0) {
        onForm((current) => ({ ...current, videoInfo: infoFromVideo(video) }));
        setLookup({ status: "ready", video, note: "Everything already matches YouTube." });
      } else {
        setLookup({ status: "ready", video });
        setReview({ video, changes });
      }
    } catch (error) {
      setLookup({ status: "error", error });
    }
  };

  // A new item fetches as soon as a new video address is entered.
  useEffect(() => {
    if (kind !== "new" || !parsed || parsed.id === lastFetched.current) return undefined;
    const timer = setTimeout(() => fetchInfo(true), 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, parsed?.id]);

  const toggle = (index) =>
    setReview((current) => ({ ...current, changes: current.changes.map((change, i) => (i === index ? { ...change, apply: !change.apply } : change)) }));

  const missing = lookup.video?.missing ?? [];
  const oembed = shown?.source === "youtube-oembed";

  return (
    <div className="editor-section editor-fields" lang="en">
      <div className="editor-field">
        <label className="editor-label" htmlFor={ids.videoUrl}>
          YouTube video
        </label>
        <div className="editor-inline-row" dir="ltr">
          <input
            aria-describedby={`${ids.videoUrl}-hint`}
            aria-invalid={Boolean(errors?.videoUrl) || undefined}
            className="editor-input"
            id={ids.videoUrl}
            inputMode="url"
            onChange={(event) => onForm((current) => ({ ...current, videoUrl: event.target.value }))}
            placeholder="Paste a YouTube link (watch, youtu.be, Shorts, live…)"
            spellCheck={false}
            value={form.videoUrl}
          />
          <button
            aria-disabled={!parsed || lookup.status === "loading" || undefined}
            className="button button--small"
            onClick={() => parsed && lookup.status !== "loading" && fetchInfo(kind === "new" && !form.videoInfo)}
            type="button"
          >
            <RefreshIcon />
            {kind === "new" ? "Get video information" : "Refresh video information"}
          </button>
        </div>
        <p className="editor-hint" id={`${ids.videoUrl}-hint`} role="status">
          {form.videoUrl.trim() === ""
            ? "Paste the video's address: its title, description, tags and channel are filled in for you."
            : !parsed
              ? "This is not a YouTube video link yet."
              : lookup.status === "loading"
                ? "Getting the video's information from YouTube…"
                : `Video ${parsed.id}${parsed.isShort ? " (a Short)" : ""}${parsed.start ? `, starting at ${parsed.start}s` : ""}.`}
        </p>
        {errors?.videoUrl && <p className="editor-error">YouTube video {errors.videoUrl}</p>}
      </div>

      {lookup.status === "error" && (
        <ErrorNotice error={lookup.error} onRetry={() => fetchInfo(kind === "new" && !form.videoInfo)} retryLabel="Try again">
          {lookup.error?.kind !== "session" && lookup.error?.body?.error && lookup.error.body.error !== describeError(lookup.error) && <p>{lookup.error.body.error}</p>}
        </ErrorNotice>
      )}

      {shown && (
        <div className="video-card">
          {shown.thumbnailUrl && <img alt="" className="video-card__image" loading="lazy" referrerPolicy="no-referrer" src={shown.thumbnailUrl} />}
          <div className="video-card__text">
            <strong dir="auto">{shown.title || "Untitled video"}</strong>
            {shown.channelTitle && (
              <span dir="auto">
                {shown.channelUrl ? (
                  <a href={shown.channelUrl} rel="noreferrer" target="_blank">
                    {shown.channelTitle}
                  </a>
                ) : (
                  shown.channelTitle
                )}
              </span>
            )}
            <span className="video-card__source">
              {oembed
                ? "From YouTube (title and channel only: the description and tags need the YouTube API key)."
                : "From the YouTube Data API."}
              {lookup.status === "ready" && !oembed && missing.length > 0 && ` YouTube has no ${missing.join(" or ")} for this video.`}
            </span>
            {lookup.filled?.length > 0 && <span className="video-card__note">Filled in: {lookup.filled.map((field) => FILLED[field] ?? field).join(", ")}{lookup.arabic ? "; language set to Arabic" : ""}.</span>}
            {lookup.note && <span className="video-card__note">{lookup.note}</span>}
          </div>
        </div>
      )}

      {review && (
        <div aria-label="Changes from YouTube" className="admin-notice video-review" role="group">
          <p>
            <strong>YouTube's information differs from this item.</strong> Choose what to use; fields you changed yourself are not
            ticked. Your notes are never changed.
          </p>
          <ul className="video-review__list">
            {review.changes.map((change, index) => (
              <li key={change.field}>
                <label>
                  <input checked={change.apply} onChange={() => toggle(index)} type="checkbox" />
                  <span>
                    <strong>{change.label}</strong>
                    {change.edited && <em> (you changed this)</em>}
                  </span>
                </label>
                <div className="video-review__values">
                  {change.field !== "channel" && change.field !== "tags" && (
                    <span dir="auto">
                      <b>Now:</b> {change.current.trim() ? change.current.slice(0, 240) : "—"}
                      {change.current.length > 240 ? "…" : ""}
                    </span>
                  )}
                  <span dir="auto">
                    <b>{change.field === "tags" ? "Tags:" : change.field === "channel" ? "Add:" : "YouTube:"}</b> {change.incoming.slice(0, 240)}
                    {change.incoming.length > 240 ? "…" : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="admin-notice__actions">
            <button
              className="button button--small button--primary"
              onClick={() => {
                onForm((current) => applyChanges(current, review.video, review.changes, newRowKey));
                setLookup((previous) => ({ ...previous, note: "Video information updated. Save to keep it." }));
                setReview(null);
              }}
              type="button"
            >
              Use the ticked information
            </button>
            <button
              className="button button--small"
              onClick={() => {
                onForm((current) => ({ ...current, videoInfo: infoFromVideo(review.video) }));
                setReview(null);
              }}
              type="button"
            >
              Keep everything as it is
            </button>
          </div>
        </div>
      )}

      <div className="editor-field">
        <label className="editor-label" htmlFor={ids.videoDescription}>
          Video description <span className="editor-optional">(from YouTube, editable)</span>
        </label>
        <AutoTextarea
          aria-describedby={`${ids.videoDescription}-hint`}
          aria-invalid={Boolean(errors?.videoDescription) || undefined}
          className="editor-input editor-textarea"
          dir="auto"
          id={ids.videoDescription}
          onChange={(videoDescription) => onForm((current) => ({ ...current, videoDescription }))}
          placeholder="The video's own description"
          value={form.videoDescription}
        />
        <p className="editor-hint" id={`${ids.videoDescription}-hint`}>
          Visitors see it in a collapsed “Video description” section under the video. Leave it empty to hide it.
        </p>
        {errors?.videoDescription && <p className="editor-error">Video description {errors.videoDescription}</p>}
      </div>
    </div>
  );
}

const FILLED = { title: "title", description: "description", videoDescription: "video description", tags: "tags", channel: "channel link" };
