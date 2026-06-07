import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { assertDirNotExists, postCloneSetup, PostCloneSetupResult } from "./setup.js";

export interface JoinInput {
  repoUrl: string;
  dir?: string;
}

export interface JoinResult {
  repoDir: string;
  setup: PostCloneSetupResult;
}

export function joinRepo(input: JoinInput): JoinResult {
  const repoDir =
    input.dir ?? process.env.TEAM_MEMORY_DIR ?? join(homedir(), ".team-memory");

  assertDirNotExists(repoDir);

  execFileSync("git", ["clone", input.repoUrl, repoDir]);

  const setup = postCloneSetup({ repoDir });

  execFileSync("git", ["push", "origin", "HEAD"], { cwd: repoDir });

  return { repoDir, setup };
}
