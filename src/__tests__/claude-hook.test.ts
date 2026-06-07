import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { installClaudeHook } from "../claude-hook.js";

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

  test("creates settings.json with UserPromptSubmit hook when file does not exist", () => {
    const result = installClaudeHook({ settingsPath });

    expect(result.installed).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const entry = settings.hooks.UserPromptSubmit[0].hooks[0];
    expect(entry.type).toBe("command");
    expect(entry.command).toBe("team-memory preprompt-hook");
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
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
  });

  test("is idempotent — does not duplicate hook entry on second call", () => {
    installClaudeHook({ settingsPath });
    const result2 = installClaudeHook({ settingsPath });

    expect(result2.installed).toBe(false);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks).toHaveLength(1);
  });
});
