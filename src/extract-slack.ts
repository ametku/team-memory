import { appendFileSync } from "fs";
import { join } from "path";
import { invokeClaudeForFacts } from "./claude-exec.js";
import { resolveRepoDir } from "./repo.js";
import { pendingPrompts, markProcessed } from "./slack-queue.js";
import { addPendingFacts } from "./pending-facts.js";

const LOG_PREFIX = "[extract-slack]";

function log(msg: string): void {
  process.stdout.write(`${LOG_PREFIX} ${msg}\n`);
}

// Uses Claude with the Slack MCP server (already configured in ~/.claude/settings.json).
// No SLACK_TOKEN needed — Claude searches Slack directly via MCP tools.
const SYSTEM_PROMPT = `You have access to Slack MCP tools (slack_search_public, slack_read_thread, etc.).

For the developer query below, search Slack for relevant technical discussions and extract 0-2 facts worth saving to a shared team knowledge base.

A fact is a decision, gotcha, correction, or convention the team reached.

DO capture: technical decisions ("we use X because Y"), gotchas ("watch out for X when Y"), conventions ("always do X in this codebase").
DO NOT capture: casual chat, opinions, jokes, ephemeral state ("deploy is broken right now").

Steps:
1. Use Slack search to find threads relevant to the query
2. Read the most relevant thread replies
3. Extract facts from what the team discussed and decided

Return JSON only:
{
  "facts": [
    {
      "content": "one declarative sentence, concrete and future-searchable",
      "tags": ["category:<gotcha|convention|tool|workaround|decision>", "kw1", "kw2"]
    }
  ]
}

If no relevant discussion found, return { "facts": [] }.`;

export async function runExtractSlack({ dryRun }: { dryRun: boolean }): Promise<void> {
  const repoDir = resolveRepoDir();
  const logPath = join(repoDir, "slack.txt");

  const pending = pendingPrompts(repoDir);
  if (pending.length === 0) {
    log("no pending prompts in queue.");
    return;
  }

  log(`found ${pending.length} pending prompt(s) to search via Slack MCP`);
  let totalFacts = 0;

  for (const item of pending.slice(0, 20)) {
    log(`searching Slack for: "${item.prompt.slice(0, 80)}"`);

    const prompt = `${SYSTEM_PROMPT}\n\nDeveloper query: ${JSON.stringify(item.prompt)}`;
    const facts = invokeClaudeForFacts(prompt);

    log(`extracted ${facts.length} fact(s)`);

    if (facts.length > 0) {
      if (dryRun) {
        for (const f of facts) {
          process.stdout.write(`[dry-run] Fact: ${JSON.stringify(f.content)}\n`);
          process.stdout.write(`         Tags: ${JSON.stringify(f.tags)}\n`);
          process.stdout.write(`         Project: ${item.project ?? "global"}\n`);
        }
      } else {
        const project = item.project ?? "_slack";
        addPendingFacts(repoDir, project, facts.map(f => ({ ...f, session: item.prompt })));
        totalFacts += facts.length;
        // Log each fact to slack.txt in TEAM_MEMORY_DIR
        try {
          const ts = new Date().toISOString();
          for (const f of facts) {
            appendFileSync(logPath, `[extract-slack] ${ts} queued [${project}]: "${f.content.slice(0, 120)}"\n`);
          }
        } catch { /* best-effort */ }
        log(`queued ${facts.length} fact(s) for ${item.project ?? "global"} → run 'team-memory review-pending'`);
      }
    }

    if (!dryRun) {
      markProcessed(repoDir, item.prompt);
    }
  }

  if (dryRun) {
    process.stdout.write(`[dry-run] done. No changes written.\n`);
  } else {
    log(`done. ${totalFacts} fact(s) queued from ${pending.length} prompt(s).`);
    try {
      appendFileSync(logPath, `[extract-slack] ${new Date().toISOString()} done — ${totalFacts} fact(s) queued from ${pending.length} prompt(s)\n`);
    } catch { /* best-effort */ }
  }
}
