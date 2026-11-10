/**
 * The admin's library data, plugged into services/libraryRepository.js while
 * signed in (setAdminSource in AdminLayer).
 *
 * Items come from GET /api/admin/items (never cached, drafts included);
 * categories and languages from the public API. With Edit mode off, drafts
 * are left out, so the admin sees exactly what visitors see, only fresher.
 * If the admin API cannot be read, the repository uses the public API instead
 * (published items only) and `availability` becomes "unavailable": every
 * editing control is then disabled until a retry succeeds. If neither can be
 * read, the views show an error with Retry (never other content).
 */
import { useSyncExternalStore } from "react";
import { checkAdminSession } from "../services/adminSession.js";
import { getEditMode } from "../services/editMode.js";
import { itemDetails, loadPublicLibrary } from "../services/libraryRepository.js";
import { adminApi } from "./client.js";

let list = null; // last GET /api/admin/items answer: { items, counts }
let state = { availability: "loading", error: null, counts: null };
const listeners = new Set();

function setState(changes) {
  state = { ...state, ...changes };
  listeners.forEach((listener) => listener());
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** { availability: "loading" | "ok" | "unavailable", error, counts } */
export const useAdminCatalog = () => useSyncExternalStore(subscribe, () => state);

const countsOf = (items) => ({
  total: items.length,
  published: items.filter((item) => item.status === "published").length,
  draft: items.filter((item) => item.status === "draft").length,
});

export const adminSource = {
  name: "admin",
  async loadLibrary() {
    const [publicData, data] = await Promise.all([loadPublicLibrary(), adminApi.listItems()]);
    if (!Array.isArray(data?.items)) throw new Error("Unexpected /api/admin/items answer");
    list = data;
    setState({ availability: "ok", error: null, counts: countsOf(data.items) });
    return {
      categories: publicData.categories,
      languages: publicData.languages,
      items: getEditMode() ? data.items : data.items.filter((item) => item.status === "published"),
    };
  },
  async loadDetails(slug) {
    const id = await findItemId(slug);
    if (!id) throw new Error(`Item "${slug}" was not found`);
    const { item } = await adminApi.getItem(id);
    return itemDetails(item);
  },
  reportFailure(error) {
    setState({ availability: "unavailable", error });
    // A sign-in problem while just browsing: let the session state catch up.
    if (error?.kind === "session") checkAdminSession();
  },
};

/** The id for a slug (re-reading the list once if it is not known yet). */
export async function findItemId(slug) {
  const known = list?.items.find((item) => item.slug === slug);
  if (known) return known.id;
  list = await adminApi.listItems();
  return list.items.find((item) => item.slug === slug)?.id ?? null;
}

/** Keeps the cached list in step with an item the admin just saved. */
export function rememberItem(item) {
  if (!list || !item?.id) return;
  const { blocks: _blocks, ...summary } = item;
  const items = list.items.some((entry) => entry.id === item.id)
    ? list.items.map((entry) => (entry.id === item.id ? summary : entry))
    : [summary, ...list.items];
  list = { ...list, items };
  setState({ counts: countsOf(items) });
}

export function forgetItem(id) {
  if (!list) return;
  const items = list.items.filter((entry) => entry.id !== id);
  list = { ...list, items };
  setState({ counts: countsOf(items) });
}
