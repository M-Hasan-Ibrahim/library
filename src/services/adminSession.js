/**
 * Admin sign-in state for the Library website.
 *
 * Sign-in is handled by Cloudflare Access in front of the API's /api/admin/*
 * paths (Google login, one allowed account). The website stores no password
 * and no token: Access keeps an HttpOnly cookie on the API host, which the
 * browser sends with credentialed requests to /api/admin/*. The Worker
 * verifies the Access token on every one of those requests.
 *
 * Visitors are never affected:
 * - Nothing is requested unless this browser has been used to sign in
 *   (a "library.admin" flag in localStorage, set when a sign-in starts and
 *   removed by Sign out). The flag is only a hint for the UI; it grants nothing.
 * - The admin interface (src/admin/) is a separate chunk, loaded only after
 *   the API has confirmed the session.
 *
 * States: { status: "signed-out" } | { status: "checking" }
 *       | { status: "unavailable" }  (the API could not confirm right now)
 *       | { status: "signed-in", email, expiresAt }
 *
 * Only a definite answer from the server (401/403, or a redirect to the
 * Access login) means "signed out". Temporary problems (5xx, network,
 * timeout) keep the previous state and retry, so a short outage never logs
 * the admin out of the UI. Open tabs stay in sync through the flag.
 */
import { API_URL } from "./apiConfig.js";

const FLAG_KEY = "library.admin";
const SIGNAL_KEY = "library.admin.signed-in"; // tells other tabs to re-check
const SESSION_TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [3000, 10000, 30000]; // after "unavailable"
const RECHECK_ON_FOCUS_MS = 60 * 1000; // re-check a visible tab at most once a minute

/** Admin sign-in needs the API (builds without VITE_LIBRARY_API_URL have none). */
export const adminSignInAvailable = API_URL !== "";
export const ADMIN_LOGIN_URL = `${API_URL}/api/admin/login`;
export const ADMIN_LOGOUT_URL = `${API_URL}/cdn-cgi/access/logout`;

function readFlag() {
  try {
    return window.localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFlag(on) {
  try {
    if (on) window.localStorage.setItem(FLAG_KEY, "1");
    else window.localStorage.removeItem(FLAG_KEY);
  } catch {
    // Storage blocked: sign-in still works for this page view only.
  }
}

const SIGNED_OUT = Object.freeze({ status: "signed-out" });
let state = adminSignInAvailable && readFlag() ? { status: "checking" } : SIGNED_OUT;
let signingIn = false;
let signingOut = false;
let lastCheckedAt = 0;
let retryTimer = null;
let retryCount = 0;
const listeners = new Set();

function setState(next) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribeAdminSession(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getAdminSession = () => state;

class TemporaryError extends Error {}

/** @returns {Promise<{ email: string, expiresAt: string } | null>} null = not signed in */
async function fetchSession() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_URL}/api/admin/session`, {
      credentials: "include", // the Access cookie for the API host
      // A missing or expired Access session answers with a redirect to the
      // login page; "manual" turns that into a plain "not signed in".
      redirect: "manual",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new TemporaryError(`Admin session: ${error?.name ?? "network error"}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) return null;
  if (response.status !== 200) throw new TemporaryError(`Admin session: HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  if (typeof data?.email !== "string" || data.email === "") throw new TemporaryError("Admin session: unexpected response");
  return data;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (retryCount >= RETRY_DELAYS_MS.length) return; // focus or "Try again" will check again
  retryTimer = setTimeout(checkAdminSession, RETRY_DELAYS_MS[retryCount]);
  retryCount += 1;
}

let pendingCheck = null;

/** Asks the API who is signed in, but only if this browser is used for admin. */
export function checkAdminSession() {
  if (!adminSignInAvailable || signingIn || signingOut) return Promise.resolve(state);
  if (!readFlag()) {
    if (state !== SIGNED_OUT) setState(SIGNED_OUT);
    return Promise.resolve(state);
  }
  pendingCheck ??= (async () => {
    clearTimeout(retryTimer);
    if (state.status === "signed-out") setState({ status: "checking" });
    try {
      const session = await fetchSession();
      lastCheckedAt = Date.now();
      retryCount = 0;
      const wasSignedIn = state.status === "signed-in";
      setState(session ? { status: "signed-in", email: session.email, expiresAt: session.expiresAt } : SIGNED_OUT);
      if (session && !wasSignedIn) {
        try {
          window.localStorage.setItem(SIGNAL_KEY, String(Date.now()));
        } catch {
          // Other tabs will notice on their next check instead.
        }
      }
    } catch {
      // Not an answer about the session: keep what we know and try again.
      if (state.status !== "signed-in") setState({ status: "unavailable" });
      scheduleRetry();
    } finally {
      pendingCheck = null;
    }
    return state;
  })();
  return pendingCheck;
}

/** Sends the browser to Cloudflare Access (Google sign-in); it comes back to #/. */
export function startAdminSignIn() {
  if (!adminSignInAvailable || signingOut) return;
  signingIn = true;
  writeFlag(true);
  window.location.assign(ADMIN_LOGIN_URL);
}

/**
 * Ends the Access session (Cloudflare revokes it for all Access applications;
 * the API host's cookie is removed). Other open tabs see the flag disappear
 * and drop their admin controls at once.
 */
export function signOutAdmin() {
  signingOut = true;
  clearTimeout(retryTimer);
  writeFlag(false);
  setState(SIGNED_OUT);
  window.location.assign(ADMIN_LOGOUT_URL);
}

if (adminSignInAvailable && typeof window !== "undefined") {
  // Another tab signed out (flag removed) or started a sign-in (flag set).
  window.addEventListener("storage", (event) => {
    if (event.key === SIGNAL_KEY) {
      if (state.status !== "signed-in") checkAdminSession();
      return;
    }
    if (event.key !== FLAG_KEY && event.key !== null) return;
    if (readFlag()) checkAdminSession();
    else {
      clearTimeout(retryTimer);
      if (state !== SIGNED_OUT) setState(SIGNED_OUT);
    }
  });
  // Back button from the sign-in/out pages restores this page from the cache:
  // the navigation it started did not happen, so allow checks again.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    signingIn = false;
    signingOut = false;
    checkAdminSession();
  });
  // Coming back to a tab: pick up sign-ins, sign-outs and expiry from elsewhere.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !readFlag()) return;
    const expired = state.status === "signed-in" && Date.now() >= Date.parse(state.expiresAt);
    if (state.status === "unavailable" || expired || Date.now() - lastCheckedAt >= RECHECK_ON_FOCUS_MS) {
      retryCount = 0;
      checkAdminSession();
    }
  });
}
