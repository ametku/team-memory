import { join } from "path";
import { readdirSync } from "fs";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { openInteractionsDb } from "./interactions-db.js";

export interface RejectFactInput {
  factId: string;
  repoDir: string;
  developer: string;
}

export function rejectFact(input: RejectFactInput): { content: string } {
  const content = findFact(input.repoDir, input.factId);

  const interactionsDir = join(input.repoDir, "interactions");
  const db = openInteractionsDb(interactionsDir, input.developer);

  db.prepare(`
    INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score)
    VALUES (?, 0, ?, -1)
    ON CONFLICT(fact_id) DO UPDATE SET explicit_score = -1
  `).run(input.factId, new Date().toISOString());

  db.exec("VACUUM");
  db.close();

  const dbFile = join("interactions", `interactions-${input.developer}.db`);
  execFileSync("git", ["add", dbFile], { cwd: input.repoDir });
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: input.repoDir, encoding: "utf-8" });
  if (status.trim()) {
    execFileSync("git", ["commit", "-m", `feat: reject fact ${input.factId}`], { cwd: input.repoDir });
  }

  return { content };
}

function findFact(repoDir: string, factId: string): string {
  const factsDir = join(repoDir, "facts");
  const files = readdirSync(factsDir).filter(f => f.startsWith("facts-") && f.endsWith(".db"));

  for (const file of files) {
    const db = new Database(join(factsDir, file));
    const row = db.prepare("SELECT content FROM facts WHERE id = ? AND deleted_at IS NULL").get(factId) as { content: string } | undefined;
    db.close();
    if (row) return row.content;
  }

  throw new Error(`Fact not found: ${factId}`);
}
