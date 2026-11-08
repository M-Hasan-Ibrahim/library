import { useEffect, useRef, useState } from "react";
import { BLOCK_KINDS, blockKind, blockKindLabel, convertBlock, emptyBlock, wrapText } from "./editorModel.js";
import { AutoTextarea, IconButton } from "./ui.jsx";

/**
 * The article text as a list of blocks, each edited in place with the same
 * typography as the reading view: paragraphs, headings, lists, quotes, code
 * and expandable sections (one level deep). Blocks can be added, removed,
 * changed into another kind and moved up or down; the last removal can be
 * undone. Ctrl/Cmd+B, I and K format the selected text.
 */
const ADD_KINDS = [
  { value: "paragraph", label: "Paragraph" },
  { value: "heading-2", label: "Heading" },
  { value: "list-bulleted", label: "List" },
  { value: "quote", label: "Quote" },
  { value: "code", label: "Code" },
  { value: "details", label: "Section" },
];

const FORMATS = [
  { format: "bold", label: "Bold (Ctrl+B)", text: "B", className: "icon-button--bold" },
  { format: "italic", label: "Italic (Ctrl+I)", text: "I", className: "icon-button--italic" },
  { format: "code", label: "Inline code", text: "</>", className: "icon-button--code" },
  { format: "link", label: "Link (Ctrl+K)", text: "Link", className: "icon-button--wide" },
];
const SHORTCUTS = { b: "bold", i: "italic", k: "link" };

const hasInlineMarkup = (block) => ["paragraph", "heading", "list", "quote"].includes(block.type);
const textKey = (block) => (block.type === "details" ? "summary" : "text");

/** Applies a format to a field and selects the right part afterwards. */
function applyFormat(element, format, onText) {
  if (!element) return;
  const result = wrapText(element.value, element.selectionStart, element.selectionEnd, format);
  onText(result.value);
  requestAnimationFrame(() => {
    element.focus();
    element.setSelectionRange(result.start, result.end);
  });
}

export default function BlocksEditor({ blocks, onChange, makeId, problems, depth = 0 }) {
  const [focusId, setFocusId] = useState(null);
  const [removed, setRemoved] = useState(null); // { before, after, label }

  const replaceAt = (index, block) => onChange(blocks.map((entry, i) => (i === index ? block : entry)));
  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const insertAt = (index, kind) => {
    const block = emptyBlock(kind, makeId);
    const next = [...blocks];
    next.splice(index, 0, block);
    onChange(next);
    setFocusId(block.id);
  };
  const remove = (index) => {
    const next = blocks.filter((_, i) => i !== index);
    setRemoved({ before: blocks, after: next, label: blockKindLabel(blocks[index]) });
    onChange(next);
  };

  return (
    <div className="block-list" data-depth={depth}>
      {blocks.map((block, index) => (
        <BlockItem
          autoFocus={focusId === block.id}
          block={block}
          count={blocks.length}
          depth={depth}
          index={index}
          key={block.id}
          makeId={makeId}
          onChange={(next) => replaceAt(index, next)}
          onFocused={() => setFocusId(null)}
          onInsertBelow={() => insertAt(index + 1, "paragraph")}
          onMove={(delta) => move(index, delta)}
          onRemove={() => remove(index)}
          problems={problems}
        />
      ))}
      {blocks.length === 0 && <p className="editor-hint block-list__empty">No text yet.</p>}
      {/* Undo only while nothing else changed since the removal. */}
      {removed && removed.after === blocks && (
        <p className="block-undo" role="status">
          {removed.label} removed.{" "}
          <button
            className="button button--small"
            onClick={() => {
              onChange(removed.before);
              setRemoved(null);
            }}
            type="button"
          >
            Undo
          </button>
        </p>
      )}
      <div aria-label={depth ? "Add a block to this section" : "Add a block"} className="block-add" lang="en" role="group">
        <span className="editor-label">Add</span>
        {ADD_KINDS.filter((kind) => depth === 0 || kind.value !== "details").map((kind) => (
          <button className="button button--small" key={kind.value} onClick={() => insertAt(blocks.length, kind.value)} type="button">
            {kind.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function BlockItem({ block, index, count, depth, problems, makeId, autoFocus, onChange, onFocused, onInsertBelow, onMove, onRemove }) {
  const fieldRef = useRef(null); // the field that formatting applies to (for lists: the focused item)
  const activeItem = useRef(0);
  const ownProblems = problems?.get(block.id) ?? [];
  const kindLabel = blockKindLabel(block);

  useEffect(() => {
    if (!autoFocus) return;
    fieldRef.current?.focus();
    onFocused();
  }, [autoFocus, onFocused]);

  // Moving a block can move its DOM node, which drops focus: put it back.
  const moveKeepingFocus = (delta, event) => {
    const button = event.currentTarget;
    onMove(delta);
    requestAnimationFrame(() => {
      if (button.isConnected && document.activeElement !== button) button.focus();
    });
  };

  const setText = (text) =>
    onChange(
      block.type === "list"
        ? { ...block, items: block.items.map((item, i) => (i === activeItem.current ? text : item)) }
        : { ...block, [textKey(block)]: text },
    );
  const onFormatKey = (event) => {
    const format = SHORTCUTS[event.key.toLowerCase()];
    if (!format || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    applyFormat(event.currentTarget, format, setText);
  };

  return (
    <div
      aria-label={`${kindLabel}, block ${index + 1} of ${count}`}
      className="block-editor"
      data-invalid={ownProblems.length > 0 ? "true" : undefined}
      data-kind={blockKind(block)}
      role="group"
    >
      <div className="block-editor__controls" lang="en">
        <select
          aria-label="Block kind"
          className="block-editor__kind"
          disabled={block.type === "details" || block.unsupported}
          onChange={(event) => onChange(convertBlock(block, event.target.value, makeId))}
          value={blockKind(block)}
        >
          {block.type === "details" ? (
            <option value="details">Expandable section</option>
          ) : block.unsupported ? (
            <option value={block.type}>{block.type}</option>
          ) : (
            BLOCK_KINDS.filter((kind) => depth === 0 || kind.value !== "details").map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))
          )}
        </select>
        {hasInlineMarkup(block) &&
          FORMATS.map((format) => (
            <button
              aria-label={format.label}
              className={`icon-button ${format.className}`}
              key={format.format}
              onClick={() => applyFormat(fieldRef.current, format.format, setText)}
              // Keep the text selection in the field while clicking.
              onMouseDown={(event) => event.preventDefault()}
              title={format.label}
              type="button"
            >
              <span aria-hidden="true">{format.text}</span>
            </button>
          ))}
        <span className="block-editor__spacer" />
        <IconButton disabled={index === 0} label="Move up" onClick={(event) => moveKeepingFocus(-1, event)}>
          ↑
        </IconButton>
        <IconButton disabled={index === count - 1} label="Move down" onClick={(event) => moveKeepingFocus(1, event)}>
          ↓
        </IconButton>
        <IconButton label="Add a paragraph below" onClick={onInsertBelow}>
          +
        </IconButton>
        <IconButton className="icon-button--danger" label={`Remove this ${kindLabel.toLowerCase()}`} onClick={onRemove}>
          ✕
        </IconButton>
      </div>

      <BlockFields
        activeItem={activeItem}
        block={block}
        fieldRef={fieldRef}
        makeId={makeId}
        onChange={onChange}
        onFormatKey={onFormatKey}
        problems={problems}
        setText={setText}
      />

      {ownProblems.length > 0 && (
        <ul className="editor-error-list" lang="en">
          {ownProblems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BlockFields({ block, fieldRef, activeItem, makeId, onChange, onFormatKey, problems, setText }) {
  const invalid = problems?.has(block.id) || undefined;
  const common = { "aria-invalid": invalid, onKeyDown: onFormatKey, textareaRef: fieldRef };

  switch (block.type) {
    case "paragraph":
      return (
        <AutoTextarea {...common} aria-label="Paragraph" className="block-input block-input--paragraph" onChange={setText} placeholder="Write a paragraph…" value={block.text} />
      );
    case "heading":
      return (
        <AutoTextarea
          {...common}
          aria-label={block.level === 3 ? "Subheading" : "Heading"}
          className={`block-input block-input--h${block.level === 3 ? 4 : 3}`}
          onChange={setText}
          placeholder={block.level === 3 ? "Subheading" : "Heading"}
          singleLine
          value={block.text}
        />
      );
    case "list":
      return (
        <ListItems activeItem={activeItem} block={block} fieldRef={fieldRef} invalid={invalid} onChange={onChange} onFormatKey={onFormatKey} />
      );
    case "quote":
      return (
        <div className="block-quote">
          <AutoTextarea {...common} aria-label="Quote" className="block-input block-input--quote" onChange={setText} placeholder="Quote" value={block.text} />
        </div>
      );
    case "code":
      return (
        <div className="block-code" dir="ltr">
          <input
            aria-label="Code language (optional)"
            className="editor-input block-code__language"
            onChange={(event) => onChange({ ...block, language: event.target.value })}
            placeholder="Language, e.g. shell"
            spellCheck={false}
            value={block.language}
          />
          <AutoTextarea
            aria-invalid={invalid}
            aria-label="Code"
            className="block-input block-input--code"
            onChange={(text) => onChange({ ...block, text })}
            placeholder="Code, shown exactly as typed"
            spellCheck={false}
            textareaRef={fieldRef}
            value={block.text}
            wrap="off"
          />
        </div>
      );
    case "details":
      return (
        <div className="block-details">
          <AutoTextarea
            aria-invalid={invalid}
            aria-label="Section title, always visible"
            className="block-input block-input--summary"
            onChange={(summary) => onChange({ ...block, summary })}
            onKeyDown={onFormatKey}
            placeholder="Section title (always visible)"
            singleLine
            textareaRef={fieldRef}
            value={block.summary}
          />
          <BlocksEditor blocks={block.blocks} depth={1} makeId={makeId} onChange={(blocks) => onChange({ ...block, blocks })} problems={problems} />
        </div>
      );
    default:
      return (
        <p className="editor-hint" lang="en">
          This kind of block ({block.type}) cannot be edited here. It is kept unchanged.
        </p>
      );
  }
}

/**
 * A list with one field per item and the reading view's markers. Enter
 * starts the next item (splitting at the caret), Backspace in an empty item
 * removes it, and pasting several lines adds one item per line.
 */
function ListItems({ block, onChange, fieldRef, activeItem, onFormatKey, invalid }) {
  const items = block.items.length > 0 ? block.items : [""];
  const refs = useRef([]);
  const [focus, setFocus] = useState(null); // { index, at: "start" | "end" }

  useEffect(() => {
    if (!focus) return;
    const element = refs.current[focus.index];
    if (element) {
      element.focus();
      const caret = focus.at === "start" ? 0 : element.value.length;
      element.setSelectionRange(caret, caret);
    }
    setFocus(null);
  }, [focus]);

  const setItems = (next) => onChange({ ...block, items: next.length > 0 ? next : [""] });

  const handleKeyDown = (index) => (event) => {
    const element = event.currentTarget;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = element;
      const next = [...items];
      next.splice(index, 1, value.slice(0, selectionStart), value.slice(selectionEnd));
      setItems(next);
      setFocus({ index: index + 1, at: "start" });
      return;
    }
    if (event.key === "Backspace" && element.value === "" && items.length > 1) {
      event.preventDefault();
      setItems(items.filter((_, i) => i !== index));
      setFocus({ index: Math.max(0, index - 1), at: "end" });
      return;
    }
    onFormatKey(event);
  };

  const handlePaste = (index) => (event) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!/\r?\n/.test(text)) return;
    // Pasted bullets or numbers ("- ", "• ", "1. ") are list markers, not text.
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))
      .filter((line) => line.trim() !== "");
    if (lines.length === 0) return;
    event.preventDefault();
    const element = event.currentTarget;
    lines[0] = element.value.slice(0, element.selectionStart) + lines[0];
    lines[lines.length - 1] += element.value.slice(element.selectionEnd);
    const next = [...items];
    next.splice(index, 1, ...lines);
    setItems(next);
    setFocus({ index: index + lines.length - 1, at: "end" });
  };

  const List = block.ordered ? "ol" : "ul";
  return (
    <List className={`block-list-items block-list-items--${block.ordered ? "numbered" : "bulleted"}`}>
      {items.map((item, index) => (
        // Items have no identity of their own; index keys keep focus on the
        // same field while the text moves between items.
        // eslint-disable-next-line react/no-array-index-key
        <li key={index}>
          <AutoTextarea
            aria-invalid={invalid}
            aria-label={`Item ${index + 1} of ${items.length}`}
            className="block-input block-input--item"
            onChange={(text) => setItems(items.map((entry, i) => (i === index ? text : entry)))}
            onFocus={(event) => {
              activeItem.current = index;
              fieldRef.current = event.currentTarget;
            }}
            onKeyDown={handleKeyDown(index)}
            onPaste={handlePaste(index)}
            placeholder={index === 0 ? "List item (Enter starts the next one)" : "List item"}
            singleLine
            textareaRef={(element) => {
              refs.current[index] = element;
              if (element && index === 0 && !fieldRef.current?.isConnected) fieldRef.current = element;
            }}
            value={item}
          />
        </li>
      ))}
    </List>
  );
}
