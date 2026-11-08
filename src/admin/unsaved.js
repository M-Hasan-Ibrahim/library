/**
 * Unsaved edits, kept in this tab (sessionStorage) while the admin types.
 *
 * If the editor closes before saving (Back button, sign-in expired, the API
 * went away, the tab reloaded), the next time the item is opened the admin is
 * offered the unsaved changes again. Key: the item id, or "new" for a new
 * item. Removed as soon as the changes are saved or discarded. Only the
 * admin's own text is stored; nothing here is sent anywhere.
 */
const PREFIX = "library.admin.unsaved.";
const VERSION = 1;

export function saveUnsaved(key, data) {
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify({ v: VERSION, savedAt: Date.now(), ...data }));
  } catch {
    // Storage full or blocked: the editor still works, without this safety net.
  }
}

export function readUnsaved(key) {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data?.v === VERSION && data.form && typeof data.form === "object" ? data : null;
  } catch {
    return null;
  }
}

export function clearUnsaved(key) {
  try {
    window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}
