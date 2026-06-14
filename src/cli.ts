#!/usr/bin/env node

import { basename, dirname, join } from "path";
import { mkdirSync, readFileSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { addFact } from "./add.js";
import { rejectFacts } from "./reject.js";
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
import { getPendingFacts, getAllPendingFacts, removePendingFacts, markSessionHandledByExtractFacts } from "./pending-facts.js";
import { markSessionActive, markSessionCleanEnd } from "./active-sessions.js";
import { generateDashboard } from "./dashboard.js";
import { createOptInMarker, registerProject, isOptedIn, writeLocalDirPointer } from "./opt-in.js";
import { updateInstallation } from "./update.js";
import { runExtractSlack } from "./extract-slack.js";

const USAGE = `team-memory — shared long-term memory for coding agents

Usage:
  team-memory <command> [options]

── Setup (run once from terminal) ───────────────────────────────────────────
  init --org X --repo Y  Create a new team-memory repo on GitHub + onboard
  join <repo-url>        Join an existing team-memory repo + onboard
  update                 Upgrade CLI binary, reinstall hooks/skill, sync facts
                         Use --no-rebuild to skip git pull + build step
  opt-in                 Opt the current project into team-memory extraction
                         Run from your project directory; commit the marker file

── Claude Code hooks (auto-installed — never call these manually) ────────────
  preprompt-hook         UserPromptSubmit: injects matching facts into every prompt
  session-start          SessionStart: marks session live, notifies pending facts
  session-deactivate     SessionEnd: marks session complete, prevents bgc re-processing
  session-end            SessionEnd: commits surface interactions to git
  install-hook           Install post-merge git hook for auto index rebuild

── Inside your Claude session (use the ! prefix to run in terminal) ──────────
  ! team-memory review-pending   Review + approve facts queued by extract-bgc/slack
  ! team-memory query <text>     Search facts (--project <name> to scope, --limit N)
  ! team-memory add <content>    Add a fact manually (--project <p> --tags '[...]')
  ! team-memory reject <id> [id2 id3 ...]  Mark one or more facts as incorrect
  ! team-memory dashboard        Generate + open the HTML fact browser
  ! team-memory opt-in           Opt current project in

── From terminal (or /loop <interval> inside Claude) ────────────────────────
  extract-bgc            Mine past sessions via Claude — no API key needed
                         Run periodically: team-memory extract-bgc
                         Or inside Claude: /loop 30m team-memory extract-bgc
  extract-slack          Mine Slack threads via Slack MCP — no token needed
                         Requires Slack MCP server in ~/.claude/settings.json
  sync [--push]          Pull teammates' facts, rebuild index, optionally push yours
  rebuild-index          Rebuild local FTS index from all fact DBs
  prune [--dry-run]      Remove stale or rejected facts (your authored facts only)
  extract-bg             Mine past sessions via NerdCompletion API
                         Requires: NERD_COMPLETION_API_KEY env var

Options:
  --help                 Show this help message
  --version              Show version

Logs (all in TEAM_MEMORY_DIR):
  idle.txt               Idle hook fires and skips (one entry per Claude response)
  bgc.txt                Facts queued by extract-bgc (one line per fact)
  slack.txt              Facts queued by extract-slack (one line per fact)
  hooks.log              Warnings/errors from Claude Code hooks (never shown in session)
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
    try {
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      process.stdout.write(`${pkg.version ?? "unknown"}\n`);
    } catch {
      process.stdout.write("unknown\n");
    }
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
    const factIds = commandArgs.filter(a => !a.startsWith("--"));
    if (factIds.length === 0) {
      process.stderr.write("Error: at least one <fact_id> is required\n");
      process.stderr.write("Usage: team-memory reject <id1> [id2 id3 ...]\n");
      process.exit(1);
    }
    const repoDir = resolveRepoDir();
    const developer = getDeveloperName();
    try {
      const result = rejectFacts({ factIds, repoDir, developer });
      for (const r of result.rejected) {
        const preview = r.content.length > 60 ? r.content.slice(0, 60) + "..." : r.content;
        process.stdout.write(`Rejected ${r.id}: ${preview}\n`);
      }
      for (const id of result.notFound) {
        process.stderr.write(`Not found: ${id}\n`);
      }
      if (result.notFound.length > 0 && result.rejected.length === 0) process.exit(1);
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
      process.stdout.write(`\nWhat was set up:\n`);
      process.stdout.write(`  • Git repo: ${result.repoDir}\n`);
      process.stdout.write(`  • Per-dev facts DB: ${result.setup.factsDbPath}\n`);
      process.stdout.write(`  • Per-dev interactions DB: ${result.setup.interactionsDbPath}\n`);
      process.stdout.write(`  • Merged index: ${result.setup.indexPath}\n`);
      process.stdout.write(`  • Post-merge hook: ${result.setup.hookPath} (${result.setup.hookInstalled ? "installed" : "already present"})\n`);
      process.stdout.write(`  • Claude hooks: UserPromptSubmit + SessionStart + SessionEnd + Stop(idle)\n`);
      process.stdout.write(`  • Skill: ~/.claude/skills/extract-facts/SKILL.md\n`);
      process.stdout.write(`\nexport TEAM_MEMORY_DIR=${result.repoDir}\n`);
      process.stdout.write(`\nTo backfill facts from past Claude Code sessions (no API key needed):\n`);
      process.stdout.write(`  team-memory extract-bgc\n`);
      process.stdout.write(`\nOr with NerdCompletion API:\n`);
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
      process.stdout.write(`\nWhat was set up:\n`);
      process.stdout.write(`  • Git repo cloned: ${result.repoDir}\n`);
      process.stdout.write(`  • Per-dev facts DB: ${result.setup.factsDbPath}\n`);
      process.stdout.write(`  • Per-dev interactions DB: ${result.setup.interactionsDbPath}\n`);
      process.stdout.write(`  • Merged index: ${result.setup.indexPath}\n`);
      process.stdout.write(`  • Post-merge hook: ${result.setup.hookPath} (${result.setup.hookInstalled ? "installed" : "already present"})\n`);
      process.stdout.write(`  • Claude hooks: UserPromptSubmit + SessionStart + SessionEnd + Stop(idle)\n`);
      process.stdout.write(`  • Skill: ~/.claude/skills/extract-facts/SKILL.md\n`);
      process.stdout.write(`\nTo backfill facts from past Claude Code sessions (no API key needed):\n`);
      process.stdout.write(`  team-memory extract-bgc\n`);
      process.stdout.write(`\nOr with NerdCompletion API:\n`);
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
    // Hook commands must NEVER write to stderr — Claude Code would surface it as
    // an error in the user's session. Redirect stderr to hooks.log instead.
    const hooksLogPath = join(resolveRepoDir(), "hooks.log");
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (msg: string | Uint8Array, ...args: any[]): boolean => {
      try { appendFileSync(hooksLogPath, `${new Date().toISOString()} [preprompt] ${msg}`); } catch { /* best-effort */ }
      return true;
    };

    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        let prompt = "";
        try {
          const payload = JSON.parse(raw);
          prompt = payload.prompt ?? "";
        } catch { /* malformed input — continue with empty prompt */ }
        const indexPath = resolveIndexPath();
        const repoDir = resolveRepoDir();
        const developer = (() => { try { return getDeveloperName(); } catch { return "unknown"; } })();
        const project = detectProject();
        const projectRoot = detectProjectRoot();
        const result = runPrepromptHook({ prompt, indexPath, repoDir, developer, project, projectRoot });
        process.stdout.write(JSON.stringify(result));
      } catch (e: any) {
        try { appendFileSync(hooksLogPath, `${new Date().toISOString()} [preprompt] ERROR: ${e?.message}\n`); } catch { /* best-effort */ }
        process.stdout.write(JSON.stringify({ continue: true }));
      }
      // Restore stderr
      (process.stderr as any).write = origStderrWrite;
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
    writeLocalDirPointer(projectRoot, repoDir);
    if (markerCreated) {
      process.stdout.write(`Opted in: ${projectRoot}\n`);
      process.stdout.write(`Created: ${projectRoot}/.claude/team-memory.md\n`);
      process.stdout.write(`Created: ${projectRoot}/.claude/.team-memory-dir (gitignored — enables auto-discovery)\n`);
      process.stdout.write(`\nCommit .claude/team-memory.md so teammates are opted in.\n`);
      process.stdout.write(`Teammates run 'team-memory opt-in' once after pulling to get their own .team-memory-dir.\n`);
    } else {
      process.stdout.write(`Already opted in: ${projectRoot}\n`);
      process.stdout.write(`Updated: ${projectRoot}/.claude/.team-memory-dir → ${repoDir}\n`);
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
    // Works from any directory — no git repo required.
    // getAllPendingFacts returns every queued fact across all buckets (projects, _slack, _global).
    const pending = getAllPendingFacts(repoDir);
    if (pending.length === 0) {
      process.stdout.write(`No pending facts.\n`);
      return;
    }
    (async () => {
      const { createInterface } = await import("readline");
      process.stdout.write(`${pending.length} pending fact(s):\n\n`);
      const approvedByBucket = new Map<string, string[]>();
      const rejectedByBucket = new Map<string, string[]>();
      for (let i = 0; i < pending.length; i++) {
        const f = pending[i];
        const { bucket, ...fact } = f;
        const factProject = bucket.startsWith("_") ? (detectProject() ?? bucket) : bucket;

        // Rich metadata display
        process.stdout.write(`Fact ${i + 1}/${pending.length}:\n`);
        process.stdout.write(`  ${fact.content}\n`);
        process.stdout.write(`  project : ${bucket}\n`);
        process.stdout.write(`  tags    : ${JSON.stringify(fact.tags)}\n`);
        const sourceLabel = fact.source === "slack" ? "Slack thread" : fact.source === "bgc" ? "Claude session" : "manual";
        process.stdout.write(`  source  : ${sourceLabel}${fact.author ? ` (by ${fact.author})` : ""}\n`);
        if (fact.slack_url) process.stdout.write(`  url     : ${fact.slack_url}\n`);
        else process.stdout.write(`  session : ${fact.session?.slice(0, 50) ?? "unknown"}\n`);

        const answer = await new Promise<string>(res => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          rl.question("Save? (y/n): ", a => { rl.close(); res(a.trim().toLowerCase()); });
        });
        if (answer === "y") {
          if (!approvedByBucket.has(bucket)) approvedByBucket.set(bucket, []);
          approvedByBucket.get(bucket)!.push(fact.id);
          execFileSync("team-memory", ["add", fact.content, "--project", factProject, "--tags", JSON.stringify(fact.tags)], { stdio: "inherit" });
        } else {
          if (!rejectedByBucket.has(bucket)) rejectedByBucket.set(bucket, []);
          rejectedByBucket.get(bucket)!.push(fact.id);
        }
      }
      // Remove reviewed facts from each bucket
      for (const bucket of new Set([...approvedByBucket.keys(), ...rejectedByBucket.keys()])) {
        const allIds = [...(approvedByBucket.get(bucket) ?? []), ...(rejectedByBucket.get(bucket) ?? [])];
        removePendingFacts(repoDir, bucket, allIds);
      }
      const totalApproved = [...approvedByBucket.values()].flat().length;
      const totalRejected = [...rejectedByBucket.values()].flat().length;
      process.stdout.write(`\nDone. ${totalApproved} saved, ${totalRejected} rejected.\n`);
      if (totalApproved > 0) {
        process.stdout.write(`Pushing to team...\n`);
        execFileSync("team-memory", ["sync", "--push"], { stdio: "inherit" });
      }
    })().catch(e => { process.stderr.write(`Error: ${e.message}\n`); process.exit(1); });
    return;
  }

  if (command === "session-start") {
    const hooksLogPath = join(resolveRepoDir(), "hooks.log");
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (msg: string | Uint8Array, ...args: any[]): boolean => {
      try { appendFileSync(hooksLogPath, `${new Date().toISOString()} [session-start] ${msg}`); } catch { /* best-effort */ }
      return true;
    };

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
            (process.stderr as any).write = origWrite;
            return;
          }
        }
      } catch (e: any) {
        try { appendFileSync(hooksLogPath, `${new Date().toISOString()} [session-start] ERROR: ${e?.message}\n`); } catch { /* best-effort */ }
      }
      process.stdout.write(JSON.stringify({ continue: true }));
      (process.stderr as any).write = origWrite;
    });
    return;
  }

  if (command === "session-deactivate") {
    // Silent — no stdout output needed, no stderr allowed in Claude session
    const hooksLogPath = join(resolveRepoDir(), "hooks.log");
    (process.stderr as any).write = (msg: string | Uint8Array, ...args: any[]): boolean => {
      try { appendFileSync(hooksLogPath, `${new Date().toISOString()} [session-deactivate] ${msg}`); } catch { /* best-effort */ }
      return true;
    };

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
      } catch (e: any) {
        try { appendFileSync(hooksLogPath, `${new Date().toISOString()} [session-deactivate] ERROR: ${e?.message}\n`); } catch { /* best-effort */ }
      }
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

  if (command === "update") {
    const noRebuild = commandArgs.includes("--no-rebuild");
    if (!noRebuild) {
      process.stdout.write(`Pulling latest CLI source and rebuilding...\n`);
    }
    const result = updateInstallation({ noRebuild });
    if (result.rebuilt) {
      const same = result.versionBefore === result.versionAfter;
      process.stdout.write(
        same
          ? `CLI rebuilt (v${result.versionAfter}, same version — settings refreshed)\n`
          : `CLI upgraded: v${result.versionBefore} → v${result.versionAfter}\n`
      );
    } else if (result.rebuildWarning) {
      process.stdout.write(`CLI rebuild: ${result.rebuildWarning}\n`);
    }
    process.stdout.write(`Wiping old hooks and reinstalling fresh...\n`);
    process.stdout.write(`Hooks reinstalled → ${result.settingsPath}\n`);
    process.stdout.write(`  • UserPromptSubmit: team-memory preprompt-hook\n`);
    process.stdout.write(`  • SessionStart: team-memory session-start\n`);
    process.stdout.write(`  • SessionEnd: team-memory session-deactivate + /extract-facts reminder\n`);
    process.stdout.write(`  • Stop (idle): ~/.team-memory/hooks/idle.sh (2min idle, 10min cooldown)\n`);
    process.stdout.write(`Skill: ${result.skillUpdated ? "updated → ~/.claude/skills/extract-facts/SKILL.md" : "already current"}\n`);
    if (result.pullWarning) {
      process.stdout.write(`Warning: team sync failed — ${result.pullWarning}\n`);
    } else {
      process.stdout.write(`Team facts synced.\n`);
    }
    process.stdout.write(`Done.\n`);
    return;
  }

  if (command === "extract-slack") {
    const dryRun = commandArgs.includes("--dry-run");
    runExtractSlack({ dryRun }).catch((e: any) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    });
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
