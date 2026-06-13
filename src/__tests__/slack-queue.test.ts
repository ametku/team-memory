import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { enqueuePrompt, pendingPrompts, markProcessed } from "../slack-queue.js";

describe("slack queue", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tm-slack-queue-")); });
  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("returns empty pending when no queue file", () => {
    expect(pendingPrompts(dir)).toHaveLength(0);
  });

  it("enqueues a prompt", () => {
    enqueuePrompt(dir, "why does the deploy fail");
    expect(pendingPrompts(dir)).toHaveLength(1);
    expect(pendingPrompts(dir)[0].prompt).toBe("why does the deploy fail");
  });

  it("accumulates multiple prompts", () => {
    enqueuePrompt(dir, "why does X fail");
    enqueuePrompt(dir, "how should I handle retries");
    expect(pendingPrompts(dir)).toHaveLength(2);
  });

  it("markProcessed removes prompt from pending", () => {
    enqueuePrompt(dir, "why does X fail");
    enqueuePrompt(dir, "how to configure viper");
    markProcessed(dir, "why does X fail");
    const pending = pendingPrompts(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0].prompt).toBe("how to configure viper");
  });

  it("markProcessed is a no-op for unknown prompt", () => {
    enqueuePrompt(dir, "why does X fail");
    markProcessed(dir, "nonexistent prompt");
    expect(pendingPrompts(dir)).toHaveLength(1);
  });
});
