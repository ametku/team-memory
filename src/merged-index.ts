import Database from "better-sqlite3";
import { readdirSync } from "fs";
import { join } from "path";

export function rebuildIndex(repoDir: string, outputPath: string): void {
  const db = new Database(outputPath);
  db.pragma("journal_mode = WAL");

  db.exec(`DROP TABLE IF EXISTS facts_view`);
  db.exec(`DROP TABLE IF EXISTS staged_facts`);

  db.exec(`
    CREATE TABLE staged_facts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      project TEXT,
      tags TEXT
    )
  `);

  const factsDir = join(repoDir, "facts");
  const factsFiles = readdirSync(factsDir).filter((f) => f.startsWith("facts-") && f.endsWith(".db"));

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

  db.exec(`
    CREATE VIRTUAL TABLE facts_view USING fts5(
      id UNINDEXED,
      content,
      tags,
      project,
      trust UNINDEXED
    )
  `);

  db.exec(`
    INSERT INTO facts_view (id, content, tags, project, trust)
    SELECT id, content, COALESCE(tags, ''), COALESCE(project, ''), 1.0
    FROM staged_facts
  `);

  db.exec(`DROP TABLE staged_facts`);
  db.close();
}
