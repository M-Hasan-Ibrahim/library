/* Small building blocks shared by the admin views. */
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ITEM_TITLE_ID } from "../components/ItemView.jsx";
import useAsync from "../hooks/useAsync.js";
import useLibraryVersion from "../hooks/useLibraryVersion.js";
import { ADMIN_LOGIN_URL } from "../services/adminSession.js";
import { getLibrary, refreshLibrary } from "../services/libraryRepository.js";
import { describeError } from "./api.js";

/** Renders the admin toolbar into the reading panel's top bar. */
export function PanelTools({ target, label = "Item tools", className = "", children }) {
  if (!target) return null;
  return createPortal(
    <div aria-label={label} className={`admin-tools${className ? ` ${className}` : ""}`} role="group">
      {children}
    </div>,
    target,
  );
}

export function StatusBadge({ status }) {
  const draft = status === "draft";
  return (
    <span className={`status-badge status-badge--${draft ? "draft" : "published"}`}>{draft ? "Draft" : "Published"}</span>
  );
}

/**
 * A textarea that grows with its text. `singleLine` fields (titles, headings)
 * turn pasted line breaks into spaces and ignore Enter.
 */
export function AutoTextarea({ value, onChange, singleLine = false, onKeyDown, textareaRef, ...props }) {
  const ownRef = useRef(null);
  // Our own ref for sizing, passed on to the caller's ref (object or function).
  const setRef = (element) => {
    ownRef.current = element;
    if (typeof textareaRef === "function") textareaRef(element);
    else if (textareaRef) textareaRef.current = element;
  };

  useLayoutEffect(() => {
    const element = ownRef.current;
    if (!element) return undefined;
    const fit = () => {
      // Measuring needs height:auto for a moment; keep the panel's scroll position.
      const scroller = element.closest(".item-panel__content");
      const top = scroller?.scrollTop;
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight + (element.offsetHeight - element.clientHeight)}px`;
      if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
    };
    fit();
    // Text re-wraps when the panel changes width (rotation, window resize).
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);

  return (
    <textarea
      {...props}
      onChange={(event) => onChange(singleLine ? event.target.value.replace(/\s*\r?\n\s*/g, " ") : event.target.value)}
      onKeyDown={(event) => {
        if (singleLine && event.key === "Enter") event.preventDefault();
        onKeyDown?.(event);
      }}
      ref={setRef}
      rows={1}
      value={value}
    />
  );
}

/**
 * A small square control (↑ ↓ + ✕). "Disabled" keeps focus on the button
 * (aria-disabled), so repeated presses with the keyboard never lose it.
 */
export function IconButton({ label, disabled = false, onClick, children, className = "" }) {
  return (
    <button
      aria-disabled={disabled || undefined}
      aria-label={label}
      className={`icon-button ${className}`}
      onClick={(event) => !disabled && onClick(event)}
      title={label}
      type="button"
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

/** Opens the Access sign-in in a new tab, so this tab keeps its unsaved work. */
export const signInAgain = () => window.open(ADMIN_LOGIN_URL, "_blank", "noopener");

/**
 * An admin API failure in plain words, with the way out: sign in again
 * (new tab), retry, or both.
 */
export function ErrorNotice({ error, onRetry, retryLabel = "Try again", keepsChanges = false, children }) {
  if (!error) return null;
  const session = error.kind === "session";
  return (
    <div className="admin-notice admin-notice--error" role="alert">
      <p>
        <strong>{describeError(error)}</strong>{" "}
        {session && "Sign in again in the new tab, then come back here."}
        {keepsChanges && " Your changes are still here."}
      </p>
      {children}
      {(session || onRetry) && (
        <div className="admin-notice__actions">
          {session && (
            <button className="button button--small" onClick={signInAgain} type="button">
              Sign in again <span aria-hidden="true">↗</span>
              <span className="visually-hidden"> (opens in a new tab)</span>
            </button>
          )}
          {onRetry && (
            <button className="button button--small" onClick={onRetry} type="button">
              {retryLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * An inline confirmation. Focus moves to its safe choice (Cancel), so an
 * accidental Enter never confirms; Escape is left to the panel.
 */
export function ConfirmBox({ title, children, confirmLabel, onConfirm, onCancel, cancelLabel = "Cancel", busy = false, danger = false }) {
  const boxRef = useRef(null);
  useEffect(() => {
    boxRef.current?.querySelector("[data-safe]")?.focus();
    boxRef.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div aria-label={title} className="admin-notice admin-notice--confirm" ref={boxRef} role="alertdialog">
      <p>
        <strong>{title}</strong> {children}
      </p>
      <div className="admin-notice__actions">
        <button
          aria-disabled={busy || undefined}
          className={`button button--small ${danger ? "button--danger" : "button--primary"}`}
          onClick={() => !busy && onConfirm()}
          type="button"
        >
          {busy ? "Working…" : confirmLabel}
        </button>
        <button className="button button--small" data-safe onClick={onCancel} type="button">
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

// Categories and languages rarely change: the last ones read stay usable if a
// later refresh fails, so an outage never takes an open editor away.
let lastMeta = null;

/**
 * Categories and languages (for the editor's menus and the previews).
 * `meta` is null only if they have never been read; `error` is set while the
 * library cannot be read.
 */
export function useLibraryMeta() {
  const version = useLibraryVersion();
  const result = useAsync(getLibrary, [version]);
  if (result.data) lastMeta = result.data;
  return { meta: result.data ?? lastMeta, error: result.status === "error" ? result.error : null };
}

/**
 * In place of an admin panel while the Library API cannot be reached: nothing
 * can be edited (or saved) until it answers again.
 */
export function LibraryUnavailable({ toolsElement }) {
  return (
    <>
      <PanelTools label="Admin" target={toolsElement}>
        <span className="admin-tools__state">Editing unavailable</span>
      </PanelTools>
      <div className="reader">
        <h2 className="visually-hidden" id={ITEM_TITLE_ID}>
          Editing is unavailable
        </h2>
        <div className="admin-notice admin-notice--error" lang="en" role="alert">
          <p>
            <strong>The Library API can't be reached right now, so editing is unavailable.</strong> Changes you had not
            saved in this tab are kept and offered again.
          </p>
          <div className="admin-notice__actions">
            <button className="button button--small" onClick={refreshLibrary} type="button">
              Retry
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const timeFormatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** "8 Nov 2026, 14:03" in the admin's own time zone. */
export function formatDateTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso ?? "") : timeFormatter.format(date);
}
