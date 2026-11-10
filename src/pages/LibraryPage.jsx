import { useMemo } from "react";
import ItemCard from "../components/ItemCard.jsx";
import LibraryFilters from "../components/LibraryFilters.jsx";
import PageHeader from "../components/PageHeader.jsx";
import SearchField from "../components/SearchField.jsx";
import { EmptyState, ErrorState, LoadingState } from "../components/StatusMessage.jsx";
import { CONTENT_TYPES } from "../contentTypes.js";
import useAsync from "../hooks/useAsync.js";
import useDocumentTitle from "../hooks/useDocumentTitle.js";
import useLibraryVersion from "../hooks/useLibraryVersion.js";
import { plural } from "../lib/format.js";
import { filterItems } from "../lib/search.js";
import { updateParams } from "../router.js";
import { getLibrary, refreshLibrary } from "../services/libraryRepository.js";

/**
 * One unified collection: every content type, filtered by URL parameters.
 * `adminTools`: signed-in admin only, shown next to the item count.
 */
export default function LibraryPage({ params, adminTools = null }) {
  // Re-read after admin changes; the current list stays on screen meanwhile.
  const libraryVersion = useLibraryVersion();
  const library = useAsync(getLibrary, [libraryVersion]);
  const query = params.q.trim();
  useDocumentTitle(query ? `Search: ${query}` : undefined);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Mohamad Hassan Ibrahim"
        lede="A personal collection of knowledge, ideas and interesting discoveries: articles, documents, videos and links worth keeping, in English and Arabic."
        title="The Library"
      />

      <SearchField onChange={(value) => updateParams({ q: value })} value={params.q} />

      {library.status === "loading" && !library.data && <LoadingState label="Loading the library…" />}
      {library.status === "error" && (
        <ErrorState message="Please check your connection, then try again." title="The library can't be reached right now.">
          <button className="button" onClick={refreshLibrary} type="button">
            Retry
          </button>
        </ErrorState>
      )}
      {library.data && <Collection adminTools={adminTools} library={library.data} params={params} />}
    </div>
  );
}

function Collection({ library, params, adminTools }) {
  const { categories, languages, items } = library;

  // Unknown values in the URL (e.g. an old link) are ignored, so the controls
  // always show exactly what is applied.
  const filters = {
    category: categories.some((category) => category.slug === params.category) ? params.category : "",
    type: Object.hasOwn(CONTENT_TYPES, params.type) ? params.type : "",
    lang: languages.some((language) => language.code === params.lang) ? params.lang : "",
  };
  const hasFilters = Boolean(params.q.trim() || filters.category || filters.type || filters.lang);

  const visibleCategories = categories.filter((category) => category.itemCount > 0);
  const activeCategory = categories.find((category) => category.slug === filters.category);

  const results = useMemo(
    () =>
      filterItems(items, {
        query: params.q,
        category: filters.category,
        type: filters.type,
        language: filters.lang,
      }),
    [items, params.q, filters.category, filters.type, filters.lang],
  );

  const clearFilters = () => updateParams({ q: "", category: "", type: "", lang: "" });

  return (
    <>
      <LibraryFilters
        categories={visibleCategories}
        filters={filters}
        languages={languages}
        onChange={updateParams}
        totalCount={items.length}
      />

      {activeCategory?.description && <p className="category-intro">{activeCategory.description}</p>}

      <section aria-labelledby="collection-heading" className="collection">
        <div className="collection__bar">
          <h2 className="visually-hidden" id="collection-heading">
            Library items
          </h2>
          {/* Announced to screen readers whenever the results change. */}
          <p className="collection__count" role="status">
            {hasFilters ? `${results.length} of ${plural(items.length, "item")}` : plural(items.length, "item")}
          </p>
          {hasFilters && (
            <button className="button button--small" onClick={clearFilters} type="button">
              Clear filters
            </button>
          )}
          {adminTools}
        </div>

        {items.length === 0 ? (
          <EmptyState title="The library is empty for now." />
        ) : results.length === 0 ? (
          <EmptyState title="Nothing matches these filters.">
            <span>Try another word, or widen the category, type or language.</span>
            <button className="button" onClick={clearFilters} type="button">
              Show everything
            </button>
          </EmptyState>
        ) : (
          <ul className="item-list">
            {results.map((item) => (
              <li key={item.id}>
                <ItemCard item={item} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
