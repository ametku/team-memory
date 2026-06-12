import { execFileSync } from "child_process";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { resolveRepoDir } from "./repo.js";
import { installClaudeHook, installClaudeSkill } from "./claude-hook.js";
import { rebuildIndex } from "./merged-index.js";
import { resolveIndexPath } from "./index-path.js";

export interface UpdateResult {
  settingsPath: string;
  hooksWiped: boolean;
  skillUpdated: boolean;
  synced: boolean;
  pullWarning?: string;
}

export function updateInstallation(): UpdateResult {
  const repoDir = resolveRepoDir();

  // 1. Wipe ALL team-memory hooks from every event type, then reinstall fresh.
  //    This runs unconditionally — even if commands are identical, a clean
  //    reinstall guarantees no orphaned hooks survive across version upgrades.
  const hookResult = installClaudeHook({
    settingsPath: process.env.TEAM_MEMORY_CLAUDE_SETTINGS,
  });

  // 2. Overwrite extract-facts skill with current version unconditionally.
  let skillUpdated = false;
  try {
    const skillResult = installClaudeSkill({
      skillsDir: process.env.TEAM_MEMORY_CLAUDE_SKILLS_DIR,
    });
    skillUpdated = skillResult.installed;
  } catch { /* skill source not present in this install */ }

  // 3. Pull latest team facts and rebuild index.
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
    hooksWiped: true,
    skillUpdated,
    synced,
    pullWarning,
  };
}
