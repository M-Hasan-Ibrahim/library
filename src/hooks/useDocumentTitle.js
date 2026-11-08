import { useEffect } from "react";

const SITE_NAME = "Library | Mohamad Hassan Ibrahim";

/**
 * Sets the browser tab title while the calling component is mounted and
 * restores the previous title afterwards (so closing the reading panel
 * brings back the library's title). Pass nothing to use the site name, or
 * null to leave the title to another component.
 */
export default function useDocumentTitle(title) {
  useEffect(() => {
    if (title === null) return undefined;
    const previous = document.title;
    document.title = title ? `${title} | Library` : SITE_NAME;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
