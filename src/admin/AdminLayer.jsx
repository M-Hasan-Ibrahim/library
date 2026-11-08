import { useEffect } from "react";
import { createPortal } from "react-dom";
import useEditMode from "../hooks/useEditMode.js";
import { openPanel } from "../router.js";
import { checkAdminSession, signOutAdmin } from "../services/adminSession.js";
import { setEditMode, subscribeEditMode } from "../services/editMode.js";
import { refreshLibrary, setAdminSource } from "../services/libraryRepository.js";
import { adminSource, useAdminCatalog } from "./catalog.js";
import { clearFlash, useFlash } from "./flash.js";
import "./admin.css";

/**
 * The signed-in admin's header controls. This file is a separate chunk,
 * loaded after the API has confirmed the session, so visitors never
 * download it. While mounted it plugs the admin data source into the
 * library (drafts and fresh data), and removes it again on sign-out.
 * (Re-checks on tab focus and across tabs live in services/adminSession.js.)
 */
export default function AdminLayer({ session }) {
  const editMode = useEditMode();
  const catalog = useAdminCatalog();
  const unavailable = catalog.availability === "unavailable";

  // Re-check when the Access session expires, so the UI never pretends to be signed in.
  useEffect(() => {
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt)) return undefined;
    const timer = setTimeout(checkAdminSession, Math.min(Math.max(expiresAt - Date.now(), 0) + 1000, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [session.expiresAt]);

  useEffect(() => {
    setAdminSource(adminSource);
    const stopWatching = subscribeEditMode(refreshLibrary); // drafts appear / disappear
    return () => {
      stopWatching();
      setAdminSource(null);
    };
  }, []);

  const startNewItem = () => {
    setEditMode(true);
    openPanel("new");
  };

  return (
    <span className="admin-bar">
      <span className="admin-bar__label" title={`Signed in as ${session.email}`}>
        Admin<span className="visually-hidden">, signed in as {session.email}</span>
      </span>
      {unavailable && (
        <span className="admin-bar__problem" role="status">
          Editing unavailable
          <button className="button button--small" onClick={refreshLibrary} type="button">
            Retry
          </button>
        </span>
      )}
      {/* Narrow screens show "New" and "Edit"; the accessible names stay complete. */}
      <button
        aria-disabled={unavailable || undefined}
        aria-label="New item"
        className="button button--small"
        onClick={() => !unavailable && startNewItem()}
        title={unavailable ? "The admin API cannot be reached right now" : undefined}
        type="button"
      >
        New<span className="admin-bar__long"> item</span>
      </button>
      <button
        aria-label="Edit mode"
        aria-pressed={editMode}
        className="button button--small admin-toggle"
        onClick={() => setEditMode(!editMode)}
        type="button"
      >
        Edit<span className="admin-bar__long"> mode</span>
      </button>
      <button className="button button--small" onClick={signOutAdmin} type="button">
        Sign out
      </button>
      <AdminToast />
    </span>
  );
}

/** Confirmations shown on the page after a panel closed (e.g. "Deleted"). */
function AdminToast() {
  const message = useFlash();
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => clearFlash(message.id), 7000);
    return () => clearTimeout(timer);
  }, [message]);

  return createPortal(
    <div className="admin-toast-region" role="status">
      {message && (
        <p className="admin-toast">
          {message.text}
          <button aria-label="Dismiss" className="admin-toast__close" onClick={() => clearFlash(message.id)} type="button">
            <span aria-hidden="true">✕</span>
          </button>
        </p>
      )}
    </div>,
    document.body,
  );
}
