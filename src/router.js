/**
 * URL state for the library (hash-based, like the portfolio, so it works on
 * any static host). Everything a visitor sees is described by the URL:
 *
 *   #/?q=git&category=science&type=pdf&lang=en&item=some-slug
 *
 * - Search and filters REPLACE the current history entry (no Back-button spam).
 * - Opening an item PUSHES an entry, so Back (or Android's back gesture)
 *   closes the panel and returns to the same filtered list.
 * - `panel` names an admin-only panel ("new" item, "deleted" items). It opens
 *   in the same reading panel with the same history behaviour; the app
 *   ignores it unless the admin is signed in.
 */

const PARAM_KEYS = ["q", "category", "type", "lang", "item", "panel"];
const PANEL_ENTRY = "libraryPanel";
const listeners = new Set();
let isGoingBack = false;

const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    isGoingBack = false;
  });
}

export function subscribe(listener) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
  };
}

export const getHash = () => window.location.hash;

/** @returns {{ path: string, params: { q: string, category: string, type: string, lang: string, item: string, panel: string } }} */
export function parseLocation(hash) {
  const raw = hash.replace(/^#/, "");
  const queryStart = raw.indexOf("?");
  const pathPart = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const search = new URLSearchParams(queryStart === -1 ? "" : raw.slice(queryStart + 1));
  const params = Object.fromEntries(PARAM_KEYS.map((key) => [key, search.get(key) ?? ""]));
  return { path: pathPart.replace(/\/+$/, "") || "/", params };
}

export function buildHash(params) {
  const search = new URLSearchParams();
  for (const key of PARAM_KEYS) {
    if (params[key]) search.set(key, params[key]);
  }
  const query = search.toString();
  return query ? `#/?${query}` : "#/";
}

const currentParams = () => parseLocation(window.location.hash).params;

function write(hash, { replace, state = window.history.state }) {
  if (replace) window.history.replaceState(state, "", hash);
  else window.history.pushState(state, "", hash);
  notify();
}

/** Search and filters: updates the URL in place (an admin panel is never open meanwhile). */
export function updateParams(changes) {
  write(buildHash({ ...currentParams(), panel: "", ...changes }), { replace: true });
}

/** Link target for an item, keeping the current filters. */
export const itemHref = (slug) => buildHash({ ...currentParams(), item: slug, panel: "" });

function showInPanel(changes) {
  const params = currentParams();
  const hash = buildHash({ ...params, item: "", panel: "", ...changes });
  if (params.item || params.panel) {
    // Already reading something: swap content without stacking history.
    write(hash, { replace: true });
  } else {
    write(hash, { replace: false, state: { [PANEL_ENTRY]: true } });
  }
}

export function openItem(slug) {
  showInPanel({ item: slug });
}

/** Admin panels ("new", "deleted"): same history behaviour as an item. */
export function openPanel(name) {
  showInPanel({ panel: name });
}

export function closeItem() {
  if (isGoingBack) return; // a close is already in progress
  if (window.history.state?.[PANEL_ENTRY]) {
    // We opened this entry: going back restores the exact list URL.
    isGoingBack = true;
    window.history.back();
    return;
  }
  // Opened from a shared link: remove the item from the URL instead.
  write(buildHash({ ...currentParams(), item: "", panel: "" }), { replace: true });
}

/**
 * Click handler for in-app links like "#/?item=slug" (used in rich text).
 * Returns true when it handled the click.
 */
export function followInternalLink(event, href) {
  const { path, params } = parseLocation(href);
  if (path !== "/" || !params.item) return false;
  event.preventDefault();
  openItem(params.item);
  return true;
}

/** True for clicks that should open in a new tab/window instead. */
export const isModifiedClick = (event) =>
  event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
