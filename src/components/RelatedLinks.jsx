import { useId } from "react";
import { hostname } from "../lib/format.js";
import { followInternalLink, isModifiedClick } from "../router.js";

/** Optional "Links" list available on every content type. */
export default function RelatedLinks({ links }) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="related-links">
      <h3 id={headingId}>Links</h3>
      <ul>
        {links.map((link) => {
          const isInternal = link.url.startsWith("#");
          return (
            <li key={`${link.url}-${link.label}`}>
              {isInternal ? (
                <a href={link.url} onClick={(event) => !isModifiedClick(event) && followInternalLink(event, link.url)}>
                  {link.label}
                </a>
              ) : (
                <a href={link.url} rel="noreferrer" target="_blank">
                  {link.label}
                  <span className="related-links__host" dir="ltr">
                    {hostname(link.url)}
                  </span>
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
