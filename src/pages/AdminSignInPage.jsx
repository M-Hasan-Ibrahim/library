import { useEffect } from "react";
import PageHeader from "../components/PageHeader.jsx";
import useAdminSession from "../hooks/useAdminSession.js";
import useDocumentTitle from "../hooks/useDocumentTitle.js";
import { startAdminSignIn } from "../services/adminSession.js";

/**
 * #/admin (not linked anywhere). Sends the admin to Cloudflare Access
 * (Google sign-in), which returns to the library at #/. Visiting it while
 * signed in just confirms the session.
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

  return (
    <div className="page">
      <PageHeader eyebrow="Admin" lede="Opening the secure sign-in page…" title="Signing in" />
    </div>
  );
}
