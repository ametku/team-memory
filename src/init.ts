import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { assertDirNotExists, postCloneSetup, PostCloneSetupResult } from "./setup.js";
import { getDeveloperName } from "./developer.js";
import { installClaudeHook, installClaudeSkill } from "./claude-hook.js";
import { createOptInMarker, registerProject } from "./opt-in.js";
import { saveCliSource } from "./update.js";

export interface InitInput {
  org: string;
  repo: string;
  dir?: string;
}

export interface InitResult {
  repoDir: string;
  setup: PostCloneSetupResult;
}

export type RepoCreator = (slug: string, dir: string) => void;

const ghRepoCreate: RepoCreator = (slug, dir) => {
  execFileSync("gh", ["repo", "create", slug, "--private"]);
  execFileSync("gh", ["repo", "clone", slug, dir]);
};

export function initRepo(input: InitInput, createRepo: RepoCreator = ghRepoCreate): InitResult {
  const repoDir =
    input.dir ?? process.env.TEAM_MEMORY_DIR ?? join(homedir(), ".team-memory");

  assertDirNotExists(repoDir);

  const slug = `${input.org}/${input.repo}`;
  createRepo(slug, repoDir);

  const developer = getDeveloperName();
  writeFileSync(
    join(repoDir, "README.md"),
    `# ${input.repo}\n\nTeam-shared long-term memory for coding agents.\n`,
  );
  writeFileSync(
    join(repoDir, "config.yaml"),
    `version: 1\ndeveloper: ${developer}\n`,
  );
  writeFileSync(
    join(repoDir, ".gitignore"),
    `# SQLite WAL companion files — transient, never commit\n*.db-shm\n*.db-wal\n\n# Local-only merged index — rebuilt from facts-*.db on every pull\nmerged_index.db\n\n# Generated dashboard — regenerate with \`team-memory dashboard\`\ndashboard.html\n\n# Extraction state — local to each developer\nprocessed-sessions.json\nprocessed-slack-threads.json\n\n# Opt-in registry + Slack queue — machine-specific, never commit\nopted-in-projects.json\nslack-queue.json\n`,
  );

  execFileSync("git", ["add", "README.md", "config.yaml", ".gitignore"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "chore: initialize team-memory repo"], { cwd: repoDir });

  const setup = postCloneSetup({ repoDir });

  installClaudeHook({ settingsPath: process.env.TEAM_MEMORY_CLAUDE_SETTINGS });
  installClaudeSkill({ skillsDir: process.env.TEAM_MEMORY_CLAUDE_SKILLS_DIR });
  saveCliSource(repoDir);

  try {
    const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    if (projectRoot) { createOptInMarker(projectRoot); registerProject(repoDir, projectRoot); }
  } catch { /* not in a project repo — skip */ }

  execFileSync("git", ["push", "origin", "HEAD"], { cwd: repoDir });

  return { repoDir, setup };
}
