import { useEffect } from "react";
import PageHeader from "../components/PageHeader.jsx";
import useAdminSession from "../hooks/useAdminSession.js";
import useDocumentTitle from "../hooks/useDocumentTitle.js";
import { checkAdminSession, startAdminSignIn } from "../services/adminSession.js";

/**
 * #/admin (reached from the header's "Admin login" icon). Sends the admin to
 * Cloudflare Access (Google sign-in), which returns to the library at #/.
 * When already signed in it just confirms the session, without a new login.
 */
export default function AdminSignInPage() {
  const session = useAdminSession();
  useDocumentTitle("Admin sign-in");

  useEffect(() => {
    if (session.status === "signed-out") startAdminSignIn();
  }, [session.status]);

  if (session.status === "signed-in") {
    return (
      <div className="page">
        <PageHeader eyebrow="Admin" lede={`Signed in as ${session.email}.`} title="You are signed in" />
        <a className="button button--primary" href="#/">
          Back to the library
        </a>
      </div>
    );
  }

  if (session.status === "unavailable") {
    // Never redirect in a loop: the server could not answer, so let the admin retry.
    return (
      <div className="page">
        <PageHeader
          eyebrow="Admin"
          lede="Sign-in could not be confirmed right now. Please try again in a moment."
          title="Sign-in unavailable"
        />
        <button className="button button--primary" onClick={() => checkAdminSession()} type="button">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Admin" lede="Opening the secure sign-in page…" title="Signing in" />
    </div>
  );
}
