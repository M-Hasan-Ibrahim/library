/**
 * Short confirmations for the admin.
 *  - flash(text): shown on the page once a panel has closed (e.g. "Deleted").
 *  - setPanelNotice(slug, text): shown when that item's panel opens next
 *    (e.g. "Saved as a draft" right after creating it).
 */
import { useSyncExternalStore } from "react";

let message = null; // { id, text }
const listeners = new Set();
const panelNotices = new Map();

export function flash(text) {
  message = { id: Date.now(), text };
  listeners.forEach((listener) => listener());
}

export function clearFlash(id) {
  if (message?.id !== id) return;
  message = null;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useFlash = () => useSyncExternalStore(subscribe, () => message);

export const setPanelNotice = (slug, text) => panelNotices.set(slug, text);

export function takePanelNotice(slug) {
  const text = panelNotices.get(slug) ?? null;
  panelNotices.delete(slug);
  return text;
}
