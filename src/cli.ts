#!/usr/bin/env node

import { basename, dirname, join } from "path";
import { mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { addFact } from "./add.js";
import { rejectFact } from "./reject.js";
import { queryFacts } from "./query.js";
import { rebuildIndex } from "./merged-index.js";
import { pruneFacts } from "./prune.js";
import { syncRepo } from "./sync.js";
import { installPostMergeHook } from "./hook.js";
import { joinRepo } from "./join.js";
import { initRepo } from "./init.js";
import { resolveRepoDir } from "./repo.js";
import { resolveIndexPath } from "./index-path.js";
import { getDeveloperName } from "./developer.js";
import { runPrepromptHook } from "./preprompt.js";
import { commitInteractions } from "./surface-logging.js";
import { runExtractBg } from "./extract-bg.js";
import { runExtractBgc } from "./extract-bgc.js";
import { getPendingFacts, removePendingFacts, markSessionHandledByExtractFacts } from "./pending-facts.js";
import { markSessionActive, markSessionCleanEnd } from "./active-sessions.js";
import { generateDashboard } from "./dashboard.js";
import { createOptInMarker, registerProject, isOptedIn } from "./opt-in.js";

const USAGE = `team-memory — shared long-term memory for coding agents

Usage:
  team-memory <command> [options]

Commands:
  add <content>        Add a new fact
  query <text>         Search facts by relevance (use --project <name> to scope)
  reject <fact_id>     Mark a fact as incorrect
  rebuild-index        Rebuild the local merged index
  prune                Remove stale or rejected facts
  sync                 Pull from remote and rebuild index
  install-hook         Install post-merge git hook for auto-rebuild
  preprompt-hook       Claude Code UserPromptSubmit hook (reads stdin JSON, writes stdout JSON)
  session-end          Commit accumulated surface interactions to git
  extract-bg           Extract facts from past sessions using NerdCompletion API
  extract-bgc          Extract facts from past sessions using Claude (no API key needed)
  review-pending       Review facts queued by extract-bgc in current project
  dashboard            Generate and open a static HTML fact browser
  opt-in               Opt the current project into team-memory fact extraction
  join <repo-url>      Clone an existing team-memory repo, onboard this dev,
                       and install the Claude pre-prompt hook in ~/.claude/settings.json
  init                 Create a new team-memory repo on GitHub, bootstrap it,
                       and install the Claude pre-prompt hook in ~/.claude/settings.json

Options:
  --help               Show this help message
  --version            Show version
`;

function detectProject(): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    return root ? basename(root) : undefined;
  } catch {
    return undefined;
  }
}

function detectProjectRoot(): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

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

    let project: string | undefined;
    const projectIdx = commandArgs.indexOf("--project");
    if (projectIdx !== -1 && commandArgs[projectIdx + 1]) {
      project = commandArgs[projectIdx + 1];
    }

    const indexPath = resolveIndexPath();

    try {
      const results = queryFacts({ indexPath, query: queryText, limit, project });
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

  if (command === "install-hook") {
    const repoDir = resolveRepoDir();
    const result = installPostMergeHook({ repoDir });
    if (result.installed) {
      process.stdout.write(`Installed post-merge hook at ${result.hookPath}\n`);
    } else {
      process.stdout.write(`Skipped: hook already exists at ${result.hookPath}\n`);
    }
    return;
  }

  if (command === "init") {
    const orgIdx = commandArgs.indexOf("--org");
    const repoIdx = commandArgs.indexOf("--repo");
    const org = orgIdx !== -1 ? commandArgs[orgIdx + 1] : undefined;
    const repo = repoIdx !== -1 ? commandArgs[repoIdx + 1] : undefined;
    if (!org || !repo) {
      process.stderr.write("Error: --org and --repo are required\n");
      process.exit(1);
    }
    const dirIdx = commandArgs.indexOf("--dir");
    const dir = dirIdx !== -1 ? commandArgs[dirIdx + 1] : undefined;
    try {
      const result = initRepo({ org, repo, dir });
      process.stdout.write(`Initialized ${org}/${repo} → ${result.repoDir}\n`);
      process.stdout.write(`export TEAM_MEMORY_DIR=${result.repoDir}\n`);
      process.stdout.write(`\nTo backfill facts from past Claude Code sessions, run:\n`);
      process.stdout.write(`  NERD_COMPLETION_API_KEY=<your-key> team-memory extract-bg\n`);
    } catch (e: any) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (command === "join") {
    const url = commandArgs[0];
    if (!url || url.startsWith("--")) {
      process.stderr.write("Error: <repo-url> is required\n");
      process.exit(1);
    }
    const dirIdx = commandArgs.indexOf("--dir");
    const dir = dirIdx !== -1 ? commandArgs[dirIdx + 1] : undefined;
    try {
      const result = joinRepo({ repoUrl: url, dir });
      process.stdout.write(`Joined ${url} → ${result.repoDir}\n`);
      process.stdout.write(`\nTo backfill facts from past Claude Code sessions, run:\n`);
      process.stdout.write(`  NERD_COMPLETION_API_KEY=<your-key> team-memory extract-bg\n`);
    } catch (e: any) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (command === "sync") {
    const repoDir = resolveRepoDir();
    const indexPath = resolveIndexPath();
    mkdirSync(dirname(indexPath), { recursive: true });
    const push = commandArgs.includes("--push");

    const start = performance.now();
    const result = syncRepo({ repoDir, indexPath, push });
    const duration = ((performance.now() - start) / 1000).toFixed(2);

    if (result.pullWarning) {
      process.stdout.write(`Warning: pull failed, rebuilding from local cache\n`);
    }
    if (result.pushed) {
      process.stdout.write("Pushed local commits.\n");
    }
    process.stdout.write(
      `Synced: ${result.rebuildStats.devDbs} dev DBs, ${result.rebuildStats.factsIndexed} facts indexed in ${duration}s\n`
    );
    return;
  }

  if (command === "preprompt-hook") {
    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => { raw += chunk; });
    process.stdin.on("end", () => {
      let prompt = "";
      try {
        const payload = JSON.parse(raw);
        prompt = payload.prompt ?? "";
      } catch {
        process.stdout.write(JSON.stringify({ continue: true }));
        return;
      }
      const indexPath = resolveIndexPath();
      const repoDir = resolveRepoDir();
      const developer = (() => {
        try { return getDeveloperName(); } catch { return "unknown"; }
      })();
      const project = detectProject();
      const projectRoot = detectProjectRoot();
      const result = runPrepromptHook({ prompt, indexPath, repoDir, developer, project, projectRoot });
      process.stdout.write(JSON.stringify(result));
    });
    return;
  }

  if (command === "opt-in") {
    let projectRoot: string;
    try {
      projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    } catch {
      process.stderr.write("Error: not in a git repository. Run this from your project directory.\n");
      process.exit(1);
    }
    const repoDir = resolveRepoDir();
    const markerCreated = createOptInMarker(projectRoot);
    registerProject(repoDir, projectRoot);
    if (markerCreated) {
      process.stdout.write(`Opted in: ${projectRoot}\n`);
      process.stdout.write(`Created: ${projectRoot}/.claude/team-memory.md\n`);
      process.stdout.write(`Tip: commit .claude/team-memory.md so teammates are opted in too.\n`);
    } else {
      process.stdout.write(`Already opted in: ${projectRoot}\n`);
    }
    return;
  }

  if (command === "extract-bg") {
    const dryRun = commandArgs.includes("--dry-run");
    runExtractBg({ dryRun }).catch((e: any) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    });
    return;
  }

  if (command === "extract-bgc") {
    const dryRun = commandArgs.includes("--dry-run");
    runExtractBgc({ dryRun }).catch((e: any) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    });
    return;
  }

  if (command === "review-pending") {
    const repoDir = resolveRepoDir();
    const project = detectProject();
    if (!project) {
      process.stderr.write("Error: not in a git repository\n");
      process.exit(1);
    }
    const pending = getPendingFacts(repoDir, project);
    if (pending.length === 0) {
      process.stdout.write(`No pending facts for ${project}.\n`);
      return;
    }
    (async () => {
      const { createInterface } = await import("readline");
      process.stdout.write(`${pending.length} pending fact(s) for ${project}:\n\n`);
      const approved: string[] = [];
      const rejected: string[] = [];
      for (let i = 0; i < pending.length; i++) {
        const f = pending[i];
        process.stdout.write(`Fact ${i + 1}/${pending.length}:\n  ${f.content}\n  tags: ${JSON.stringify(f.tags)}\n  from: ${f.session}\n`);
        const answer = await new Promise<string>(res => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.question("Save? (y/n): ", a => { rl.close(); res(a.trim().toLowerCase()); });
        });
        if (answer === "y") {
          approved.push(f.id);
          execFileSync("team-memory", ["add", f.content, "--project", project, "--tags", JSON.stringify(f.tags)], { stdio: "inherit" });
        } else { rejected.push(f.id); }
      }
      removePendingFacts(repoDir, project, [...approved, ...rejected]);
      process.stdout.write(`\nDone. ${approved.length} saved, ${rejected.length} rejected.\n`);
    })().catch(e => { process.stderr.write(`Error: ${e.message}\n`); process.exit(1); });
    return;
  }

  if (command === "session-start") {
    // Claude Code SessionStart hook — mark session active + notify pending facts
    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c: string) => { raw += c; });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(raw);
        const sessionId = payload.session_id ?? "";
        if (sessionId) markSessionActive(sessionId);
        const repoDir = resolveRepoDir();
        const project = (() => { try { return basename(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim()); } catch { return null; } })();
        if (project) {
          const count = getPendingFacts(repoDir, project).length;
          if (count > 0) {
            process.stdout.write(JSON.stringify({ systemMessage: `team-memory: ${count} fact(s) pending review from past sessions — run \`! team-memory review-pending\` when ready.` }));
            return;
          }
        }
      } catch { /* ignore */ }
      process.stdout.write(JSON.stringify({ continue: true }));
    });
    return;
  }

  if (command === "session-deactivate") {
    // Called from SessionEnd hook: remove sentinel + mark session handled for bgc
    // so extract-bgc never re-processes a session that /extract-facts already handled
    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c: string) => { raw += c; });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(raw);
        const sessionId = payload.session_id ?? "";
        if (sessionId) {
          markSessionCleanEnd(sessionId);
          const repoDir = resolveRepoDir();
          markSessionHandledByExtractFacts(repoDir, sessionId);
        }
      } catch { /* ignore */ }
    });
    return;
  }

  if (command === "dashboard") {
    const repoDir = resolveRepoDir();
    const indexPath = join(repoDir, "merged_index.db");
    const outputPath = join(repoDir, "dashboard.html");
    const noOpen = commandArgs.includes("--no-open");
    const result = generateDashboard({ repoDir, indexPath, outputPath, openBrowser: !noOpen });
    process.stdout.write(`Dashboard: ${result.factCount} facts from ${result.authorCount} author(s) → ${result.outputPath}\n`);
    return;
  }

  if (command === "session-end") {
    const repoDir = resolveRepoDir();
    const developer = getDeveloperName();
    commitInteractions(join(repoDir, "interactions"), developer);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(1);
}

main();
