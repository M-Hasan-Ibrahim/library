import { useEffect } from "react";
import { checkAdminSession, signOutAdmin } from "../services/adminSession.js";
import "./admin.css";

/**
 * Everything only the signed-in admin sees. This file is a separate chunk,
 * loaded after the API has confirmed the session, so visitors never
 * download it. Phase 1: sign-in status and sign-out; the inline editing
 * tools will be mounted from here in later phases.
 */
export default function AdminLayer({ session }) {
  // Re-check when the Access session expires, and when the tab comes back
  // after it has expired, so the UI never pretends to be signed in.
  useEffect(() => {
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt)) return undefined;
    const timer = setTimeout(checkAdminSession, Math.min(Math.max(expiresAt - Date.now(), 0) + 1000, 2_000_000_000));
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() >= expiresAt) checkAdminSession();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session.expiresAt]);

  return (
    <span className="admin-bar">
      <span className="admin-bar__label" title={`Signed in as ${session.email}`}>
        Admin<span className="visually-hidden">, signed in as {session.email}</span>
      </span>
      <button className="button button--small" onClick={signOutAdmin} type="button">
        Sign out
      </button>
    </span>
  );
}
