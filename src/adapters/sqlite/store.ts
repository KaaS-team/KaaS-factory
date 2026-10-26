// StorePort on SQLite: one key/value table, so it can share a plane's database file or stand alone.
import type { Database } from "bun:sqlite";
import type { StorePort } from "../../ports/store";

export class SqliteStore implements StorePort {
  constructor(
    private readonly db: Database,
    private readonly table = "kv_store",
  ) {
    if (!/^\w+$/.test(table)) throw new Error(`bad table name ${table}`);
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  async get(key: string): Promise<string | undefined> {
    const row = this.db.query(`SELECT value FROM ${this.table} WHERE key = ?`).get(key) as { value: string } | null;
    return row?.value;
  }

  async put(key: string, value: string): Promise<void> {
    this.db
      .query(
        `INSERT INTO ${this.table} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.db.query(`DELETE FROM ${this.table} WHERE key = ?`).run(key);
  }

  async list(prefix: string): Promise<string[]> {
    // substr, not LIKE, so a `%` or `_` in the prefix is matched as itself.
    const rows = this.db
      .query(`SELECT key FROM ${this.table} WHERE substr(key, 1, ?) = ? ORDER BY key`)
      .all(prefix.length, prefix) as { key: string }[];
    return rows.map((r) => r.key);
  }
}
