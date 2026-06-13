import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { installClaudeHook, installClaudeSkill } from "../claude-hook.js";

describe("installClaudeHook", () => {
  let tmp: string;
  let settingsPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tm-claude-hook-"));
    settingsPath = join(tmp, ".claude", "settings.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  test("creates settings.json with all hooks when file does not exist", () => {
    const result = installClaudeHook({ settingsPath });

    expect(result.prepromptInstalled).toBe(true);
    expect(result.sessionStartInstalled).toBe(true);
    expect(result.sessionDeactivateInstalled).toBe(true);
    expect(result.sessionEndInstalled).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // UserPromptSubmit → preprompt
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe("team-memory preprompt-hook");
    // SessionStart → session-start
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("team-memory session-start");
    // SessionEnd → deactivate first, then reminder
    const sessionEndCmds = settings.hooks.SessionEnd.map((g: any) => g.hooks[0].command);
    expect(sessionEndCmds).toContain("team-memory session-deactivate");
    expect(sessionEndCmds.some((c: string) => c.includes("/extract-facts"))).toBe(true);
  });

  test("merges into existing settings.json without dropping unrelated keys", () => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "dark",
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );

    installClaudeHook({ settingsPath });

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.theme).toBe("dark");
    // Non-team-memory SessionStart hook preserved
    expect(settings.hooks.SessionStart.some((g: any) => g.hooks[0].command === "echo hi")).toBe(true);
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeDefined();
  });

  test("is idempotent — running twice produces no duplicate hooks", () => {
    installClaudeHook({ settingsPath });
    const result2 = installClaudeHook({ settingsPath });

    expect(result2.prepromptInstalled).toBe(false);
    expect(result2.sessionStartInstalled).toBe(false);
    expect(result2.sessionDeactivateInstalled).toBe(false);
    expect(result2.sessionEndInstalled).toBe(false);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionEnd).toHaveLength(2); // deactivate + reminder
  });

  test("installs SessionEnd alongside a pre-existing UserPromptSubmit entry", () => {
    installClaudeHook({ settingsPath });

    // Wipe the SessionEnd entry to simulate an upgrade from an older install
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    delete settings.hooks.SessionEnd;
    writeFileSync(settingsPath, JSON.stringify(settings));

    const result = installClaudeHook({ settingsPath });
    expect(result.prepromptInstalled).toBe(false);
    expect(result.sessionEndInstalled).toBe(true);
    expect(result.sessionDeactivateInstalled).toBe(true);
  });
});

describe("installClaudeSkill", () => {
  let tmp: string;
  let skillsDir: string;
  let sourcePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tm-claude-skill-"));
    skillsDir = join(tmp, ".claude", "skills");
    sourcePath = join(tmp, "src-skill", "SKILL.md");
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "---\nname: extract-facts\ndescription: test fixture\n---\n\nbody\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  test("copies SKILL.md to <skillsDir>/extract-facts/SKILL.md", () => {
    const result = installClaudeSkill({ skillsDir, sourcePath });

    expect(result.installed).toBe(true);
    expect(result.destPath).toBe(join(skillsDir, "extract-facts", "SKILL.md"));
    expect(readFileSync(result.destPath, "utf-8")).toBe(readFileSync(sourcePath, "utf-8"));
  });

  test("is idempotent when source content unchanged", () => {
    installClaudeSkill({ skillsDir, sourcePath });
    const result2 = installClaudeSkill({ skillsDir, sourcePath });
    expect(result2.installed).toBe(false);
  });

  test("overwrites when source content changes (upgrade)", () => {
    installClaudeSkill({ skillsDir, sourcePath });
    writeFileSync(sourcePath, "---\nname: extract-facts\ndescription: updated\n---\n\nnew body\n");

    const result = installClaudeSkill({ skillsDir, sourcePath });
    expect(result.installed).toBe(true);
    expect(readFileSync(result.destPath, "utf-8")).toContain("new body");
  });

  test("throws if source SKILL.md missing", () => {
    expect(() =>
      installClaudeSkill({ skillsDir, sourcePath: join(tmp, "nonexistent.md") }),
    ).toThrow(/Skill source not found/);
  });

  test("default sourcePath resolves to repo's .agents/skills/extract-facts/SKILL.md", () => {
    // Sanity: the bundled skill is reachable when no sourcePath is passed.
    const result = installClaudeSkill({ skillsDir });
    expect(result.installed).toBe(true);
    const body = readFileSync(result.destPath, "utf-8");
    expect(body).toContain("name: extract-facts");
    expect(body).toContain("category:");
  });
});
