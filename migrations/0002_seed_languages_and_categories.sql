-- Migration 0002: initial languages (2) and categories (5).
--
-- IDs and values are identical to src/content/languages.json and
-- src/content/categories.json, the sources the frontend uses today.
--
-- Production D1 (library-db) already contains these rows because they were
-- inserted manually. INSERT OR IGNORE skips any row whose primary key (or
-- unique slug) already exists, so applying this migration there inserts
-- nothing and never overwrites existing values (for example, a category
-- renamed later keeps its new name). created_at / updated_at are left to
-- their column defaults.

INSERT OR IGNORE INTO languages (code, name, native_name, dir) VALUES
  ('en', 'English', 'English', 'ltr'),
  ('ar', 'Arabic', 'العربية', 'rtl');

INSERT OR IGNORE INTO categories (id, slug, name, description, position) VALUES
  ('cat_science', 'science', 'Science', 'How the world works, from light and numbers to the ideas behind modern AI.', 1),
  ('cat_thoughts', 'thoughts', 'Thoughts', 'Reflections and ideas worth coming back to.', 2),
  ('cat_interesting_finds', 'interesting-finds', 'Interesting Finds', 'Videos, sites and discoveries that were too good not to keep.', 3),
  ('cat_personal', 'personal', 'Personal', 'Notes from my own life, outside of work.', 4),
  ('cat_other', 'other', 'Other', 'Everything that does not fit neatly anywhere else.', 5);
