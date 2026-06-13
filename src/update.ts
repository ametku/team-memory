import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolveRepoDir } from "./repo.js";
import { installClaudeHook, installClaudeSkill } from "./claude-hook.js";
import { rebuildIndex } from "./merged-index.js";
import { resolveIndexPath } from "./index-path.js";

// Detect CLI source root from the running binary path:
//   dist/cli.js → dist/ → project root
function detectCliSource(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/
  return resolve(here, ".."); // project root
}

function readCliVersion(cliSource: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cliSource, "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch { return "unknown"; }
}

function readConfigValue(repoDir: string, key: string): string | undefined {
  const configPath = join(repoDir, "config.yaml");
  if (!existsSync(configPath)) return undefined;
  const lines = readFileSync(configPath, "utf-8").split("\n");
  for (const line of lines) {
    const match = line.match(new RegExp(`^${key}:\\s*(.+)$`));
    if (match) return match[1].trim();
  }
  return undefined;
}

function writeConfigValue(repoDir: string, key: string, value: string): void {
  const configPath = join(repoDir, "config.yaml");
  let content = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  const regex = new RegExp(`^${key}:.*$`, "m");
  const line = `${key}: ${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() + "\n" + line + "\n";
  }
  writeFileSync(configPath, content);
}

export function saveCliSource(repoDir: string): void {
  const cliSource = detectCliSource();
  writeConfigValue(repoDir, "cli_source", cliSource);
}

export interface UpdateResult {
  settingsPath: string;
  cliSource?: string;
  versionBefore?: string;
  versionAfter?: string;
  rebuilt: boolean;
  rebuildWarning?: string;
  hooksWiped: boolean;
  skillUpdated: boolean;
  synced: boolean;
  pullWarning?: string;
}

export function updateInstallation({ noRebuild = false } = {}): UpdateResult {
  const repoDir = resolveRepoDir();

  // 1. Pull + rebuild the CLI binary from source.
  const cliSource = readConfigValue(repoDir, "cli_source") ?? detectCliSource();
  let rebuilt = false;
  let rebuildWarning: string | undefined;
  let versionBefore: string | undefined;
  let versionAfter: string | undefined;

  if (!noRebuild && existsSync(join(cliSource, "package.json"))) {
    versionBefore = readCliVersion(cliSource);
    try {
      execFileSync("git", ["pull"], { cwd: cliSource, stdio: "inherit" });
      execFileSync("npm", ["run", "build"], { cwd: cliSource, stdio: "inherit" });
      versionAfter = readCliVersion(cliSource);
      rebuilt = true;
    } catch (e: any) {
      rebuildWarning = `CLI rebuild failed: ${e.message ?? "unknown error"}`;
    }
  } else if (noRebuild) {
    rebuildWarning = "skipped (--no-rebuild)";
  } else {
    rebuildWarning = `cli_source not found at ${cliSource}`;
  }

  // 2. Wipe ALL team-memory hooks from every event type, then reinstall fresh.
  const hookResult = installClaudeHook({
    settingsPath: process.env.TEAM_MEMORY_CLAUDE_SETTINGS,
  });

  // 3. Overwrite extract-facts skill with current version.
  let skillUpdated = false;
  try {
    const skillResult = installClaudeSkill({
      skillsDir: process.env.TEAM_MEMORY_CLAUDE_SKILLS_DIR,
      force: true,
    });
    skillUpdated = skillResult.installed;
  } catch { /* skill source not present */ }

  // 4. Pull latest team facts and rebuild index.
  let synced = true;
  let pullWarning: string | undefined;
  try {
    execFileSync("git", ["pull", "origin"], { cwd: repoDir });
  } catch (e: any) {
    synced = false;
    pullWarning = e.message ?? "git pull failed";
  }

  const indexPath = resolveIndexPath();
  mkdirSync(dirname(indexPath), { recursive: true });
  rebuildIndex(repoDir, indexPath);

  return {
    settingsPath: hookResult.settingsPath,
    cliSource,
    versionBefore,
    versionAfter,
    rebuilt,
    rebuildWarning,
    hooksWiped: true,
    skillUpdated,
    synced,
    pullWarning,
  };
}
