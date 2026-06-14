import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const PREPROMPT_COMMAND = "team-memory preprompt-hook";
const SESSION_START_COMMAND = "team-memory session-start";
const SESSION_DEACTIVATE_COMMAND = "team-memory session-deactivate";
const SESSION_END_COMMAND =
  "echo '{\"systemMessage\": \"team-memory: run /extract-facts before quitting to save anything worth keeping.\"}'";


// Identifier prefix used in ALL team-memory hook commands.
// wipeAllTeamMemoryHooks matches this to safely remove only our hooks.
const TM_HOOK_ID = "# tm:";

// The idle hook is a platform-specific script in TEAM_MEMORY_DIR/hooks/
// macOS/Linux: idle.sh (bash)   Windows: idle.ps1 (PowerShell)
// Settings.json gets one short identifiable line — no 400-char inline blob.
function idleScriptName(): string {
  return process.platform === "win32" ? "idle.ps1" : "idle.sh";
}
function idleHookScriptPath(): string {
  return join(resolveHooksDir(), idleScriptName());
}
function resolveHooksDir(): string {
  const tmDir = process.env.TEAM_MEMORY_DIR ?? join(homedir(), ".team-memory");
  return join(tmDir, "hooks");
}

// The installed command in settings.json.
// IMPORTANT: do NOT prefix with "# tm:" — # starts a shell comment and the
// script would never run. Identification for hook-wiping uses the filename
// (idle.sh / idle.ps1) which appears in the path.
function idleExtractCommand(): string {
  const scriptPath = idleHookScriptPath();
  if (process.platform === "win32") {
    return `powershell -ExecutionPolicy Bypass -NonInteractive -File "${scriptPath}"`;
  }
  return scriptPath;
}

// macOS/Linux bash script — uses $TMPDIR for sentinels (not hardcoded /tmp)
// Logs go to TEAM_MEMORY_DIR/idle.txt (all persistent files stay in the repo clone)
const IDLE_SCRIPT_SH = `#!/bin/sh
# team-memory idle extract-facts hook
# Fires /extract-facts after IDLE_SECS idle + COOLDOWN_SECS per-session cooldown.
# Scoped via PPID so multiple concurrent sessions never interfere.
SPID="\${PPID:-0}"
IDLE_SECS=120       # 2 minutes idle before firing
COOLDOWN_SECS=600   # 10 minutes between fires per session

TS=$(date +%s)
TMPBASE="\${TMPDIR:-/tmp}"
ACTIVITY="$TMPBASE/tm-activity-$SPID"
SESSION_FLAG="$TMPBASE/tm-extracted-ppid-$SPID"
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

// Windows PowerShell equivalent — uses $env:TEMP for sentinels
const IDLE_SCRIPT_PS1 = `# team-memory idle extract-facts hook (Windows PowerShell)
# Fires /extract-facts after $IdleSecs idle + $CooldownSecs per-session cooldown.
$SPID = $PID
$IdleSecs = 120
$CooldownSecs = 600
$TmDir = if ($env:TEAM_MEMORY_DIR) { $env:TEAM_MEMORY_DIR } else { Join-Path $HOME ".team-memory" }
$LogFile = Join-Path $TmDir "idle.txt"
$Activity = Join-Path $env:TEMP "tm-activity-$SPID"
$SessionFlag = Join-Path $env:TEMP "tm-extracted-ppid-$SPID"

$TS = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
Set-Content -Path $Activity -Value $TS -Encoding UTF8 -Force
$ts = Get-Date -Format "HH:mm:ss"
Add-Content -Path $LogFile -Value "[team-memory] $ts [$SPID] hook started, waiting $($IdleSecs)s..."

Start-Sleep -Seconds $IdleSecs

$Current = if (Test-Path $Activity) { (Get-Content $Activity -Raw).Trim() } else { "" }
$Last    = if (Test-Path $SessionFlag) { [long](Get-Content $SessionFlag -Raw).Trim() } else { 0 }
$Now     = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$Elapsed = $Now - $Last

$ts = Get-Date -Format "HH:mm:ss"
if ($Current -eq "$TS" -and $Elapsed -ge $CooldownSecs) {
  Add-Content -Path $LogFile -Value "[team-memory] $ts [$SPID] idle $($IdleSecs)s + cooldown elapsed — firing extract-facts"
  Set-Content -Path $SessionFlag -Value $Now -Encoding UTF8 -Force
  exit 2
} else {
  Add-Content -Path $LogFile -Value "[team-memory] $ts [$SPID] skipping (active or cooldown active, elapsed=$($Elapsed)s)"
}
exit 0
`;

const SKILL_NAME = "extract-facts";


export interface InstallClaudeHookInput {
  settingsPath?: string;
}

export interface InstallClaudeHookResult {
  settingsPath: string;
  prepromptInstalled: boolean;
  sessionStartInstalled: boolean;
  sessionDeactivateInstalled: boolean;
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
    SessionStart?: ClaudeHookGroup[];
    SessionEnd?: ClaudeHookGroup[];
    Stop?: ClaudeHookGroupExtended[];
  } & Record<string, unknown>;
  [key: string]: unknown;
}

function isTeamMemoryHook(group: ClaudeHookGroup): boolean {
  return group.hooks?.some((h) => {
    if (typeof h.command !== "string") return false;
    return (
      h.command.startsWith(TM_HOOK_ID)      ||  // legacy: old # tm: prefix
      h.command.includes("team-memory")     ||  // all explicit team-memory commands
      h.command.includes("idle.sh")         ||  // idle hook (custom TEAM_MEMORY_DIR)
      h.command.includes("idle.ps1")            // idle hook on Windows
    );
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
  settings.hooks.SessionStart ??= [];
  settings.hooks.SessionEnd ??= [];
  settings.hooks.Stop ??= [];

  // Track whether hooks were already at current version before wiping.
  const prepromptCurrent = (settings.hooks.UserPromptSubmit as ClaudeHookGroup[])
    .some((g) => g.hooks?.some((h) => h.command === PREPROMPT_COMMAND));
  const sessionStartCurrent = (settings.hooks.SessionStart as ClaudeHookGroup[])
    .some((g) => g.hooks?.some((h) => h.command === SESSION_START_COMMAND));
  const sessionDeactivateCurrent = (settings.hooks.SessionEnd as ClaudeHookGroup[])
    .some((g) => g.hooks?.some((h) => h.command === SESSION_DEACTIVATE_COMMAND));
  const sessionEndCurrent = (settings.hooks.SessionEnd as ClaudeHookGroup[])
    .some((g) => g.hooks?.some((h) => h.command === SESSION_END_COMMAND));

  // Wipe ALL team-memory hooks across every event type, then reinstall fresh.
  wipeAllTeamMemoryHooks(settings);

  settings.hooks.UserPromptSubmit ??= [];
  settings.hooks.SessionStart ??= [];
  settings.hooks.SessionEnd ??= [];
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

  addHook(settings.hooks.UserPromptSubmit as ClaudeHookGroup[], { type: "command", command: PREPROMPT_COMMAND });

  // SessionStart: mark session active (extract-bgc safety gate) + notify pending facts
  addHook(settings.hooks.SessionStart as ClaudeHookGroup[], { type: "command", command: SESSION_START_COMMAND });

  // SessionEnd: deactivate session (clean sentinel + mark processed) + remind about /extract-facts
  addHook(settings.hooks.SessionEnd as ClaudeHookGroup[], { type: "command", command: SESSION_DEACTIVATE_COMMAND });
  addHook(settings.hooks.SessionEnd as ClaudeHookGroup[], { type: "command", command: SESSION_END_COMMAND });

  // Write the platform-appropriate idle script to TEAM_MEMORY_DIR/hooks/
  const hooksDir = resolveHooksDir();
  mkdirSync(hooksDir, { recursive: true });
  const scriptPath = idleHookScriptPath();
  const scriptContent = process.platform === "win32" ? IDLE_SCRIPT_PS1 : IDLE_SCRIPT_SH;
  writeFileSync(scriptPath, scriptContent);
  if (process.platform !== "win32") {
    try { chmodSync(scriptPath, 0o755); } catch { /* ok */ }
  }

  (settings.hooks.Stop as ClaudeHookGroupExtended[]).push({
    hooks: [{
      type: "command",
      command: idleExtractCommand(),
      asyncRewake: true,
      rewakeMessage: "/extract-facts",
    }],
  });

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return {
    settingsPath,
    prepromptInstalled: !prepromptCurrent,
    sessionStartInstalled: !sessionStartCurrent,
    sessionDeactivateInstalled: !sessionDeactivateCurrent,
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
