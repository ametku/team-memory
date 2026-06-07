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

  test("prunes fact with zero surfaces and age > 6 months (never-surfaced)", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const id = "old-fact1";
    factsDb.prepare(
      "INSERT INTO facts (id, content, project, tags, created_at, deleted_at) VALUES (?, ?, NULL, '[]', ?, NULL)"
    ).run(id, "ancient wisdom", "2025-01-01T00:00:00Z");
    factsDb.exec("VACUUM");
    factsDb.close();

    execFileSync("git", ["add", "facts/facts-alice.db"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "setup"], { cwd: dir });

    const result = pruneFacts({ repoDir: dir, developer: "alice" });

    expect(result.pruned).toHaveLength(1);
    expect(result.pruned[0].id).toBe(id);
    expect(result.pruned[0].reason).toBe("never-surfaced");
  });

  test("prunes fact last surfaced > 6 months ago with total_surfaces < 5 (stale)", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(factsDb, { content: "briefly relevant tip" });
    factsDb.exec("VACUUM");
    factsDb.close();

    const iDb = openInteractionsDb(join(dir, "interactions"), "bob");
    iDb.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 3, '2025-01-01T00:00:00Z', 0)"
    ).run(fact.id);
    iDb.close();

    execFileSync("git", ["add", "facts/facts-alice.db"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "setup"], { cwd: dir });

    const result = pruneFacts({ repoDir: dir, developer: "alice" });

    expect(result.pruned).toHaveLength(1);
    expect(result.pruned[0].id).toBe(fact.id);
    expect(result.pruned[0].reason).toBe("stale");
  });

  test("does NOT prune facts that meet no predicate (evergreen)", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(factsDb, { content: "healthy fact" });
    factsDb.exec("VACUUM");
    factsDb.close();

    const iDb = openInteractionsDb(join(dir, "interactions"), "bob");
    iDb.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 10, '2026-06-01T00:00:00Z', 1)"
    ).run(fact.id);
    iDb.close();

    execFileSync("git", ["add", "facts/facts-alice.db"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "setup"], { cwd: dir });

    const result = pruneFacts({ repoDir: dir, developer: "alice" });

    expect(result.pruned).toHaveLength(0);

    const db = openFactsDb(join(dir, "facts"), "alice");
    const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(fact.id);
    db.close();
    expect(row).toBeDefined();
  });

  test("dry-run reports prunable facts without deleting them", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(factsDb, { content: "doomed fact" });
    factsDb.exec("VACUUM");
    factsDb.close();

    const iDb1 = openInteractionsDb(join(dir, "interactions"), "bob");
    iDb1.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-01T00:00:00Z', -1)"
    ).run(fact.id);
    iDb1.close();

    const iDb2 = openInteractionsDb(join(dir, "interactions"), "carol");
    iDb2.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-02T00:00:00Z', -1)"
    ).run(fact.id);
    iDb2.close();

    execFileSync("git", ["add", "facts/facts-alice.db"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "setup"], { cwd: dir });

    const result = pruneFacts({ repoDir: dir, developer: "alice", dryRun: true });

    expect(result.pruned).toHaveLength(1);
    expect(result.pruned[0].reason).toBe("rejected");

    const db = openFactsDb(join(dir, "facts"), "alice");
    const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(fact.id);
    db.close();
    expect(row).toBeDefined();
  });

  test("only prunes facts from the specified developer's DB", () => {
    const aliceDb = openFactsDb(join(dir, "facts"), "alice");
    const aliceFact = insertFact(aliceDb, { content: "alice bad fact" });
    aliceDb.exec("VACUUM");
    aliceDb.close();

    const bobDb = openFactsDb(join(dir, "facts"), "bob");
    const bobFact = insertFact(bobDb, { content: "bob bad fact" });
    bobDb.exec("VACUUM");
    bobDb.close();

    const iDb1 = openInteractionsDb(join(dir, "interactions"), "carol");
    iDb1.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-01T00:00:00Z', -1)"
    ).run(aliceFact.id);
    iDb1.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-01T00:00:00Z', -1)"
    ).run(bobFact.id);
    iDb1.close();

    const iDb2 = openInteractionsDb(join(dir, "interactions"), "dave");
    iDb2.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-02T00:00:00Z', -1)"
    ).run(aliceFact.id);
    iDb2.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-02T00:00:00Z', -1)"
    ).run(bobFact.id);
    iDb2.close();

    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "setup"], { cwd: dir });

    const result = pruneFacts({ repoDir: dir, developer: "alice" });

    expect(result.pruned).toHaveLength(1);
    expect(result.pruned[0].id).toBe(aliceFact.id);

    const db = openFactsDb(join(dir, "facts"), "bob");
    const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(bobFact.id);
    db.close();
    expect(row).toBeDefined();
  });

  test("returns empty result when developer has no facts", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    factsDb.exec("VACUUM");
    factsDb.close();

    execFileSync("git", ["add", "facts/facts-alice.db"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "setup"], { cwd: dir });

    const result = pruneFacts({ repoDir: dir, developer: "alice" });

    expect(result.pruned).toHaveLength(0);
  });
});
