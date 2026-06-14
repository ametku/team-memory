import { join } from "path";
import { readdirSync } from "fs";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { openInteractionsDb } from "./interactions-db.js";

export interface RejectFactInput {
  factIds: string[];
  repoDir: string;
  developer: string;
}

export interface RejectResult {
  rejected: Array<{ id: string; content: string }>;
  notFound: string[];
}

export function rejectFacts(input: RejectFactInput): RejectResult {
  const interactionsDir = join(input.repoDir, "interactions");
  const db = openInteractionsDb(interactionsDir, input.developer);
  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score)
    VALUES (?, 0, ?, -1)
    ON CONFLICT(fact_id) DO UPDATE SET explicit_score = -1
  `);

  const rejected: Array<{ id: string; content: string }> = [];
  const notFound: string[] = [];

  for (const factId of input.factIds) {
    try {
      const content = findFact(input.repoDir, factId);
      upsert.run(factId, now);
      rejected.push({ id: factId, content });
    } catch {
      notFound.push(factId);
    }
  }

  db.exec("VACUUM");
  db.close();

  if (rejected.length > 0) {
    const dbFile = join("interactions", `interactions-${input.developer}.db`);
    execFileSync("git", ["add", dbFile], { cwd: input.repoDir });
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: input.repoDir, encoding: "utf-8" });
    if (status.trim()) {
      const ids = rejected.map(r => r.id).join(" ");
      execFileSync("git", ["commit", "-m", `feat: reject fact(s) ${ids}`], { cwd: input.repoDir });
    }
  }

  return { rejected, notFound };
}

// Legacy single-ID wrapper for backwards compatibility
export function rejectFact(input: { factId: string; repoDir: string; developer: string }): { content: string } {
  const result = rejectFacts({ factIds: [input.factId], repoDir: input.repoDir, developer: input.developer });
  if (result.notFound.length > 0) throw new Error(`Fact not found: ${input.factId}`);
  return { content: result.rejected[0].content };
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
