import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const PREPROMPT_COMMAND = "team-memory preprompt-hook";
const SESSION_END_COMMAND =
  "echo '{\"systemMessage\": \"team-memory: run /extract-facts before quitting to save anything worth keeping.\"}'";

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

function isTeamMemoryHook(group: ClaudeHookGroup): boolean {
  return group.hooks?.some(
    (h) => typeof h.command === "string" && h.command.includes("team-memory")
  ) ?? false;
}

function addHook(groups: ClaudeHookGroup[], entry: Record<string, unknown>): void {
  groups.push({ hooks: [entry as unknown as ClaudeHookEntry] });
}

// Wipe ALL team-memory hooks from every hook event in settings.
// Scans every event type so no stale hook survives a version upgrade,
// even if a future version moves a hook to a different event.
function wipeAllTeamMemoryHooks(settings: ClaudeSettings): number {
  let removed = 0;
  if (!settings.hooks) return 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event] as ClaudeHookGroup[] | undefined;
    if (!Array.isArray(groups)) continue;
    const before = groups.length;
    const filtered = groups.filter((g) => !isTeamMemoryHook(g));
    settings.hooks[event] = filtered;
    removed += before - filtered.length;
  }
  return removed;
}

export function installClaudeHook(input: InstallClaudeHookInput = {}): InstallClaudeHookResult {
  const settingsPath = input.settingsPath ?? join(homedir(), ".claude", "settings.json");

  const settings: ClaudeSettings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf-8"))
    : {};

  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit ??= [];
  settings.hooks.SessionEnd ??= [];

  // Track whether hooks were already at current version before wiping.
  const prepromptCurrent = (settings.hooks.UserPromptSubmit as ClaudeHookGroup[])
    .some((g) => g.hooks?.some((h) => h.command === PREPROMPT_COMMAND));
  const sessionEndCurrent = (settings.hooks.SessionEnd as ClaudeHookGroup[])
    .some((g) => g.hooks?.some((h) => h.command === SESSION_END_COMMAND));

  // Wipe ALL team-memory hooks across every event type, then reinstall fresh.
  // This handles version upgrades where hook commands change or move to new events.
  wipeAllTeamMemoryHooks(settings);

  settings.hooks.UserPromptSubmit ??= [];
  settings.hooks.SessionEnd ??= [];

  addHook(settings.hooks.UserPromptSubmit as ClaudeHookGroup[], { type: "command", command: PREPROMPT_COMMAND });
  addHook(settings.hooks.SessionEnd as ClaudeHookGroup[], { type: "command", command: SESSION_END_COMMAND });

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return {
    settingsPath,
    prepromptInstalled: !prepromptCurrent,
    sessionEndInstalled: !sessionEndCurrent,
  };
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
