import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { installClaudeHook } from "../claude-hook.js";

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

describe("installClaudeHook — clean replace", () => {
  let settingsDir: string;
  let settingsPath: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(join(tmpdir(), "tm-update-"));
    settingsPath = join(settingsDir, "settings.json");
  });

  afterEach(() => { rmSync(settingsDir, { recursive: true }); });

  it("installs hooks on fresh settings", () => {
    const result = installClaudeHook({ settingsPath });
    const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.SessionEnd).toHaveLength(1);
  });

  it("replaces stale team-memory hook without duplicating", () => {
    // Install old version
    const oldSettings = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "team-memory old-preprompt" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "echo 'team-memory: old message'" }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(oldSettings, null, 2));

    // Re-install (simulates update)
    installClaudeHook({ settingsPath });

    const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Should have exactly 1 entry each — old removed, new added
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    // New commands should be current versions
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe("team-memory preprompt-hook");
    expect(s.hooks.SessionEnd[0].hooks[0].command).toContain("systemMessage");
  });

  it("preserves non-team-memory hooks", () => {
    const existing = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-other-tool hook" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "my-other-tool end" }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    installClaudeHook({ settingsPath });

    const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Other tool preserved + team-memory added = 2 each
    expect(s.hooks.UserPromptSubmit).toHaveLength(2);
    expect(s.hooks.SessionEnd).toHaveLength(2);
    expect(s.hooks.UserPromptSubmit.some((g: any) => g.hooks[0].command === "my-other-tool hook")).toBe(true);
    expect(s.hooks.UserPromptSubmit.some((g: any) => g.hooks[0].command === "team-memory preprompt-hook")).toBe(true);
  });

  it("running twice produces no duplicates", () => {
    installClaudeHook({ settingsPath });
    installClaudeHook({ settingsPath });
    const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.SessionEnd).toHaveLength(1);
  });
});

describe("team-memory update CLI", () => {
  let tmp: string;
  let bareDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tm-update-cli-"));
    bareDir = join(tmp, "team.git");
    const seed = join(tmp, "seed");
    execFileSync("git", ["init", "--bare", bareDir]);
    execFileSync("git", ["clone", bareDir, seed]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: seed });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: seed });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: seed });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: seed });

    const joined = join(tmp, "joined");
    execFileSync("git", ["clone", bareDir, joined]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: joined });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: joined });
    mkdirSync(join(joined, "facts"), { recursive: true });
    mkdirSync(join(joined, "interactions"), { recursive: true });
  });

  afterEach(() => { rmSync(tmp, { recursive: true }); });

  it("prints hooks updated and exits 0", () => {
    const joined = join(tmp, "joined");
    const settingsPath = join(tmp, "settings.json");

    const output = execFileSync("node", [CLI_PATH, "update"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        TEAM_MEMORY_DIR: joined,
        TEAM_MEMORY_DEVELOPER: "testdev",
        TEAM_MEMORY_INDEX_PATH: join(joined, "merged_index.db"),
        TEAM_MEMORY_CLAUDE_SETTINGS: settingsPath,
      },
    });

    expect(output).toContain("Hooks updated");
    expect(output).toContain(settingsPath);
  });
});
