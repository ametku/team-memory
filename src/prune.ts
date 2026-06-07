import { join } from "path";
import { readdirSync } from "fs";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import { openFactsDb } from "./facts-db.js";

export interface PruneInput {
  repoDir: string;
  developer: string;
  dryRun?: boolean;
}

export interface PrunedFact {
  id: string;
  content: string;
  reason: "rejected" | "never-surfaced" | "stale";
}

export interface PruneResult {
  pruned: PrunedFact[];
}

interface AggregatedInteraction {
  fact_id: string;
  total_surfaces: number;
  net_explicit: number;
  last_surfaced_at: string | null;
}

function aggregateInteractions(interactionsDir: string): Map<string, AggregatedInteraction> {
  const map = new Map<string, AggregatedInteraction>();

  let files: string[];
  try {
    files = readdirSync(interactionsDir).filter(f => f.startsWith("interactions-") && f.endsWith(".db"));
  } catch {
    return map;
  }

  for (const file of files) {
    const db = new Database(join(interactionsDir, file));
    const rows = db.prepare("SELECT fact_id, surface_count, last_surfaced_at, explicit_score FROM interactions").all() as {
      fact_id: string;
      surface_count: number;
      last_surfaced_at: string;
      explicit_score: number;
    }[];
    db.close();

    for (const row of rows) {
      const existing = map.get(row.fact_id);
      if (existing) {
        existing.total_surfaces += row.surface_count;
        existing.net_explicit += row.explicit_score;
        if (row.last_surfaced_at > (existing.last_surfaced_at ?? "")) {
          existing.last_surfaced_at = row.last_surfaced_at;
        }
      } else {
        map.set(row.fact_id, {
          fact_id: row.fact_id,
          total_surfaces: row.surface_count,
          net_explicit: row.explicit_score,
          last_surfaced_at: row.last_surfaced_at,
        });
      }
    }
  }

  return map;
}

function sixMonthsAgo(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString();
}

export function pruneFacts(input: PruneInput): PruneResult {
  const factsDir = join(input.repoDir, "facts");
  const interactionsDir = join(input.repoDir, "interactions");

  const db = openFactsDb(factsDir, input.developer);
  const facts = db.prepare(
    "SELECT id, content, created_at FROM facts WHERE deleted_at IS NULL"
  ).all() as { id: string; content: string; created_at: string }[];

  if (facts.length === 0) {
    db.close();
    return { pruned: [] };
  }

  const interactions = aggregateInteractions(interactionsDir);
  const cutoff = sixMonthsAgo();
  const pruned: PrunedFact[] = [];

  for (const fact of facts) {
    const agg = interactions.get(fact.id);
    const totalSurfaces = agg?.total_surfaces ?? 0;
    const netExplicit = agg?.net_explicit ?? 0;
    const lastSurfaced = agg?.last_surfaced_at ?? null;

    if (netExplicit <= -2) {
      pruned.push({ id: fact.id, content: fact.content, reason: "rejected" });
    } else if (totalSurfaces === 0 && fact.created_at < cutoff) {
      pruned.push({ id: fact.id, content: fact.content, reason: "never-surfaced" });
    } else if (lastSurfaced && lastSurfaced < cutoff && totalSurfaces < 5) {
      pruned.push({ id: fact.id, content: fact.content, reason: "stale" });
    }
  }

  if (pruned.length === 0 || input.dryRun) {
    db.close();
    return { pruned };
  }

  for (const fact of pruned) {
    db.prepare("DELETE FROM facts WHERE id = ?").run(fact.id);
  }

  db.exec("VACUUM");
  db.close();

  const dbFile = join("facts", `facts-${input.developer}.db`);
  execFileSync("git", ["add", dbFile], { cwd: input.repoDir });
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: input.repoDir, encoding: "utf-8" });
  if (status.trim()) {
    execFileSync("git", ["commit", "-m", `chore: prune ${pruned.length} facts`], { cwd: input.repoDir });
  }

  return { pruned };
}
