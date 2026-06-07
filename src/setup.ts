import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { getDeveloperName } from "./developer.js";
import { openFactsDb } from "./facts-db.js";
import { openInteractionsDb } from "./interactions-db.js";
import { rebuildIndex } from "./merged-index.js";
import { installPostMergeHook } from "./hook.js";

export interface PostCloneSetupInput {
  repoDir: string;
}

export interface PostCloneSetupResult {
  developer: string;
  factsDbPath: string;
  interactionsDbPath: string;
  indexPath: string;
  hookPath: string;
  hookInstalled: boolean;
}

export function postCloneSetup(input: PostCloneSetupInput): PostCloneSetupResult {
  const { repoDir } = input;
  const developer = getDeveloperName();

  const factsDir = join(repoDir, "facts");
  mkdirSync(factsDir, { recursive: true });
  const factsDb = openFactsDb(factsDir, developer);
  const factsDbPath = join(factsDir, `facts-${developer}.db`);
  factsDb.close();

  const intDir = join(repoDir, "interactions");
  mkdirSync(intDir, { recursive: true });
  const intDb = openInteractionsDb(intDir, developer);
  const interactionsDbPath = join(intDir, `interactions-${developer}.db`);
  intDb.close();

  const indexPath = join(repoDir, "merged_index.db");
  rebuildIndex(repoDir, indexPath);

  const hookResult = installPostMergeHook({ repoDir });

  try {
    execFileSync("git", ["add", "facts/", "interactions/"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "chore: initialize per-dev databases"], { cwd: repoDir });
  } catch {
    // Nothing to commit (files already tracked)
  }

  return {
    developer,
    factsDbPath,
    interactionsDbPath,
    indexPath,
    hookPath: hookResult.hookPath,
    hookInstalled: hookResult.installed,
  };
}

export function assertDirNotExists(dir: string): void {
  if (existsSync(dir)) {
    throw new Error(`Directory already exists: ${dir}. Remove it first or choose a different path.`);
  }
}
