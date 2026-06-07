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

  describe("FTS5 search", () => {
    test("MATCH queries find facts by content", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb, { content: "Use viper for config parsing in Go services" });
      insertFact(factsDb, { content: "Stripe webhooks must be idempotent" });
      factsDb.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT content FROM facts_view WHERE facts_view MATCH ?").all("viper config") as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain("viper");
      db.close();
    });

    test("MATCH queries find facts by tags", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb, { content: "Some networking fact", tags: ["category:gotcha", "docker", "networking"] });
      insertFact(factsDb, { content: "Unrelated fact", tags: ["category:convention", "testing"] });
      factsDb.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT content FROM facts_view WHERE facts_view MATCH ?").all("docker") as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe("Some networking fact");
      db.close();
    });

    test("MATCH queries find facts by project", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb, { content: "Payments fact", project: "payments-service" });
      insertFact(factsDb, { content: "Frontend fact", project: "web-app" });
      factsDb.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT content FROM facts_view WHERE facts_view MATCH ?").all("payments") as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe("Payments fact");
      db.close();
    });

    test("results can be ranked by bm25 * trust", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      const highTrust = insertFact(factsDb, { content: "Config parsing with viper is required" });
      const lowTrust = insertFact(factsDb, { content: "Config parsing alternative exists" });
      factsDb.close();

      const aliceInt = openInteractionsDb(join(repoDir, "interactions"), "alice");
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(highTrust.id, 20, "2026-01-15T00:00:00.000Z", 0);
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(lowTrust.id, 1, "2026-01-01T00:00:00.000Z", 0);
      aliceInt.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare(
        "SELECT content, trust, bm25(facts_view) AS bm25_score FROM facts_view WHERE facts_view MATCH ? ORDER BY bm25(facts_view) * trust"
      ).all("config parsing") as any[];
      expect(rows).toHaveLength(2);
      // bm25 returns negative values; more negative = better match
      // Multiplying by trust (positive) keeps the order: more negative * higher trust = most negative = first in ASC
      expect(rows[0].content).toContain("viper");
      db.close();
    });
  });

  describe("edge cases", () => {
    test("produces empty FTS table when no facts DBs exist", () => {
      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const row = db.prepare("SELECT count(*) as cnt FROM facts_view").get() as any;
      expect(row.cnt).toBe(0);
      db.close();
    });

    test("works when interactions directory has no files", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb, { content: "Lonely fact" });
      factsDb.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT content, trust FROM facts_view").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].trust).toBe(1.0);
      db.close();
    });

    test("rebuilding twice overwrites cleanly", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb, { content: "First build fact" });
      factsDb.close();

      rebuildIndex(repoDir, outputPath);

      const factsDb2 = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(factsDb2, { content: "Second build fact" });
      factsDb2.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const rows = db.prepare("SELECT content FROM facts_view").all() as any[];
      expect(rows).toHaveLength(2);
      db.close();
    });
  });

  describe("stats return value", () => {
    test("returns devDbs and factsIndexed counts", () => {
      const aliceDb = openFactsDb(join(repoDir, "facts"), "alice");
      insertFact(aliceDb, { content: "Alice fact" });
      aliceDb.close();

      const bobDb = openFactsDb(join(repoDir, "facts"), "bob");
      insertFact(bobDb, { content: "Bob fact one" });
      insertFact(bobDb, { content: "Bob fact two" });
      bobDb.close();

      const stats = rebuildIndex(repoDir, outputPath);
      expect(stats).toEqual({ devDbs: 2, factsIndexed: 3 });
    });

    test("returns zero counts when no facts exist", () => {
      const stats = rebuildIndex(repoDir, outputPath);
      expect(stats).toEqual({ devDbs: 0, factsIndexed: 0 });
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

    test("high surface count produces logarithmic growth (100 surfaces)", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      const fact = insertFact(factsDb, { content: "Highly surfaced fact" });
      factsDb.close();

      const aliceInt = openInteractionsDb(join(repoDir, "interactions"), "alice");
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(fact.id, 100, "2026-01-15T00:00:00.000Z", 0);
      aliceInt.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const row = db.prepare("SELECT trust FROM facts_view WHERE id = ?").get(fact.id) as any;
      // trust = (1 + ln(1 + 100)) * max(0.1, 1 + 0.5 * 0) = (1 + ln(101)) * 1.0
      const expected = (1 + Math.log(101)) * 1.0;
      expect(expected).toBeGreaterThan(1.0);
      expect(row.trust).toBeCloseTo(expected, 5);
      db.close();
    });

    test("single reject halves the explicit multiplier (boundary before exclusion)", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      const fact = insertFact(factsDb, { content: "Penalized but not excluded" });
      factsDb.close();

      const aliceInt = openInteractionsDb(join(repoDir, "interactions"), "alice");
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(fact.id, 10, "2026-01-15T00:00:00.000Z", -1);
      aliceInt.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const row = db.prepare("SELECT trust FROM facts_view WHERE id = ?").get(fact.id) as any;
      // net_explicit=-1 is the most negative non-excluded integer value
      // trust = (1 + ln(11)) * max(0.1, 1 + 0.5*(-1)) = (1 + ln(11)) * 0.5
      const expected = (1 + Math.log(11)) * 0.5;
      expect(row.trust).toBeCloseTo(expected, 5);
      db.close();
    });

    test("aggregates surfaces from 3+ developers correctly", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      const fact = insertFact(factsDb, { content: "Multi-dev fact" });
      factsDb.close();

      const aliceInt = openInteractionsDb(join(repoDir, "interactions"), "alice");
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(fact.id, 10, "2026-01-10T00:00:00.000Z", 0);
      aliceInt.close();

      const bobInt = openInteractionsDb(join(repoDir, "interactions"), "bob");
      bobInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(fact.id, 7, "2026-01-12T00:00:00.000Z", 0);
      bobInt.close();

      const carolInt = openInteractionsDb(join(repoDir, "interactions"), "carol");
      carolInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(fact.id, 3, "2026-01-14T00:00:00.000Z", 0);
      carolInt.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);
      const row = db.prepare("SELECT trust FROM facts_view WHERE id = ?").get(fact.id) as any;
      // total_surfaces = 10 + 7 + 3 = 20, net_explicit = 0
      // trust = (1 + ln(21)) * 1.0
      const expected = (1 + Math.log(21)) * 1.0;
      expect(row.trust).toBeCloseTo(expected, 5);
      db.close();
    });

    test("comprehensive multi-dev scenario with mixed signals", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      const popular = insertFact(factsDb, { content: "Popular well-trusted fact" });
      const controversial = insertFact(factsDb, { content: "Controversial fact one reject" });
      const rejected = insertFact(factsDb, { content: "Rejected by two devs" });
      const fresh = insertFact(factsDb, { content: "Fresh fact no interactions" });
      factsDb.close();

      // Alice: surfaced popular 15x, surfaced controversial 5x, rejected rejected once
      const aliceInt = openInteractionsDb(join(repoDir, "interactions"), "alice");
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(popular.id, 15, "2026-01-15T00:00:00.000Z", 0);
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(controversial.id, 5, "2026-01-10T00:00:00.000Z", 0);
      aliceInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(rejected.id, 2, "2026-01-08T00:00:00.000Z", -1);
      aliceInt.close();

      // Bob: surfaced popular 10x, rejected controversial once, rejected rejected once
      const bobInt = openInteractionsDb(join(repoDir, "interactions"), "bob");
      bobInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(popular.id, 10, "2026-02-01T00:00:00.000Z", 0);
      bobInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(controversial.id, 3, "2026-01-20T00:00:00.000Z", -1);
      bobInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(rejected.id, 1, "2026-01-12T00:00:00.000Z", -1);
      bobInt.close();

      // Carol: surfaced popular 5x
      const carolInt = openInteractionsDb(join(repoDir, "interactions"), "carol");
      carolInt.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(popular.id, 5, "2026-02-05T00:00:00.000Z", 0);
      carolInt.close();

      rebuildIndex(repoDir, outputPath);

      const db = new Database(outputPath);

      // Popular: total_surfaces=30, net_explicit=0 → trust = (1 + ln(31)) * 1.0
      const popularRow = db.prepare("SELECT trust FROM facts_view WHERE id = ?").get(popular.id) as any;
      expect(popularRow.trust).toBeCloseTo((1 + Math.log(31)) * 1.0, 5);

      // Controversial: total_surfaces=8, net_explicit=-1 → trust = (1 + ln(9)) * 0.5
      const controversialRow = db.prepare("SELECT trust FROM facts_view WHERE id = ?").get(controversial.id) as any;
      expect(controversialRow.trust).toBeCloseTo((1 + Math.log(9)) * 0.5, 5);

      // Rejected: net_explicit = -2 → excluded entirely
      const rejectedRow = db.prepare("SELECT trust FROM facts_view WHERE id = ?").get(rejected.id) as any;
      expect(rejectedRow).toBeUndefined();

      // Fresh: no interactions → trust = 1.0
      const freshRow = db.prepare("SELECT trust FROM facts_view WHERE id = ?").get(fresh.id) as any;
      expect(freshRow.trust).toBe(1.0);

      // Verify ranking: popular > controversial > fresh (when querying "fact")
      const rows = db.prepare(
        "SELECT id, trust FROM facts_view WHERE facts_view MATCH ? ORDER BY bm25(facts_view) * trust"
      ).all("fact") as any[];
      const ids = rows.map((r: any) => r.id);
      const popularIdx = ids.indexOf(popular.id);
      const controversialIdx = ids.indexOf(controversial.id);
      const freshIdx = ids.indexOf(fresh.id);
      // Higher trust should rank earlier (bm25 is negative, * higher trust = more negative = earlier in ASC)
      expect(popularIdx).toBeLessThan(freshIdx);
      expect(controversialIdx).toBeLessThan(freshIdx);

      db.close();
    });
  });
});
