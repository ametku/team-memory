import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { join } from "path";
import type { Fact } from "./types.js";

export interface InsertFactInput {
  content: string;
  project?: string;
  tags?: string[];
}

export function openFactsDb(dir: string, developer: string): Database.Database {
  const dbPath = join(dir, `facts-${developer}.db`);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      project TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  return db;
}

export function insertFact(db: Database.Database, input: InsertFactInput): Fact {
  const id = nanoid(8);
  const created_at = new Date().toISOString();
  const tags = input.tags ?? [];
  const project = input.project ?? null;
  const tagsJson = JSON.stringify(tags);

  db.prepare(
    "INSERT INTO facts (id, content, project, tags, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(id, input.content, project, tagsJson, created_at);

  return { id, content: input.content, project, tags, created_at, deleted_at: null };
}

export function selectFacts(db: Database.Database): Fact[] {
  const rows = db
    .prepare("SELECT id, content, project, tags, created_at, deleted_at FROM facts WHERE deleted_at IS NULL")
    .all() as { id: string; content: string; project: string | null; tags: string; created_at: string; deleted_at: string | null }[];

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

export function softDeleteFact(db: Database.Database, factId: string): void {
  const result = db
    .prepare("UPDATE facts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(new Date().toISOString(), factId);

  if (result.changes === 0) {
    throw new Error(`Fact not found or already deleted: ${factId}`);
  }
}
