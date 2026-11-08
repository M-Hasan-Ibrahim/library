// A small Cloudflare D1 stand-in on Node's built-in SQLite (node:sqlite), for tests.
//
// It builds the database exactly like production: migrations 0001 and 0002,
// then db/seed.sql (the 13 items), then every later migration (0003 records
// the baseline history). So SQL, triggers, constraints and JSON functions are
// the real thing. Reproduced D1 behaviour: prepare().bind().first()/all()/run(),
// batch() as ONE transaction (all statements or none), meta.changes.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const ROOT = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");

class Statement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.database, this.sql, params);
  }

  /** Synchronous execution (used by batch inside its transaction). */
  execute() {
    const statement = this.database.prepare(this.sql);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql)) {
      return { success: true, results: statement.all(...this.params).map((row) => ({ ...row })), meta: { changes: 0 } };
    }
    const info = statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return column ? row[column] : { ...row };
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }
}

/** A fresh in-memory database in the same state as production after migration 0003. */
export function createTestDb() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;"); // D1 always enforces foreign keys
  const migrations = readdirSync(new URL("migrations/", ROOT)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of migrations) {
    database.exec(read(`migrations/${file}`));
    if (file.startsWith("0002_")) database.exec(read("db/seed.sql")); // production order
  }
  return {
    prepare: (sql) => new Statement(database, sql),
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    /** Direct access for test assertions. */
    raw: database,
  };
}
