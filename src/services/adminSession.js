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
 * - Nothing is requested unless this browser started an admin sign-in before
 *   (a "library.admin" flag in localStorage). The flag is only a hint for
 *   the UI; it grants nothing.
 * - The admin interface (src/admin/) is a separate chunk, loaded only after
 *   the API has confirmed the session.
 *
 * States: { status: "signed-out" } | { status: "checking" }
 *       | { status: "signed-in", email, expiresAt }
 */
import { API_URL } from "./apiConfig.js";

const FLAG_KEY = "library.admin";
const SESSION_TIMEOUT_MS = 8000;

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
let signingOut = false;
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

async function fetchSession() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}/api/admin/session`, {
      credentials: "include", // the Access cookie for the API host
      // A missing or expired Access session answers with a redirect to the
      // login page; "manual" turns that into a plain "not signed in".
      redirect: "manual",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`Admin session: HTTP ${response.status || response.type}`);
    const data = await response.json();
    if (typeof data?.email !== "string" || data.email === "") throw new Error("Admin session: unexpected response");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

let pendingCheck = null;

/** Asks the API who is signed in, but only if this browser signed in before. */
export function checkAdminSession() {
  if (!adminSignInAvailable || !readFlag()) {
    if (state !== SIGNED_OUT) setState(SIGNED_OUT);
    return Promise.resolve(state);
  }
  pendingCheck ??= (async () => {
    if (state.status !== "signed-in") setState({ status: "checking" });
    try {
      const { email, expiresAt } = await fetchSession();
      setState({ status: "signed-in", email, expiresAt });
    } catch {
      writeFlag(false);
      setState(SIGNED_OUT);
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
  writeFlag(true);
  window.location.assign(ADMIN_LOGIN_URL);
}

/** Ends the Access session on the API host. */
export function signOutAdmin() {
  signingOut = true;
  writeFlag(false);
  setState(SIGNED_OUT);
  window.location.assign(ADMIN_LOGOUT_URL);
}
