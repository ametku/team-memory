import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openInteractionsDb } from "../interactions-db.js";

describe("interactions-db", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "team-memory-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  describe("openInteractionsDb", () => {
    test("creates database file with interactions table", () => {
      const db = openInteractionsDb(dir, "alice");
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain("interactions");
      db.close();
    });

    test("interactions table has correct schema", () => {
      const db = openInteractionsDb(dir, "alice");
      const cols = db.pragma("table_info(interactions)") as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }[];
      const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

      expect(colMap["fact_id"].type).toBe("TEXT");
      expect(colMap["fact_id"].pk).toBe(1);
      expect(colMap["surface_count"].type).toBe("INTEGER");
      expect(colMap["surface_count"].dflt_value).toBe("0");
      expect(colMap["last_surfaced_at"].type).toBe("TEXT");
      expect(colMap["last_surfaced_at"].notnull).toBe(1);
      expect(colMap["explicit_score"].type).toBe("INTEGER");
      expect(colMap["explicit_score"].dflt_value).toBe("0");
      db.close();
    });

    test("opening same db twice is safe (idempotent migration)", () => {
      const db1 = openInteractionsDb(dir, "alice");
      db1.close();
      const db2 = openInteractionsDb(dir, "alice");
      const tables = db2
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain("interactions");
      db2.close();
    });
  });
});
