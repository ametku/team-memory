import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const PREPROMPT_COMMAND = "team-memory preprompt-hook";
const SESSION_END_COMMAND =
  "team-memory slack-review; echo 'team-memory: run /extract-facts before quitting to save anything worth keeping.'";
const SKILL_NAME = "extract-facts";

const SLACK_PERMISSIONS = [
  "mcp__plugin_slack_slack__slack_search_public",
  "mcp__plugin_slack_slack__slack_read_thread",
];

export interface InstallClaudeHookInput {
  settingsPath?: string;
}

export interface InstallClaudeHookResult {
  settingsPath: string;
  prepromptInstalled: boolean;
  sessionEndInstalled: boolean;
  slackPermissionsInstalled: boolean;
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
  permissions?: {
    allow?: string[];
    [key: string]: unknown;
  };
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
  settings.permissions ??= {};
  settings.permissions.allow ??= [];

  const prepromptInstalled = ensureHook(settings.hooks.UserPromptSubmit, PREPROMPT_COMMAND);
  const sessionEndInstalled = ensureHook(settings.hooks.SessionEnd, SESSION_END_COMMAND);

  const existingAllow = settings.permissions.allow;
  const missingPerms = SLACK_PERMISSIONS.filter(p => !existingAllow.includes(p));
  if (missingPerms.length > 0) existingAllow.push(...missingPerms);
  const slackPermissionsInstalled = missingPerms.length > 0;

  if (prepromptInstalled || sessionEndInstalled || slackPermissionsInstalled) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  return { settingsPath, prepromptInstalled, sessionEndInstalled, slackPermissionsInstalled };
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
