import { useId } from "react";

export default function SearchField({ value, onChange }) {
  const inputId = useId();
  const hintId = useId();

  return (
    <div className="search-field" role="search">
      <label htmlFor={inputId}>Search the library</label>
      <input
        aria-describedby={hintId}
        autoComplete="off"
        id={inputId}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Try “rainbow”, “Git” or “video”"
        spellCheck="false"
        type="search"
        value={value}
      />
      <p className="search-field__hint" id={hintId}>
        Searches titles, descriptions, categories and tags, in English and Arabic.
      </p>
    </div>
  );
}
