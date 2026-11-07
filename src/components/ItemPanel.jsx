import { useEffect, useLayoutEffect, useRef, useState } from "react";
import useAsync from "../hooks/useAsync.js";
import useDocumentTitle from "../hooks/useDocumentTitle.js";
import { closeItem } from "../router.js";
import { getItem } from "../services/libraryRepository.js";
import ItemView, { ITEM_TITLE_ID } from "./ItemView.jsx";
import { PanelScrollContext } from "./panelScrollContext.js";
import { EmptyState, ErrorState, LoadingState } from "./StatusMessage.jsx";

/**
 * Bottom sheet that opens library items, reproducing the portfolio's project
 * modal (Portfolio/src/pages/Projects.jsx + .project-modal styles): a dimmed,
 * blurred backdrop and a window that rises from the bottom of the screen.
 *
 * Built on a native modal <dialog>, which adds what the portfolio version
 * lacks: focus stays inside while open, the page behind is inert, and Escape
 * is handled by the browser. Background scrolling is locked while open, and
 * focus returns to the card that opened the panel.
 */
export default function ItemPanel({ slug }) {
  const dialogRef = useRef(null);
  const [scrollElement, setScrollElement] = useState(null);
  const backdropPressRef = useRef(false);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  const result = useAsync(() => getItem(slug), [slug]);
  const item = result.status === "success" ? result.data : null;
  useDocumentTitle(item?.title);

  // Open as a modal on mount; on unmount, unlock scrolling and restore focus.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;

    root.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();

    return () => {
      root.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();

      const card = document.querySelector(`[data-item-link="${CSS.escape(slugRef.current)}"]`);
      const target = opener instanceof HTMLElement && opener !== document.body && opener.isConnected ? opener : card;
      target?.focus({ preventScroll: true });
    };
  }, []);

  // Start every item at the top, and put keyboard focus on the scrolling
  // area so arrow keys / Page Down scroll the content immediately.
  useEffect(() => {
    if (!scrollElement) return;
    scrollElement.scrollTop = 0;
    scrollElement.focus({ preventScroll: true });
  }, [scrollElement, slug]);

  const handleCancel = (event) => {
    event.preventDefault(); // let the URL drive closing (keeps Back button in sync)
    closeItem();
  };

  // If the browser closed the dialog itself (while still mounted), sync the URL.
  const handleClose = () => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) closeItem();
  };

  // Close on a click that both starts and ends on the backdrop (not when a
  // text selection inside the panel is dragged outside it).
  const handlePointerDown = (event) => {
    backdropPressRef.current = event.target === event.currentTarget;
  };
  const handleClick = (event) => {
    if (event.target === event.currentTarget && backdropPressRef.current) closeItem();
  };

  return (
    <dialog
      aria-label={item ? undefined : "Library item"}
      aria-labelledby={item ? ITEM_TITLE_ID : undefined}
      className="item-panel"
      onCancel={handleCancel}
      onClick={handleClick}
      onClose={handleClose}
      onPointerDown={handlePointerDown}
      ref={dialogRef}
    >
      <div className="item-panel__window">
        <div className="item-panel__bar">
          <button aria-label="Close" className="item-panel__close" onClick={closeItem} type="button">
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="item-panel__content" ref={setScrollElement} tabIndex={-1}>
          <PanelScrollContext.Provider value={scrollElement}>
            {result.status === "loading" && <LoadingState label="Opening…" />}
            {result.status === "error" && (
              <ErrorState message={result.error.message} title="This item could not be opened." />
            )}
            {result.status === "success" && !item && (
              <EmptyState title="This item is not in the library.">
                <span>It may have been removed or renamed.</span>
              </EmptyState>
            )}
            {item && <ItemView item={item} key={item.slug} />}
          </PanelScrollContext.Provider>
        </div>
      </div>
    </dialog>
  );
}
