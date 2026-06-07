import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { openFactsDb, insertFact } from "../facts-db.js";
import { openInteractionsDb } from "../interactions-db.js";
import { rebuildIndex } from "../merged-index.js";

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

describe("preprompt-hook integration", () => {
  let repoDir: string;
  let indexPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "tm-preprompt-int-"));
    mkdirSync(join(repoDir, "facts"));
    mkdirSync(join(repoDir, "interactions"));
    indexPath = join(repoDir, "merged_index.db");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true });
  });

  test("injects matching facts into additionalContext", () => {
    const db = openFactsDb(join(repoDir, "facts"), "bob");
    const fact = insertFact(db, { content: "Use viper for config parsing in Go services" });
    db.close();
    rebuildIndex(repoDir, indexPath);

    const hookInput = JSON.stringify({
      session_id: "test-session",
      hook_event_name: "UserPromptSubmit",
      prompt: "viper config",
    });

    const output = execFileSync("node", [CLI_PATH, "preprompt-hook"], {
      encoding: "utf-8",
      input: hookInput,
      env: {
        ...process.env,
        TEAM_MEMORY_INDEX_PATH: indexPath,
        TEAM_MEMORY_DIR: repoDir,
        TEAM_MEMORY_DEVELOPER: "bob",
      },
    });

    const parsed = JSON.parse(output);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("viper");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(fact.id);
  });

  test("surface count incremented after hook call", () => {
    const db = openFactsDb(join(repoDir, "facts"), "bob");
    const fact = insertFact(db, { content: "Stripe webhooks must be idempotent" });
    db.close();
    rebuildIndex(repoDir, indexPath);

    const hookInput = JSON.stringify({
      session_id: "test-session",
      hook_event_name: "UserPromptSubmit",
      prompt: "stripe idempotent",
    });

    execFileSync("node", [CLI_PATH, "preprompt-hook"], {
      encoding: "utf-8",
      input: hookInput,
      env: {
        ...process.env,
        TEAM_MEMORY_INDEX_PATH: indexPath,
        TEAM_MEMORY_DIR: repoDir,
        TEAM_MEMORY_DEVELOPER: "bob",
      },
    });

    const idb = openInteractionsDb(join(repoDir, "interactions"), "bob");
    const row = idb
      .prepare("SELECT surface_count FROM interactions WHERE fact_id = ?")
      .get(fact.id) as { surface_count: number } | undefined;
    idb.close();

    expect(row?.surface_count).toBe(1);
  });

  test("no additionalContext when no facts match", () => {
    const db = openFactsDb(join(repoDir, "facts"), "bob");
    insertFact(db, { content: "Stripe webhooks must be idempotent" });
    db.close();
    rebuildIndex(repoDir, indexPath);

    const hookInput = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "kubernetes pod autoscaling",
    });

    const output = execFileSync("node", [CLI_PATH, "preprompt-hook"], {
      encoding: "utf-8",
      input: hookInput,
      env: {
        ...process.env,
        TEAM_MEMORY_INDEX_PATH: indexPath,
        TEAM_MEMORY_DIR: repoDir,
        TEAM_MEMORY_DEVELOPER: "bob",
      },
    });

    const parsed = JSON.parse(output);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });
});
