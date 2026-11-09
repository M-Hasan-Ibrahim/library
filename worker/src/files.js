/**
 * Uploaded files (PDFs) in the R2 bucket bound as FILES.
 *
 *   POST /api/admin/files          admin only (admin.js): upload one PDF          201
 *   GET  /api/admin/files/<key>    admin only (admin.js): read any kept upload (drafts,
 *                                  history, not yet saved); ?download=1 = save
 *   GET  /files/<key>              public (index.js): read it, ONLY while a published
 *                                  item uses it; ?download=1 = save
 *   scheduled (index.js)           remove uploads that nothing uses after a day
 *
 * Upload rules: Content-Type application/pdf, Content-Length required and at
 * most 25 MB, the bytes must start like a PDF ("%PDF-") and end like one
 * ("%%EOF", so a cut-off upload is refused). The name sent by the browser
 * (X-File-Name, URI-encoded) is only used, cleaned, as part of the key and
 * for downloads; it never chooses a path. Keys are new random addresses
 * (pdf/<year>/<month>/<16 random characters>-<name>.pdf): nothing is ever
 * overwritten, and replacing an item's PDF uploads a new file, so earlier
 * versions in the history keep theirs.
 *
 * Who can read what: the public address answers only for a file that a
 * published item uses (items.file_url); a draft's file, a file only in the
 * history (replaced, or its item deleted or unpublished), an upload not saved
 * yet and a removed upload all answer the same 404 as an address that never
 * existed, so knowing or guessing an address reveals nothing. The admin reads
 * those through /api/admin/files/<key>, behind Cloudflare Access.
 *
 * Bookkeeping (D1 table files): the row is written BEFORE the bytes go to R2,
 * so every stored object has a row, even if the Worker stops half way; the
 * scheduled clean-up then finds it. Uploads that no item and no saved revision
 * mentions are removed a day after their upload.
 */
import { HttpError } from "./httpError.js";
import { allowedOrigin } from "./http.js";

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const FILE_KEY = /^pdf\/\d{4}\/\d{2}\/[a-z0-9]{16}-[a-z0-9-]{1,60}\.pdf$/;
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 25; // uploads removed per scheduled run at most (runs hourly)
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEPT = new Set(["uploaded", "attached"]); // statuses whose file still exists
// A visitor's own browser may keep a public file for an hour; no shared cache
// may keep it ("private"), so unpublishing stops every other request at once.
const PUBLIC_CACHE = "private, max-age=3600";

// A row the clean-up may remove: still unused ('uploaded'), older than the
// cut-off (?2), and its address (its last part ?3, which is unique and has no
// "/" to be escaped) appears in no item and no saved revision.
const UNUSED =
  "status = 'uploaded' AND uploaded_at < ?2 " +
  "AND NOT EXISTS (SELECT 1 FROM items i WHERE instr(COALESCE(i.file_url, ''), ?3) > 0 " +
  "OR instr(COALESCE(i.body_json, ''), ?3) > 0 OR instr(i.links_json, ?3) > 0) " +
  "AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.entity_type = 'item' AND instr(r.snapshot_json, ?3) > 0)";

const SQL = {
  insert:
    "INSERT INTO files (key, original_name, size, content_type, sha256, status, uploaded_by) VALUES (?1, ?2, ?3, 'application/pdf', ?4, 'uploaded', ?5)",
  forget: "DELETE FROM files WHERE key = ?1 AND status = 'uploaded'",
  status: "SELECT status FROM files WHERE key = ?1",
  // No status condition: for a file being removed, the files_removal_final
  // trigger aborts the whole save (see migration 0004).
  attach: "UPDATE files SET status = 'attached', attached_at = COALESCE(attached_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE key = ?1",
  published:
    "SELECT 1 AS ok FROM published_items i JOIN files f ON f.key = ?2 " +
    "WHERE i.file_url = ?1 AND f.status IN ('uploaded', 'attached') LIMIT 1",
  // Unused old uploads, and removals an earlier run did not finish.
  candidates:
    "SELECT key FROM files WHERE (status = 'uploaded' AND uploaded_at < ?1) OR status = 'deleting' " +
    "ORDER BY uploaded_at LIMIT ?2",
  claim: `UPDATE files SET status = 'deleting' WHERE key = ?1 AND ${UNUSED}`,
  finish: "UPDATE files SET status = 'deleted', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = ?1 AND status = 'deleting'",
};

/** "https://api.library.mh-ibrahim.com/files/" (from the PUBLIC_API_URL variable). */
export const filesBase = (env) => `${String(env.PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "")}/files/`;

/**
 * The R2 key when `url` is one of this API's uploaded files, else null.
 * Throws for an address under /files/ that is not a valid key.
 */
export function ownFileKey(url, env) {
  const base = filesBase(env);
  if (base === "/files/" || typeof url !== "string" || !url.startsWith(base)) return null;
  const key = url.slice(base.length);
  if (!FILE_KEY.test(key)) throw new HttpError(422, { error: "Some fields are not valid", code: "validation", fields: { fileUrl: "is not an uploaded file address" } });
  return key;
}

export const MISSING_UPLOAD = "this uploaded file does not exist (upload it again)";

/** Statements that mark an item's uploaded file as used (checked to exist). */
export async function attachStatements(db, fileUrl, env) {
  const key = ownFileKey(fileUrl, env);
  if (!key) return [];
  const row = await db.prepare(SQL.status).bind(key).first();
  if (!row || !KEPT.has(row.status)) {
    throw new HttpError(422, { error: "Some fields are not valid", code: "validation", fields: { fileUrl: MISSING_UPLOAD } });
  }
  return [db.prepare(SQL.attach).bind(key)];
}

/** `length` characters from ALPHABET, uniformly (rejection sampling: no bias). */
function randomToken(length) {
  let token = "";
  while (token.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      // 252 = 7 × 36: bytes 252..255 would favour the first letters, so skip them.
      if (byte < 252 && token.length < length) token += ALPHABET[byte % ALPHABET.length];
    }
  }
  return token;
}

/** The uploaded name, cleaned: no folders, no control characters, at most 200 characters. */
export function cleanFileName(raw) {
  let name = "";
  try {
    name = decodeURIComponent(String(raw ?? ""));
  } catch {
    name = "";
  }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 200);
  if (!name || name === "." || name === "..") name = "document.pdf";
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

/** The name part of a key: lowercase latin words joined by hyphens ("document" if none). */
export function keyName(fileName) {
  const base = fileName
    .replace(/\.pdf$/i, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return base || "document";
}

// Bytes as characters (one per byte), to look for the PDF markers.
const textAt = (bytes, start, end) => String.fromCharCode(...bytes.subarray(Math.max(0, start), Math.min(bytes.length, end)));

/** Checks the request and stores the PDF. Returns the 201 body. */
export async function uploadPdf(request, env, email, { now = () => new Date(), random = randomToken } = {}) {
  if (!env.FILES) throw new HttpError(503, { error: "File storage is not set up yet", code: "storage_unavailable" });
  if (!/^application\/pdf\s*(;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
    throw new HttpError(415, { error: "Only PDF files can be uploaded", code: "unsupported_media_type" });
  }
  const declared = Number(request.headers.get("Content-Length"));
  if (!Number.isInteger(declared) || declared <= 0) throw new HttpError(411, { error: "The file size must be sent", code: "length_required" });
  if (declared > MAX_PDF_BYTES) throw new HttpError(413, { error: "PDFs can be at most 25 MB", code: "too_large" });

  let bytes;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    throw new HttpError(400, { error: "The upload was interrupted", code: "incomplete_upload" });
  }
  if (bytes.length > MAX_PDF_BYTES) throw new HttpError(413, { error: "PDFs can be at most 25 MB", code: "too_large" });
  if (bytes.length !== declared) throw new HttpError(400, { error: "The upload was interrupted", code: "incomplete_upload" });
  if (!textAt(bytes, 0, 1024).includes("%PDF-")) throw new HttpError(422, { error: "This file is not a PDF", code: "not_pdf" });
  if (!textAt(bytes, bytes.length - 4096, bytes.length).includes("%%EOF")) {
    throw new HttpError(422, { error: "This PDF is incomplete (the file may be damaged or the upload cut off)", code: "incomplete_pdf" });
  }

  const originalName = cleanFileName(request.headers.get("X-File-Name"));
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  const date = now();
  const folder = `pdf/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

  // 1. A new address, recorded first: the row (primary key) and the bucket
  //    must both be free, so nothing is ever overwritten.
  let key = null;
  for (let attempt = 0; attempt < 5 && !key; attempt += 1) {
    const candidate = `${folder}/${random(16)}-${keyName(originalName)}.pdf`;
    if (await env.FILES.head(candidate)) continue;
    try {
      await env.DB.prepare(SQL.insert).bind(candidate, originalName, bytes.length, sha256, email).run();
      key = candidate;
    } catch (error) {
      if (!/UNIQUE constraint failed: files\.key/i.test(String(error?.message ?? error))) throw error;
    }
  }
  if (!key) throw new HttpError(500, { error: "Could not choose a file address", code: "storage_error" });

  // 2. The bytes. If storing fails, the record goes too (and if even that
  //    fails, the scheduled clean-up removes the record after a day).
  try {
    await env.FILES.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { originalName, uploadedBy: email, sha256 },
    });
  } catch (error) {
    await env.DB.prepare(SQL.forget).bind(key).run().catch(() => {});
    throw error;
  }
  console.log(`Admin file upload: ${key} (${bytes.length} bytes)`);
  return { file: { key, url: `${filesBase(env)}${key}`, name: originalName, size: bytes.length, sha256 } };
}

/**
 * Removes uploads that nothing uses, a day after their upload (the scheduled
 * run, hourly). Each one is first claimed in D1 ('deleting', only if it is
 * still unused at that instant: an item saved meanwhile wins), then removed
 * from R2, then marked 'deleted'. A run stopped half way leaves 'deleting',
 * which the next run finishes. Returns the removed keys.
 */
export async function cleanupOrphans(env, { now = Date.now, limit = CLEANUP_BATCH } = {}) {
  if (!env.FILES || !env.DB) return [];
  const cutoff = new Date(now() - ORPHAN_AGE_MS).toISOString();
  const { results } = await env.DB.prepare(SQL.candidates).bind(cutoff, limit).all();
  const removed = [];
  for (const { key } of results) {
    try {
      const claimed = await env.DB.prepare(SQL.claim).bind(key, cutoff, key.split("/").pop()).run();
      const current = claimed.meta?.changes ? "deleting" : (await env.DB.prepare(SQL.status).bind(key).first())?.status;
      if (current !== "deleting") continue; // used after all, or already gone
      await env.FILES.delete(key);
      await env.DB.prepare(SQL.finish).bind(key).run();
      removed.push(key);
      console.log(`Removed unused upload ${key}`);
    } catch (error) {
      // Stays 'deleting' (or 'uploaded'): the next run tries again.
      console.error(`Clean-up of ${key} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return removed;
}

/* ------------------------------------------------------------ reading */

/** "bytes=a-b" | "bytes=a-" | "bytes=-n" -> { offset, length } (null = whole file, false = unsatisfiable). */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return false;
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || end < start) return false;
  return { offset: start, length: end - start + 1 };
}

const asciiName = (name) => name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
// What a PDF viewer on the site must be able to read from another origin.
const EXPOSE = "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag";

const notFound = (request, headers) =>
  new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/** The object's bytes (Range, HEAD, If-None-Match), with `headers` added. */
async function sendObject(request, env, key, headers) {
  const head = await env.FILES.head(key);
  if (!head) return notFound(request, headers);
  const size = head.size;
  const download = new URL(request.url).searchParams.get("download") === "1";
  const name = head.customMetadata?.originalName ?? key.split("/").pop();
  const all = {
    ...headers,
    "Content-Type": "application/pdf",
    "Accept-Ranges": "bytes",
    ETag: head.httpEtag,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  if (request.headers.get("If-None-Match") === head.httpEtag) return new Response(null, { status: 304, headers: all });

  const range = parseRange(request.headers.get("Range"), size);
  if (range === false) return new Response(null, { status: 416, headers: { ...all, "Content-Range": `bytes */${size}` } });
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: { ...all, "Content-Length": String(size) } });

  const object = await env.FILES.get(key, range ? { range } : undefined);
  if (!object) return notFound(request, headers);
  if (range) {
    return new Response(object.body, {
      status: 206,
      headers: { ...all, "Content-Length": String(range.length), "Content-Range": `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` },
    });
  }
  return new Response(object.body, { status: 200, headers: { ...all, "Content-Length": String(size) } });
}

/** GET / HEAD /files/<key> (public): only a file that a published item uses. */
export async function servePublicFile(request, env, key) {
  const headers = { Vary: "Origin", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Expose-Headers"] = EXPOSE;
  }
  // Same answer, from D1 alone, for "never existed", "draft", "history only",
  // "not saved yet" and "removed".
  if (!FILE_KEY.test(key) || !env.FILES || !env.DB) return notFound(request, headers);
  const published = await env.DB.prepare(SQL.published).bind(`${filesBase(env)}${key}`, key).first();
  if (!published) return notFound(request, headers);
  return sendObject(request, env, key, { ...headers, "Cache-Control": PUBLIC_CACHE });
}

/**
 * GET / HEAD /api/admin/files/<key> (admin.js, after the Access check): any
 * upload that still exists. `headers` = the admin answer's (no-store, CORS
 * with credentials for the site).
 */
export async function serveAdminFile(request, env, key, headers) {
  const all = { ...headers, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store" };
  if (all["Access-Control-Allow-Origin"]) all["Access-Control-Expose-Headers"] = EXPOSE;
  if (!FILE_KEY.test(key) || !env.FILES) return notFound(request, all);
  const row = await env.DB.prepare(SQL.status).bind(key).first();
  if (!row || !KEPT.has(row.status)) return notFound(request, all);
  return sendObject(request, env, key, all);
}
