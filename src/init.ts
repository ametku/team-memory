import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { assertDirNotExists, postCloneSetup, PostCloneSetupResult } from "./setup.js";
import { getDeveloperName } from "./developer.js";

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

  execFileSync("git", ["add", "README.md", "config.yaml"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "chore: initialize team-memory repo"], { cwd: repoDir });

  const setup = postCloneSetup({ repoDir });

  execFileSync("git", ["push", "origin", "HEAD"], { cwd: repoDir });

  return { repoDir, setup };
}
