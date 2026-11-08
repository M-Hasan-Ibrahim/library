/**
 * The admin's "Edit mode" switch (a display preference only).
 *
 * It decides whether the signed-in admin sees drafts and the editing tools,
 * or the library exactly as visitors see it. It grants nothing: it only has
 * an effect while the API confirms an admin session, and every change is
 * checked by the API. Remembered in this browser (localStorage), so a reload
 * keeps the admin's choice.
 */
const KEY = "library.admin.editMode";
const listeners = new Set();

function read() {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = typeof window === "undefined" ? false : read();

export const getEditMode = () => enabled;

export function setEditMode(value) {
  const next = Boolean(value);
  if (next === enabled) return;
  enabled = next;
  try {
    if (enabled) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the switch still works in this tab.
  }
  listeners.forEach((listener) => listener());
}

export function subscribeEditMode(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
