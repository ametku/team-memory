import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { initRepo, RepoCreator } from "../init.js";

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
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
    delete process.env.TEAM_MEMORY_DEVELOPER;
    delete process.env.TEAM_MEMORY_DIR;
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
