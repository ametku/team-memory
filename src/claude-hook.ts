import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const PREPROMPT_COMMAND = "team-memory preprompt-hook";
const SESSION_END_COMMAND =
  "echo '{\"systemMessage\": \"team-memory: run /extract-facts before quitting to save anything worth keeping.\"}'";

// Identifier prefix used in ALL team-memory hook commands.
// wipeAllTeamMemoryHooks matches this to safely remove only our hooks.
const TM_HOOK_ID = "# tm:";

// The idle hook is installed as a dedicated script at ~/.team-memory/hooks/idle.sh
// so settings.json contains only one short line, not a 400-char inline command.
// This prevents collision with other Stop hooks (e.g. jarvis.sh) and makes
// deduplication reliable via script path matching.
const IDLE_HOOK_SCRIPT_NAME = "idle.sh";
function idleHookScriptPath(): string {
  return join(resolveHooksDir(), IDLE_HOOK_SCRIPT_NAME);
}
function resolveHooksDir(): string {
  const tmDir = process.env.TEAM_MEMORY_DIR ?? join(homedir(), ".team-memory");
  return join(tmDir, "hooks");
}

// The installed command — short, identifiable, easy to wipe cleanly
function idleExtractCommand(): string {
  return `${TM_HOOK_ID}idle ${idleHookScriptPath()}`;
}

// The actual script content written to ~/.team-memory/hooks/idle.sh
const IDLE_SCRIPT_CONTENT = `#!/bin/sh
# team-memory idle extract-facts hook
# Fires /extract-facts after IDLE_SECS idle + COOLDOWN_SECS per-session cooldown.
# Scoped via PPID so multiple concurrent sessions never interfere.
SPID="\${PPID:-0}"
IDLE_SECS=120       # 2 minutes idle before firing
COOLDOWN_SECS=600   # 10 minutes between fires per session

TS=$(date +%s)
ACTIVITY="/tmp/tm-activity-$SPID"
SESSION_FLAG="/tmp/tm-extracted-ppid-$SPID"
LOGFILE="\${TEAM_MEMORY_DIR:-$HOME/.team-memory}/idle.txt"

echo $TS > "$ACTIVITY"
echo "[team-memory] $(date '+%H:%M:%S') [$SPID] hook started, waiting \${IDLE_SECS}s..." >> "$LOGFILE"
sleep $IDLE_SECS

CURRENT=$(cat "$ACTIVITY" 2>/dev/null)
LAST=$(cat "$SESSION_FLAG" 2>/dev/null || echo 0)
NOW=$(date +%s)
ELAPSED=$((NOW - LAST))

if [ "$CURRENT" = "$TS" ] && [ $ELAPSED -ge $COOLDOWN_SECS ]; then
  echo "[team-memory] $(date '+%H:%M:%S') [$SPID] idle \${IDLE_SECS}s + cooldown elapsed — firing extract-facts" >> "$LOGFILE"
  echo $NOW > "$SESSION_FLAG"
  exit 2
else
  echo "[team-memory] $(date '+%H:%M:%S') [$SPID] skipping (active or cooldown active, elapsed=\${ELAPSED}s)" >> "$LOGFILE"
fi
exit 0
`;

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

function isTeamMemoryHook(group: ClaudeHookGroup): boolean {
  return group.hooks?.some((h) => {
    if (typeof h.command !== "string") return false;
    // Matches both new-style (# tm: prefix) and old inline commands containing "team-memory"
    return h.command.startsWith(TM_HOOK_ID) || h.command.includes("team-memory");
  }) ?? false;
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
  settings.hooks.Stop ??= [];

  // Track whether hooks were already at current version before wiping.
  const prepromptCurrent = (settings.hooks.UserPromptSubmit as ClaudeHookGroup[])
    .some((g) => g.hooks?.some((h) => h.command === PREPROMPT_COMMAND));
  const sessionEndCurrent = (settings.hooks.SessionEnd as ClaudeHookGroup[])
    .some((g) => g.hooks?.some((h) => h.command === SESSION_END_COMMAND));

  // Wipe ALL team-memory hooks across every event type, then reinstall fresh.
  wipeAllTeamMemoryHooks(settings);

  settings.hooks.UserPromptSubmit ??= [];
  settings.hooks.SessionEnd ??= [];
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

  addHook(settings.hooks.UserPromptSubmit as ClaudeHookGroup[], { type: "command", command: PREPROMPT_COMMAND });
  addHook(settings.hooks.SessionEnd as ClaudeHookGroup[], { type: "command", command: SESSION_END_COMMAND });

  // Write the idle script to ~/.team-memory/hooks/idle.sh
  // Settings.json gets a short identifiable command instead of 400-char inline blob
  const hooksDir = resolveHooksDir();
  mkdirSync(hooksDir, { recursive: true });
  const scriptPath = idleHookScriptPath();
  writeFileSync(scriptPath, IDLE_SCRIPT_CONTENT);
  try { const { chmodSync } = require("fs"); chmodSync(scriptPath, 0o755); } catch { /* ok */ }

  (settings.hooks.Stop as ClaudeHookGroupExtended[]).push({
    hooks: [{
      type: "command",
      command: idleExtractCommand(),
      asyncRewake: true,
      rewakeMessage: "Session idle for 45 seconds. Please run /extract-facts now to save any valuable insights from this session.",
    }],
  });

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return {
    settingsPath,
    prepromptInstalled: !prepromptCurrent,
    sessionEndInstalled: !sessionEndCurrent,
    idleExtractInstalled: true,
  };
}

export interface InstallClaudeSkillInput {
  skillsDir?: string;
  sourcePath?: string;
  force?: boolean;  // always overwrite even if content is identical (used by `update`)
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

  if (!input.force && existsSync(destPath) && readFileSync(destPath, "utf-8") === readFileSync(sourcePath, "utf-8")) {
    return { destPath, installed: false };
  }

  copyFileSync(sourcePath, destPath);
  return { destPath, installed: true };
}
