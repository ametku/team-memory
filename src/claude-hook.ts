import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const PREPROMPT_COMMAND = "team-memory preprompt-hook";
const SESSION_END_COMMAND =
  "echo 'team-memory: run /extract-facts before quitting to save anything worth keeping.'";
const SKILL_NAME = "extract-facts";

export interface InstallClaudeHookInput {
  settingsPath?: string;
}

export interface InstallClaudeHookResult {
  settingsPath: string;
  prepromptInstalled: boolean;
  sessionEndInstalled: boolean;
}

interface ClaudeHookEntry {
  type: string;
  command: string;
}

interface ClaudeHookGroup {
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: ClaudeHookGroup[];
    SessionEnd?: ClaudeHookGroup[];
  } & Record<string, unknown>;
  [key: string]: unknown;
}

function ensureHook(groups: ClaudeHookGroup[], command: string): boolean {
  const present = groups.some((g) => g.hooks?.some((h) => h.command === command));
  if (present) return false;
  groups.push({ hooks: [{ type: "command", command }] });
  return true;
}

export function installClaudeHook(input: InstallClaudeHookInput = {}): InstallClaudeHookResult {
  const settingsPath = input.settingsPath ?? join(homedir(), ".claude", "settings.json");

  const settings: ClaudeSettings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf-8"))
    : {};

  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit ??= [];
  settings.hooks.SessionEnd ??= [];

  const prepromptInstalled = ensureHook(settings.hooks.UserPromptSubmit, PREPROMPT_COMMAND);
  const sessionEndInstalled = ensureHook(settings.hooks.SessionEnd, SESSION_END_COMMAND);

  if (prepromptInstalled || sessionEndInstalled) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  return { settingsPath, prepromptInstalled, sessionEndInstalled };
}

export interface InstallClaudeSkillInput {
  skillsDir?: string;
  sourcePath?: string;
}

export interface InstallClaudeSkillResult {
  destPath: string;
  installed: boolean;
}

function defaultSkillSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", ".agents", "skills", SKILL_NAME, "SKILL.md");
}

export function installClaudeSkill(input: InstallClaudeSkillInput = {}): InstallClaudeSkillResult {
  const skillsDir = input.skillsDir ?? join(homedir(), ".claude", "skills");
  const sourcePath = input.sourcePath ?? defaultSkillSourcePath();
  const destDir = join(skillsDir, SKILL_NAME);
  const destPath = join(destDir, "SKILL.md");

  if (!existsSync(sourcePath)) {
    throw new Error(`Skill source not found: ${sourcePath}`);
  }

  mkdirSync(destDir, { recursive: true });

  if (existsSync(destPath) && readFileSync(destPath, "utf-8") === readFileSync(sourcePath, "utf-8")) {
    return { destPath, installed: false };
  }

  copyFileSync(sourcePath, destPath);
  return { destPath, installed: true };
}
