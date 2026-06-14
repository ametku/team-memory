import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rebuildIndex } from "../merged-index.js";
import { runPrepromptHook } from "../preprompt.js";
import { pendingPrompts } from "../slack-queue.js";

describe("preprompt hook — Slack queue logging", () => {
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

  it("queues qualifying prompt silently", () => {
    runPrepromptHook({
      prompt: "why does the payments service keep timing out",
      indexPath, repoDir, developer: "alice",
    });
    expect(pendingPrompts(repoDir)).toHaveLength(1);
    expect(pendingPrompts(repoDir)[0].prompt).toBe("why does the payments service keep timing out");
  });

  it("does not queue non-qualifying prompt", () => {
    runPrepromptHook({ prompt: "fix typo", indexPath, repoDir, developer: "alice" });
    expect(pendingPrompts(repoDir)).toHaveLength(0);
  });

  it("does not inject Slack instruction into additionalContext", () => {
    const result = runPrepromptHook({
      prompt: "why does the payments service keep timing out",
      indexPath, repoDir, developer: "alice",
    });
    const ctx = result.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).not.toContain("slack");
    expect(ctx).not.toContain("Agent");
  });

  it("queue logging never blocks the prompt — returns continue:true", () => {
    const result = runPrepromptHook({
      prompt: "why does the payments service crash on startup",
      indexPath, repoDir, developer: "alice",
    });
    expect(result.continue).toBe(true);
  });
});
