import { parseYouTubeUrl, youTubeEmbedUrl } from "../lib/youtube.js";
import { ErrorState } from "./StatusMessage.jsx";

/**
 * Responsive YouTube player. The video stays on YouTube (privacy-enhanced
 * youtube-nocookie.com embed); videos whose owners disable embedding show
 * YouTube's own message, and the header link opens them on YouTube instead.
 */
export default function YouTubeEmbed({ url, title }) {
  const video = parseYouTubeUrl(url);

  if (!video) {
    return <ErrorState message="The video address is not a valid YouTube link." title="This video cannot be shown." />;
  }

  return (
    <div className={`video-frame${video.isShort ? " video-frame--vertical" : ""}`}>
      <iframe
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        src={youTubeEmbedUrl(video)}
        title={`YouTube video: ${title}`}
      />
    </div>
  );
}
