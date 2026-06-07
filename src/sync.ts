import { execFileSync } from "child_process";
import { rebuildIndex, RebuildStats } from "./merged-index.js";

export interface SyncInput {
  repoDir: string;
  indexPath: string;
  push?: boolean;
}

export interface SyncResult {
  pulled: boolean;
  pullWarning?: string;
  pushed?: boolean;
  rebuildStats: RebuildStats;
}

export function syncRepo(input: SyncInput): SyncResult {
  let pulled = true;
  let pullWarning: string | undefined;

  try {
    execFileSync("git", ["pull"], { cwd: input.repoDir });
  } catch (e: any) {
    pulled = false;
    pullWarning = e.message ?? "git pull failed";
  }

  const rebuildStats = rebuildIndex(input.repoDir, input.indexPath);

  return { pulled, pullWarning, rebuildStats };
}
