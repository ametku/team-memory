import Database from "better-sqlite3";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { normalizeTags } from "./tags.js";

export interface RebuildStats {
  devDbs: number;
  factsIndexed: number;
}

export function rebuildIndex(repoDir: string, outputPath: string): RebuildStats {
  const db = new Database(outputPath);
  db.pragma("journal_mode = WAL");

  db.exec(`DROP TABLE IF EXISTS facts_view`);
  db.exec(`DROP TABLE IF EXISTS staged_facts`);
  db.exec(`DROP TABLE IF EXISTS staged_interactions`);

  db.exec(`
    CREATE TABLE staged_facts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      project TEXT,
      tags TEXT
    )
  `);

  db.exec(`
    CREATE TABLE staged_interactions (
      fact_id TEXT NOT NULL,
      surface_count INTEGER NOT NULL,
      last_surfaced_at TEXT NOT NULL,
      explicit_score INTEGER NOT NULL
    )
  `);

  // Stage facts
  const factsDir = join(repoDir, "facts");
  const factsFiles = existsSync(factsDir)
    ? readdirSync(factsDir).filter((f) => f.startsWith("facts-") && f.endsWith(".db"))
    : [];
  const devDbs = factsFiles.length;

  let attachIdx = 0;
  for (const file of factsFiles) {
    const alias = `att_${attachIdx++}`;
    db.exec(`ATTACH DATABASE '${join(factsDir, file)}' AS ${alias}`);
    db.exec(`
      INSERT OR IGNORE INTO staged_facts (id, content, project, tags)
      SELECT id, content, project, tags FROM ${alias}.facts
      WHERE deleted_at IS NULL
    `);
    db.exec(`DETACH DATABASE ${alias}`);
  }

  // Stage interactions
  const intDir = join(repoDir, "interactions");
  const intFiles = existsSync(intDir)
    ? readdirSync(intDir).filter((f) => f.startsWith("interactions-") && f.endsWith(".db"))
    : [];

  for (const file of intFiles) {
    const alias = `att_${attachIdx++}`;
    db.exec(`ATTACH DATABASE '${join(intDir, file)}' AS ${alias}`);
    db.exec(`
      INSERT INTO staged_interactions (fact_id, surface_count, last_surfaced_at, explicit_score)
      SELECT fact_id, surface_count, last_surfaced_at, explicit_score FROM ${alias}.interactions
    `);
    db.exec(`DETACH DATABASE ${alias}`);
  }

  // Build FTS5 with computed trust
  db.exec(`
    CREATE VIRTUAL TABLE facts_view USING fts5(
      id UNINDEXED,
      content,
      tags,
      project,
      trust UNINDEXED
    )
  `);

  const rows = db.prepare(`
    SELECT
      f.id,
      f.content,
      f.tags AS raw_tags,
      COALESCE(f.project, '') AS project,
      CASE
        WHEN agg.total_surfaces IS NULL THEN 1.0
        ELSE (1.0 + ln(1.0 + agg.total_surfaces)) * max(0.1, 1.0 + 0.5 * agg.net_explicit)
      END AS trust
    FROM staged_facts f
    LEFT JOIN (
      SELECT
        fact_id,
        SUM(surface_count) AS total_surfaces,
        MAX(last_surfaced_at) AS last_surfaced_at,
        SUM(explicit_score) AS net_explicit
      FROM staged_interactions
      GROUP BY fact_id
    ) agg ON agg.fact_id = f.id
    WHERE agg.net_explicit IS NULL OR agg.net_explicit > -2
  `).all() as { id: string; content: string; raw_tags: string | null; project: string; trust: number }[];

  const insert = db.prepare(`
    INSERT INTO facts_view (id, content, tags, project, trust)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const { tags, warning } = normalizeTags(row.raw_tags);
    if (warning) {
      process.stderr.write(`team-memory: fact ${row.id}: ${warning}\n`);
    }
    const tagsJson = tags.length === 0 ? "" : JSON.stringify(tags);
    insert.run(row.id, row.content, tagsJson, row.project, row.trust);
  }

  db.exec(`DROP TABLE staged_facts`);
  db.exec(`DROP TABLE staged_interactions`);

  const row = db.prepare("SELECT count(*) as cnt FROM facts_view").get() as { cnt: number };
  const factsIndexed = row.cnt;

  db.close();
  return { devDbs, factsIndexed };
}
