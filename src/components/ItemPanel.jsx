import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import useAsync from "../hooks/useAsync.js";
import useDocumentTitle from "../hooks/useDocumentTitle.js";
import useLibraryVersion from "../hooks/useLibraryVersion.js";
import { closeItem } from "../router.js";
import { getItem, refreshLibrary } from "../services/libraryRepository.js";
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
 *
 * `AdminContent` (signed-in admin only, from src/admin/) replaces the reading
 * view with the admin's view of the same panel. It receives a toolbar slot in
 * the panel's top bar and can hold the panel open while it has unsaved changes
 * (`closeGuardRef.current()` returns false). Visitors never get either.
 */
export default function ItemPanel({ slug, panel = "", AdminContent = null }) {
  const dialogRef = useRef(null);
  const [scrollElement, setScrollElement] = useState(null);
  const [toolsElement, setToolsElement] = useState(null);
  const closeGuardRef = useRef(null);
  const backdropPressRef = useRef(false);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  const libraryVersion = useLibraryVersion();
  const isAdmin = AdminContent !== null;
  const result = useAsync(() => (isAdmin ? null : getItem(slug)), [slug, libraryVersion, isAdmin]);
  // While the same item is read again (after an admin change elsewhere), keep showing it.
  const item = !isAdmin && result.data?.slug === slug ? result.data : null;
  const loading = result.status === "loading" && !item;
  useDocumentTitle(isAdmin ? null : item?.title);

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
  }, [scrollElement, slug, panel]);

  // Closing asks the admin content first (it may have unsaved changes).
  const requestClose = () => {
    if (closeGuardRef.current && closeGuardRef.current() === false) return;
    closeItem();
  };

  const handleCancel = (event) => {
    event.preventDefault(); // let the URL drive closing (keeps Back button in sync)
    requestClose();
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
    if (event.target === event.currentTarget && backdropPressRef.current) requestClose();
  };

  // The admin content always renders an element with ITEM_TITLE_ID once loaded;
  // until then the fallback label names the dialog.
  const labelled = isAdmin || Boolean(item);

  return (
    <dialog
      aria-label={labelled && !isAdmin ? undefined : "Library item"}
      aria-labelledby={labelled ? ITEM_TITLE_ID : undefined}
      className="item-panel"
      onCancel={handleCancel}
      onClick={handleClick}
      onClose={handleClose}
      onPointerDown={handlePointerDown}
      ref={dialogRef}
    >
      <div className="item-panel__window">
        <div className="item-panel__bar">
          {isAdmin && <div className="item-panel__tools" ref={setToolsElement} />}
          <button aria-label="Close" className="item-panel__close" onClick={requestClose} type="button">
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="item-panel__content" ref={setScrollElement} tabIndex={-1}>
          <PanelScrollContext.Provider value={scrollElement}>
            {isAdmin ? (
              <Suspense fallback={<LoadingState label="Opening…" />}>
                <AdminContent closeGuardRef={closeGuardRef} panel={panel} slug={slug} toolsElement={toolsElement} />
              </Suspense>
            ) : (
              <>
                {loading && <LoadingState label="Opening…" />}
                {result.status === "error" && (
                  <ErrorState message="The library can't be reached right now. Please check your connection, then try again." title="This item could not be opened.">
                    <button className="button" onClick={refreshLibrary} type="button">
                      Retry
                    </button>
                  </ErrorState>
                )}
                {result.status === "success" && !item && (
                  <EmptyState title="This item is not in the library.">
                    <span>It may have been removed or renamed.</span>
                  </EmptyState>
                )}
                {item && <ItemView item={item} key={item.slug} />}
              </>
            )}
          </PanelScrollContext.Provider>
        </div>
      </div>
    </dialog>
  );
}
