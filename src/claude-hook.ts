import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

const HOOK_COMMAND = "team-memory preprompt-hook";

export interface InstallClaudeHookInput {
  settingsPath?: string;
}

export interface InstallClaudeHookResult {
  settingsPath: string;
  installed: boolean;
}

interface ClaudeHookEntry {
  type: string;
  command: string;
}

interface ClaudeHookGroup {
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: { UserPromptSubmit?: ClaudeHookGroup[] } & Record<string, unknown>;
  [key: string]: unknown;
}

export function installClaudeHook(input: InstallClaudeHookInput = {}): InstallClaudeHookResult {
  const settingsPath = input.settingsPath ?? join(homedir(), ".claude", "settings.json");

  const settings: ClaudeSettings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf-8"))
    : {};

  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit ??= [];

  const alreadyInstalled = settings.hooks.UserPromptSubmit.some((group) =>
    group.hooks?.some((h) => h.command === HOOK_COMMAND),
  );

  if (alreadyInstalled) {
    return { settingsPath, installed: false };
  }

  settings.hooks.UserPromptSubmit.push({
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  });

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return { settingsPath, installed: true };
}
