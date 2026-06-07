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

  describe("multiple developers", () => {
    test("merges facts from all developers", () => {
      const aliceDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(aliceDb, { content: "Alice fact one" });
      aliceDb.close();

      const bobDb = openFactsDb(join(repoDir, "facts"), "bob");
      insertFact(bobDb, { content: "Bob fact one" });
      insertFact(bobDb, { content: "Bob fact two" });
      bobDb.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT content FROM facts_view").all() as any[];
      expect(rows).toHaveLength(3);
      const contents = rows.map((r: any) => r.content);
      expect(contents).toContain("Alice fact one");
      expect(contents).toContain("Bob fact one");
      expect(contents).toContain("Bob fact two");
      db.close();
    });
  });

  describe("soft-deleted facts", () => {
    test("excludes facts with deleted_at set", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb, { content: "Keep this" });
      const deleted = insertFact(factsDb, { content: "Delete this" });
      factsDb.prepare("UPDATE facts SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), deleted.id);
      factsDb.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT content FROM facts_view").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe("Keep this");
      db.close();
    });
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
