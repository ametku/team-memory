import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installPostMergeHook } from "../hook.js";

describe("installPostMergeHook", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-hook-"));
    execFileSync("git", ["init"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("installs hook at correct path with correct content", () => {
    const result = installPostMergeHook({ repoDir: dir });

    expect(result.installed).toBe(true);
    expect(result.hookPath).toBe(join(dir, ".git", "hooks", "post-merge"));

    const content = readFileSync(result.hookPath, "utf-8");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain("team-memory rebuild-index");
  });

  it("hook file is executable", () => {
    const result = installPostMergeHook({ repoDir: dir });
    const stats = statSync(result.hookPath);
    const mode = stats.mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
  });

  it("skips installation if hook already exists", () => {
    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "post-merge"), "#!/bin/sh\necho existing\n");

    const result = installPostMergeHook({ repoDir: dir });

    expect(result.installed).toBe(false);
    const content = readFileSync(result.hookPath, "utf-8");
    expect(content).toContain("echo existing");
  });

  it("creates hooks directory if missing", () => {
    const hooksDir = join(dir, ".git", "hooks");
    rmSync(hooksDir, { recursive: true, force: true });

    const result = installPostMergeHook({ repoDir: dir });

    expect(result.installed).toBe(true);
    expect(readFileSync(result.hookPath, "utf-8")).toContain("#!/bin/sh");
  });

  it("hook script is non-blocking (exits 0 even on rebuild failure)", () => {
    const result = installPostMergeHook({ repoDir: dir });
    const content = readFileSync(result.hookPath, "utf-8");
    expect(content).toContain("||");
    expect(content).not.toContain("set -e");
  });
});
