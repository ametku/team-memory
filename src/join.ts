import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { assertDirNotExists, postCloneSetup, PostCloneSetupResult } from "./setup.js";
import { installClaudeHook, installClaudeSkill } from "./claude-hook.js";
import { createOptInMarker, registerProject } from "./opt-in.js";

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

  installClaudeHook({ settingsPath: process.env.TEAM_MEMORY_CLAUDE_SETTINGS });
  installClaudeSkill({ skillsDir: process.env.TEAM_MEMORY_CLAUDE_SKILLS_DIR });

  try {
    const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    if (projectRoot) { createOptInMarker(projectRoot); registerProject(repoDir, projectRoot); }
  } catch { /* not in a project repo — skip */ }

  execFileSync("git", ["push", "origin", "HEAD"], { cwd: repoDir });

  return { repoDir, setup };
}
