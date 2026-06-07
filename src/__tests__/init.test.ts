import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { initRepo, RepoCreator } from "../init.js";

function makeClaudeSettingsPath(tmp: string): string {
  return join(tmp, ".claude", "settings.json");
}

describe("initRepo", () => {
  let tmp: string;
  let bareDir: string;
  let createRepo: RepoCreator;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tm-init-"));
    bareDir = join(tmp, "remote.git");
    execFileSync("git", ["init", "--bare", bareDir]);

    // Stand-in for `gh repo create --clone`: clone the local bare repo to the target dir
    createRepo = (_slug: string, dir: string) => {
      execFileSync("git", ["clone", bareDir, dir]);
      execFileSync("git", ["config", "user.email", "init@test.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "initdev"], { cwd: dir });
      // Bare repo has no default branch yet; set up an initial commit so push origin HEAD works
      execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: dir });
      execFileSync("git", ["push", "origin", "HEAD"], { cwd: dir });
    };

    process.env.TEAM_MEMORY_DEVELOPER = "initdev";
    process.env.TEAM_MEMORY_CLAUDE_SETTINGS = makeClaudeSettingsPath(tmp);
    process.env.TEAM_MEMORY_CLAUDE_SKILLS_DIR = join(tmp, ".claude", "skills");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
    delete process.env.TEAM_MEMORY_DEVELOPER;
    delete process.env.TEAM_MEMORY_DIR;
    delete process.env.TEAM_MEMORY_CLAUDE_SETTINGS;
    delete process.env.TEAM_MEMORY_CLAUDE_SKILLS_DIR;
  });

  test("scaffolds README and config.yaml, runs setup, pushes", () => {
    const target = join(tmp, "new-team");

    const result = initRepo({ org: "myorg", repo: "myteam", dir: target }, createRepo);

    expect(result.repoDir).toBe(target);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(join(target, "config.yaml"))).toBe(true);
    expect(existsSync(result.setup.factsDbPath)).toBe(true);
    expect(existsSync(result.setup.indexPath)).toBe(true);
    expect(existsSync(result.setup.hookPath)).toBe(true);

    const config = readFileSync(join(target, "config.yaml"), "utf-8");
    expect(config).toMatch(/version:\s*1/);
    expect(config).toMatch(/developer:\s*initdev/);

    // Verify push: re-clone bare and check files
    const verify = join(tmp, "verify");
    execFileSync("git", ["clone", bareDir, verify]);
    expect(existsSync(join(verify, "README.md"))).toBe(true);
    expect(existsSync(join(verify, "config.yaml"))).toBe(true);
    expect(existsSync(join(verify, "facts", "facts-initdev.db"))).toBe(true);
  });

  test("aborts if target directory already exists", () => {
    const target = join(tmp, "occupied");
    mkdirSync(target);

    expect(() => initRepo({ org: "o", repo: "r", dir: target }, createRepo)).toThrow(
      /already exists/,
    );
  });

  test("resolves dir from TEAM_MEMORY_DIR when dir arg omitted", () => {
    const target = join(tmp, "from-env");
    process.env.TEAM_MEMORY_DIR = target;

    const result = initRepo({ org: "o", repo: "r" }, createRepo);

    expect(result.repoDir).toBe(target);
    expect(existsSync(join(target, "config.yaml"))).toBe(true);
  });

  test("installs Claude UserPromptSubmit hook in settings.json", () => {
    const target = join(tmp, "with-hook");
    initRepo({ org: "o", repo: "r", dir: target }, createRepo);

    const settingsPath = makeClaudeSettingsPath(tmp);
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toBe("team-memory preprompt-hook");
  });

  test("installs SessionEnd hook and extract-facts skill", () => {
    const target = join(tmp, "with-skill");
    initRepo({ org: "o", repo: "r", dir: target }, createRepo);

    const settings = JSON.parse(readFileSync(makeClaudeSettingsPath(tmp), "utf-8"));
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain("/extract-facts");

    const skillPath = join(tmp, ".claude", "skills", "extract-facts", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toContain("name: extract-facts");
  });

  test("passes <org>/<repo> slug to createRepo", () => {
    let receivedSlug: string | undefined;
    const captureCreator: RepoCreator = (slug, dir) => {
      receivedSlug = slug;
      createRepo(slug, dir);
    };

    initRepo({ org: "myorg", repo: "myteam", dir: join(tmp, "captured") }, captureCreator);

    expect(receivedSlug).toBe("myorg/myteam");
  });
});
