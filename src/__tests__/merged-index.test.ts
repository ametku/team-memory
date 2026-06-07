import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openFactsDb, insertFact } from "../facts-db.js";
import { rebuildIndex } from "../merged-index.js";

describe("merged-index", () => {
  let repoDir: string;
  let outputPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "team-memory-test-"));
    mkdirSync(join(repoDir, "facts"));
    mkdirSync(join(repoDir, "interactions"));
    outputPath = join(repoDir, "merged_index.db");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true });
  });

  describe("single developer, no interactions", () => {
    test("indexes all non-deleted facts with trust = 1.0", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb, { content: "Use viper for config", project: "backend", tags: ["go", "config"] });
      insertFact(factsDb, { content: "Retry flaky deploys once", tags: ["ci"] });
      factsDb.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT id, content, tags, project, trust FROM facts_view").all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows.every((r: any) => r.trust === 1.0)).toBe(true);
      expect(rows.find((r: any) => r.content === "Use viper for config").project).toBe("backend");
      expect(rows.find((r: any) => r.content === "Retry flaky deploys once").project).toBe("");
      db.close();
    });
  });
});
