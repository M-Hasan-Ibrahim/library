import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { safeHref } from "../lib/inlineMarkup.js";
import { blocksToDoc, collectOriginals, defaultIdMaker, docToBlocks } from "./docModel.js";
import { canWrapInSection, currentListDepth, documentExtensions, isInSection, moveBlock, wrapInSection } from "./docExtensions.js";
import {
  BoldIcon,
  BulletListIcon,
  CodeBlockIcon,
  CodeIcon,
  DividerIcon,
  IndentIcon,
  ItalicIcon,
  LinkIcon,
  MoveDownIcon,
  MoveUpIcon,
  OrderedListIcon,
  OutdentIcon,
  QuoteIcon,
  RedoIcon,
  SectionIcon,
  UndoIcon,
} from "./icons.jsx";

/**
 * One continuous document, edited like a word processor, with the reading
 * view's own typography (the page uses the .rich-text styles). A toolbar
 * above it formats as you go; nothing is typed as markup.
 *
 * The document is converted to the stored blocks (docModel.js) after every
 * change (once per frame) and handed to `onChange`; untouched blocks come
 * back exactly as they were stored. `controllerRef.current.flush()` returns
 * the blocks right now (used before saving).
 */
const BLOCK_STYLES = [
  { value: "paragraph", label: "Normal text" },
  { value: "2", label: "Heading 1" },
  { value: "3", label: "Heading 2" },
  { value: "4", label: "Heading 3" },
];
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
const mod = isMac ? "⌘" : "Ctrl+";

/** "example.com" -> "https://example.com"; "#/?item=x", mailto: and http(s) as they are. */
export function normaliseHref(value) {
  const href = String(value ?? "").trim();
  if (href === "") return "";
  if (/^(https?:|mailto:|#\/)/i.test(href)) return safeHref(href) ? href : null;
  if (/^[^\s/]+\.[^\s]+$/.test(href)) return `https://${href}`;
  return null;
}

function ToolButton({ label, shortcut, active, disabled, onClick, children }) {
  return (
    <button
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : Boolean(active)}
      className="doc-tool"
      onClick={() => !disabled && onClick()}
      onMouseDown={(event) => event.preventDefault()} // keep the selection in the document
      title={shortcut ? `${label} (${shortcut})` : label}
      type="button"
    >
      {children}
    </button>
  );
}

export default function DocumentEditor({ initialBlocks, onChange, dir = "ltr", lang = "en", problems, placeholder = "Start writing…", label = "Text", controllerRef }) {
  const [linkEditor, setLinkEditor] = useState(null); // { href, error }
  const linkInputId = useId();
  const linkInputRef = useRef(null);
  const pending = useRef(0);
  const originals = useRef(new Map());
  const makeId = useMemo(() => defaultIdMaker(), []);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const openLinkRef = useRef(() => {});

  const editor = useEditor({
    extensions: documentExtensions({ makeId, onLink: () => openLinkRef.current(), placeholder }),
    content: blocksToDoc(initialBlocks),
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "doc-page rich-text", role: "textbox", "aria-multiline": "true", "aria-label": label, spellcheck: "true" },
      // ProseMirror swallows Escape, so the panel would never hear it. Hand it
      // on as the same close request the browser sends from any other field
      // (the panel then asks before discarding unsaved changes).
      handleKeyDown: (view, event) => {
        if (event.key !== "Escape" || event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
        const dialog = view.dom.closest("dialog");
        if (!dialog?.open) return false;
        dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
        return true;
      },
    },
    onCreate: ({ editor: created }) => {
      originals.current = collectOriginals(created.getJSON(), initialBlocks);
    },
    onUpdate: () => {
      cancelAnimationFrame(pending.current);
      pending.current = requestAnimationFrame(() => emit());
    },
  });

  function currentBlocks() {
    return editor ? docToBlocks(editor.getJSON(), { originals: originals.current, makeId }) : initialBlocks;
  }
  function emit() {
    pending.current = 0;
    onChangeRef.current(currentBlocks());
  }

  useImperativeHandle(controllerRef, () => ({
    flush() {
      if (pending.current) {
        cancelAnimationFrame(pending.current);
        emit();
      }
      return currentBlocks();
    },
    focus: () => editor?.commands.focus(),
  }));

  useEffect(() => () => cancelAnimationFrame(pending.current), []);

  // Text direction and language follow the item's language.
  useEffect(() => {
    if (!editor) return;
    editor.view.dom.setAttribute("dir", dir);
    editor.view.dom.setAttribute("lang", lang);
  }, [editor, dir, lang]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const heading = [2, 3, 4].find((level) => e.isActive("heading", { level }));
      return {
        style: heading ? String(heading) : e.isActive("paragraph") ? "paragraph" : "",
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        code: e.isActive("code"),
        link: e.isActive("link"),
        bulletList: e.isActive("bulletList"),
        orderedList: e.isActive("orderedList"),
        blockquote: e.isActive("blockquote"),
        codeBlock: e.isActive("codeBlock"),
        language: e.isActive("codeBlock") ? e.getAttributes("codeBlock").language ?? "" : null,
        inSection: isInSection(e),
        canSection: canWrapInSection(e),
        listItem: e.isActive("listItem"),
        listDepth: currentListDepth(e),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        canQuote: e.can().toggleBlockquote(),
        canSink: e.can().sinkListItem("listItem"),
        canLift: e.can().liftListItem("listItem"),
      };
    },
  });

  openLinkRef.current = () => {
    if (!editor) return;
    setLinkEditor({ href: editor.getAttributes("link").href ?? "", error: "" });
    // Already open (Ctrl+K again): autoFocus does not run twice.
    setTimeout(() => linkInputRef.current?.focus(), 0);
  };

  const applyLink = (value) => {
    const href = normaliseHref(value);
    if (href === null) {
      setLinkEditor({ href: value, error: "Use an address starting with https://, mailto: or #/?item=" });
      return;
    }
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href === "") chain.unsetLink().run();
    else if (editor.state.selection.empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else chain.setLink({ href }).run();
    setLinkEditor(null);
  };

  if (!editor || !state) return <div className="doc-editor doc-editor--loading" />;

  const run = (command) => command(editor.chain().focus()).run();
  const setStyle = (value) => {
    if (value === "paragraph") run((c) => c.setParagraph());
    else run((c) => c.setHeading({ level: Number(value) }));
  };
  const invalidIds = problems ? [...problems.keys()].filter((id) => /^[a-z0-9-]+$/i.test(id)) : [];

  return (
    <div className="doc-editor">
      {/* English controls, left to right like the rest of the admin, even for an Arabic text. */}
      <div aria-label={`${label}: formatting`} className="doc-toolbar" dir="ltr" lang="en" role="group">
        <div className="doc-toolbar__group">
          <ToolButton disabled={!state.canUndo} label="Undo" onClick={() => run((c) => c.undo())} shortcut={`${mod}Z`}>
            <UndoIcon />
          </ToolButton>
          <ToolButton disabled={!state.canRedo} label="Redo" onClick={() => run((c) => c.redo())} shortcut={isMac ? "⌘⇧Z" : "Ctrl+Y"}>
            <RedoIcon />
          </ToolButton>
        </div>
        <div className="doc-toolbar__group">
          <select
            aria-label="Text style"
            className="doc-style"
            disabled={state.codeBlock}
            onChange={(event) => setStyle(event.target.value)}
            onMouseDown={(event) => event.stopPropagation()}
            title="Text style (Ctrl+Alt+0 to 3)"
            value={state.style}
          >
            {state.style === "" && <option value="">—</option>}
            {BLOCK_STYLES.map((style) => (
              <option key={style.value} value={style.value}>
                {style.label}
              </option>
            ))}
          </select>
        </div>
        <div className="doc-toolbar__group">
          <ToolButton active={state.bold} disabled={state.codeBlock} label="Bold" onClick={() => run((c) => c.toggleBold())} shortcut={`${mod}B`}>
            <BoldIcon />
          </ToolButton>
          <ToolButton active={state.italic} disabled={state.codeBlock} label="Italic" onClick={() => run((c) => c.toggleItalic())} shortcut={`${mod}I`}>
            <ItalicIcon />
          </ToolButton>
          <ToolButton active={state.code} disabled={state.codeBlock} label="Inline code" onClick={() => run((c) => c.toggleCode())} shortcut={`${mod}E`}>
            <CodeIcon />
          </ToolButton>
          <ToolButton active={state.link} disabled={state.codeBlock} label="Link" onClick={() => openLinkRef.current()} shortcut={`${mod}K`}>
            <LinkIcon />
          </ToolButton>
        </div>
        <div className="doc-toolbar__group">
          <ToolButton active={state.bulletList} label="Bulleted list" onClick={() => run((c) => c.toggleBulletList())} shortcut={`${mod}Shift+8`}>
            <BulletListIcon />
          </ToolButton>
          <ToolButton active={state.orderedList} label="Numbered list" onClick={() => run((c) => c.toggleOrderedList())} shortcut={`${mod}Shift+7`}>
            <OrderedListIcon />
          </ToolButton>
          {state.listItem && (
            <>
              <ToolButton disabled={!state.canLift} label="Decrease indent" onClick={() => run((c) => c.liftListItem("listItem"))} shortcut="Shift+Tab">
                <OutdentIcon />
              </ToolButton>
              <ToolButton disabled={!state.canSink || state.listDepth >= 3} label="Increase indent" onClick={() => run((c) => c.sinkListItem("listItem"))} shortcut="Tab">
                <IndentIcon />
              </ToolButton>
            </>
          )}
          <ToolButton active={state.blockquote} disabled={!state.blockquote && !state.canQuote} label="Quote" onClick={() => run((c) => c.toggleBlockquote())} shortcut={`${mod}Shift+B`}>
            <QuoteIcon />
          </ToolButton>
          <ToolButton active={state.codeBlock} label="Code block" onClick={() => run((c) => c.toggleCodeBlock())} shortcut={`${mod}Alt+C`}>
            <CodeBlockIcon />
          </ToolButton>
          <ToolButton label="Divider" onClick={() => run((c) => c.setHorizontalRule())}>
            <DividerIcon />
          </ToolButton>
          <ToolButton active={state.inSection} disabled={!state.inSection && !state.canSection} label="Expandable section" onClick={() => !state.inSection && wrapInSection(editor)}>
            <SectionIcon />
          </ToolButton>
        </div>
        <div className="doc-toolbar__group">
          <ToolButton label="Move block up" onClick={() => moveBlock(editor, -1)} shortcut="Alt+Shift+↑">
            <MoveUpIcon />
          </ToolButton>
          <ToolButton label="Move block down" onClick={() => moveBlock(editor, 1)} shortcut="Alt+Shift+↓">
            <MoveDownIcon />
          </ToolButton>
        </div>
        {state.language !== null && (
          <div className="doc-toolbar__group">
            <input
              aria-label="Code language (optional)"
              className="doc-language"
              dir="ltr"
              onChange={(event) => editor.chain().updateAttributes("codeBlock", { language: event.target.value.trim() || null }).run()}
              placeholder="language"
              spellCheck={false}
              value={state.language}
            />
          </div>
        )}
        {linkEditor && (
          // Not a <form>: it sits inside the item's form, and nested forms are not
          // valid HTML (Enter would submit the whole page). Enter is handled here.
          <div aria-label="Link" className="doc-link" role="group">
            <label className="visually-hidden" htmlFor={linkInputId}>
              Link address
            </label>
            <input
              aria-describedby={linkEditor.error ? `${linkInputId}-error` : undefined}
              autoFocus
              className="doc-link__input"
              dir="ltr"
              id={linkInputId}
              onChange={(event) => setLinkEditor({ href: event.target.value, error: "" })}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyLink(linkEditor.href);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setLinkEditor(null);
                  editor.commands.focus();
                }
              }}
              placeholder="https://… or #/?item=…"
              ref={linkInputRef}
              spellCheck={false}
              value={linkEditor.href}
            />
            <button className="button button--small button--primary" onClick={() => applyLink(linkEditor.href)} type="button">
              Apply
            </button>
            {state.link && (
              <button className="button button--small" onClick={() => applyLink("")} type="button">
                Remove link
              </button>
            )}
            <button
              className="button button--small"
              onClick={() => {
                setLinkEditor(null);
                editor.commands.focus();
              }}
              type="button"
            >
              Cancel
            </button>
            {linkEditor.error && (
              <p className="editor-error doc-link__error" id={`${linkInputId}-error`}>
                {linkEditor.error}
              </p>
            )}
          </div>
        )}
      </div>

      {invalidIds.length > 0 && (
        <style>{invalidIds.map((id) => `.doc-page [data-block-id="${id}"]`).join(",\n") + " { outline: 2px solid var(--error); outline-offset: 4px; border-radius: 4px; }"}</style>
      )}
      {problems && problems.size > 0 && (
        <ul className="editor-error-list doc-problems" lang="en">
          {[...problems.entries()].map(([id, messages]) => (
            <li key={id}>
              <button
                className="editor-summary__link"
                onClick={() => {
                  const element = editor.view.dom.querySelector(`[data-block-id="${id}"]`);
                  if (!element) return;
                  const position = editor.view.posAtDOM(element, 0);
                  editor.chain().focus().setTextSelection(position).scrollIntoView().run();
                }}
                type="button"
              >
                Show
              </button>{" "}
              {messages.join("; ")}
            </li>
          ))}
        </ul>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}
