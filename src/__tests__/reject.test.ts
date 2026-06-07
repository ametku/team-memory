import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { openFactsDb, insertFact } from "../facts-db.js";
import { openInteractionsDb } from "../interactions-db.js";
import { rejectFact } from "../reject.js";

describe("rejectFact", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-reject-"));
    mkdirSync(join(dir, "facts"));
    mkdirSync(join(dir, "interactions"));
    execSync("git init", { cwd: dir });
    execSync('git config user.email "test@test.com"', { cwd: dir });
    execSync('git config user.name "testdev"', { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test("records explicit_score = -1 for a valid fact", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(factsDb, { content: "always use TLS" });
    factsDb.exec("VACUUM");
    factsDb.close();

    const result = rejectFact({ factId: fact.id, repoDir: dir, developer: "bob" });

    expect(result.content).toBe("always use TLS");

    const iDb = openInteractionsDb(join(dir, "interactions"), "bob");
    const row = iDb.prepare("SELECT explicit_score, surface_count FROM interactions WHERE fact_id = ?").get(fact.id) as any;
    iDb.close();
    expect(row.explicit_score).toBe(-1);
    expect(row.surface_count).toBe(0);
  });

  test("rejecting same fact twice keeps explicit_score at -1", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(factsDb, { content: "use pnpm" });
    factsDb.exec("VACUUM");
    factsDb.close();

    rejectFact({ factId: fact.id, repoDir: dir, developer: "bob" });
    rejectFact({ factId: fact.id, repoDir: dir, developer: "bob" });

    const iDb = openInteractionsDb(join(dir, "interactions"), "bob");
    const row = iDb.prepare("SELECT explicit_score FROM interactions WHERE fact_id = ?").get(fact.id) as any;
    iDb.close();
    expect(row.explicit_score).toBe(-1);
  });

  test("reject preserves existing surface_count and last_surfaced_at", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(factsDb, { content: "check CI before merge" });
    factsDb.exec("VACUUM");
    factsDb.close();

    const iDb = openInteractionsDb(join(dir, "interactions"), "bob");
    iDb.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 5, '2026-01-01T00:00:00Z', 0)"
    ).run(fact.id);
    iDb.close();

    rejectFact({ factId: fact.id, repoDir: dir, developer: "bob" });

    const iDb2 = openInteractionsDb(join(dir, "interactions"), "bob");
    const row = iDb2.prepare("SELECT surface_count, last_surfaced_at, explicit_score FROM interactions WHERE fact_id = ?").get(fact.id) as any;
    iDb2.close();
    expect(row.explicit_score).toBe(-1);
    expect(row.surface_count).toBe(5);
    expect(row.last_surfaced_at).toBe("2026-01-01T00:00:00Z");
  });

  test("throws error for non-existent fact_id", () => {
    expect(() =>
      rejectFact({ factId: "nonexist", repoDir: dir, developer: "bob" })
    ).toThrow("Fact not found: nonexist");
  });

  test("throws error for soft-deleted fact", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(factsDb, { content: "old fact" });
    factsDb.prepare("UPDATE facts SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), fact.id);
    factsDb.exec("VACUUM");
    factsDb.close();

    expect(() =>
      rejectFact({ factId: fact.id, repoDir: dir, developer: "bob" })
    ).toThrow(`Fact not found: ${fact.id}`);
  });
});
