import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openFactsDb, insertFact } from "../facts-db.js";
import { rebuildIndex } from "../merged-index.js";
import { openInteractionsDb } from "../interactions-db.js";
import { runPrepromptHook } from "../preprompt.js";
import { createOptInMarker } from "../opt-in.js";

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

  function seedAndBuild(facts: { content: string; project?: string }[]) {
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

  test("project filter surfaces only matching project + team-wide facts", () => {
    seedAndBuild([
      { content: "payments fact about retries", project: "payments-service" },
      { content: "frontend fact about retries", project: "web-app" },
      { content: "team-wide fact about retries" },
    ]);

    const result = runPrepromptHook({
      prompt: "retries",
      indexPath,
      repoDir,
      developer: "alice",
      project: "payments-service",
    });

    const ctx = result.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("payments fact");
    expect(ctx).toContain("team-wide fact");
    expect(ctx).not.toContain("frontend fact");
  });

  test("no project filter surfaces all matching facts", () => {
    seedAndBuild([
      { content: "payments fact about retries", project: "payments-service" },
      { content: "frontend fact about retries", project: "web-app" },
    ]);

    const result = runPrepromptHook({ prompt: "retries", indexPath, repoDir, developer: "alice" });

    const ctx = result.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("payments fact");
    expect(ctx).toContain("frontend fact");
  });

  test("returns continue:true with no additionalContext when prompt has FTS special characters and no signals", () => {
    seedAndBuild([{ content: "Rate limit is 100 requests per second" }]);

    // Deliberately non-qualifying: no question/debug/arch keywords, > 20 chars, but has FTS special chars
    const result = runPrepromptHook({
      prompt: `rate limit "OR" AND (test)`,
      indexPath,
      repoDir,
      developer: "alice",
    });

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

  test("returns continue:true with no context when project is not opted in", () => {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "tm-not-opted-")));
    seedAndBuild([{ content: "Use viper for config parsing" }]);

    const result = runPrepromptHook({
      prompt: "viper config", indexPath, repoDir, developer: "alice", projectRoot,
    });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
    rmSync(projectRoot, { recursive: true });
  });

  test("injects facts when project is opted in", () => {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "tm-opted-in-")));
    createOptInMarker(projectRoot);
    seedAndBuild([{ content: "Use viper for config parsing" }]);

    const result = runPrepromptHook({
      prompt: "viper config", indexPath, repoDir, developer: "alice", projectRoot,
    });

    expect(result.hookSpecificOutput?.additionalContext).toContain("viper");
    rmSync(projectRoot, { recursive: true });
  });

  test("injects facts when projectRoot is not provided (backward compat)", () => {
    seedAndBuild([{ content: "Use viper for config parsing" }]);

    const result = runPrepromptHook({ prompt: "viper config", indexPath, repoDir, developer: "alice" });

    expect(result.hookSpecificOutput?.additionalContext).toContain("viper");
  });
});
