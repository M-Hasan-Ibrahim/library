/**
 * Admin sign-in state for the Library website.
 *
 * Sign-in is handled by Cloudflare Access in front of the API's /api/admin/*
 * paths (Google login, one allowed account). The website stores no password
 * and no token: Access keeps an HttpOnly cookie on the API host, which the
 * browser sends with credentialed requests to /api/admin/*. The Worker
 * verifies the Access token on every one of those requests; nothing here
 * grants anything.
 *
 * When the page asks GET /api/admin/session (the server decides):
 * - after any successful login: the Worker's /api/admin/login sends the
 *   browser to "<site>/?admin=signed-in#/" whichever way the login started
 *   (the header's globe, /api/admin/login typed directly, Cloudflare's own
 *   "Log in" button). The marker is removed at once; it grants nothing.
 * - in a browser whose last confirmed state was "signed in" (localStorage
 *   "library.admin", a hint only), so returning admins and new tabs see
 *   "checking" instead of the visitor header (no globe flicker);
 * - on #/admin, before deciding whether a login is needed;
 * - when another tab signs in, and when an admin tab becomes visible again.
 * Plain visitors make no admin request at all (Access would otherwise answer
 * them with a redirect and set a CF_AppSession cookie on the API host).
 * The admin interface (src/admin/) is a separate chunk, loaded only after the
 * API has confirmed the session.
 *
 * States: { status: "signed-out", verified } | { status: "checking" }
 *       | { status: "unavailable" }  (the API could not answer right now)
 *       | { status: "signed-in", email, expiresAt }
 *
 * Only a definite answer from the server (401/403, or a redirect to the Access
 * login) means "signed out". Temporary problems (5xx, network, timeout) keep a
 * confirmed session and retry, so a short outage never logs the admin out of
 * the UI. Open tabs follow sign-in and Sign out in any other tab.
 */
import { API_URL } from "./apiConfig.js";

const FLAG_KEY = "library.admin"; // "1" = last confirmed state was signed in
const EVENT_KEY = "library.admin.event"; // tells other tabs: signed-in / signed-out
const SESSION_TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [3000, 10000, 30000]; // after "unavailable"
const RECHECK_ON_FOCUS_MS = 60 * 1000; // re-check a visible admin tab at most once a minute

/** Admin sign-in needs the API (builds without VITE_LIBRARY_API_URL have none). */
export const adminSignInAvailable = API_URL !== "";
export const ADMIN_LOGIN_URL = `${API_URL}/api/admin/login`;
export const ADMIN_LOGOUT_URL = `${API_URL}/cdn-cgi/access/logout`;

const storage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      // Storage blocked: this tab still works; other tabs update on their next check.
    }
  },
};
const rememberedSignedIn = () => storage.get(FLAG_KEY) === "1";
const announce = (type) => storage.set(EVENT_KEY, JSON.stringify({ type, at: Date.now() }));

/** Reads and removes "?admin=signed-in" (set by the Worker after a login). */
function consumeSignInMarker() {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get("admin") !== "signed-in") return false;
  url.searchParams.delete("admin");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash || "#/"}`);
  return true;
}

const justSignedIn = adminSignInAvailable && consumeSignInMarker();
const signedOut = (verified) => ({ status: "signed-out", verified });
let state = adminSignInAvailable && (justSignedIn || rememberedSignedIn()) ? { status: "checking" } : signedOut(false);
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

/** Page load: ask the server only after a login or in a browser used for admin. */
export function checkAdminSessionOnLoad() {
  if (justSignedIn || rememberedSignedIn()) return checkAdminSession();
  return Promise.resolve(state);
}

/** Asks the API whether this browser has an admin session (the server decides). */
export function checkAdminSession() {
  if (!adminSignInAvailable || signingIn || signingOut) return Promise.resolve(state);
  pendingCheck ??= (async () => {
    clearTimeout(retryTimer);
    const before = state.status;
    try {
      const session = await fetchSession();
      lastCheckedAt = Date.now();
      retryCount = 0;
      if (session) {
        storage.set(FLAG_KEY, "1");
        setState({ status: "signed-in", email: session.email, expiresAt: session.expiresAt });
        if (before !== "signed-in") announce("signed-in");
      } else {
        storage.set(FLAG_KEY, null);
        setState(signedOut(true));
      }
    } catch {
      // Not an answer about the session: keep a confirmed session, retry if this
      // browser is (or was) used for admin; visitors are not retried.
      if (before !== "signed-in") setState({ status: "unavailable" });
      if (before === "signed-in" || before === "checking" || before === "unavailable" || rememberedSignedIn()) scheduleRetry();
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
  storage.set(FLAG_KEY, "1"); // the return trip shows "checking", not the visitor header
  window.location.assign(ADMIN_LOGIN_URL);
}

/**
 * Ends the Access session (Cloudflare revokes it for all Access applications;
 * the API host's cookie is removed). Other open tabs drop their admin
 * controls at once.
 */
export function signOutAdmin() {
  signingOut = true;
  clearTimeout(retryTimer);
  storage.set(FLAG_KEY, null);
  announce("signed-out");
  setState(signedOut(true));
  window.location.assign(ADMIN_LOGOUT_URL);
}

if (adminSignInAvailable && typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== EVENT_KEY || !event.newValue) return;
    let type;
    try {
      ({ type } = JSON.parse(event.newValue));
    } catch {
      return;
    }
    if (type === "signed-out") {
      clearTimeout(retryTimer);
      setState(signedOut(true));
    } else if (type === "signed-in" && state.status !== "signed-in") {
      checkAdminSession();
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
  // Coming back to an admin tab: pick up sign-outs and expiry from elsewhere.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const adminTab = state.status === "signed-in" || state.status === "unavailable" || rememberedSignedIn();
    if (!adminTab) return;
    const expired = state.status === "signed-in" && Date.now() >= Date.parse(state.expiresAt);
    if (state.status === "unavailable" || expired || Date.now() - lastCheckedAt >= RECHECK_ON_FOCUS_MS) {
      retryCount = 0;
      checkAdminSession();
    }
  });
}
