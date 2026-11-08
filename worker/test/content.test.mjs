// Public item queries must never read the `items` table directly (drafts live
// there); they read the `published_items` view from migration 0003.
// End-to-end proof against a real (local) D1 lives in the migration test.
// Run: npm run test:worker
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ITEM_BY_SLUG_SQL, ITEMS_SQL } from "../src/content.js";

test("item list and single item read only from published_items", () => {
  for (const sql of [ITEMS_SQL, ITEM_BY_SLUG_SQL]) {
    assert.match(sql, /\bFROM published_items\b/);
    assert.doesNotMatch(sql, /\bFROM items\b/);
  }
});

test("no public query in content.js reads the items table directly", () => {
  const source = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bFROM\s+items\b/i);
});

test("the view exists in migration 0003 and filters on status = 'published'", () => {
  const migration = readFileSync(new URL("../../migrations/0003_content_management.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE VIEW IF NOT EXISTS published_items AS\s+SELECT \* FROM items WHERE status = 'published';/);
});
