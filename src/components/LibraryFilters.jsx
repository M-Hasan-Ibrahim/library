import { useId } from "react";
import { CONTENT_TYPES } from "../contentTypes.js";

/**
 * Category chips plus compact type/language selects. All values come from
 * data (categories, languages) or the type registry — nothing is hardcoded.
 */
export default function LibraryFilters({ categories, languages, totalCount, filters, onChange }) {
  const typeId = useId();
  const languageId = useId();

  return (
    <div className="library-filters">
      <fieldset className="category-filter">
        <legend>Categories</legend>
        <div className="chips">
          <button
            aria-pressed={!filters.category}
            className="chip"
            onClick={() => onChange({ category: "" })}
            type="button"
          >
            All <span className="chip__count">{totalCount}</span>
          </button>
          {categories.map((category) => (
            <button
              aria-pressed={filters.category === category.slug}
              className="chip"
              key={category.id}
              onClick={() => onChange({ category: category.slug })}
              type="button"
            >
              {category.name} <span className="chip__count">{category.itemCount}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="select-row">
        <div className="select-field">
          <label htmlFor={typeId}>Type</label>
          <select id={typeId} onChange={(event) => onChange({ type: event.target.value })} value={filters.type}>
            <option value="">All types</option>
            {Object.entries(CONTENT_TYPES).map(([id, type]) => (
              <option key={id} value={id}>
                {type.plural}
              </option>
            ))}
          </select>
        </div>

        <div className="select-field">
          <label htmlFor={languageId}>Language</label>
          <select id={languageId} onChange={(event) => onChange({ lang: event.target.value })} value={filters.lang}>
            <option value="">All languages</option>
            {languages.map((language) => (
              <option key={language.code} lang={language.code} value={language.code}>
                {language.nativeName}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
