import { join } from "path";
import { execFileSync } from "child_process";
import { openFactsDb, insertFact } from "./facts-db.js";
import type { Fact } from "./types.js";

export interface AddFactInput {
  content: string;
  repoDir: string;
  developer: string;
  project?: string;
  tags?: string[];
}

export function addFact(input: AddFactInput): Fact {
  const factsDir = join(input.repoDir, "facts");
  const db = openFactsDb(factsDir, input.developer);

  const fact = insertFact(db, {
    content: input.content,
    project: input.project,
    tags: input.tags,
  });

  db.exec("VACUUM");
  db.close();

  const dbFile = join("facts", `facts-${input.developer}.db`);
  execFileSync("git", ["add", dbFile], { cwd: input.repoDir });
  execFileSync("git", ["commit", "-m", `feat: add fact ${fact.id}`], { cwd: input.repoDir });

  return fact;
}
