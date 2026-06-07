import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { postCloneSetup } from "../setup.js";

describe("postCloneSetup integration", () => {
  let tmp: string;
  let bareDir: string;
  let cloneDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tm-setup-int-"));
    bareDir = join(tmp, "bare.git");
    cloneDir = join(tmp, "clone");

    execFileSync("git", ["init", "--bare", bareDir]);
    execFileSync("git", ["clone", bareDir, cloneDir]);
    execFileSync("git", ["config", "user.name", "integrationdev"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.email", "int@test.com"], { cwd: cloneDir });
    // Initial commit so the branch exists
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: cloneDir });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: cloneDir });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  test("full setup and verify on re-clone", () => {
    process.env.TEAM_MEMORY_DEVELOPER = "integrationdev";

    const result = postCloneSetup({ repoDir: cloneDir });

    // Verify files created
    expect(existsSync(result.factsDbPath)).toBe(true);
    expect(existsSync(result.interactionsDbPath)).toBe(true);
    expect(existsSync(result.indexPath)).toBe(true);
    expect(existsSync(result.hookPath)).toBe(true);

    // Verify commit in log
    const log = execFileSync("git", ["log", "--oneline"], { cwd: cloneDir, encoding: "utf-8" });
    expect(log).toContain("initialize per-dev databases");

    // Push and re-clone
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: cloneDir });
    const recloneDir = join(tmp, "reclone");
    execFileSync("git", ["clone", bareDir, recloneDir]);

    // Verify db files present in re-clone
    expect(existsSync(join(recloneDir, "facts", "facts-integrationdev.db"))).toBe(true);
    expect(existsSync(join(recloneDir, "interactions", "interactions-integrationdev.db"))).toBe(true);

    delete process.env.TEAM_MEMORY_DEVELOPER;
  });
});
