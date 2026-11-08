import { useEffect } from "react";
import PageHeader from "../components/PageHeader.jsx";
import useAdminSession from "../hooks/useAdminSession.js";
import useDocumentTitle from "../hooks/useDocumentTitle.js";
import { checkAdminSession, startAdminSignIn } from "../services/adminSession.js";

/**
 * #/admin (reached from the header's "Admin login" globe). Once the API has
 * answered: signed in -> confirmation (no new login); signed out -> Cloudflare
 * Access (Google sign-in), which returns to the library at #/; API unavailable
 * -> a message with "Try again" (never a redirect loop).
 */
export default function AdminSignInPage() {
  const session = useAdminSession();
  useDocumentTitle("Admin sign-in");

  useEffect(() => {
    if (session.status !== "signed-out") return;
    if (session.verified) startAdminSignIn();
    else checkAdminSession(); // wait for the server's answer first
  }, [session]);

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
