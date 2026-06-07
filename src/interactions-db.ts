import Database from "better-sqlite3";
import { join } from "path";

export function openInteractionsDb(dir: string, developer: string): Database.Database {
  const dbPath = join(dir, `interactions-${developer}.db`);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS interactions (
      fact_id TEXT PRIMARY KEY,
      surface_count INTEGER NOT NULL DEFAULT 0,
      last_surfaced_at TEXT NOT NULL,
      explicit_score INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}
