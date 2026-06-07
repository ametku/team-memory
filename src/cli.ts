#!/usr/bin/env node

import { dirname } from "path";
import { mkdirSync } from "fs";
import { addFact } from "./add.js";
import { rejectFact } from "./reject.js";
import { queryFacts } from "./query.js";
import { rebuildIndex } from "./merged-index.js";
import { pruneFacts } from "./prune.js";
import { resolveRepoDir } from "./repo.js";
import { resolveIndexPath } from "./index-path.js";
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

  if (command === "reject") {
    const factId = commandArgs[0];
    if (!factId) {
      process.stderr.write("Error: <fact_id> is required\n");
      process.exit(1);
    }
    const repoDir = resolveRepoDir();
    const developer = getDeveloperName();
    try {
      const result = rejectFact({ factId, repoDir, developer });
      const preview = result.content.length > 60 ? result.content.slice(0, 60) + "..." : result.content;
      process.stdout.write(`Rejected fact ${factId}: ${preview}\n`);
    } catch (e: any) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (command === "query") {
    const queryText = commandArgs[0];
    if (!queryText) {
      process.stderr.write("Error: <text> is required\n");
      process.exit(1);
    }

    let limit = 5;
    const limitIdx = commandArgs.indexOf("--limit");
    if (limitIdx !== -1 && commandArgs[limitIdx + 1]) {
      limit = parseInt(commandArgs[limitIdx + 1], 10);
    }

    const indexPath = resolveIndexPath();

    try {
      const results = queryFacts({ indexPath, query: queryText, limit });
      for (const r of results) {
        process.stdout.write(`[${r.id}] (trust: ${r.trust.toFixed(2)}) ${r.content}`);
        if (r.project) process.stdout.write(` [project: ${r.project}]`);
        if (r.tags) process.stdout.write(` [tags: ${r.tags}]`);
        process.stdout.write("\n");
      }
    } catch (e: any) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (command === "rebuild-index") {
    const repoDir = resolveRepoDir();
    const outputPath = resolveIndexPath();
    mkdirSync(dirname(outputPath), { recursive: true });
    const start = performance.now();
    const stats = rebuildIndex(repoDir, outputPath);
    const duration = ((performance.now() - start) / 1000).toFixed(2);
    process.stdout.write(`Rebuilt index: ${stats.devDbs} dev DBs, ${stats.factsIndexed} facts indexed in ${duration}s\n`);
    return;
  }

  if (command === "prune") {
    const repoDir = resolveRepoDir();
    const developer = getDeveloperName();
    const dryRun = commandArgs.includes("--dry-run");

    const result = pruneFacts({ repoDir, developer, dryRun });

    if (result.pruned.length === 0) {
      process.stdout.write("Nothing to prune.\n");
      return;
    }

    if (dryRun) {
      process.stdout.write("dry-run: would prune the following facts:\n");
    } else {
      const outputPath = resolveIndexPath();
      mkdirSync(dirname(outputPath), { recursive: true });
      rebuildIndex(repoDir, outputPath);
      process.stdout.write(`Pruned ${result.pruned.length} fact(s):\n`);
    }

    for (const fact of result.pruned) {
      const preview = fact.content.length > 60 ? fact.content.slice(0, 60) + "..." : fact.content;
      process.stdout.write(`  [${fact.id}] (${fact.reason}) ${preview}\n`);
    }
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(1);
}

main();
