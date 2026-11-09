/**
 * Admin item operations on D1 (drafts included). Called by admin.js only after
 * the Cloudflare Access token has been verified.
 *
 * Consistency (migration 0003):
 *  - Every write is ONE D1 batch (a transaction): the item change and its
 *    revisions row commit together or not at all.
 *  - Optimistic concurrency: writes say which revision they are based on
 *    (`UPDATE ... WHERE id = ? AND revision = ?`). If someone else saved
 *    first, nothing matches (or the history row collides with theirs and the
 *    batch rolls back) and the API answers 409 with the current revision.
 *  - The items_revision_step trigger refuses any UPDATE that does not raise
 *    the revision by exactly 1, as a last line of defence.
 *  - History rows hold the complete row after each change; a delete first
 *    records a tombstone revision with the deleted row, so it can be restored.
 *
 * Security: every SQL statement below is a constant; values are bound with
 * .bind(), never concatenated.
 */
import { toItem } from "./content.js";
import { attachStatements, filesBase, MISSING_UPLOAD } from "./files.js";
import { HttpError } from "./httpError.js";
import {
  applyFields,
  assertValidRow,
  newItemId,
  newRow,
  parseCreateInput,
  parseRevisionInput,
  parseUpdateInput,
  randomToken,
  slugify,
  today,
} from "./itemInput.js";

export { HttpError };

const COLUMNS = [
  "id", "slug", "type", "category_id", "language", "title", "description", "tags_json", "links_json",
  "added_at", "updated_at", "body_json", "reading_minutes", "file_url", "page_count", "video_url", "url",
  "video_description", "media_json", // migration 0004
  "status", "revision",
];
// Same snapshot shape as migration 0003's baseline rows (plus the 0004 columns).
const SNAPSHOT = `json_object(${COLUMNS.map((c) => `'${c}', ${c}`).join(", ")})`;
// Columns a content edit or a restore may change (never id, slug, type, status).
const CONTENT_COLUMNS = [
  "category_id", "language", "title", "description", "tags_json", "links_json", "added_at", "updated_at",
  "body_json", "reading_minutes", "file_url", "page_count", "video_url", "url", "video_description", "media_json",
];
// The list leaves out the long text columns.
const LIST_COLUMNS = COLUMNS.filter((c) => !["body_json", "video_description", "media_json"].includes(c));

const SQL = {
  list: `SELECT ${LIST_COLUMNS.join(", ")} FROM items ORDER BY added_at DESC, id`,
  get: `SELECT ${COLUMNS.join(", ")} FROM items WHERE id = ?1`,
  categoryIds: "SELECT id FROM categories",
  languageCodes: "SELECT code FROM languages",
  // A slug is taken if a live item or any item in the history (e.g. a deleted one) uses it.
  slugTaken:
    "SELECT 1 AS taken FROM items WHERE slug = ?1 " +
    "UNION ALL SELECT 1 FROM revisions WHERE entity_type = 'item' AND json_extract(snapshot_json, '$.slug') = ?1 LIMIT 1",
  insert: `INSERT INTO items (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((_, i) => `?${i + 1}`).join(", ")})`,
  // Records the item's row as it is at revision ?2 (only if it is there).
  record:
    "INSERT INTO revisions (entity_type, entity_id, revision, action, snapshot_json, changed_by, note) " +
    `SELECT 'item', id, revision, ?3, ${SNAPSHOT}, ?4, ?5 FROM items WHERE id = ?1 AND revision = ?2`,
  update:
    `UPDATE items SET ${CONTENT_COLUMNS.map((c, i) => `${c} = ?${i + 3}`).join(", ")}, revision = revision + 1 ` +
    "WHERE id = ?1 AND revision = ?2",
  setStatus: "UPDATE items SET status = ?3, revision = revision + 1 WHERE id = ?1 AND revision = ?2",
  bump: "UPDATE items SET revision = revision + 1 WHERE id = ?1 AND revision = ?2",
  delete: "DELETE FROM items WHERE id = ?1 AND revision = ?2",
  history:
    "SELECT revision, action, changed_by, changed_at, note FROM revisions " +
    "WHERE entity_type = 'item' AND entity_id = ?1 ORDER BY revision DESC",
  snapshot:
    "SELECT revision, action, changed_by, changed_at, note, snapshot_json FROM revisions " +
    "WHERE entity_type = 'item' AND entity_id = ?1 AND revision = ?2",
  latest:
    "SELECT revision, action FROM revisions WHERE entity_type = 'item' AND entity_id = ?1 ORDER BY revision DESC LIMIT 1",
  deleted:
    "SELECT r.entity_id AS id, r.revision, r.changed_at AS deletedAt, r.changed_by AS deletedBy, " +
    "json_extract(r.snapshot_json, '$.slug') AS slug, json_extract(r.snapshot_json, '$.title') AS title, " +
    "json_extract(r.snapshot_json, '$.type') AS type, json_extract(r.snapshot_json, '$.status') AS status " +
    "FROM revisions r WHERE r.entity_type = 'item' AND r.action = 'delete' " +
    "AND r.revision = (SELECT max(x.revision) FROM revisions x WHERE x.entity_type = 'item' AND x.entity_id = r.entity_id) " +
    "AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = r.entity_id) ORDER BY r.changed_at DESC",
};

/* ------------------------------------------------------------ helpers */

function parseBlocks(bodyJson) {
  if (typeof bodyJson !== "string" || bodyJson === "") return [];
  try {
    const blocks = JSON.parse(bodyJson)?.blocks;
    return Array.isArray(blocks) ? blocks : [];
  } catch {
    return [];
  }
}

function parseVideoInfo(mediaJson) {
  if (typeof mediaJson !== "string" || mediaJson === "") return null;
  try {
    const info = JSON.parse(mediaJson);
    return info && typeof info === "object" && !Array.isArray(info) ? info : null;
  } catch {
    return null;
  }
}

/**
 * Admin view of an item: the public shape plus status, revision and blocks
 * (and, for videos, the information last fetched from YouTube).
 */
export function toAdminItem(row) {
  const item = { ...toItem(row), status: row.status, revision: row.revision, blocks: parseBlocks(row.body_json) };
  if (row.type === "youtube") item.videoInfo = parseVideoInfo(row.media_json);
  return item;
}

// This API's own upload address, when configured (see RULES.fileUrl).
const inputOptions = (env) => (env?.PUBLIC_API_URL ? { ownFiles: filesBase(env) } : {});

const rowValues = (row) => COLUMNS.map((c) => row[c] ?? null);
const contentValues = (row) => CONTENT_COLUMNS.map((c) => row[c] ?? null);

async function currentRow(db, id) {
  return db.prepare(SQL.get).bind(id).first();
}

async function requireRow(db, id) {
  const row = await currentRow(db, id);
  if (!row) throw new HttpError(404, { error: "Item not found", code: "not_found" });
  return row;
}

async function contentContext(db) {
  const [categories, languages] = await db.batch([db.prepare(SQL.categoryIds), db.prepare(SQL.languageCodes)]);
  return {
    categoryIds: new Set(categories.results.map((r) => r.id)),
    languageCodes: new Set(languages.results.map((r) => r.code)),
  };
}

async function conflict(db, id) {
  const row = await currentRow(db, id);
  return new HttpError(409, {
    error: "This item was changed since you loaded it. Reload it and try again.",
    code: "conflict",
    currentRevision: row?.revision ?? null,
  });
}

function assertRevision(row, revision) {
  if (row.revision !== revision) {
    throw new HttpError(409, {
      error: "This item was changed since you loaded it. Reload it and try again.",
      code: "conflict",
      currentRevision: row.revision,
    });
  }
}

/** Translates D1 constraint errors into clear API errors (null for anything else). */
async function translateDbError(db, error, id) {
  const message = String(error?.message ?? error);
  if (/UNIQUE constraint failed: items\.slug/i.test(message)) {
    return new HttpError(409, { error: "This slug is already used by another item.", code: "slug_taken" });
  }
  if (/UNIQUE constraint failed: (items\.id|revisions\.)/i.test(message) || /revision must increase/i.test(message)) {
    return conflict(db, id);
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new HttpError(422, { error: "The category or language no longer exists.", code: "validation" });
  }
  // The upload was removed by the clean-up at the moment of saving (trigger files_removal_final).
  if (/a removed file cannot be used again/i.test(message)) {
    return new HttpError(422, { error: "Some fields are not valid", code: "validation", fields: { fileUrl: MISSING_UPLOAD } });
  }
  return null;
}

async function runBatch(db, statements, id) {
  try {
    return await db.batch(statements);
  } catch (error) {
    const translated = await translateDbError(db, error, id);
    if (translated) throw translated;
    throw error;
  }
}

const log = (action, id, revision) => console.log(`Admin item ${action}: ${id} -> revision ${revision}`);

async function chooseSlug(db, requested, title) {
  const taken = async (slug) => Boolean(await db.prepare(SQL.slugTaken).bind(slug).first());
  if (requested) {
    if (await taken(requested)) {
      throw new HttpError(409, { error: "This slug is already used by another item (possibly a deleted one).", code: "slug_taken" });
    }
    return requested;
  }
  const base = slugify(title) || `item-${randomToken(6)}`;
  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${base}-${randomToken(6)}`;
}

/* ------------------------------------------------------------ operations */

export async function listItems(db) {
  const { results } = await db.prepare(SQL.list).all();
  const items = results.map((row) => ({ ...toItem(row), status: row.status, revision: row.revision }));
  return {
    items,
    counts: {
      total: items.length,
      published: items.filter((i) => i.status === "published").length,
      draft: items.filter((i) => i.status === "draft").length,
    },
  };
}

export async function getItem(db, id) {
  return { item: toAdminItem(await requireRow(db, id)) };
}

/** New items are always drafts at revision 1. `env` locates uploaded files. */
export async function createItem(db, input, email, env = {}) {
  const { type, slug: requestedSlug, fields } = parseCreateInput(input, inputOptions(env));
  const context = await contentContext(db);
  const id = newItemId();
  const slug = await chooseSlug(db, requestedSlug, fields.title);
  const row = newRow({ id, slug, type, fields });
  assertValidRow(row, context, toItem);
  await runBatch(db, [
    db.prepare(SQL.insert).bind(...rowValues(row)),
    db.prepare(SQL.record).bind(id, 1, "create", email, ""),
    ...(await attachStatements(db, row.file_url, env)),
  ], id);
  log("create", id, 1);
  return { item: toAdminItem(await requireRow(db, id)) };
}

/** Changes only the fields sent; everything else keeps its exact stored value. */
export async function updateItem(db, id, input, email, env = {}) {
  const current = await requireRow(db, id);
  const { revision, fields } = parseUpdateInput(input, current.type, inputOptions(env));
  assertRevision(current, revision);
  const next = { ...applyFields(current, fields, current.type), updated_at: today() };
  assertValidRow(next, await contentContext(db), toItem);
  const attach = next.file_url !== current.file_url ? await attachStatements(db, next.file_url, env) : [];
  const [result] = await runBatch(db, [
    db.prepare(SQL.update).bind(id, revision, ...contentValues(next)),
    db.prepare(SQL.record).bind(id, revision + 1, "update", email, ""),
    ...attach,
  ], id);
  if (!result.meta?.changes) throw await conflict(db, id);
  log("update", id, revision + 1);
  return { item: toAdminItem(await requireRow(db, id)) };
}

export async function setItemStatus(db, id, input, email, status) {
  const current = await requireRow(db, id);
  const { revision } = parseRevisionInput(input);
  assertRevision(current, revision);
  if (current.status === status) return { item: toAdminItem(current), changed: false };
  const action = status === "published" ? "publish" : "unpublish";
  const [result] = await runBatch(db, [
    db.prepare(SQL.setStatus).bind(id, revision, status),
    db.prepare(SQL.record).bind(id, revision + 1, action, email, ""),
  ], id);
  if (!result.meta?.changes) throw await conflict(db, id);
  log(action, id, revision + 1);
  return { item: toAdminItem(await requireRow(db, id)), changed: true };
}

/** Records a tombstone revision (the deleted row), then deletes the item. */
export async function deleteItem(db, id, input, email) {
  const current = await requireRow(db, id);
  const { revision } = parseRevisionInput(input);
  assertRevision(current, revision);
  const tombstone = revision + 1;
  const [bumped, , removed] = await runBatch(db, [
    db.prepare(SQL.bump).bind(id, revision),
    db.prepare(SQL.record).bind(id, tombstone, "delete", email, ""),
    db.prepare(SQL.delete).bind(id, tombstone),
  ], id);
  if (!bumped.meta?.changes || !removed.meta?.changes) throw await conflict(db, id);
  log("delete", id, tombstone);
  return { deleted: { id, slug: current.slug, title: current.title, revision: tombstone } };
}

export async function itemHistory(db, id) {
  const { results } = await db.prepare(SQL.history).bind(id).all();
  if (results.length === 0) throw new HttpError(404, { error: "No history for this item", code: "not_found" });
  const current = await currentRow(db, id);
  return {
    id,
    currentRevision: current?.revision ?? null,
    deleted: !current,
    revisions: results.map((r) => ({ revision: r.revision, action: r.action, changedBy: r.changed_by, changedAt: r.changed_at, note: r.note })),
  };
}

export async function itemRevision(db, id, revision) {
  const row = await db.prepare(SQL.snapshot).bind(id, revision).first();
  if (!row) throw new HttpError(404, { error: "Revision not found", code: "not_found" });
  return {
    revision: row.revision,
    action: row.action,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    note: row.note,
    item: toAdminItem(JSON.parse(row.snapshot_json)),
  };
}

/**
 * Writes an earlier version's content back as a NEW revision.
 *  - Existing item: content columns from the snapshot; status unchanged.
 *  - Deleted item: the row comes back as a DRAFT (never silently re-published).
 */
export async function restoreItem(db, id, input, email, env = {}) {
  const { revision, fromRevision } = parseRevisionInput(input, { withFrom: true });
  const source = await db.prepare(SQL.snapshot).bind(id, fromRevision).first();
  if (!source) throw new HttpError(404, { error: "Revision not found", code: "not_found" });
  const snapshot = JSON.parse(source.snapshot_json);
  if (snapshot.id !== id) throw new HttpError(422, { error: "Snapshot does not belong to this item", code: "validation" });
  const context = await contentContext(db);
  const note = `Restored revision ${fromRevision}`;
  const current = await currentRow(db, id);

  if (current) {
    assertRevision(current, revision);
    const next = { ...current, updated_at: today() };
    for (const column of CONTENT_COLUMNS) if (column !== "updated_at") next[column] = snapshot[column] ?? null;
    assertValidRow(next, context, toItem);
    const attach = next.file_url !== current.file_url ? await attachStatements(db, next.file_url, env) : [];
    const [result] = await runBatch(db, [
      db.prepare(SQL.update).bind(id, revision, ...contentValues(next)),
      db.prepare(SQL.record).bind(id, revision + 1, "restore", email, note),
      ...attach,
    ], id);
    if (!result.meta?.changes) throw await conflict(db, id);
    log("restore", id, revision + 1);
    return { item: toAdminItem(await requireRow(db, id)) };
  }

  const latest = await db.prepare(SQL.latest).bind(id).first();
  if (!latest || latest.action !== "delete") throw new HttpError(404, { error: "Item not found", code: "not_found" });
  if (latest.revision !== revision) {
    throw new HttpError(409, { error: "This item's history changed. Reload it and try again.", code: "conflict", currentRevision: latest.revision });
  }
  const row = { ...snapshot, status: "draft", revision: latest.revision + 1, updated_at: today() };
  assertValidRow(row, context, toItem);
  await runBatch(db, [
    db.prepare(SQL.insert).bind(...rowValues(row)),
    db.prepare(SQL.record).bind(id, row.revision, "restore", email, `${note} after deletion`),
    ...(await attachStatements(db, row.file_url, env)),
  ], id);
  log("restore", id, row.revision);
  return { item: toAdminItem(await requireRow(db, id)) };
}

export async function deletedItems(db) {
  const { results } = await db.prepare(SQL.deleted).all();
  return { items: results };
}
