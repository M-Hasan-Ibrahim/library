// Dates are stored as calendar days ("2026-10-30"). Formatting in UTC keeps
// the displayed day identical for every visitor, whatever their time zone.
const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDate(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? isoDate : dateFormatter.format(date);
}

export const plural = (count, singular, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Small, discreet hint shown on cards: "3 min read", "PDF · 2 pages", "Video", "Link · nasa.gov". */
export function typeHint(item) {
  switch (item.type) {
    case "article":
      return item.readingMinutes ? `${item.readingMinutes} min read` : "Article";
    case "pdf":
      return item.pageCount ? `PDF · ${plural(item.pageCount, "page")}` : "PDF";
    case "youtube":
      return "Video";
    case "link": {
      const host = hostname(item.url);
      return host ? `Link · ${host}` : "Link";
    }
    default:
      return "";
  }
}
