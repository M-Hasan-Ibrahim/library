import { useEffect, useState } from "react";

// Local data usually arrives within a frame; waiting briefly before showing
// the loading message avoids a distracting flash on every navigation.
const LOADING_MESSAGE_DELAY_MS = 250;

export function LoadingState({ label = "Loading…" }) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsVisible(true), LOADING_MESSAGE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className={`state ${isVisible ? "" : "state--pending"}`} role="status">
      {isVisible ? label : null}
    </div>
  );
}

export function EmptyState({ title, children }) {
  return (
    <div className="state">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function ErrorState({ title, message, children }) {
  return (
    <div className="state state--error" role="alert">
      <strong>{title}</strong>
      {message && <span>{message}</span>}
      {children}
    </div>
  );
}
