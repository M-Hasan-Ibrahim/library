import { hostname } from "../lib/format.js";

/** The destination of an external-link item, shown as one clear, large target. */
export default function LinkPreview({ url }) {
  return (
    <a className="link-preview" dir="ltr" href={url} rel="noreferrer" target="_blank">
      <span className="link-preview__host">{hostname(url) || url}</span>
      <span className="link-preview__url">{url}</span>
      <span className="link-preview__action">
        Visit site <span aria-hidden="true">↗</span>
        <span className="visually-hidden"> (opens in a new tab)</span>
      </span>
    </a>
  );
}
