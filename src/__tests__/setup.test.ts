import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { assertDirNotExists, postCloneSetup } from "../setup.js";

describe("assertDirNotExists", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tm-guard-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  test("throws when directory exists", () => {
    const dir = join(tmp, "existing");
    mkdirSync(dir);
    expect(() => assertDirNotExists(dir)).toThrow(/already exists/);
  });

  test("does not throw when directory does not exist", () => {
    const dir = join(tmp, "nonexistent");
    expect(() => assertDirNotExists(dir)).not.toThrow();
  });
});

describe("postCloneSetup", () => {
  let tmp: string;
  let repoDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tm-setup-"));
    repoDir = join(tmp, "repo");
    mkdirSync(repoDir);
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    // Need an initial commit so git commit works
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  test("creates facts db with correct schema", () => {
    process.env.TEAM_MEMORY_DEVELOPER = "testdev";
    const result = postCloneSetup({ repoDir });
    expect(existsSync(result.factsDbPath)).toBe(true);
    expect(result.factsDbPath).toContain("facts-testdev.db");
    delete process.env.TEAM_MEMORY_DEVELOPER;
  });

  test("creates interactions db with correct schema", () => {
    process.env.TEAM_MEMORY_DEVELOPER = "testdev";
    const result = postCloneSetup({ repoDir });
    expect(existsSync(result.interactionsDbPath)).toBe(true);
    expect(result.interactionsDbPath).toContain("interactions-testdev.db");
    delete process.env.TEAM_MEMORY_DEVELOPER;
  });

  test("builds merged_index.db", () => {
    process.env.TEAM_MEMORY_DEVELOPER = "testdev";
    const result = postCloneSetup({ repoDir });
    expect(existsSync(result.indexPath)).toBe(true);
    expect(result.indexPath).toContain("merged_index.db");
    delete process.env.TEAM_MEMORY_DEVELOPER;
  });

  test("installs post-merge hook", () => {
    process.env.TEAM_MEMORY_DEVELOPER = "testdev";
    const result = postCloneSetup({ repoDir });
    expect(existsSync(result.hookPath)).toBe(true);
    expect(result.hookInstalled).toBe(true);
    const stat = statSync(result.hookPath);
    expect(stat.mode & 0o755).toBe(0o755);
    delete process.env.TEAM_MEMORY_DEVELOPER;
  });

  test("commits the db files", () => {
    process.env.TEAM_MEMORY_DEVELOPER = "testdev";
    postCloneSetup({ repoDir });
    const log = execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf-8" });
    expect(log).toContain("initialize per-dev databases");
    delete process.env.TEAM_MEMORY_DEVELOPER;
  });

  test("returns correct result struct", () => {
    process.env.TEAM_MEMORY_DEVELOPER = "testdev";
    const result = postCloneSetup({ repoDir });
    expect(result.developer).toBe("testdev");
    expect(result.factsDbPath).toBe(join(repoDir, "facts", "facts-testdev.db"));
    expect(result.interactionsDbPath).toBe(join(repoDir, "interactions", "interactions-testdev.db"));
    expect(result.indexPath).toBe(join(repoDir, "merged_index.db"));
    expect(result.hookPath).toBe(join(repoDir, ".git", "hooks", "post-merge"));
    delete process.env.TEAM_MEMORY_DEVELOPER;
  });
});
