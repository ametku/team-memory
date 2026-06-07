import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openFactsDb, insertFact } from "../facts-db.js";
import { rebuildIndex } from "../merged-index.js";
import { openInteractionsDb } from "../interactions-db.js";
import { runPrepromptHook } from "../preprompt.js";

describe("runPrepromptHook", () => {
  let repoDir: string;
  let indexPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "team-memory-preprompt-"));
    mkdirSync(join(repoDir, "facts"));
    mkdirSync(join(repoDir, "interactions"));
    indexPath = join(repoDir, "merged_index.db");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true });
  });

  function seedAndBuild(facts: { content: string }[]) {
    const db = openFactsDb(join(repoDir, "facts"), "alice");
    for (const f of facts) insertFact(db, f);
    db.close();
    rebuildIndex(repoDir, indexPath);
  }

  test("returns matching facts as additionalContext", () => {
    seedAndBuild([
      { content: "Use viper for config parsing in Go services" },
      { content: "Stripe webhooks must be idempotent" },
    ]);

    const result = runPrepromptHook({ prompt: "viper config", indexPath, repoDir, developer: "alice" });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toContain("viper");
  });

  test("returns continue:true with no additionalContext when index missing", () => {
    const result = runPrepromptHook({
      prompt: "anything",
      indexPath: "/nonexistent/merged_index.db",
      repoDir,
      developer: "alice",
    });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  test("returns continue:true with no additionalContext when no facts match", () => {
    seedAndBuild([{ content: "Stripe webhooks must be idempotent" }]);

    const result = runPrepromptHook({ prompt: "viper config golang", indexPath, repoDir, developer: "alice" });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  test("logs surface counts for returned facts", () => {
    seedAndBuild([{ content: "Use viper for config parsing" }]);

    runPrepromptHook({ prompt: "viper", indexPath, repoDir, developer: "alice" });

    const db = openInteractionsDb(join(repoDir, "interactions"), "alice");
    const rows = db.prepare("SELECT * FROM interactions").all() as { fact_id: string; surface_count: number }[];
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].surface_count).toBe(1);
  });
});
