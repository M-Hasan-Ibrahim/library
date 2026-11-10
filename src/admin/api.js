/**
 * Client for the admin API (worker/src/admin.js). Admin-only chunk.
 *
 * Every request carries the browser's Cloudflare Access cookie for the API
 * host (credentials: "include"); the website itself holds no token. Requests
 * never follow redirects: a missing or expired Access session answers with a
 * redirect to the sign-in page, which is reported as kind "session".
 * Responses are never cached (cache: "no-store"), so the admin always edits
 * the current database content, never a copy.
 *
 * Failures are AdminApiError with a `kind`:
 *   session      sign-in missing or expired (redirect, 401, 403 from Access)
 *   validation   422, `fields` maps each field to a reason
 *   conflict     409, the item changed since it was loaded (or slug taken)
 *   not_found    404
 *   forbidden    403 from the Worker's origin check
 *   too_large    413
 *   bad_request  400 / 415
 *   server       5xx or an unreadable answer
 *   network      no answer (offline, DNS, CORS)
 *   timeout      no answer in time (a write may still have been applied)
 */

const READ_TIMEOUT_MS = 12_000;
const WRITE_TIMEOUT_MS = 20_000;
const ITEM_ID = /^itm_[a-z0-9]+(?:_[a-z0-9]+)*$/;

export class AdminApiError extends Error {
  constructor(kind, { status = 0, body = null, message } = {}) {
    super(message ?? body?.error ?? `Admin API: ${kind}`);
    this.name = "AdminApiError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }

  get code() {
    return this.body?.code ?? null;
  }

  get fields() {
    const fields = this.body?.fields;
    return fields && typeof fields === "object" ? fields : null;
  }
}

function classify(status, body) {
  if (status === 401) return "session";
  if (status === 403) return body?.code === "forbidden_origin" ? "forbidden" : "session";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 411 || status === 415) return "bad_request";
  if (status === 0) return "network";
  return "server";
}

function itemPath(id, suffix = "") {
  if (typeof id !== "string" || !ITEM_ID.test(id)) throw new AdminApiError("bad_request", { message: "Invalid item id" });
  return `/api/admin/items/${id}${suffix}`;
}

/**
 * @param {{ baseUrl: string, fetch?: typeof fetch }} options
 */
export function createAdminApi({ baseUrl, fetch: fetchImpl = (...args) => globalThis.fetch(...args) }) {
  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        credentials: "include",
        redirect: "manual",
        cache: "no-store",
        headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const kind = error?.name === "AbortError" ? "timeout" : "network";
      throw new AdminApiError(kind, { message: kind === "timeout" ? "The server did not answer in time" : "The server could not be reached" });
    } finally {
      clearTimeout(timer);
    }

    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new AdminApiError("session", { status: response.status, message: "Admin sign-in required" });
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.ok) {
      if (data === null || typeof data !== "object") throw new AdminApiError("server", { status: response.status, message: "Unexpected answer from the server" });
      return data;
    }
    throw new AdminApiError(classify(response.status, data), { status: response.status, body: data });
  }

  return {
    listItems: () => request("GET", "/api/admin/items"),
    getItem: async (id) => request("GET", itemPath(id)),
    createItem: (fields) => request("POST", "/api/admin/items", fields),
    updateItem: async (id, changes) => request("PATCH", itemPath(id), changes),
    deleteItem: async (id, revision) => request("DELETE", itemPath(id), { revision }),
    publishItem: async (id, revision) => request("POST", itemPath(id, "/publish"), { revision }),
    unpublishItem: async (id, revision) => request("POST", itemPath(id, "/unpublish"), { revision }),
    restoreItem: async (id, revision, fromRevision) => request("POST", itemPath(id, "/restore"), { revision, fromRevision }),
    itemHistory: async (id) => request("GET", itemPath(id, "/revisions")),
    itemRevision: async (id, revision) => {
      if (!Number.isInteger(revision) || revision < 1) throw new AdminApiError("bad_request", { message: "Invalid revision" });
      return request("GET", itemPath(id, `/revisions/${revision}`));
    },
    deletedItems: () => request("GET", "/api/admin/deleted-items"),
    session: () => request("GET", "/api/admin/session"),
    youtubeInfo: async (videoId) => {
      if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new AdminApiError("bad_request", { message: "Invalid video id" });
      return request("GET", `/api/admin/youtube/${videoId}`);
    },
  };
}

/**
 * Uploads one PDF to POST /api/admin/files with upload progress (fetch has
 * none, so this uses XMLHttpRequest). Resolves to { file: { key, url, name,
 * size } }; rejects with AdminApiError. `onProgress(sent, total)`;
 * `signal` (AbortSignal) cancels. Redirects cannot be stopped here, so the
 * caller checks the session first (an expired session then shows up as
 * kind "network").
 */
export function uploadPdf(baseUrl, file, { onProgress = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${baseUrl}/api/admin/files`);
    xhr.withCredentials = true;
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader("Content-Type", "application/pdf");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name ?? "document.pdf"));
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const done = (fn) => {
      signal?.removeEventListener("abort", abort);
      fn();
    };
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status === 201 && body?.file?.url) done(() => resolve(body));
      else done(() => reject(new AdminApiError(xhr.status === 413 ? "too_large" : classify(xhr.status, body), { status: xhr.status, body })));
    };
    xhr.onerror = () => done(() => reject(new AdminApiError("network", { message: "The upload could not reach the server" })));
    xhr.ontimeout = () => done(() => reject(new AdminApiError("timeout", { message: "The upload took too long" })));
    xhr.onabort = () => done(() => reject(new AdminApiError("aborted", { message: "Upload cancelled" })));
    xhr.send(file);
  });
}

/** A short, plain-language description of a failure, for the admin. */
export function describeError(error) {
  // services/libraryRepository.js: the library itself could not be read.
  if (error?.name === "LibraryUnavailableError") return "The Library API can't be reached right now, so editing is unavailable.";
  switch (error?.kind) {
    case "session":
      return "Your admin sign-in has expired.";
    case "network":
      return "The server could not be reached. Check the connection and try again.";
    case "timeout":
      return "The server did not answer in time. Try again (reload first if you were saving: it may have been saved).";
    case "forbidden":
      return "The server refused this request because it did not come from the Library website.";
    case "too_large":
      return error.body?.error ?? "This is too large to save (256 KB at most).";
    case "rate_limited":
      return error.body?.error ?? "Too many requests. Wait a minute and try again.";
    case "not_found":
      return error.body?.code === "video_not_found" ? error.body.error : "This item no longer exists. It may have been deleted elsewhere.";
    case "conflict":
      return "This item was changed elsewhere since it was opened.";
    case "validation":
      return "Some fields are not valid.";
    case "bad_request":
      return error.body?.error ?? "The server could not read this request.";
    case "aborted":
      return "Cancelled.";
    case "server":
      return error.body?.error && error.status >= 500 && error.body?.code ? error.body.error : "The server had a problem. Try again in a moment.";
    default:
      return "The server had a problem. Try again in a moment.";
  }
}
