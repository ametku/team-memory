import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { joinRepo } from "../join.js";

describe("joinRepo", () => {
  let tmp: string;
  let bareDir: string;
  let seedDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tm-join-"));
    bareDir = join(tmp, "team.git");
    seedDir = join(tmp, "seed");

    execFileSync("git", ["init", "--bare", bareDir]);
    execFileSync("git", ["clone", bareDir, seedDir]);
    execFileSync("git", ["config", "user.email", "seed@test.com"], { cwd: seedDir });
    execFileSync("git", ["config", "user.name", "seeddev"], { cwd: seedDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: seedDir });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: seedDir });

    process.env.TEAM_MEMORY_DEVELOPER = "joiner";
    process.env.TEAM_MEMORY_CLAUDE_SETTINGS = join(tmp, ".claude", "settings.json");
    process.env.TEAM_MEMORY_CLAUDE_SKILLS_DIR = join(tmp, ".claude", "skills");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
    delete process.env.TEAM_MEMORY_DEVELOPER;
    delete process.env.TEAM_MEMORY_DIR;
    delete process.env.TEAM_MEMORY_CLAUDE_SETTINGS;
    delete process.env.TEAM_MEMORY_CLAUDE_SKILLS_DIR;
  });

  test("clones repo, runs setup, pushes per-dev DB commit", () => {
    const target = join(tmp, "joined");

    const result = joinRepo({ repoUrl: bareDir, dir: target });

    expect(result.repoDir).toBe(target);
    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(existsSync(result.setup.factsDbPath)).toBe(true);
    expect(existsSync(result.setup.interactionsDbPath)).toBe(true);
    expect(existsSync(result.setup.indexPath)).toBe(true);
    expect(existsSync(result.setup.hookPath)).toBe(true);

    // Verify commit was pushed: re-clone bare and check .db files
    const verify = join(tmp, "verify");
    execFileSync("git", ["clone", bareDir, verify]);
    expect(existsSync(join(verify, "facts", "facts-joiner.db"))).toBe(true);
    expect(existsSync(join(verify, "interactions", "interactions-joiner.db"))).toBe(true);
  });

  test("installs Claude UserPromptSubmit hook in settings.json", () => {
    const target = join(tmp, "with-hook");
    joinRepo({ repoUrl: bareDir, dir: target });

    const settingsPath = process.env.TEAM_MEMORY_CLAUDE_SETTINGS!;
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      "team-memory preprompt-hook",
    );
  });

  test("installs SessionEnd hook and extract-facts skill", () => {
    const target = join(tmp, "with-skill");
    joinRepo({ repoUrl: bareDir, dir: target });

    const settings = JSON.parse(
      readFileSync(process.env.TEAM_MEMORY_CLAUDE_SETTINGS!, "utf-8"),
    );
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain("/extract-facts");

    const skillPath = join(tmp, ".claude", "skills", "extract-facts", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toContain("name: extract-facts");
  });

  test("aborts if target directory already exists", () => {
    const target = join(tmp, "occupied");
    mkdirSync(target);

    expect(() => joinRepo({ repoUrl: bareDir, dir: target })).toThrow(/already exists/);
  });

  test("resolves dir from TEAM_MEMORY_DIR env when dir arg omitted", () => {
    const target = join(tmp, "from-env");
    process.env.TEAM_MEMORY_DIR = target;

    const result = joinRepo({ repoUrl: bareDir });

    expect(result.repoDir).toBe(target);
    expect(existsSync(join(target, ".git"))).toBe(true);
  });
});
