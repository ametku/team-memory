import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const PREPROMPT_COMMAND = "team-memory preprompt-hook";
const SESSION_END_COMMAND =
  "echo '{\"systemMessage\": \"team-memory: run /extract-facts before quitting to save anything worth keeping.\"}'";

// Fires after every Claude response. Starts a 3-minute background countdown.
// If no new response fires within 3 min (idle), wakes Claude once per session
// to run /extract-facts automatically.
// asyncRewake runs this command in background — no & needed.
// Sleeps 45s then exits 2 if still idle → wakes Claude to run /extract-facts.
// The timestamp check prevents firing when the user is actively sending prompts.
// A flag file scoped to the first-seen timestamp prevents repeat triggers.
const IDLE_EXTRACT_COMMAND =
  "TS=$(date +%s); " +
  "echo $TS > /tmp/tm-last-activity; " +
  "sleep 45; " +
  "CURRENT=$(cat /tmp/tm-last-activity 2>/dev/null); " +
  "FLAG=\"/tmp/tm-extracted-$TS\"; " +
  "[ \"$CURRENT\" = \"$TS\" ] && [ ! -f \"$FLAG\" ] && touch \"$FLAG\" && exit 2; " +
  "exit 0";

const SKILL_NAME = "extract-facts";

export interface InstallClaudeHookInput {
  settingsPath?: string;
}

export interface InstallClaudeHookResult {
  settingsPath: string;
  prepromptInstalled: boolean;
  sessionEndInstalled: boolean;
  idleExtractInstalled: boolean;
}

interface ClaudeHookEntry {
  type: string;
  command: string;
}

interface ClaudeHookGroup {
  hooks: ClaudeHookEntry[];
}

interface ClaudeHookEntryExtended {
  type: string;
  command: string;
  asyncRewake?: boolean;
  rewakeMessage?: string;
}

interface ClaudeHookGroupExtended {
  hooks: ClaudeHookEntryExtended[];
}

interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: ClaudeHookGroup[];
    SessionEnd?: ClaudeHookGroup[];
    Stop?: ClaudeHookGroupExtended[];
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
  settings.hooks.Stop ??= [];

  const prepromptInstalled = ensureHook(settings.hooks.UserPromptSubmit, PREPROMPT_COMMAND);
  const sessionEndInstalled = ensureHook(settings.hooks.SessionEnd, SESSION_END_COMMAND);

  const stopGroups = settings.hooks.Stop as ClaudeHookGroupExtended[];
  const idlePresent = stopGroups.some(g =>
    g.hooks?.some(h => h.command === IDLE_EXTRACT_COMMAND)
  );
  let idleExtractInstalled = false;
  if (!idlePresent) {
    stopGroups.push({
      hooks: [{
        type: "command",
        command: IDLE_EXTRACT_COMMAND,
        asyncRewake: true,
        rewakeMessage: "Session idle for 45 seconds. Please run /extract-facts now to save any valuable insights from this session.",
      }],
    });
    idleExtractInstalled = true;
  }

  if (prepromptInstalled || sessionEndInstalled || idleExtractInstalled) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  return { settingsPath, prepromptInstalled, sessionEndInstalled, idleExtractInstalled };
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
