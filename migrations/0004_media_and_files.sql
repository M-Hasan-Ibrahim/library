-- Migration 0004: YouTube video information and uploaded files (PDFs in R2).
--
-- Additive only: two nullable columns on items (existing rows keep every
-- value; the new columns are NULL until an item uses them) and a new table.
-- The public view published_items is "SELECT * FROM items WHERE ...", so it
-- includes the new columns without being recreated; public queries choose
-- their columns explicitly.

-- The video's original description, as published on YouTube (multi-line
-- plain text). Shown to visitors in a collapsed "Video description" section.
ALTER TABLE items ADD COLUMN video_description TEXT;

-- The video information last fetched from YouTube (JSON: title, description,
-- tags, channel, thumbnail, source, fetchedAt). Admin only: used to tell
-- which fields the admin changed by hand before a "Refresh video information".
ALTER TABLE items ADD COLUMN media_json TEXT;

-- Files uploaded by the admin to the R2 bucket (PDFs). A row is written just
-- before the file is stored ("uploaded"), marked "attached" once an item is
-- saved with the file's address. An upload that nothing uses after a day is
-- removed by the scheduled clean-up: "deleting" while it is being removed
-- from R2 (a clean-up interrupted there is finished by the next run), then
-- "deleted". Files referenced by any item or any saved revision are never
-- deleted, so restoring an earlier version always finds its file.
CREATE TABLE IF NOT EXISTS files (
  key           TEXT PRIMARY KEY,               -- R2 object key, e.g. pdf/2026/11/k3j…-notes.pdf
  original_name TEXT NOT NULL,                  -- file name as uploaded (for downloads)
  size          INTEGER NOT NULL CHECK (size > 0),
  content_type  TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'attached', 'deleting', 'deleted')),
  uploaded_by   TEXT NOT NULL,                  -- admin email from the verified Access token
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attached_at   TEXT,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_status_uploaded ON files (status, uploaded_at);

-- A file on its way out (or gone) can never be attached again: an item saved
-- with it at that moment fails as a whole (its D1 batch rolls back) instead
-- of pointing at a missing file.
CREATE TRIGGER IF NOT EXISTS files_removal_final
BEFORE UPDATE OF status ON files
WHEN OLD.status IN ('deleting', 'deleted') AND NEW.status NOT IN ('deleting', 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'files: a removed file cannot be used again');
END;

-- Uploaded files are public only while a published item uses them; this
-- index makes that check (one per file request) read a single row.
CREATE INDEX IF NOT EXISTS idx_items_file_url ON items (file_url);
