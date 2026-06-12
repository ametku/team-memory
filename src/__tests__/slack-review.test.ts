import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { recordThread, loadSession } from "../slack-session.js";
import { reviewSlackSession } from "../slack-review.js";

const CLI_PATH = new URL("../../dist/cli.js", import.meta.url).pathname;

describe("reviewSlackSession", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-slack-review-"));
    mkdirSync(join(dir, "facts"));
    mkdirSync(join(dir, "interactions"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: dir });
  });

  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("exits silently when no session file exists", async () => {
    const lines: string[] = [];
    await expect(
      reviewSlackSession(dir, "testdev", { input: "", onPrompt: (q) => { lines.push(q); return Promise.resolve(false); } })
    ).resolves.not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it("deletes session file after review regardless of approval", async () => {
    recordThread(dir, { url: "https://slack.com/t/1", summary: "Use pnpm", prompt: "how to install" });
    await reviewSlackSession(dir, "testdev", {
      input: "",
      onPrompt: () => Promise.resolve(false),
    });
    expect(existsSync(join(dir, "slack-surface-session.json"))).toBe(false);
  });

  it("prompts once per thread", async () => {
    recordThread(dir, { url: "https://slack.com/t/1", summary: "tip one", prompt: "q1" });
    recordThread(dir, { url: "https://slack.com/t/2", summary: "tip two", prompt: "q2" });

    const prompts: string[] = [];
    await reviewSlackSession(dir, "testdev", {
      input: "",
      onPrompt: (q) => { prompts.push(q); return Promise.resolve(false); },
    });
    expect(prompts).toHaveLength(2);
  });

  it("saves approved threads as facts via team-memory add", async () => {
    recordThread(dir, { url: "https://slack.com/t/1", summary: "always use pnpm not npm", prompt: "how to install" });

    let approvalCount = 0;
    await reviewSlackSession(dir, "testdev", {
      input: "",
      onPrompt: () => { approvalCount++; return Promise.resolve(true); },
      repoDir: dir,
    });

    // fact should be in the DB
    const { openFactsDb, selectFacts } = await import("../facts-db.js");
    const db = openFactsDb(join(dir, "facts"), "testdev");
    const facts = selectFacts(db);
    db.close();
    expect(facts.some(f => f.content.includes("always use pnpm not npm"))).toBe(true);
  });
});

describe("team-memory slack-record CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-slack-record-cli-"));
  });

  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("writes thread to session file", () => {
    execFileSync("node", [CLI_PATH, "slack-record",
      "--url", "https://slack.com/t/123",
      "--summary", "Use X not Y in this repo",
      "--prompt", "why does the build fail",
    ], {
      encoding: "utf-8",
      env: { ...process.env, TEAM_MEMORY_DIR: dir },
    });

    const session = loadSession(dir);
    expect(session?.threads).toHaveLength(1);
    expect(session?.threads[0].url).toBe("https://slack.com/t/123");
    expect(session?.threads[0].summary).toBe("Use X not Y in this repo");
  });
});
