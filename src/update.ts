import { execFileSync } from "child_process";
import { join } from "path";
import { resolveRepoDir } from "./repo.js";
import { installClaudeHook, installClaudeSkill } from "./claude-hook.js";
import { rebuildIndex } from "./merged-index.js";
import { resolveIndexPath } from "./index-path.js";
import { mkdirSync } from "fs";
import { dirname } from "path";

export interface UpdateResult {
  settingsPath: string;
  hooksReplaced: boolean;
  skillUpdated: boolean;
  synced: boolean;
  pullWarning?: string;
}

export function updateInstallation(): UpdateResult {
  const repoDir = resolveRepoDir();

  // 1. Re-install hooks — clean replace removes stale versions
  const hookResult = installClaudeHook({
    settingsPath: process.env.TEAM_MEMORY_CLAUDE_SETTINGS,
  });

  // 2. Re-install extract-facts skill
  let skillUpdated = false;
  try {
    const skillResult = installClaudeSkill({
      skillsDir: process.env.TEAM_MEMORY_CLAUDE_SKILLS_DIR,
    });
    skillUpdated = skillResult.installed;
  } catch { /* skill source may not be present in all installs */ }

  // 3. Sync — pull latest facts from team, rebuild index
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
    hooksReplaced: true,
    skillUpdated,
    synced,
    pullWarning,
  };
}
