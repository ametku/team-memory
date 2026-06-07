import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { openFactsDb, insertFact } from "../facts-db.js";
import { openInteractionsDb } from "../interactions-db.js";
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

  describe("exclusion of heavily-rejected facts", () => {
    test("excludes facts with net_explicit <= -2", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb, { content: "Acceptable fact" });
      const rejected = insertFact(factsDb, { content: "Bad fact" });
      factsDb.close();

      const aliceInt = openInteractionsDb(join(repoDir, "interactions"), "alice");
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(rejected.id, 2, "2026-01-10T00:00:00.000Z", -1);
      aliceInt.close();

      const bobInt = openInteractionsDb(join(repoDir, "interactions"), "bob");
      bobInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(rejected.id, 1, "2026-01-12T00:00:00.000Z", -1);
      bobInt.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT content FROM facts_view").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe("Acceptable fact");
      db.close();
    });

    test("includes facts with net_explicit = -1 (single reject)", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      const fact = insertFact(factsDb, { content: "One reject only" });
      factsDb.close();

      const aliceInt = openInteractionsDb(join(repoDir, "interactions"), "alice");
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(fact.id, 3, "2026-01-10T00:00:00.000Z", -1);
      aliceInt.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT content FROM facts_view").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe("One reject only");
      db.close();
    });
  });

  describe("trust computation", () => {
    test("computes trust from aggregated interactions across developers", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      const fact = insertFact(factsDb, { content: "Surfaced fact" });
      factsDb.close();

      const aliceInt = openInteractionsDb(join(repoDir, "interactions"), "alice");
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(fact.id, 5, "2026-01-15T00:00:00.000Z", 0);
      aliceInt.close();

      const bobInt = openInteractionsDb(join(repoDir, "interactions"), "bob");
      bobInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(fact.id, 3, "2026-02-01T00:00:00.000Z", 0);
      bobInt.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const row = db.prepare("SELECT trust FROM facts_view WHERE id = ?").get(fact.id) as any;
      // total_surfaces = 8, net_explicit = 0
      // trust = (1 + ln(1 + 8)) * max(0.1, 1 + 0.5 * 0) = (1 + ln(9)) * 1.0
      const expected = (1 + Math.log(1 + 8)) * Math.max(0.1, 1 + 0.5 * 0);
      expect(row.trust).toBeCloseTo(expected, 5);
      db.close();
    });

    test("applies explicit_score penalty to trust", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      const fact = insertFact(factsDb, { content: "Penalized fact" });
      factsDb.close();

      const aliceInt = openInteractionsDb(join(repoDir, "interactions"), "alice");
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(fact.id, 4, "2026-01-15T00:00:00.000Z", -1);
      aliceInt.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const row = db.prepare("SELECT trust FROM facts_view WHERE id = ?").get(fact.id) as any;
      // total_surfaces = 4, net_explicit = -1
      // trust = (1 + ln(5)) * max(0.1, 1 + 0.5 * (-1)) = (1 + ln(5)) * 0.5
      const expected = (1 + Math.log(1 + 4)) * Math.max(0.1, 1 + 0.5 * -1);
      expect(row.trust).toBeCloseTo(expected, 5);
      db.close();
    });

    test("facts with no interactions default to trust 1.0", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb, { content: "No interactions" });
      factsDb.close();

      const intDb = openInteractionsDb(join(repoDir, "interactions"), "alice");
      intDb.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const row = db.prepare("SELECT trust FROM facts_view WHERE content = ?").get("No interactions") as any;
      expect(row.trust).toBe(1.0);
      db.close();
    });
  });
});
