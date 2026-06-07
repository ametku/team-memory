#!/usr/bin/env node

import { addFact } from "./add.js";
import { resolveRepoDir } from "./repo.js";
import { getDeveloperName } from "./developer.js";

const USAGE = `team-memory — shared long-term memory for coding agents

Usage:
  team-memory <command> [options]

Commands:
  add <content>        Add a new fact
  query <text>         Search facts by relevance
  reject <fact_id>     Mark a fact as incorrect
  rebuild-index        Rebuild the local merged index
  prune                Remove stale or rejected facts
  sync                 Pull from remote and rebuild index

Options:
  --help               Show this help message
  --version            Show version
`;

function parseAddArgs(args: string[]): { content: string; project?: string; tags?: string[] } {
  const content = args[0];
  if (!content) {
    process.stderr.write("Error: <content> is required\n");
    process.exit(1);
  }

  let project: string | undefined;
  let tags: string[] | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      project = args[++i];
    } else if (args[i] === "--tags" && args[i + 1]) {
      tags = JSON.parse(args[++i]);
    }
  }

  return { content, project, tags };
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("0.1.0\n");
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  if (command === "add") {
    const { content, project, tags } = parseAddArgs(commandArgs);
    const repoDir = resolveRepoDir();
    const developer = getDeveloperName();
    const fact = addFact({ content, repoDir, developer, project, tags });
    process.stdout.write(`${fact.id}\n`);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(1);
}

main();
