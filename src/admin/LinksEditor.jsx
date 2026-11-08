import { useEffect, useRef, useState } from "react";
import { newRowKey } from "./editorModel.js";
import { IconButton } from "./ui.jsx";

/** The optional "Links" list under the text: label + address rows. Empty rows are ignored. */
export default function LinksEditor({ links, onChange, error, id }) {
  const [focusKey, setFocusKey] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!focusKey) return;
    listRef.current?.querySelector(`[data-row="${focusKey}"] input`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const update = (index, changes) => onChange(links.map((link, i) => (i === index ? { ...link, ...changes } : link)));
  const move = (index, delta, event) => {
    const target = index + delta;
    if (target < 0 || target >= links.length) return;
    const button = event.currentTarget;
    const next = [...links];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    requestAnimationFrame(() => {
      if (button.isConnected && document.activeElement !== button) button.focus();
    });
  };
  const add = () => {
    const row = { key: newRowKey(), label: "", url: "" };
    onChange([...links, row]);
    setFocusKey(row.key);
  };

  return (
    <div className="links-editor" id={id}>
      {links.length === 0 && (
        <p className="editor-hint" lang="en">
          No links yet. Links are listed under the text.
        </p>
      )}
      {links.length > 0 && (
        <ul className="links-editor__rows" ref={listRef}>
          {links.map((link, index) => (
            <li className="links-editor__row" data-row={link.key} key={link.key}>
              <input
                aria-label={`Link ${index + 1}: label`}
                className="editor-input"
                onChange={(event) => update(index, { label: event.target.value })}
                placeholder="Label"
                value={link.label}
              />
              <input
                aria-label={`Link ${index + 1}: address`}
                className="editor-input"
                dir="ltr"
                inputMode="url"
                onChange={(event) => update(index, { url: event.target.value })}
                placeholder="https://… or #/?item=…"
                spellCheck={false}
                value={link.url}
              />
              <span className="links-editor__actions" lang="en">
                <IconButton disabled={index === 0} label={`Move link ${index + 1} up`} onClick={(event) => move(index, -1, event)}>
                  ↑
                </IconButton>
                <IconButton disabled={index === links.length - 1} label={`Move link ${index + 1} down`} onClick={(event) => move(index, 1, event)}>
                  ↓
                </IconButton>
                <IconButton
                  className="icon-button--danger"
                  label={`Remove link ${index + 1}`}
                  onClick={() => onChange(links.filter((_, i) => i !== index))}
                >
                  ✕
                </IconButton>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="editor-error" lang="en">
          Links {error}
        </p>
      )}
      <button className="button button--small" lang="en" onClick={add} type="button">
        Add link
      </button>
    </div>
  );
}
