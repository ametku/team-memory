import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openFactsDb, insertFact, selectFacts, softDeleteFact } from "../facts-db.js";
import type { Fact } from "../types.js";

describe("facts-db", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "team-memory-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  describe("openFactsDb", () => {
    test("creates database file with facts table", () => {
      const db = openFactsDb(dir, "alice");
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain("facts");
      db.close();
    });

    test("facts table has correct schema", () => {
      const db = openFactsDb(dir, "alice");
      const cols = db.pragma("table_info(facts)") as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[];
      const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

      expect(colMap["id"].type).toBe("TEXT");
      expect(colMap["id"].pk).toBe(1);
      expect(colMap["content"].type).toBe("TEXT");
      expect(colMap["content"].notnull).toBe(1);
      expect(colMap["project"].type).toBe("TEXT");
      expect(colMap["tags"].type).toBe("TEXT");
      expect(colMap["created_at"].type).toBe("TEXT");
      expect(colMap["created_at"].notnull).toBe(1);
      expect(colMap["deleted_at"].type).toBe("TEXT");
      db.close();
    });

    test("opening same db twice is safe (idempotent migration)", () => {
      const db1 = openFactsDb(dir, "alice");
      db1.close();
      const db2 = openFactsDb(dir, "alice");
      const tables = db2
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain("facts");
      db2.close();
    });
  });

  describe("insertFact", () => {
    test("inserts a fact and returns it with generated id", () => {
      const db = openFactsDb(dir, "alice");
      const fact = insertFact(db, {
        content: "Use viper for config parsing",
        project: "backend",
        tags: ["config", "go"],
      });

      expect(fact.id).toHaveLength(8);
      expect(fact.content).toBe("Use viper for config parsing");
      expect(fact.project).toBe("backend");
      expect(fact.tags).toEqual(["config", "go"]);
      expect(fact.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(fact.deleted_at).toBeNull();
      db.close();
    });

    test("inserts a fact with no project or tags", () => {
      const db = openFactsDb(dir, "alice");
      const fact = insertFact(db, { content: "A bare fact" });

      expect(fact.content).toBe("A bare fact");
      expect(fact.project).toBeNull();
      expect(fact.tags).toEqual([]);
      db.close();
    });
  });

  describe("selectFacts", () => {
    test("returns all non-deleted facts", () => {
      const db = openFactsDb(dir, "alice");
      insertFact(db, { content: "Fact one" });
      insertFact(db, { content: "Fact two" });

      const facts = selectFacts(db);
      expect(facts).toHaveLength(2);
      expect(facts.map((f) => f.content)).toContain("Fact one");
      expect(facts.map((f) => f.content)).toContain("Fact two");
      db.close();
    });

    test("excludes soft-deleted facts", () => {
      const db = openFactsDb(dir, "alice");
      const fact = insertFact(db, { content: "Will be deleted" });
      insertFact(db, { content: "Will remain" });
      softDeleteFact(db, fact.id);

      const facts = selectFacts(db);
      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe("Will remain");
      db.close();
    });

    test("returns empty array when no facts exist", () => {
      const db = openFactsDb(dir, "alice");
      expect(selectFacts(db)).toEqual([]);
      db.close();
    });
  });

  describe("softDeleteFact", () => {
    test("sets deleted_at timestamp on the fact", () => {
      const db = openFactsDb(dir, "alice");
      const fact = insertFact(db, { content: "Delete me" });
      softDeleteFact(db, fact.id);

      const row = db
        .prepare("SELECT deleted_at FROM facts WHERE id = ?")
        .get(fact.id) as { deleted_at: string };
      expect(row.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      db.close();
    });

    test("soft-deleting non-existent id throws", () => {
      const db = openFactsDb(dir, "alice");
      expect(() => softDeleteFact(db, "nonexist")).toThrow();
      db.close();
    });
  });

  describe("round-trip", () => {
    test("insert then select produces identical objects", () => {
      const db = openFactsDb(dir, "bob");
      const inserted = insertFact(db, {
        content: "Stripe webhooks must be idempotent",
        project: "payments",
        tags: ["stripe", "webhooks", "idempotent"],
      });

      const facts = selectFacts(db);
      expect(facts).toHaveLength(1);

      const retrieved = facts[0];
      expect(retrieved).toEqual(inserted);
      db.close();
    });
  });
});
