import { join } from "path";
import { homedir } from "os";

export function resolveIndexPath(): string {
  return process.env.TEAM_MEMORY_INDEX_PATH ?? join(homedir(), ".cache", "team-memory", "merged_index.db");
}
