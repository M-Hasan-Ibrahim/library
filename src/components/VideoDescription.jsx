/**
 * A video's original description (as published on YouTube), collapsed by
 * default under the player. Plain text: line breaks are kept, web addresses
 * become links, nothing else is interpreted (never rendered as HTML).
 */
const WEB_ADDRESS = /https?:\/\/[^\s<>"]+/g;

/** Trailing punctuation is not part of an address ("…see https://x.org." ). */
function trimAddress(raw) {
  let url = raw.replace(/[.,;:!?'"]+$/, "");
  while (url.endsWith(")") && (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length) url = url.slice(0, -1);
  return url;
}

function withLinks(text) {
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(WEB_ADDRESS)) {
    const url = trimAddress(match[0]);
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(
      <a dir="ltr" href={url} key={match.index} rel="noreferrer" target="_blank">
        {url}
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>,
    );
    cursor = match.index + url.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export default function VideoDescription({ text }) {
  return (
    <details className="video-description">
      <summary lang="en">Video description</summary>
      <div className="video-description__text" dir="auto">
        {withLinks(text)}
      </div>
    </details>
  );
}
