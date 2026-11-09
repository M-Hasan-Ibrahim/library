import { useContext } from "react";
import { formatDate } from "../lib/format.js";
import { parseYouTubeUrl, youTubeWatchUrl } from "../lib/youtube.js";
import { API_URL } from "../services/apiConfig.js";
import { FileAccessContext } from "./fileAccess.js";
import LinkPreview from "./LinkPreview.jsx";
import PdfViewer from "./PdfViewer.jsx";
import RelatedLinks from "./RelatedLinks.jsx";
import RichText from "./RichText.jsx";
import { EmptyState } from "./StatusMessage.jsx";
import VideoDescription from "./VideoDescription.jsx";
import YouTubeEmbed from "./YouTubeEmbed.jsx";

// PDFs uploaded to the API live on another host, where the browser ignores
// the download attribute; the API sends them as a download when asked.
const downloadHref = (fileUrl) => (API_URL && fileUrl?.startsWith(`${API_URL}/files/`) ? `${fileUrl}?download=1` : fileUrl);

/** Where the reading view reads and downloads an item's file (see fileAccess.js). */
function useFileLinks(fileUrl) {
  const resolve = useContext(FileAccessContext);
  return resolve?.(fileUrl) ?? { url: fileUrl, downloadUrl: downloadHref(fileUrl), withCredentials: false };
}

export const ITEM_TITLE_ID = "item-panel-title";

/**
 * The single reading layout for every content type:
 *   header (category · date, title, description, one small action)
 *   -> main content for the type (PDF pages, video, link)
 *   -> optional text blocks -> optional related links.
 * Each section is its own element so a future admin mode can attach edit
 * controls to it without restructuring the view.
 */
export default function ItemView({ item }) {
  const file = useFileLinks(item.fileUrl);
  return (
    <article className="reader" dir={item.dir} lang={item.language}>
      <header className="reader__header">
        <div className="reader__topline">
          <p className="eyebrow reader__meta">
            {/* One left-to-right run, so Arabic items don't reorder the date. */}
            <span dir="ltr">
              {item.category.name}
              <span aria-hidden="true"> · </span>
              <time dateTime={item.addedAt}>{formatDate(item.addedAt)}</time>
            </span>
          </p>
          <HeaderAction downloadUrl={file.downloadUrl} item={item} />
        </div>
        <h2 className="reader__title" id={ITEM_TITLE_ID}>
          {item.title}
        </h2>
        {item.description && <p className="lede">{item.description}</p>}
      </header>

      {item.type === "pdf" && <PdfViewer key={file.url} title={item.title} url={file.url} withCredentials={file.withCredentials} />}
      {item.type === "youtube" && <YouTubeEmbed title={item.title} url={item.videoUrl} />}
      {item.type === "youtube" && item.videoDescription && <VideoDescription text={item.videoDescription} />}
      {item.type === "link" && <LinkPreview url={item.url} />}

      {item.blocks.length > 0 ? (
        <RichText blocks={item.blocks} />
      ) : (
        item.type === "article" && <EmptyState title="This article has no text yet." />
      )}

      {item.links?.length > 0 && <RelatedLinks links={item.links} />}
    </article>
  );
}

/** The only visible difference between types in the header: one small, discreet action. */
function HeaderAction({ item, downloadUrl }) {
  if (item.type === "pdf") {
    return (
      <a className="button button--small" download href={downloadUrl}>
        Download
      </a>
    );
  }

  if (item.type === "youtube") {
    const video = parseYouTubeUrl(item.videoUrl);
    if (!video) return null;
    return (
      <a className="button button--small" href={youTubeWatchUrl(video)} rel="noreferrer" target="_blank">
        YouTube <span aria-hidden="true">↗</span>
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    );
  }

  return null;
}
