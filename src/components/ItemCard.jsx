import { formatDate, typeHint } from "../lib/format.js";
import { isModifiedClick, itemHref, openItem } from "../router.js";

/**
 * One card design for every content type. The type only shows as a small hint
 * in the meta line ("3 min read", "PDF · 2 pages", "Video", "Link · site").
 * The whole card is clickable, but only the title is a link, so screen
 * readers hear one clear link per item. Ctrl/Cmd-click opens a new tab.
 * Drafts (only ever listed for the signed-in admin) carry a small "Draft" tag.
 */
export default function ItemCard({ item }) {
  const handleClick = (event) => {
    if (isModifiedClick(event)) return;
    event.preventDefault();
    openItem(item.slug);
  };

  return (
    <article className="item-card" data-type={item.type} dir={item.dir} lang={item.language}>
      <p className="item-card__category">
        {item.category.name}
        {item.status === "draft" && (
          <span className="status-badge status-badge--draft" dir="ltr" lang="en">
            Draft
          </span>
        )}
      </p>
      <h3 className="item-card__title">
        <a className="item-card__link" data-item-link={item.slug} href={itemHref(item.slug)} onClick={handleClick}>
          {item.title}
        </a>
      </h3>
      {item.description && <p className="item-card__summary">{item.description}</p>}
      <p className="item-meta">
        {/* English metadata kept as one left-to-right run, so in Arabic cards
            the date is not reordered ("2 November 2026" stays intact). */}
        <span dir="ltr">
          <time dateTime={item.addedAt}>{formatDate(item.addedAt)}</time>
          <span aria-hidden="true"> · </span>
          <span>{typeHint(item)}</span>
        </span>
      </p>
    </article>
  );
}
