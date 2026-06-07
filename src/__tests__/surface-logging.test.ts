import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { openInteractionsDb } from "../interactions-db.js";
import { logSurfaces, commitInteractions } from "../surface-logging.js";

describe("logSurfaces", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "team-memory-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test("surfaces a fact once → surface_count = 1", () => {
    logSurfaces(dir, "alice", ["fact-1"]);

    const db = openInteractionsDb(dir, "alice");
    const row = db
      .prepare("SELECT * FROM interactions WHERE fact_id = ?")
      .get("fact-1") as { fact_id: string; surface_count: number; last_surfaced_at: string; explicit_score: number };
    db.close();

    expect(row.surface_count).toBe(1);
    expect(row.last_surfaced_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("surfaces a fact N times → surface_count = N, last_surfaced_at is latest", () => {
    logSurfaces(dir, "alice", ["fact-1"]);
    logSurfaces(dir, "alice", ["fact-1"]);
    logSurfaces(dir, "alice", ["fact-1"]);

    const db = openInteractionsDb(dir, "alice");
    const row = db
      .prepare("SELECT * FROM interactions WHERE fact_id = ?")
      .get("fact-1") as { fact_id: string; surface_count: number; last_surfaced_at: string };
    db.close();

    expect(row.surface_count).toBe(3);
  });

  test("surfaces multiple facts in one call → all rows updated", () => {
    logSurfaces(dir, "alice", ["fact-1", "fact-2", "fact-3"]);

    const db = openInteractionsDb(dir, "alice");
    const rows = db
      .prepare("SELECT * FROM interactions ORDER BY fact_id")
      .all() as { fact_id: string; surface_count: number }[];
    db.close();

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.surface_count === 1)).toBe(true);
  });

  test("empty array → no rows created", () => {
    logSurfaces(dir, "alice", []);

    const db = openInteractionsDb(dir, "alice");
    const rows = db.prepare("SELECT * FROM interactions").all();
    db.close();

    expect(rows).toHaveLength(0);
  });

  test("does not reset explicit_score on existing row", () => {
    const db = openInteractionsDb(dir, "alice");
    db.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2024-01-01T00:00:00Z', -1)"
    ).run("fact-1");
    db.close();

    logSurfaces(dir, "alice", ["fact-1"]);

    const db2 = openInteractionsDb(dir, "alice");
    const row = db2
      .prepare("SELECT * FROM interactions WHERE fact_id = ?")
      .get("fact-1") as { surface_count: number; explicit_score: number };
    db2.close();

    expect(row.surface_count).toBe(1);
    expect(row.explicit_score).toBe(-1);
  });
});

describe("commitInteractions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "team-memory-test-"));
    execSync("git init", { cwd: dir });
    execSync("git config user.name 'Test'", { cwd: dir });
    execSync("git config user.email 'test@test.com'", { cwd: dir });
    execSync("git commit --allow-empty -m 'init'", { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test("commits interactions db file to git", () => {
    logSurfaces(dir, "alice", ["fact-1"]);
    commitInteractions(dir, "alice");

    const log = execSync("git log --oneline", { cwd: dir, encoding: "utf-8" });
    expect(log).toContain("chore: update interactions");
  });

  test("interactions db file is tracked after commit", () => {
    logSurfaces(dir, "alice", ["fact-1"]);
    commitInteractions(dir, "alice");

    const tracked = execSync("git ls-files", { cwd: dir, encoding: "utf-8" });
    expect(tracked).toContain("interactions-alice.db");
  });

  test("no-op if interactions db does not exist", () => {
    commitInteractions(dir, "alice");

    const log = execSync("git log --oneline", { cwd: dir, encoding: "utf-8" });
    expect(log.trim().split("\n")).toHaveLength(1);
  });
});
