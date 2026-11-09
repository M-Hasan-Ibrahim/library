-- REFERENCE SNAPSHOT of the Cloudflare D1 schema (library-db).
-- The source of truth for changes is migrations/ (applied with
-- `wrangler d1 migrations apply`). Do NOT execute this file against
-- production: it bypasses migration tracking. Any schema change must be a
-- new numbered migration; then update this snapshot to match.
--
-- The frontend still reads src/content/*.json. Columns map 1:1 to the
-- JSON fields (snake_case here, camelCase in the app), so a Worker can return
-- the exact shapes the UI already consumes.
--
-- Concepts kept separate on purpose:
--   categories  = subject (Science, Thoughts, ...)        -> data, editable by admin
--   languages   = language of the content (en, ar, ...)   -> data
--   items.type  = how an item is rendered (article, pdf, youtube, link) -> code

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS languages (
  code        TEXT PRIMARY KEY,                 -- ISO 639 code: 'en', 'ar'
  name        TEXT NOT NULL,                    -- 'Arabic'
  native_name TEXT NOT NULL,                    -- 'العربية'
  dir         TEXT NOT NULL CHECK (dir IN ('ltr', 'rtl'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,                 -- e.g. 'cat_science'
  slug        TEXT NOT NULL UNIQUE,             -- used in URLs (?category=science)
  name        TEXT NOT NULL,                    -- renaming only changes this column
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,       -- display order
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- 0003: optimistic concurrency; every UPDATE must add exactly 1 (trigger).
  revision    INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS items (
  id              TEXT PRIMARY KEY,             -- e.g. 'itm_rainbow'
  slug            TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL CHECK (type IN ('article', 'pdf', 'youtube', 'link')),
  -- RESTRICT: a category can only be removed once no item uses it.
  category_id     TEXT NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  language        TEXT NOT NULL REFERENCES languages (code) ON DELETE RESTRICT,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  tags_json       TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  links_json      TEXT NOT NULL DEFAULT '[]',   -- JSON array of { "label", "url" }
  added_at        TEXT NOT NULL,                -- calendar day, 'YYYY-MM-DD'
  updated_at      TEXT NOT NULL,
  -- Optional rich text for ANY type (required for articles):
  -- { "blocks": [ { "id", "type", ... } ] }, as in src/content/bodies/*.json
  body_json       TEXT,
  reading_minutes INTEGER,                      -- articles
  file_url        TEXT,                         -- pdf: site path, URL, or an upload (<API>/files/…, R2)
  page_count      INTEGER,                      -- pdf
  video_url       TEXT,                         -- youtube: any supported YouTube URL
  url             TEXT,                         -- link: destination
  -- 0003 (added with ALTER TABLE ADD COLUMN, i.e. after all earlier columns):
  -- only 'published' items are public (through the published_items view).
  status          TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  -- optimistic concurrency; every UPDATE must add exactly 1 (trigger).
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- 0004 (added with ALTER TABLE ADD COLUMN, after the 0003 columns):
  video_description TEXT,                       -- youtube: original description (public, collapsed)
  media_json        TEXT,                       -- youtube: video information last fetched (admin only)
  CHECK (
    (type = 'article' AND body_json IS NOT NULL) OR
    (type = 'pdf'     AND file_url  IS NOT NULL) OR
    (type = 'youtube' AND video_url IS NOT NULL) OR
    (type = 'link'    AND url       IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_items_added ON items (added_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_category_added ON items (category_id, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_language ON items (language);
CREATE INDEX IF NOT EXISTS idx_items_type ON items (type);
CREATE INDEX IF NOT EXISTS idx_items_status_added ON items (status, added_at DESC);

-- 0003: the public API reads items only through this view.
CREATE VIEW IF NOT EXISTS published_items AS
  SELECT * FROM items WHERE status = 'published';

-- 0003: no UPDATE without moving the revision forward by exactly one.
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

-- 0003: edit history. snapshot_json = the complete row after the change
-- (for 'delete': the deleted row). No foreign keys: history outlives deletes.
CREATE TABLE IF NOT EXISTS revisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('item', 'category', 'language')),
  entity_id     TEXT NOT NULL,
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  action        TEXT NOT NULL CHECK (action IN ('import', 'create', 'update', 'publish', 'unpublish', 'delete', 'restore')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  changed_by    TEXT NOT NULL,
  changed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  note          TEXT NOT NULL DEFAULT '',
  UNIQUE (entity_type, entity_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_revisions_changed_at ON revisions (changed_at DESC);

-- 0004: files uploaded by the admin to R2 (PDFs). 'uploaded' until an item is
-- saved with the file's address ('attached'); an upload never used is removed
-- after a day by the scheduled clean-up ('deleting', then 'deleted'). Files
-- used by any item or revision are kept. Public only while a published item
-- uses them.
CREATE TABLE IF NOT EXISTS files (
  key           TEXT PRIMARY KEY,               -- R2 object key, e.g. pdf/2026/11/k3j…-notes.pdf
  original_name TEXT NOT NULL,                  -- file name as uploaded (for downloads)
  size          INTEGER NOT NULL CHECK (size > 0),
  content_type  TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'attached', 'deleting', 'deleted')),
  uploaded_by   TEXT NOT NULL,
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attached_at   TEXT,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_status_uploaded ON files (status, uploaded_at);

-- 0004: a file being removed (or removed) can never be attached again.
CREATE TRIGGER IF NOT EXISTS files_removal_final
BEFORE UPDATE OF status ON files
WHEN OLD.status IN ('deleting', 'deleted') AND NEW.status NOT IN ('deleting', 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'files: a removed file cannot be used again');
END;

-- 0004: the "is this uploaded file published?" check on every file request.
CREATE INDEX IF NOT EXISTS idx_items_file_url ON items (file_url);
