-- Migration 0003: content management (drafts, revisions, edit history).
--
-- ADDITIVE ONLY. Nothing existing is renamed, removed or rewritten:
--   * new columns get defaults that describe the current data exactly
--     (every existing item is published and at revision 1);
--   * new objects: one table (revisions), one view (published_items),
--     one index, two triggers;
--   * the revisions table is filled with one read-only "import" snapshot per
--     existing item and category, so their current state can always be
--     restored after future edits.
--
-- Compatibility: the Worker that is live when this runs names its columns
-- explicitly, so it keeps working unchanged. Deploy the Worker that reads
-- `published_items` only AFTER this migration has been applied.
--
-- Not re-runnable by design (SQLite has no ADD COLUMN IF NOT EXISTS): wrangler
-- records it in d1_migrations and never applies it twice, and D1 applies the
-- file as one unit, so a failure part-way leaves the database unchanged.
--
-- Future data migrations that UPDATE items or categories must increase
-- `revision` by exactly 1 (enforced by the triggers below) and should record
-- a row in `revisions`.

-- 1. Publication status. Only 'published' items are ever public.
ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft', 'published'));

-- 2. Revision numbers for optimistic concurrency: an edit names the revision
--    it was based on (UPDATE ... WHERE id = ? AND revision = ?); if someone
--    else saved first, no row matches and the edit is refused (409).
ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE categories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

-- 3. Every update must move the revision forward by exactly one, so no write
--    path can silently overwrite a row without a new revision.
CREATE TRIGGER IF NOT EXISTS items_revision_step
BEFORE UPDATE ON items
WHEN NEW.revision IS NOT OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'items.revision must increase by exactly 1 on every update');
END;

CREATE TRIGGER IF NOT EXISTS categories_revision_step
BEFORE UPDATE ON categories
WHEN NEW.revision IS NOT OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'categories.revision must increase by exactly 1 on every update');
END;

-- 4. Edit history: one row per change, holding the complete row as it was
--    AFTER the change (for 'delete': the row that was deleted). Restoring a
--    version = writing that snapshot back as a new revision. No foreign keys,
--    so history survives deletes. UNIQUE stops two writers from recording the
--    same revision of the same entity.
CREATE TABLE IF NOT EXISTS revisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('item', 'category', 'language')),
  entity_id     TEXT NOT NULL,                 -- items.id, categories.id or languages.code
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  action        TEXT NOT NULL CHECK (action IN ('import', 'create', 'update', 'publish', 'unpublish', 'delete', 'restore')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  changed_by    TEXT NOT NULL,                 -- admin email from the verified Access token
  changed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  note          TEXT NOT NULL DEFAULT '',
  UNIQUE (entity_type, entity_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_revisions_changed_at ON revisions (changed_at DESC);

-- 5. The public API reads items only through this view, so a draft can never
--    be returned by a public endpoint, whatever the query.
CREATE VIEW IF NOT EXISTS published_items AS
  SELECT * FROM items WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_items_status_added ON items (status, added_at DESC);

-- 6. Baseline history for the existing content (exact column values).
INSERT OR IGNORE INTO revisions (entity_type, entity_id, revision, action, snapshot_json, changed_by, note)
SELECT
  'item', id, revision, 'import',
  json_object(
    'id', id, 'slug', slug, 'type', type, 'category_id', category_id, 'language', language,
    'title', title, 'description', description, 'tags_json', tags_json, 'links_json', links_json,
    'added_at', added_at, 'updated_at', updated_at, 'body_json', body_json,
    'reading_minutes', reading_minutes, 'file_url', file_url, 'page_count', page_count,
    'video_url', video_url, 'url', url, 'status', status, 'revision', revision
  ),
  'migration 0003', 'State before content management was enabled'
FROM items;

INSERT OR IGNORE INTO revisions (entity_type, entity_id, revision, action, snapshot_json, changed_by, note)
SELECT
  'category', id, revision, 'import',
  json_object(
    'id', id, 'slug', slug, 'name', name, 'description', description, 'position', position,
    'created_at', created_at, 'updated_at', updated_at, 'revision', revision
  ),
  'migration 0003', 'State before content management was enabled'
FROM categories;
