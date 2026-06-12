import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rebuildIndex } from "../merged-index.js";
import { runPrepromptHook } from "../preprompt.js";

describe("preprompt hook — Slack background agent injection", () => {
  let repoDir: string;
  let indexPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "tm-slack-preprompt-"));
    mkdirSync(join(repoDir, "facts"));
    mkdirSync(join(repoDir, "interactions"));
    indexPath = join(repoDir, "merged_index.db");
    rebuildIndex(repoDir, indexPath);
  });

  afterEach(() => { rmSync(repoDir, { recursive: true }); });

  it("injects background agent instruction for qualifying prompt", () => {
    const result = runPrepromptHook({
      prompt: "why does the payments service keep timing out",
      indexPath,
      repoDir,
      developer: "alice",
    });

    expect(result.continue).toBe(true);
    const ctx = result.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("Slack");
    expect(ctx).toContain("background");
    expect(ctx).toContain("team-memory slack-record");
  });

  it("does not inject Slack instruction for non-qualifying prompt", () => {
    const result = runPrepromptHook({
      prompt: "fix typo",
      indexPath,
      repoDir,
      developer: "alice",
    });

    const ctx = result.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).not.toContain("slack-record");
  });

  it("does not inject Slack instruction for short prompt", () => {
    const result = runPrepromptHook({
      prompt: "add return",
      indexPath,
      repoDir,
      developer: "alice",
    });

    const ctx = result.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).not.toContain("slack-record");
  });
});
