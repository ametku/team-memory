import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";

// Local (gitignored) file written by `team-memory opt-in` into each opted-in
// project at .claude/.team-memory-dir. Stores the absolute TEAM_MEMORY_DIR
// path for that machine so commands run from the project dir auto-discover
// the right repo without requiring TEAM_MEMORY_DIR to be set in the shell.
const LOCAL_DIR_FILE = ".claude/.team-memory-dir";

function findLocalDirFile(): string | null {
  try {
    const root = execFileSync(
      "git", ["rev-parse", "--show-toplevel"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    ).trim();
    if (!root) return null;
    const p = join(root, LOCAL_DIR_FILE);
    if (existsSync(p)) return p;
  } catch { /* not in a git repo */ }
  return null;
}

export function resolveRepoDir(): string {
  // 1. Explicit env var always wins
  if (process.env.TEAM_MEMORY_DIR) return process.env.TEAM_MEMORY_DIR;

  // 2. Auto-discover from opted-in project — reads .claude/.team-memory-dir
  //    written by `team-memory opt-in`. Lets commands work from project dirs
  //    without requiring TEAM_MEMORY_DIR to be set in the shell.
  const localFile = findLocalDirFile();
  if (localFile) {
    try {
      const dir = readFileSync(localFile, "utf-8").trim();
      if (dir) return dir.replace(/^~/, homedir());
    } catch { /* unreadable — fall through */ }
  }

  // 3. Default
  return join(homedir(), ".team-memory");
}
