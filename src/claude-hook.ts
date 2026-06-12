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

// Remove any hook group whose command references team-memory — used before
// re-installing so updates never leave stale duplicate hooks behind.
function removeTeamMemoryHooks(groups: ClaudeHookGroup[]): ClaudeHookGroup[] {
  return groups.filter(
    (g) => !g.hooks?.some((h) => typeof h.command === "string" && h.command.includes("team-memory"))
  );
}

function addHook(groups: ClaudeHookGroup[], entry: Record<string, unknown>): void {
  groups.push({ hooks: [entry as unknown as ClaudeHookEntry] });
}

export function installClaudeHook(input: InstallClaudeHookInput = {}): InstallClaudeHookResult {
  const settingsPath = input.settingsPath ?? join(homedir(), ".claude", "settings.json");

  const settings: ClaudeSettings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf-8"))
    : {};

  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit ??= [];
  settings.hooks.SessionEnd ??= [];

  // Track whether hooks were already at current version before replacing.
  // "installed = true" means the hook was new or was stale and got updated.
  const prepromptCurrent = settings.hooks.UserPromptSubmit
    .some((g) => g.hooks?.some((h) => h.command === PREPROMPT_COMMAND));
  const sessionEndCurrent = settings.hooks.SessionEnd
    .some((g) => g.hooks?.some((h) => h.command === SESSION_END_COMMAND));

  // Clean-replace: strip ALL team-memory hooks then re-add current versions.
  // This prevents stale duplicates when hook commands change between versions.
  settings.hooks.UserPromptSubmit = removeTeamMemoryHooks(settings.hooks.UserPromptSubmit);
  settings.hooks.SessionEnd = removeTeamMemoryHooks(settings.hooks.SessionEnd);

  addHook(settings.hooks.UserPromptSubmit, { type: "command", command: PREPROMPT_COMMAND });
  addHook(settings.hooks.SessionEnd, { type: "command", command: SESSION_END_COMMAND });

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
