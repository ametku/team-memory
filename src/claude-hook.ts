import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const PREPROMPT_COMMAND = "team-memory preprompt-hook";
const SESSION_END_COMMAND =
  "echo '{\"systemMessage\": \"team-memory: run /extract-facts before quitting to save anything worth keeping.\"}'";

// Fires /extract-facts when BOTH are true:
//   1. Session idle ≥45s (no new Claude response since this hook started)
//   2. This session hasn't run extract-facts in the last 30 minutes
//
// Fires when BOTH are true:
//   1. THIS session idle ≥45s — uses per-session activity file so other
//      active sessions don't reset the idle timer
//   2. This session hasn't run extract-facts in the last 30 minutes
//
// ALL files scoped via $PPID — multiple concurrent sessions never interfere.
//   /tmp/tm-activity-$PPID        — activity timestamp for THIS session only
//   /tmp/tm-extracted-ppid-$PPID  — per-session cooldown timestamp
const IDLE_EXTRACT_COMMAND =
  "SPID=\"${PPID:-0}\"; " +
  "TS=$(date +%s); " +
  "echo $TS > \"/tmp/tm-activity-$SPID\"; " +
  "SESSION_FLAG=\"/tmp/tm-extracted-ppid-$SPID\"; " +
  "echo \"[team-memory] $(date '+%H:%M:%S') [$SPID] hook started, waiting 45s...\" >> /tmp/tm-idle.log; " +
  "sleep 45; " +
  "CURRENT=$(cat \"/tmp/tm-activity-$SPID\" 2>/dev/null); " +
  "LAST=$(cat \"$SESSION_FLAG\" 2>/dev/null || echo 0); " +
  "NOW=$(date +%s); " +
  "ELAPSED=$((NOW - LAST)); " +
  "if [ \"$CURRENT\" = \"$TS\" ] && [ $ELAPSED -ge 1800 ]; then " +
  "echo \"[team-memory] $(date '+%H:%M:%S') [$SPID] idle + 30min — firing extract-facts\" >> /tmp/tm-idle.log; " +
  "echo $NOW > \"$SESSION_FLAG\" && exit 2; " +
  "else " +
  "echo \"[team-memory] $(date '+%H:%M:%S') [$SPID] skipping (active or ran within 30min, elapsed=${ELAPSED}s)\" >> /tmp/tm-idle.log; " +
  "fi; " +
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
