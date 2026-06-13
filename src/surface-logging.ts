import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { openInteractionsDb } from "./interactions-db.js";

export function logSurfaces(dir: string, developer: string, factIds: string[]): void {
  if (factIds.length === 0) return;

  const db = openInteractionsDb(dir, developer);
  const upsert = db.prepare(`
    INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score)
    VALUES (?, 1, ?, 0)
    ON CONFLICT(fact_id) DO UPDATE SET
      surface_count = surface_count + 1,
      last_surfaced_at = excluded.last_surfaced_at
  `);

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const factId of factIds) {
      upsert.run(factId, now);
    }
  });
  tx();
  db.close();
}

export function commitInteractions(dir: string, developer: string): void {
  const dbFile = `interactions-${developer}.db`;
  const dbPath = join(dir, dbFile);

  if (!existsSync(dbPath)) return;

  const db = openInteractionsDb(dir, developer);
  db.exec("VACUUM");
  db.close();

  execFileSync("git", ["add", dbFile], { cwd: dir });
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf-8" });
  if (status.trim()) {
    execFileSync("git", ["commit", "-m", "chore: update interactions"], { cwd: dir });
  }
}
