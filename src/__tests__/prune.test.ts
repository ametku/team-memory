import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { openFactsDb, insertFact } from "../facts-db.js";
import { openInteractionsDb } from "../interactions-db.js";
import { pruneFacts } from "../prune.js";

describe("pruneFacts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-prune-"));
    mkdirSync(join(dir, "facts"));
    mkdirSync(join(dir, "interactions"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test("prunes fact with net_explicit <= -2 (rejected)", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(factsDb, { content: "bad advice" });
    factsDb.exec("VACUUM");
    factsDb.close();

    // Two different devs reject it: net_explicit = -2
    const iDb1 = openInteractionsDb(join(dir, "interactions"), "bob");
    iDb1.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 3, '2026-06-01T00:00:00Z', -1)"
    ).run(fact.id);
    iDb1.close();

    const iDb2 = openInteractionsDb(join(dir, "interactions"), "carol");
    iDb2.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 1, '2026-06-02T00:00:00Z', -1)"
    ).run(fact.id);
    iDb2.close();

    // Git commit the facts DB so prune can commit its deletion
    execFileSync("git", ["add", "facts/facts-alice.db"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "setup"], { cwd: dir });

    const result = pruneFacts({ repoDir: dir, developer: "alice" });

    expect(result.pruned).toHaveLength(1);
    expect(result.pruned[0].id).toBe(fact.id);
    expect(result.pruned[0].reason).toBe("rejected");

    // Verify physical deletion
    const db = openFactsDb(join(dir, "facts"), "alice");
    const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(fact.id);
    db.close();
    expect(row).toBeUndefined();
  });
});
