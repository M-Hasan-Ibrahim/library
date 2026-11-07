-- Migration 0001: initial schema (languages, categories, items + 4 indexes).
--
-- Matches db/schema.sql exactly (table definitions copied verbatim).
-- Production D1 (library-db) already contains these objects because they were
-- created manually. Every statement uses IF NOT EXISTS, so applying this
-- migration there is a no-op that only records it in wrangler's
-- d1_migrations table. It never drops, alters or rewrites anything.
--
-- `PRAGMA foreign_keys = ON` from db/schema.sql is intentionally omitted:
-- D1 always enforces foreign keys, so it is not needed here.

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
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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
  file_url        TEXT,                         -- pdf: path or URL (e.g. R2)
  page_count      INTEGER,                      -- pdf
  video_url       TEXT,                         -- youtube: any supported YouTube URL
  url             TEXT,                         -- link: destination
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
