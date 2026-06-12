import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { resolve } from "path";
import {
  isOptedIn, createOptInMarker, registerProject,
  getOptedInEncodedPaths, getOptedInProjects,
} from "../opt-in.js";

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

describe("opt-in module", () => {
  let projectDir: string;
  let repoDir: string;

  beforeEach(() => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tm-optin-project-")));
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), "tm-optin-repo-")));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true });
    rmSync(repoDir, { recursive: true });
  });

  it("isOptedIn returns false when marker absent", () => {
    expect(isOptedIn(projectDir)).toBe(false);
  });

  it("createOptInMarker creates the marker file", () => {
    createOptInMarker(projectDir);
    expect(existsSync(join(projectDir, ".claude/team-memory.md"))).toBe(true);
    expect(isOptedIn(projectDir)).toBe(true);
  });

  it("createOptInMarker returns false when already present", () => {
    createOptInMarker(projectDir);
    expect(createOptInMarker(projectDir)).toBe(false);
  });

  it("registerProject adds to registry with encoded path", () => {
    registerProject(repoDir, projectDir);
    const encoded = getOptedInEncodedPaths(repoDir);
    expect(encoded).toContain(projectDir.replace(/\//g, "-"));
  });

  it("getOptedInProjects returns absolute paths", () => {
    registerProject(repoDir, projectDir);
    expect(getOptedInProjects(repoDir)).toContain(projectDir);
  });

  it("getOptedInEncodedPaths returns empty array when no registry", () => {
    expect(getOptedInEncodedPaths(repoDir)).toHaveLength(0);
  });

  it("registerProject is idempotent", () => {
    registerProject(repoDir, projectDir);
    registerProject(repoDir, projectDir);
    expect(getOptedInProjects(repoDir)).toHaveLength(1);
  });
});

describe("team-memory opt-in CLI", () => {
  let projectDir: string;
  let repoDir: string;

  beforeEach(() => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tm-optin-cli-")));
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), "tm-optin-repo-")));
    execFileSync("git", ["init"], { cwd: projectDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: projectDir });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true });
    rmSync(repoDir, { recursive: true });
  });

  it("creates marker and registers project", () => {
    const output = execFileSync("node", [CLI_PATH, "opt-in"], {
      encoding: "utf-8",
      cwd: projectDir,
      env: { ...process.env, TEAM_MEMORY_DIR: repoDir },
    });
    expect(output).toContain("Opted in");
    expect(existsSync(join(projectDir, ".claude/team-memory.md"))).toBe(true);
    expect(getOptedInProjects(repoDir)).toContain(projectDir);
  });

  it("reports already opted in on second run", () => {
    execFileSync("node", [CLI_PATH, "opt-in"], {
      encoding: "utf-8", cwd: projectDir,
      env: { ...process.env, TEAM_MEMORY_DIR: repoDir },
    });
    const output = execFileSync("node", [CLI_PATH, "opt-in"], {
      encoding: "utf-8", cwd: projectDir,
      env: { ...process.env, TEAM_MEMORY_DIR: repoDir },
    });
    expect(output).toContain("Already opted in");
  });
});
