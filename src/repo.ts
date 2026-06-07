import { join } from "path";
import { homedir } from "os";

export function resolveRepoDir(): string {
  return process.env.TEAM_MEMORY_DIR ?? join(homedir(), ".team-memory");
}
