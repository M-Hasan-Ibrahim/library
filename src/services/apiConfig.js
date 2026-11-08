/**
 * Address of the Library API Worker, set at build time with
 * VITE_LIBRARY_API_URL (e.g. https://api.library.mh-ibrahim.com).
 * Empty = no API: the site uses its bundled JSON and admin sign-in is off.
 */
export const API_URL = String(import.meta.env.VITE_LIBRARY_API_URL ?? "").trim().replace(/\/+$/, "");
