import { useRef } from "react";
import GlobeIcon from "./GlobeIcon.jsx";

const PORTFOLIO_URL = "https://mh-ibrahim.com";

/**
 * `headerTools`: admin-only controls (only when signed in).
 * `showAdminLogin`: the "Admin login" globe (when not signed in).
 */
export default function SiteLayout({ children, headerTools = null, showAdminLogin = false }) {
  const mainRef = useRef(null);

  // The app uses hash routing, so "#main" would be read as a route. The skip
  // link moves focus directly instead of changing the URL.
  const skipToContent = (event) => {
    event.preventDefault();
    mainRef.current?.focus();
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main" onClick={skipToContent}>
        Skip to content
      </a>

      <div className="stage">
        <header className="site-header">
          <a className="brand" href="#/">
            <span aria-hidden="true" className="brand__mark">
              <span />
              <span />
              <span />
            </span>
            <span className="brand__text">
              <strong>Library</strong>
              <small>Mohamad Hassan Ibrahim</small>
            </span>
          </a>
          <nav aria-label="Site">
            {headerTools}
            {/* Only opens #/admin; Cloudflare Access and the Worker decide who gets in. */}
            {showAdminLogin && (
              <a aria-label="Admin login" className="button button--icon" href="#/admin" title="Admin login">
                <GlobeIcon />
              </a>
            )}
            <a className="button" href={PORTFOLIO_URL}>
              Portfolio
            </a>
          </nav>
        </header>

        <main className="site-main" id="main" ref={mainRef} tabIndex={-1}>
          {children}
        </main>

        <footer className="site-footer">
          <p>© {new Date().getFullYear()} Mohamad Hassan Ibrahim</p>
        </footer>
      </div>
    </div>
  );
}
